import maplibregl from 'maplibre-gl';
import { addTerrainSource, enableTerrain } from '../camera.js';
import { getTrailReplayCameraPose, normalizeTrailReplayCameraMode } from '../camera/trailReplayPlan.js';
import { applyPersistentBasemapPresentation } from '../persistentMapStyle.js';

const WARMUP_VIEWPORT = { width: 1920, height: 1080 };
const OPENING_PRELOAD_TIMEOUT_MS = 6000;
const OPENING_WINDOW_MS = 12000;
const OPENING_SAMPLE_COUNT = 5;
const DISCOVERY_RENDER_WINDOW_MS = 100;
const RESCHEDULE_INTERVAL_MS = 1500;
const NORMAL_HORIZON_MS = 20000;
const CLOSE_3D_HORIZON_MS = 45000;
const NORMAL_SAMPLE_COUNT = 12;
const CLOSE_3D_SAMPLE_COUNT = 36;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function shortestBearingDelta(from, to) {
  return ((((to - from) + 540) % 360) - 180);
}

function deduplicatePoses(poses) {
  const seen = new Set();
  return poses.filter((pose) => {
    if (!pose?.center) return false;
    const key = [
      pose.center.lng.toFixed(5),
      pose.center.lat.toFixed(5),
      pose.zoom.toFixed(1),
      pose.pitch.toFixed(0),
      pose.bearing.toFixed(0),
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function poseFor(route, progress, options) {
  return getTrailReplayCameraPose(
    route,
    clamp01(progress),
    options.followBehindZoomLevel,
    {
      cameraMode:
        normalizeTrailReplayCameraMode(options.cameraMode) === 'cinematic'
          ? 'follow-behind'
          : normalizeTrailReplayCameraMode(options.cameraMode),
      cameraStability: options.cameraStability,
      videoDurationSeconds: options.durationSec,
    },
  );
}

function openingProgresses(durationSec) {
  const durationMs = Math.max(1, durationSec * 1000);
  const endProgress = Math.min(1, OPENING_WINDOW_MS / durationMs);
  return Array.from({ length: OPENING_SAMPLE_COUNT }, (_, index) => (
    OPENING_SAMPLE_COUNT === 1
      ? 0
      : (endProgress * index) / (OPENING_SAMPLE_COUNT - 1)
  ));
}

function predictivePoses(route, currentProgress, options) {
  const mode =
    normalizeTrailReplayCameraMode(options.cameraMode) === 'cinematic'
      ? 'follow-behind'
      : normalizeTrailReplayCameraMode(options.cameraMode);
  if (mode === 'overview') return [];

  const isClose3d =
    mode === 'follow-behind' &&
    Number(options.followBehindZoomLevel) >= 66;
  const horizonMs =
    (isClose3d ? CLOSE_3D_HORIZON_MS : NORMAL_HORIZON_MS) *
    Math.max(0.25, Number(options.playbackSpeed) || 1);
  const sampleCount = isClose3d
    ? CLOSE_3D_SAMPLE_COUNT
    : NORMAL_SAMPLE_COUNT;
  const durationMs = Math.max(1, options.durationSec * 1000);
  const endOffset = Math.min(1, horizonMs / durationMs);
  const progresses = Array.from({ length: sampleCount }, (_, index) => (
    clamp01(
      currentProgress +
      (sampleCount === 1 ? 0 : (endOffset * index) / (sampleCount - 1)),
    )
  ));

  const poses = [];
  for (let index = 0; index < progresses.length; index += 1) {
    const progress = progresses[index];
    const pose = poseFor(route, progress, options);
    if (!pose) continue;
    poses.push(pose);

    // Match TrailReplay's extra incoming-frustum warmup around meaningful
    // turns, so a pitched camera has both sides of the turn cached.
    const nextProgress = progresses[Math.min(index + 1, progresses.length - 1)];
    const incoming = poseFor(route, nextProgress, options);
    if (
      incoming &&
      Math.abs(shortestBearingDelta(pose.bearing, incoming.bearing)) >= 12
    ) {
      poses.push({ ...pose, bearing: incoming.bearing });
    }
  }

  return deduplicatePoses(poses);
}

function cameraSnapshot(map) {
  const center = map.getCenter?.();
  const snapshot = {
    center: [center?.lng ?? 0, center?.lat ?? 0],
    zoom: map.getZoom?.() ?? 13,
    pitch: map.getPitch?.() ?? 0,
    bearing: map.getBearing?.() ?? 0,
  };
  const elevation = map.getCenterElevation?.();
  if (Number.isFinite(elevation)) snapshot.elevation = elevation;
  return snapshot;
}

function toMapCamera(pose) {
  return {
    center: [pose.center.lng, pose.center.lat],
    zoom: pose.zoom,
    pitch: pose.pitch,
    bearing: pose.bearing,
  };
}

/**
 * TrailReplay-style tile warming adapted to OpenFreeMap vector tiles.
 *
 * Opening warmup temporarily visits the first few real playback poses on the
 * covered visible map so MapLibre's primary cache is hot before Play.
 * During playback, a 1920x1080 offscreen MapLibre instance continuously scans
 * predicted future camera poses. This keeps HTTP/worker tile caches ahead of
 * the visible film without ever moving the customer-facing camera.
 */
export function createReplayTileWarmup({
  visibleMap,
  persistentStyle,
  presentations,
  initialBasemapStyleId,
  getCameraMode,
  getCameraStability,
  getFollowBehindZoomLevel,
  getPlaybackSpeed,
  getDurationSec,
}) {
  let route = null;
  let warmupMap = null;
  let warmupContainer = null;
  let activeBasemapStyleId = initialBasemapStyleId;
  let intervalId = null;
  let poseTimeoutId = null;
  let poseResolve = null;
  let warming = false;
  let cancelled = false;
  let currentProgress = 0;

  function cameraOptions() {
    return {
      cameraMode: getCameraMode?.() ?? 'cinematic',
      cameraStability: getCameraStability?.() ?? 0.3,
      followBehindZoomLevel: getFollowBehindZoomLevel?.() ?? 33,
      playbackSpeed: getPlaybackSpeed?.() ?? 1,
      durationSec: Math.max(0.001, getDurationSec?.() ?? 30),
    };
  }

  function setRoute(nextRoute) {
    route = nextRoute || null;
    currentProgress = 0;
  }

  function setBasemapStyle(styleId) {
    activeBasemapStyleId = styleId;
    if (warmupMap?.isStyleLoaded?.()) {
      applyPersistentBasemapPresentation(
        warmupMap,
        presentations,
        activeBasemapStyleId,
      );
    }
  }

  function ensureOffscreenMap() {
    if (warmupMap || typeof document === 'undefined') return;

    warmupContainer = document.createElement('div');
    warmupContainer.setAttribute('aria-hidden', 'true');
    Object.assign(warmupContainer.style, {
      height: `${WARMUP_VIEWPORT.height}px`,
      left: '-10000px',
      pointerEvents: 'none',
      position: 'fixed',
      top: '0',
      width: `${WARMUP_VIEWPORT.width}px`,
    });
    document.body.appendChild(warmupContainer);

    warmupMap = new maplibregl.Map({
      attributionControl: false,
      container: warmupContainer,
      interactive: false,
      maxTileCacheSize: 1200,
      style: structuredClone(persistentStyle),
    });

    warmupMap.once('load', () => {
      applyPersistentBasemapPresentation(
        warmupMap,
        presentations,
        activeBasemapStyleId,
      );
      try {
        addTerrainSource(warmupMap);
        enableTerrain(warmupMap);
      } catch {
        // Tile warmup is best-effort; visible playback must never depend on it.
      }
    });
  }

  async function preloadOpening() {
    if (!route) return true;
    const options = cameraOptions();
    const mode = normalizeTrailReplayCameraMode(options.cameraMode);
    if (mode === 'overview') return true;

    const poses = deduplicatePoses(
      openingProgresses(options.durationSec)
        .map((progress) => poseFor(route, progress, options))
        .filter(Boolean),
    );
    if (!poses.length) return true;

    const restore = cameraSnapshot(visibleMap);
    const deadline = performance.now() + OPENING_PRELOAD_TIMEOUT_MS;

    const warmPose = (pose) => new Promise((resolve) => {
      let settled = false;
      let timeoutId = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        visibleMap.off?.('idle', finish);
        if (timeoutId != null) window.clearTimeout(timeoutId);
        resolve();
      };

      visibleMap.jumpTo(toMapCamera(pose));
      visibleMap.once?.('idle', finish);
      const remaining = Math.max(0, deadline - performance.now());
      timeoutId = window.setTimeout(finish, remaining);
    });

    try {
      for (const pose of poses) {
        if (performance.now() >= deadline) break;
        await warmPose(pose);
      }
      return true;
    } finally {
      visibleMap.jumpTo(restore);
      visibleMap.triggerRepaint?.();
    }
  }

  const warmPoseOffscreen = (pose) => new Promise((resolve) => {
    if (!warmupMap || cancelled) {
      resolve();
      return;
    }

    poseResolve = resolve;
    warmupMap.jumpTo(toMapCamera(pose));
    poseTimeoutId = window.setTimeout(() => {
      poseTimeoutId = null;
      const finish = poseResolve;
      poseResolve = null;
      finish?.();
    }, DISCOVERY_RENDER_WINDOW_MS);
  });

  async function warmFuture() {
    if (warming || cancelled || !route || !warmupMap?.loaded?.()) return;
    const options = cameraOptions();
    if (normalizeTrailReplayCameraMode(options.cameraMode) === 'overview') return;

    warming = true;
    try {
      const poses = predictivePoses(route, currentProgress, options);
      for (const pose of poses) {
        if (cancelled) return;
        await warmPoseOffscreen(pose);
      }
    } finally {
      warming = false;
    }
  }

  function start() {
    cancelled = false;
    ensureOffscreenMap();
    if (intervalId != null) return;
    void warmFuture();
    intervalId = window.setInterval(() => {
      void warmFuture();
    }, RESCHEDULE_INTERVAL_MS);
  }

  function updateProgress(progress) {
    currentProgress = clamp01(progress);
  }

  function stop() {
    cancelled = true;
    warming = false;
    if (poseTimeoutId != null) {
      window.clearTimeout(poseTimeoutId);
      poseTimeoutId = null;
    }
    const finishPose = poseResolve;
    poseResolve = null;
    finishPose?.();
    if (intervalId != null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  }

  function destroy() {
    stop();
    warmupMap?.remove?.();
    warmupMap = null;
    warmupContainer?.remove?.();
    warmupContainer = null;
    route = null;
  }

  return {
    setRoute,
    setBasemapStyle,
    preloadOpening,
    start,
    updateProgress,
    stop,
    destroy,
  };
}
