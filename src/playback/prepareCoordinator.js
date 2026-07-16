/**
 * Prepares playback before Play is enabled.
 * Plans are resolved from user quality preset + prepare intent.
 */

import {
  PREPARE_INTENT,
  buildCorridorDistances,
  buildFullRouteDistances,
  normalizePrepareQuality,
  resolvePreparePlan,
} from './preparePlans.js';

export const PREPARE_PHASES = [
  'layers',
  'route_graphics',
  'playback_camera',
  'terrain_mode',
  'view_tiles',
  'corridor_prefetch',
  'full_route_prefetch',
  'first_frame',
  'armed',
];

const MAX_CRITERIA_POLLS = 240;
const RELOCATE_CRITERIA_POLLS = 120;
const CORRIDOR_HOP_POLLS = 60;

export function createPlaybackPrepareCoordinator(deps) {
  const {
    map,
    terrainStream,
    getContext,
    onPhase,
    onArmed,
    onFailed,
    onSettled,
  } = deps;

  let armed = false;
  let preparing = false;
  let prepareGeneration = 0;
  let lastError = null;
  let lastPlan = null;
  let degraded = false;

  function isArmed() {
    return armed;
  }

  function isPreparing() {
    return preparing;
  }

  function getLastError() {
    return lastError;
  }

  function isDegraded() {
    return degraded;
  }

  function getLastPlan() {
    return lastPlan;
  }

  function disarm() {
    prepareGeneration += 1;
    armed = false;
    preparing = false;
    degraded = false;
  }

  function reportPhase(phase, detail = {}) {
    onPhase?.(phase, detail);
  }

  function isDeadlineExceeded(deadlineMs, startedAt) {
    return deadlineMs > 0 && performance.now() - startedAt >= deadlineMs;
  }

  async function waitForStableView(elevationHint, { maxPolls = MAX_CRITERIA_POLLS, tilesOnly = false, deadlineMs = 0, startedAt = performance.now() } = {}) {
    if (deadlineMs > 0 && isDeadlineExceeded(deadlineMs, startedAt)) {
      throw new Error('prepare_deadline_exceeded');
    }

    const remainingMs = deadlineMs > 0
      ? Math.max(250, deadlineMs - (performance.now() - startedAt))
      : 0;
    const pollBudget = remainingMs > 0
      ? Math.min(maxPolls, Math.ceil(remainingMs / 16))
      : maxPolls;

    return waitUntil(
      () => {
        if (tilesOnly || !terrainStream) return map.areTilesLoaded();
        if (!terrainStream.isTerrainEnabled()) return map.areTilesLoaded();
        return terrainStream.isViewReady(elevationHint);
      },
      { map, label: tilesOnly ? 'view_tiles_flat' : 'view_tiles', maxPolls: pollBudget },
    );
  }

  function settlePrepare(generation, detail = {}) {
    if (generation !== prepareGeneration) return;
    preparing = false;
    onSettled?.({ armed, ...detail });
  }

  async function armPrepared(ctx, generation, reason, { isDegraded = false, plan = lastPlan } = {}) {
    if (generation !== prepareGeneration) return;

    armed = true;
    degraded = isDegraded;
    lastError = null;
    preparing = false;

    reportPhase('armed', { reason, degraded: isDegraded, plan });
    onArmed?.({ reason, degraded: isDegraded, plan });
  }

  async function prepare(reason = 'load', options = {}) {
    const intent = options.intent || PREPARE_INTENT.INITIAL;
    const qualityKey = normalizePrepareQuality(options.quality);
    const route = options.route ?? getContext()?.route ?? null;
    const plan = resolvePreparePlan(intent, qualityKey, route);
    lastPlan = plan;

    const generation = ++prepareGeneration;
    armed = false;
    preparing = true;
    lastError = null;
    degraded = false;
    const startedAt = performance.now();
    const tilePollBudget = plan.intent === PREPARE_INTENT.RELOCATE
      ? RELOCATE_CRITERIA_POLLS
      : MAX_CRITERIA_POLLS;

    try {
      const ctx = getContext();
      if (!ctx?.route) throw new Error('No route to prepare');

      reportPhase('layers', { reason, plan });
      ctx.ensureLayers();
      if (generation !== prepareGeneration) return;

      reportPhase('route_graphics', { reason, plan });
      ctx.syncRouteGraphics({ fitOverview: plan.fitOverview });
      if (generation !== prepareGeneration) return;

      const isInitial = plan.intent === PREPARE_INTENT.INITIAL;
      const elevationHint = ctx.getElevationHint();

      if (plan.requireInitialView) {
        reportPhase('view_tiles', { reason, plan });
        try {
          await waitForStableView(elevationHint, {
            maxPolls: tilePollBudget,
            tilesOnly: true,
            deadlineMs: plan.initialViewDeadlineMs,
            startedAt,
          });
        } catch {
          // Continue — route overview is already visible on flat tiles.
        }
        if (generation !== prepareGeneration) return;
      }

      if (!isInitial) {
        reportPhase('playback_camera', { reason, plan });
        ctx.applyPlaybackCamera();
        if (generation !== prepareGeneration) return;
      }

      reportPhase('terrain_mode', { reason, plan });
      ctx.stabilizeTerrain();
      if (generation !== prepareGeneration) return;

      if (plan.requireInitialView && !isInitial) {
        reportPhase('view_tiles', { reason, plan });
        try {
          await waitForStableView(elevationHint, {
            maxPolls: tilePollBudget,
            deadlineMs: plan.initialViewDeadlineMs,
            startedAt,
          });
        } catch {
          if (!plan.allowDegrade) throw new Error('initial_view_not_ready');
          ctx.degradeTerrain?.();
          await waitForStableView(elevationHint, {
            maxPolls: RELOCATE_CRITERIA_POLLS,
            tilesOnly: true,
            deadlineMs: plan.initialViewDeadlineMs,
            startedAt,
          });
        }
        if (generation !== prepareGeneration) return;
      }

      if (plan.corridor.enabled) {
        reportPhase('corridor_prefetch', { reason, plan });
        await prefetchCorridor(ctx, terrainStream, map, plan, route, {
          generation,
          prepareGeneration: () => prepareGeneration,
          fromDistance: ctx.getAnimDistance(),
          startedAt,
        });
        if (generation !== prepareGeneration) return;

        ctx.applyPlaybackCamera();
        try {
          await waitForStableView(elevationHint, {
            maxPolls: RELOCATE_CRITERIA_POLLS,
            deadlineMs: plan.initialViewDeadlineMs,
            startedAt,
          });
        } catch {
          if (!plan.allowDegrade) throw new Error('corridor_view_not_ready');
          ctx.degradeTerrain?.();
          await waitForStableView(elevationHint, {
            maxPolls: RELOCATE_CRITERIA_POLLS,
            tilesOnly: true,
            deadlineMs: plan.initialViewDeadlineMs,
            startedAt,
          });
        }
        if (generation !== prepareGeneration) return;
      }

      if (plan.fullRoute.enabled) {
        reportPhase('full_route_prefetch', { reason, plan });
        await prefetchFullRoute(ctx, terrainStream, map, plan, route, {
          generation,
          prepareGeneration: () => prepareGeneration,
          startedAt,
        });
        if (generation !== prepareGeneration) return;

        ctx.setAnimDistance(ctx.getAnimDistance());
        ctx.applyPlaybackCamera();
      }

      reportPhase('first_frame', { reason, plan });
      ctx.applyPlaybackCamera();
      ctx.renderFirstFrame();
      if (generation !== prepareGeneration) return;

      await armPrepared(ctx, generation, reason, {
        isDegraded: ctx.isTerrainDegraded?.(),
        plan,
      });
    } catch (err) {
      if (generation !== prepareGeneration) return;

      if (!plan.allowDegrade) {
        armed = false;
        lastError = err?.message || String(err);
        onFailed?.({ reason, error: lastError, recovered: false, plan });
        return;
      }

      try {
        const ctx = getContext();
        ctx.degradeTerrain?.();
        ctx.applyPlaybackCamera();
        ctx.renderFirstFrame();
        await armPrepared(ctx, generation, reason, { isDegraded: true, plan });
        lastError = err?.message || String(err);
        onFailed?.({ reason, error: lastError, recovered: true, plan });
        return;
      } catch {
        armed = false;
        lastError = err?.message || String(err);
        onFailed?.({ reason, error: lastError, recovered: false, plan });
      }
    } finally {
      settlePrepare(generation, { reason, plan });
    }
  }

  return {
    prepare,
    disarm,
    isArmed,
    isPreparing,
    getLastError,
    isDegraded,
    getLastPlan,
  };
}

export function waitUntil(predicate, { map, label = 'ready', maxPolls = MAX_CRITERIA_POLLS } = {}) {
  return new Promise((resolve, reject) => {
    let polls = 0;
    let sawUnsettled = false;

    function cleanup(onIdle) {
      if (onIdle) map.off('idle', onIdle);
    }

    function finish(onIdle, ok) {
      cleanup(onIdle);
      if (ok) resolve(true);
      else reject(new Error(`${label} not satisfied`));
    }

    function check(onIdle) {
      polls += 1;
      let ok = false;
      try {
        ok = Boolean(predicate());
      } catch {
        ok = false;
      }

      if (ok && (sawUnsettled || polls > 1)) {
        finish(onIdle, true);
        return;
      }
      if (!ok) sawUnsettled = true;

      if (polls >= maxPolls) {
        finish(onIdle, false);
        return;
      }

      requestAnimationFrame(() => check(onIdle));
    }

    function onIdle() {
      check(onIdle);
    }

    map.on('idle', onIdle);
    check(onIdle);
  });
}

async function prefetchCorridor(ctx, terrainStream, map, plan, route, options = {}) {
  if (!route || !plan.corridor.enabled) return;

  const {
    generation,
    prepareGeneration,
    fromDistance = 0,
    startedAt = performance.now(),
  } = options;

  const distances = buildCorridorDistances(plan, route, { fromDistance });
  const elevationHint = ctx.getElevationHint();
  const savedDistance = ctx.getAnimDistance();
  const corridorStarted = performance.now();

  for (const dist of distances) {
    if (generation !== prepareGeneration()) return;
    if (performance.now() - corridorStarted >= plan.corridor.deadlineMs) return;
    if (performance.now() - startedAt >= plan.totalPrepareDeadlineMs) return;

    ctx.setAnimDistance(dist);
    ctx.applyPlaybackCamera();
    try {
      await waitUntil(
        () => {
          if (!terrainStream || !terrainStream.isTerrainEnabled()) {
            return map.areTilesLoaded();
          }
          return terrainStream.isViewReady(elevationHint);
        },
        { map, label: `corridor_${Math.round(dist)}m`, maxPolls: CORRIDOR_HOP_POLLS },
      );
    } catch {
      // Best-effort — continue to next hop.
    }
  }

  ctx.setAnimDistance(savedDistance);
  ctx.applyPlaybackCamera();
}

async function prefetchFullRoute(ctx, terrainStream, map, plan, route, options = {}) {
  if (!route || !plan.fullRoute.enabled) return;

  const {
    generation,
    prepareGeneration,
    startedAt = performance.now(),
  } = options;

  const distances = buildFullRouteDistances(plan, route);
  const elevationHint = ctx.getElevationHint();
  const savedDistance = ctx.getAnimDistance();
  const prefetchStarted = performance.now();

  for (const dist of distances) {
    if (generation !== prepareGeneration()) return;
    if (performance.now() - prefetchStarted >= plan.fullRoute.deadlineMs) return;
    if (performance.now() - startedAt >= plan.totalPrepareDeadlineMs) return;

    ctx.setAnimDistance(dist);
    ctx.applyPlaybackCamera();
    try {
      await waitUntil(
        () => {
          if (!terrainStream || !terrainStream.isTerrainEnabled()) {
            return map.areTilesLoaded();
          }
          return terrainStream.isViewReady(elevationHint);
        },
        { map, label: `full_route_${Math.round(dist)}m`, maxPolls: CORRIDOR_HOP_POLLS },
      );
    } catch {
      // Best-effort sampling along the route.
    }
  }

  ctx.setAnimDistance(savedDistance);
  ctx.applyPlaybackCamera();
}
