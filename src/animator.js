import { RoutePath } from './route.js';
import {
  addTerrainSource,
  captureShot,
  defaultShotForMode,
  disableTerrain,
  enableTerrain,
  fitOverview,
  stopCameraAnimation,
} from './camera.js';
import {
  createPlaybackState,
  getPlaybackDuration,
  samplePlaybackFrame,
  seekPlaybackProgress,
} from './playback/engine.js';
import { createFrameState } from './playback/frameState.js';
import { createMapPlaybackRenderer } from './renderers/mapPlaybackRenderer.js';
import {
  applyCameraFrame,
  createCameraRuntimeState,
  resolveCameraFrame,
} from './camera/runtime.js';
import { createPlaybackProbe } from './debug/playbackProbe.js';
import { createPlaybackPrepareCoordinator } from './playback/prepareCoordinator.js';
import { mapReasonToIntent, PREPARE_INTENT, PREPARE_QUALITY } from './playback/preparePlans.js';
import { resolveCameraShotFromDocument } from './modules/cameraModule.js';
import { rigToShot } from './camera/rig.js';

export function createAnimator(map, ui, {
  terrainStream = null,
  getPrepareQuality = () => 'balanced',
  getCameraDocument = () => null,
  getTrackStyle = () => null,
} = {}) {
  const renderer = createMapPlaybackRenderer(map);
  const probe = createPlaybackProbe({
    enabled:
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('playbackDebug') === '1',
  });
  let route = null;
  let routeName = '';
  let animTime = 0;
  let animDistance = 0;
  let playing = false;
  let lastFrame = 0;
  let currentSpeed = 0;
  let speedMul = 1;
  let cameraState = createCameraRuntimeState('follow');
  let renderFrameId = null;
  let lastAppliedCadenceTick = -1;
  let terrainBarrierActive = false;
  let terrainBarrierGeneration = 0;
  const TERRAIN_BARRIER_MAX_MS = 2000;
  let mapViewMode = '3d';
  let routeReadyForPlayback = false;
  let skipNextTerrainBarrier = false;
  let prepareResumePlayback = false;
  let nextPrepareFitOnLoad = true;
  let terrainDegraded = false;
  let loopPlayback = false;

  const playbackPreparer = createPlaybackPrepareCoordinator({
    map,
    terrainStream,
    getContext: () => buildPrepareContext(),
    onPhase: (phase, detail) => ui.onPreparePhase?.(phase, detail),
    onArmed: ({ reason, degraded }) => {
      terrainDegraded = Boolean(degraded);
      const frameState = getCurrentFrameState();
      updateHUD(frameState);
      ui.onPlaybackArmed?.(reason, degraded);
      if (prepareResumePlayback) {
        prepareResumePlayback = false;
        playInternal();
      }
    },
    onFailed: ({ error, recovered }) => ui.onPrepareFailed?.(error, { recovered }),
    onSettled: () => ui.onPrepareSettled?.(),
  });

  function buildPrepareContext() {
    return {
      route,
      getElevationHint: getRouteElevationHint,
      getAnimDistance: () => animDistance,
      setAnimDistance: (dist) => {
        const pct = route?.totalDistance > 0 ? dist / route.totalDistance : 0;
        setPlaybackState(seekPlaybackProgress(route, pct, speedMul));
      },
      ensureLayers: () => addLayers(),
      syncRouteGraphics: ({ fitOverview: shouldFit = false } = {}) => {
        if (!cameraState.shot) {
          cameraState = createCameraRuntimeState(
            cameraState.preset,
            defaultShotForMode(cameraState.preset),
          );
        }
        const frameState = getCurrentFrameState();
        syncMapState(frameState);
        if (shouldFit && nextPrepareFitOnLoad) {
          applyInitialRouteView(frameState, { fitOnLoad: true });
          nextPrepareFitOnLoad = false;
        }
      },
      applyPlaybackCamera: () => {
        resetPlaybackCameraGuards();
        const frameState = getCurrentFrameState();
        syncTerrainHealth(frameState);
        applyCameraFrame(map, resolveCameraFrameForView(frameState), { continuous: false });
        lastAppliedCadenceTick = frameState?.playback?.cadenceTick ?? -1;
      },
      stabilizeTerrain: () => {
        if (mapViewMode !== '3d' || terrainDegraded) {
          disableTerrain(map);
          return;
        }
        addTerrainSource(map);
        enableTerrain(map);
        syncTerrainHealth(getCurrentFrameState());
      },
      degradeTerrain: () => {
        terrainDegraded = true;
        disableTerrain(map);
        if (cameraState?.terrainGuard) {
          cameraState.terrainGuard.enabled = false;
          cameraState.terrainGuard.lastEnvelopeM = null;
        }
      },
      isTerrainDegraded: () => terrainDegraded || mapViewMode === '2d',
      renderFirstFrame: () => {
        const frameState = getCurrentFrameState();
        refreshProgressLayers(frameState, true);
        updateHUD(frameState);
        map.triggerRepaint();
      },
    };
  }

  function schedulePrepare(reason, { resumePlayback = false, fitOnLoad, intent, quality } = {}) {
    prepareResumePlayback = resumePlayback;
    if (fitOnLoad !== undefined) nextPrepareFitOnLoad = fitOnLoad;
    const prepareIntent = intent || mapReasonToIntent(reason);
    const prepareQuality = quality ?? (
      prepareIntent === PREPARE_INTENT.INITIAL || prepareIntent === PREPARE_INTENT.RELOCATE
        ? PREPARE_QUALITY.FAST
        : getPrepareQuality()
    );
    playbackPreparer.disarm();
    ui.onPlaybackDisarmed?.();
    playbackPreparer.prepare(reason, {
      intent: prepareIntent,
      quality: prepareQuality,
      route,
    });
  }

  function applyTimelinePosition(value) {
    const pct = value / 1000;
    setPlaybackState(seekPlaybackProgress(route, pct, speedMul));
    route?.resetTraveledCache?.();
    renderer.resetProgressCache?.();
    resetPlaybackCameraGuards();
    const frameState = getCurrentFrameState();
    syncMapState(frameState);
    applyCameraFrame(
      map,
      resolveCameraFrameForView(frameState),
      { continuous: false },
    );
    updateHUD(frameState);
  }

  function resetPlaybackCameraGuards() {
    if (cameraState?.terrainGuard) {
      cameraState.terrainGuard.lastEnvelopeM = null;
      cameraState.terrainGuard.smoothedElevationM = null;
      if (cameraState.terrainGuard.bearingGuard) {
        cameraState.terrainGuard.bearingGuard.lastBearingDeg = null;
      }
    }
    clearTerrainBarrier();
  }

  function clearTerrainBarrier() {
    terrainBarrierGeneration += 1;
    terrainBarrierActive = false;
  }

  function beginTerrainBarrier(elevationHint) {
    if (!terrainStream?.isTerrainEnabled()) return;
    if (skipNextTerrainBarrier) {
      skipNextTerrainBarrier = false;
      return;
    }

    const generation = ++terrainBarrierGeneration;
    terrainBarrierActive = true;

    terrainStream.waitForViewReady(TERRAIN_BARRIER_MAX_MS, { elevationHint }).then(() => {
      if (generation !== terrainBarrierGeneration) return;
      terrainBarrierActive = false;
    });

    window.setTimeout(() => {
      if (generation !== terrainBarrierGeneration) return;
      terrainBarrierActive = false;
    }, TERRAIN_BARRIER_MAX_MS + 50);
  }

  function getRouteElevationHint() {
    if (!route?.raw?.length) return null;
    const elevations = route.raw
      .map((point) => point.ele)
      .filter((ele) => Number.isFinite(ele));
    if (!elevations.length) return null;
    return elevations[Math.floor(elevations.length / 2)];
  }

  function syncTerrainHealth(frameState = getCurrentFrameState()) {
    if (mapViewMode !== '3d' || !terrainStream) return;

    const elevationHint = getRouteElevationHint();
    const demReady = terrainStream.isTerrainDemReady(elevationHint);
    const terrainOn = terrainStream.isTerrainEnabled();

    if (demReady && !terrainOn) {
      enableTerrain(map);
      if (cameraState?.terrainGuard) {
        cameraState.terrainGuard.enabled = true;
      }
      return;
    }

    if (!demReady && terrainOn) {
      disableTerrain(map);
      if (cameraState?.terrainGuard) {
        cameraState.terrainGuard.enabled = false;
        cameraState.terrainGuard.lastEnvelopeM = null;
      }
    }
  }

  function applyInitialRouteView(frameState, { fitOnLoad = true } = {}) {
    resetPlaybackCameraGuards();
    syncTerrainHealth(frameState);
    const routeBounds = renderer.getBounds(route);
    const maxElevationM = getRouteMaxElevation();

    if (fitOnLoad && routeBounds) {
      // Always start with a stable top-down overview so the route is visible
      // while map tiles and terrain DEM load in the background.
      fitOverview(map, routeBounds, { maxElevationM });
    } else {
      applyCameraFrame(map, resolveCameraFrameForView(frameState), { continuous: false });
    }

    refreshProgressLayers(frameState, true);
    map.triggerRepaint();
  }

  function finalizeRouteLoad(name, frameState) {
    routeReadyForPlayback = true;
    ui.onRouteLoaded(name, route);
    ui.onShotChanged?.(cameraState.shot, cameraState.preset);
    updateHUD(frameState);
  }

  function getRouteMaxElevation() {
    if (!route?.raw?.length) return null;
    const elevations = route.raw
      .map((point) => point.ele)
      .filter((ele) => Number.isFinite(ele));
    return elevations.length ? Math.max(...elevations) : null;
  }

  function applyViewToCameraFrame(cameraFrame) {
    if (!cameraFrame) return cameraFrame;
    if (mapViewMode !== '2d') return cameraFrame;

    // Force an authored 2D camera:
    // - pitch must be 0 (top-down)
    // - keep bearing / offsets so camera presets still work
    // - disable terrain-aware elevation guard
    const shot = { ...cameraFrame.shot, pitch: 0 };

    const terrainGuard = cameraFrame.terrainGuard
      ? {
          ...cameraFrame.terrainGuard,
          // In 2D we disable terrain-aware elevation completely.
          enabled: false,
          lastEnvelopeM: null,
          smoothedElevationM: null,
          bearingGuard: {
            ...cameraFrame.terrainGuard.bearingGuard,
            enabled: false,
          },
        }
      : cameraFrame.terrainGuard;

    return { ...cameraFrame, shot, terrainGuard };
  }

  function resolveCameraFrameForView(frameState) {
    const cameraFrame = resolveCameraFrame(frameState, cameraState);
    const doc = getCameraDocument?.();
    if (doc) {
      const shot = resolveCameraShotFromDocument(
        doc,
        animTime,
        getDuration(),
        doc.timelineKeyframes,
      );
      const frame = applyViewToCameraFrame({ ...cameraFrame, shot });
      if (doc.rig?.smoothing && frame.terrainGuard?.bearingGuard) {
        const smooth = doc.rig.smoothing.bearing ?? 0.6;
        frame.terrainGuard.bearingGuard.maxDeltaDegPerUpdate = 0.6 + (1 - smooth) * 5;
      }
      return frame;
    }
    return applyViewToCameraFrame(cameraFrame);
  }

  function setMapViewMode(mode) {
    mapViewMode = mode === '2d' ? '2d' : '3d';

    if (mapViewMode === '2d') {
      try {
        map.setTerrain(null);
      } catch {
        // ignore
      }
      if (cameraState?.terrainGuard) {
        cameraState.terrainGuard.enabled = false;
        cameraState.terrainGuard.lastEnvelopeM = null;
        cameraState.terrainGuard.bearingGuard.enabled = false;
      }
    } else {
      addTerrainSource(map);
      if (route) {
        enableTerrain(map);
      } else {
        disableTerrain(map);
      }
      if (cameraState?.terrainGuard) {
        cameraState.terrainGuard.enabled = true;
        cameraState.terrainGuard.lastEnvelopeM = null;
        cameraState.terrainGuard.bearingGuard.enabled = true;
      }
    }

    if (route) {
      const frameState = getCurrentFrameState();
      syncMapState(frameState);
      applyCameraFrame(map, resolveCameraFrameForView(frameState), { continuous: false });
      const wasPlaying = playing;
      if (wasPlaying) {
        playing = false;
        cancelPlaybackFrame();
        stopCameraAnimation(map);
        ui.setPlaying(false);
      }
      schedulePrepare('view_mode', {
        resumePlayback: wasPlaying,
      });
    }
  }

  function clampTime(time) {
    return Math.max(0, Math.min(time, getDuration()));
  }

  function addLayers() {
    renderer.addLayers();
    const trackStyle = getTrackStyle?.();
    if (trackStyle) renderer.applyTrackStyle?.(trackStyle);
    if (route) refreshLayers(getCurrentFrameState());
    // `renderer.addLayers()` always enables terrain for the MapLibre 3D path.
    // In 2D we must keep terrain disabled even after style reloads.
    if (mapViewMode === '2d') {
      try {
        map.setTerrain(null);
      } catch {
        // ignore
      }
      if (cameraState?.terrainGuard) {
        cameraState.terrainGuard.enabled = false;
        cameraState.terrainGuard.lastEnvelopeM = null;
        cameraState.terrainGuard.bearingGuard.enabled = false;
      }
    }
  }

  function whenMapReady(fn) {
    renderer.whenReady(fn);
  }

  function clearMapData() {
    renderer.clear();
  }

  function getCurrentSample() {
    if (!route) return null;
    return route.atDistance(animDistance);
  }

  function getCurrentFrameState(sample = getCurrentSample(), overrideSpeed = currentSpeed) {
    if (!route || !sample) return null;
    return createFrameState({
      routeName,
      route,
      playbackFrame: {
        animTime,
        animDistance,
        currentSpeed: overrideSpeed,
        duration: getDuration(),
        done: false,
        sample,
      },
    });
  }

  function syncMapState(frameState = getCurrentFrameState()) {
    renderer.refreshRouteFrameState(frameState);
  }

  function setPlaybackState(state = {}) {
    const playbackState = createPlaybackState(route, state, speedMul);
    animDistance = playbackState.animDistance;
    animTime = playbackState.animTime;
    currentSpeed = playbackState.currentSpeed;
    lastFrame = 0;
    lastAppliedCadenceTick = -1;
  }

  function load({ name, points }, options = {}) {
    const {
      playbackState = null,
      fitOnLoad = true,
      resumePlayback = false,
    } = options;

    if (!points?.length || points.length < 2) {
      throw new Error('Route must contain at least 2 points');
    }

    routeReadyForPlayback = false;
    playbackPreparer.disarm();
    ui.onPlaybackDisarmed?.();
    nextPrepareFitOnLoad = fitOnLoad;
    terrainDegraded = false;

    routeName = name;
    route = new RoutePath(points);
    route.resetTraveledCache?.();
    renderer.resetRouteState();
    const trackStyle = getTrackStyle?.();
    if (trackStyle) renderer.applyTrackStyle?.(trackStyle);
    setPlaybackState(playbackState || { animTime: 0, animDistance: 0 });
    const cameraDoc = getCameraDocument?.();
    cameraState = createCameraRuntimeState(
      playbackState?.cameraPreset || cameraDoc?.preset || cameraState.preset,
      cameraDoc ? rigToShot(cameraDoc.rig, cameraDoc.preset) : cameraState.shot,
    );

    const frameState = getCurrentFrameState();
    lastAppliedCadenceTick = frameState?.playback?.cadenceTick ?? -1;
    const bounds = renderer.getBounds(route);

    whenMapReady(() => {
      requestAnimationFrame(() => {
        try {
          addLayers();
          renderer.cancelOverview();
          map.resize();
          terrainStream?.pinRouteCorridor(bounds);
          finalizeRouteLoad(name, frameState);
          schedulePrepare('load', { resumePlayback, fitOnLoad });
        } catch (err) {
          route = null;
          routeName = '';
          playbackPreparer.disarm();
          ui.onRouteLoadFailed?.(err);
        }
      });
    });
  }

  function refreshProgressLayers(frameState = getCurrentFrameState(), requestRepaint = true) {
    try {
      renderer.renderFrameState(frameState, { requestRepaint });
    } catch (err) {
      console.error('Layer update error:', err);
    }
  }

  function refreshLayers(frameState = getCurrentFrameState()) {
    renderer.refreshRouteFrameState(frameState);
  }

  function updateHUD(frameState = getCurrentFrameState()) {
    if (!frameState) return;
    ui.update({
      name: frameState.routeName,
      distance: frameState.hud.distance,
      total: frameState.hud.total,
      speed: frameState.hud.speed,
      elevation: frameState.hud.elevation,
      progress: frameState.hud.progress,
      duration: frameState.hud.duration,
      timeline: frameState.hud.timeline,
      chartProgress: frameState.hud.chartProgress,
    });
  }

  function getDuration() {
    return getPlaybackDuration(route, speedMul);
  }

  function playInternal() {
    if (!route || !playbackPreparer.isArmed()) return;
    renderer.cancelOverview();

    const dur = getDuration();
    if (animTime >= dur || animDistance >= route.totalDistance) {
      setPlaybackState({ animTime: 0, animDistance: 0 });
      const frameState = getCurrentFrameState();
      syncMapState(frameState);
      updateHUD(frameState);
    }
    if (!cameraState.shot) {
      cameraState = createCameraRuntimeState(
        cameraState.preset,
        defaultShotForMode(cameraState.preset),
      );
    }

    lastAppliedCadenceTick = -1;
    resetPlaybackCameraGuards();
    syncTerrainHealth(getCurrentFrameState());
    playing = true;
    lastFrame = 0;
    ui.setPlaying(true);
    cancelPlaybackFrame();
    clearTerrainBarrier();
    skipNextTerrainBarrier = true;
    renderFrameId = requestAnimationFrame(frame);
  }

  function frame(ts) {
    if (!playing || !route) return;

    try {
      if (!lastFrame) lastFrame = ts;
      const dt = Math.min((ts - lastFrame) / 1000, 0.05);
      lastFrame = ts;
      probe.markLoop(dt);

      const nextFrame = samplePlaybackFrame(
        route,
        { animTime, animDistance },
        dt,
        speedMul,
      );
      animTime = nextFrame.animTime;
      animDistance = nextFrame.animDistance;
      currentSpeed = nextFrame.currentSpeed;

      const frameState = createFrameState({
        routeName,
        route,
        playbackFrame: nextFrame,
      });
      probe.markFrameResolved();

      // Playback: always advance visuals + camera together — never gate on tile barriers.
      refreshProgressLayers(frameState, true);
      lastAppliedCadenceTick = frameState.playback.cadenceTick;

      const cameraStart = performance.now();
      const terrainInfo = applyCameraFrame(
        map,
        resolveCameraFrameForView(frameState),
        { continuous: true },
      );
      probe.markCameraCost(performance.now() - cameraStart);
      probe.markTerrain(terrainInfo);
      probe.markApplied();

      if (terrainStream?.isTerrainEnabled()) {
        if (terrainStream.isViewReady(getRouteElevationHint())) {
          terrainStream.markReady();
        } else {
          terrainStream.markStall();
        }
      }

      updateHUD(frameState);

      if (nextFrame.done) {
        if (loopPlayback) {
          setPlaybackState({ animTime: 0, animDistance: 0 });
          route?.resetTraveledCache?.();
          renderer.resetProgressCache?.();
          resetPlaybackCameraGuards();
          const loopFrame = getCurrentFrameState();
          syncMapState(loopFrame);
          applyCameraFrame(map, resolveCameraFrameForView(loopFrame), { continuous: false });
          updateHUD(loopFrame);
          lastFrame = 0;
          renderFrameId = requestAnimationFrame(frame);
          return;
        }
        playing = false;
        stopCameraAnimation(map);
        ui.setPlaying(false);
        probe.flush('playback-finished');
        return;
      }

      renderFrameId = requestAnimationFrame(frame);
    } catch (err) {
      console.error('Animation error:', err);
      playing = false;
      stopCameraAnimation(map);
      ui.setPlaying(false);
      probe.flush('playback-error');
    }
  }

  function cancelPlaybackFrame() {
    if (renderFrameId != null) {
      cancelAnimationFrame(renderFrameId);
      renderFrameId = null;
    }
  }

  return {
    addLayers,
    load,
    play() {
      if (!route || !playbackPreparer.isArmed()) return;
      playInternal();
    },
    pause() {
      playing = false;
      lastFrame = 0;
      currentSpeed = 0;
      cancelPlaybackFrame();
      clearTerrainBarrier();
      stopCameraAnimation(map);
      ui.setPlaying(false);
      if (route) updateHUD(getCurrentFrameState(getCurrentSample(), 0));
    },
    reset() {
      this.pause();
      route?.resetTraveledCache?.();
      setPlaybackState({ animTime: 0, animDistance: 0 });
      const frameState = getCurrentFrameState();
      syncMapState(frameState);
      applyCameraFrame(
        map,
        resolveCameraFrameForView(frameState),
        { continuous: false },
      );
      updateHUD(frameState);
      schedulePrepare('reset', { fitOnLoad: false });
    },
    scrubPreview(value) {
      if (!route) return;
      applyTimelinePosition(value);
    },
    scrubCommit(value) {
      if (!route) return;
      applyTimelinePosition(value);
      schedulePrepare('scrub', { fitOnLoad: false });
    },
    scrub(value) {
      this.scrubCommit(value);
    },
    setSpeed(mul) {
      speedMul = mul;
      if (!playing && route) {
        animTime = clampTime(animTime);
        updateHUD(getCurrentFrameState(getCurrentSample(), 0));
      }
    },
    setLoopEnabled(enabled) {
      loopPlayback = Boolean(enabled);
    },
    isLoopEnabled: () => loopPlayback,
    hasPlaybackLayers: () => renderer.hasPlaybackLayers?.(),
    setCameraPreset(mode) {
      cameraState = createCameraRuntimeState(mode, defaultShotForMode(mode));
      if (route) {
        const frameState = getCurrentFrameState();
        refreshProgressLayers(frameState);
        lastAppliedCadenceTick = frameState?.playback?.cadenceTick ?? -1;
        applyCameraFrame(
          map,
          resolveCameraFrameForView(frameState),
          { continuous: false },
        );
        schedulePrepare('camera', { fitOnLoad: false });
      }
      ui.onShotChanged?.(cameraState.shot, cameraState.preset);
    },
    setCameraFromDocument(cameraDoc) {
      if (!cameraDoc) return;
      const shot = rigToShot(cameraDoc.rig, cameraDoc.preset);
      cameraState = createCameraRuntimeState(cameraDoc.preset, shot);
      resetPlaybackCameraGuards();
      if (route) {
        const frameState = getCurrentFrameState();
        applyCameraFrame(map, { ...resolveCameraFrame(frameState, cameraState), shot }, { continuous: false });
        refreshProgressLayers(frameState, true);
      }
      ui.onShotChanged?.(cameraState.shot, cameraState.preset);
    },
    applyTrackStyle(style = {}) {
      renderer.applyTrackStyle?.(style);
      if (route) refreshLayers(getCurrentFrameState());
    },
    setTerrainExaggeration(value) {
      try {
        if (map.getTerrain()) {
          map.setTerrain({ ...map.getTerrain(), exaggeration: value });
        }
      } catch {
        // ignore
      }
    },
    setTerrainEnabled(enabled) {
      terrainDegraded = !enabled;
      if (enabled && mapViewMode === '3d') {
        addTerrainSource(map);
        enableTerrain(map);
        if (cameraState?.terrainGuard) {
          cameraState.terrainGuard.enabled = true;
          cameraState.terrainGuard.smoothedElevationM = null;
          cameraState.terrainGuard.lastEnvelopeM = null;
        }
      } else {
        disableTerrain(map);
        if (cameraState?.terrainGuard) {
          cameraState.terrainGuard.enabled = false;
          cameraState.terrainGuard.smoothedElevationM = null;
          cameraState.terrainGuard.lastEnvelopeM = null;
        }
      }
      if (route) {
        const frameState = getCurrentFrameState();
        applyCameraFrame(map, resolveCameraFrameForView(frameState), { continuous: false });
        refreshProgressLayers(frameState, true);
      }
    },
    capturePlaybackShot() {
      if (!route) return null;
      const sample = getCurrentSample();
      cameraState = createCameraRuntimeState(
        cameraState.preset,
        captureShot(map, sample, cameraState.preset),
      );
      ui.onShotChanged?.(cameraState.shot, cameraState.preset);
      return cameraState.shot;
    },
    resetPlaybackShot() {
      cameraState = createCameraRuntimeState(
        cameraState.preset,
        defaultShotForMode(cameraState.preset),
      );
      if (route) {
        const frameState = getCurrentFrameState();
        applyCameraFrame(
          map,
          resolveCameraFrameForView(frameState),
          { continuous: false },
        );
      }
      ui.onShotChanged?.(cameraState.shot, cameraState.preset);
      return cameraState.shot;
    },
    getPlaybackState() {
      return {
        playing,
        animTime,
        animDistance,
        shot: cameraState.shot,
        cameraPreset: cameraState.preset,
      };
    },
    clear() {
      this.pause();
      playbackPreparer.disarm();
      renderer.cancelOverview();
      terrainStream?.clearRouteCorridor();
      route = null;
      routeName = '';
      routeReadyForPlayback = false;
      setPlaybackState({ animTime: 0, animDistance: 0 });
      cameraState = createCameraRuntimeState('follow', null);
      renderer.resetRouteState();
      clearMapData();
      ui.onRouteCleared?.();
    },
    isPlaying: () => playing,
    isPlaybackArmed: () => playbackPreparer.isArmed(),
    isPreparingPlayback: () => playbackPreparer.isPreparing(),
    getPrepareError: () => playbackPreparer.getLastError(),
    getPreparePlan: () => playbackPreparer.getLastPlan(),
    reprepare(reason = 'reprepare') {
      if (!route) return;
      schedulePrepare(reason);
    },
    isPlaybackDegraded: () => playbackPreparer.isDegraded(),
    getRoute: () => (routeReadyForPlayback ? route : null),
    setMapViewMode,
  };
}
