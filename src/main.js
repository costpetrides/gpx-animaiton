/**
 * GPX 3D Renderer — cinematic trail film entrypoint.
 * Open GPX → build terrain once → preview → export MP4.
 */
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { parseGPX, formatDistance, formatDuration, formatElevation } from './gpx.js';
import {
  DEFAULT_MAP_STYLE_ID,
  resolveMapStyle,
} from './mapStyles.js';
import {
  applyPersistentBasemapPresentation,
  buildPersistentOpenFreeMapStyle,
} from './persistentMapStyle.js';
import {
  applyCinematicPresentation,
  attributionControlOptions,
  collapseMapAttribution,
  enforceBuildingsHidden,
  syncMap3dGestures,
} from './mapLibreShared.js';
import { createAnimator } from './animator.js';
import { initShell } from './ui/shell.js';
import { createStudioStore } from './project/store.js';
import {
  selectCameraConfig,
  selectPlaybackConfig,
  selectRouteDocument,
  selectTimelineConfig,
} from './project/selectors.js';
import { createTerrainStreamCoordinator } from './terrain/streamCoordinator.js';
import { fingerprintRoutePoints } from './gpxFingerprint.js';
import { normalizePrepareQuality } from './playback/preparePlans.js';
import { createStudioKernel } from './studio/kernel.js';
import { createDefaultCameraRig } from './camera/rig.js';
import { createElevationChart } from './elevationChart.js';
import {
  getFollowBehindLevelForStopIndex,
  getFollowBehindStopIndexForLevel,
  getSuggestedFollowBehindZoomLevel,
  normalizeTrailReplayCameraMode,
} from './camera/trailReplayPlan.js';

const store = createStudioStore();
let lastLoadedRouteFingerprint = null;
let kernel = null;
let userScrubbing = false;
let cinematicStyleApplied = false;

function getProjectState() {
  return store.getState();
}

function getRouteDocument() {
  return selectRouteDocument(getProjectState());
}

const persistentBasemap = await buildPersistentOpenFreeMapStyle(
  DEFAULT_MAP_STYLE_ID,
);

const map = new maplibregl.Map({
  container: 'map',
  style: persistentBasemap.style,
  center: [34.01, 35.05],
  zoom: 13,
  pitch: 0,
  bearing: 0,
  antialias: true,
  maxPitch: 85,
  pitchWithRotate: true,
  touchPitch: false,
  attributionControl: attributionControlOptions(),
});
collapseMapAttribution(map);

const terrainStream = createTerrainStreamCoordinator(map);
const navControl = new maplibregl.NavigationControl({ visualizePitch: true });
map.addControl(navControl, 'top-right');

const gpxInput = document.getElementById('gpx-input');
const dropzone = document.getElementById('dropzone');
const btnPlay = document.getElementById('btn-play');
const btnReset = document.getElementById('btn-skip-start');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnExport = document.getElementById('btn-export-video');
const mapStyleSelect = document.getElementById('map-style-select');
const speedSelect = document.getElementById('speed-select');
const cameraModeSelect = document.getElementById('camera-mode');
const cameraModeHint = document.getElementById('camera-mode-hint');
const cameraStability = document.getElementById('camera-stability');
const cameraStabilityLabel = document.getElementById('camera-stability-label');
const cameraStabilityGroup = document.getElementById('camera-stability-group');
const followDistanceGroup = document.getElementById('follow-distance-group');
const followDistance = document.getElementById('follow-distance');
const followDistanceLabel = document.getElementById('follow-distance-label');
const filmStats = document.getElementById('film-stats');
const elevationProfileWrap = document.getElementById('elevation-profile-wrap');
const elevationCanvas = document.getElementById('elevation-profile');
const timeline = document.getElementById('timeline');
const iconPlay = btnPlay.querySelector('.icon-play');
const iconPause = btnPlay.querySelector('.icon-pause');

function openGpxPicker() {
  gpxInput.value = '';
  if (typeof gpxInput.showPicker === 'function') {
    try {
      gpxInput.showPicker();
      return;
    } catch {
      // fall through
    }
  }
  gpxInput.click();
}

function setNavVisible(visible) {
  const el = map.getContainer()?.querySelector('.maplibregl-ctrl-top-right');
  if (el) el.classList.toggle('is-hidden-film', !visible);
  map.getContainer()?.classList.toggle('is-playing', !visible);
}

function ensureCinematicMapLook() {
  const activeBasemapStyleId = resolveMapStyle(
    getProjectState().document.project.map?.styleKey,
  ).id;
  applyCinematicPresentation(map, {
    hideLabels: true,
    muteRoads: true,
    activeBasemapStyleId,
  });
  cinematicStyleApplied = true;
}

function scheduleCinematicMapLook() {
  // Prepare / terrain steps can reassert style layout after we first hide labels.
  ensureCinematicMapLook();
  window.setTimeout(() => ensureCinematicMapLook(), 400);
  window.setTimeout(() => ensureCinematicMapLook(), 1200);
}

const shell = initShell({
  openGpx: openGpxPicker,
  togglePlay: () => (animator.isPlaying() ? animator.pause() : animator.play()),
  reset: () => animator.reset(),
  exportVideo: () => {
    if (!getRouteDocument()) {
      shell.setStatus('Open a GPX before exporting');
      return;
    }
    shell.setStatus('Exporting MP4…');
    kernel?.emit('export-video', { module: 'export' });
  },
  onResize: () => map.resize(),
});

let elevationChart = null;

const animator = createAnimator(map, {
  setPlaying(on) {
    store.dispatch({ type: 'runtime/set-playback', payload: { playing: on } });
    iconPlay.classList.toggle('hidden', on);
    iconPause.classList.toggle('hidden', !on);
    // Keep map chrome hidden whenever a film is loaded.
    if (getRouteDocument()) setNavVisible(false);
  },
  onRouteLoaded(name) {
    const routeDoc = getRouteDocument();
    shell.hideEmptyState();
    setNavVisible(false);
    shell.setStatus(`Creating film for ${routeDoc?.name || name}…`);
    shell.showPreparing('Creating your film', 'Building terrain and cinematic camera…');
    setPlaybackControlsEnabled(false);
    renderProjectState();
    shell.setTimes(0, animator.getDuration?.() || 0);
    elevationChart?.setData(animator.getElevationProfile?.() || []);
    filmStats?.classList.remove('hidden');
    elevationProfileWrap?.classList.remove('hidden');
  },
  onPlaybackDisarmed() {
    if (getRouteDocument() && animator.isPreparingPlayback?.()) {
      shell.setStatus('Creating your film…');
      shell.showPreparing('Creating your film', 'Preparing the scene…');
      setPlaybackControlsEnabled(false);
    }
    renderProjectState();
  },
  onPreparePhase(phase, detail = {}) {
    const labels = {
      layers: 'Drawing the trail…',
      camera: 'Framing the camera…',
      terrain_mode: 'Sculpting the landscape…',
      tiles_initial: 'Loading the world…',
      corridor: 'Warming the route…',
      settle: 'Finishing the scene…',
      armed: 'Ready',
      failed: 'Could not build the scene',
    };
    const msg = labels[phase] || detail?.message || 'Creating your film…';
    shell.setStatus(msg);
    shell.updatePreparing(detail?.message || msg);
  },
  onPlaybackArmed(_reason, degraded) {
    shell.hidePreparing();
    shell.setStatus(degraded ? 'Preview ready — press Play' : 'Preview ready — press Play');
    setPlaybackControlsEnabled(true);
    setNavVisible(false);
    requestAnimationFrame(() => scheduleCinematicMapLook());
    renderProjectState();
    const dur = animator.getDuration?.() || 0;
    const state = animator.getPlaybackState?.();
    shell.setTimes(state?.animTime || 0, dur);
  },
  onPrepareFailed(error, { recovered } = {}) {
    if (recovered) {
      shell.hidePreparing();
      shell.setStatus('Preview ready — press Play');
      setPlaybackControlsEnabled(true);
      scheduleCinematicMapLook();
    } else {
      shell.updatePreparing(`Failed: ${error}`);
      shell.setStatus(`Failed: ${error}`);
      setPlaybackControlsEnabled(false);
    }
    renderProjectState();
  },
  onPrepareSettled() {
    shell.hidePreparing();
    updateExportEnabled();
    scheduleCinematicMapLook();
  },
  onRouteCleared() {
    shell.hidePreparing();
    elevationChart?.setData([]);
    filmStats?.classList.add('hidden');
    elevationProfileWrap?.classList.add('hidden');
    setPlaybackControlsEnabled(false);
    updateExportEnabled();
    cinematicStyleApplied = false;
    setNavVisible(true);
    renderProjectState();
  },
  onRouteLoadFailed(err) {
    shell.setStatus(`Load failed: ${err?.message || err}`);
    animator.clear();
    store.dispatch({ type: 'project/reset' });
    gpxInput.value = '';
    lastLoadedRouteFingerprint = null;
    clearProjectUI();
  },
  onShotChanged() {
    renderProjectState();
  },
  update(hud) {
    // Animator is the single source of truth for clock + timeline.
    if (!userScrubbing && Number.isFinite(hud.timeline)) {
      timeline.value = String(Math.round(hud.timeline));
    }
    const current = Number.isFinite(hud.currentTimeSec) ? hud.currentTimeSec : 0;
    const total = Number.isFinite(hud.durationSec)
      ? hud.durationSec
      : (animator.getDuration?.() || 0);
    shell.setTimes(current, total);
    const progress = Number.isFinite(hud.progress) ? hud.progress / 100 : 0;
    elevationChart?.setProgress(progress);

    const setLive = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value ?? '—';
    };
    setLive('live-distance', hud.distance);
    setLive('live-gain', hud.elevationGain);
    setLive('live-elevation', hud.elevation);
    setLive('live-time', hud.recordedTime || '00:00');

    const routeDoc = getRouteDocument();
    if (routeDoc && Number.isFinite(total)) {
      const metaDur = document.getElementById('meta-duration');
      if (metaDur) metaDur.textContent = formatDuration(total);
    }
  },
}, {
  terrainStream,
  getPrepareQuality: () => normalizePrepareQuality(selectPlaybackConfig(getProjectState()).prepareQuality),
  getCameraDocument: () => {
    const state = getProjectState();
    return {
      ...selectCameraConfig(state),
      timelineKeyframes: selectTimelineConfig(state).keyframes,
    };
  },
  getTrackStyle: () => getProjectState().document.project.track,
  getFollowBehindZoomLevel: () => (
    selectPlaybackConfig(getProjectState()).followBehindZoomLevel ?? 33
  ),
  getCameraMode: () => (
    selectPlaybackConfig(getProjectState()).cameraMode || 'cinematic'
  ),
  getCameraStability: () => (
    selectPlaybackConfig(getProjectState()).cameraStability ?? 0.3
  ),
});

if (elevationCanvas) {
  elevationChart = createElevationChart(elevationCanvas, {
    onScrub(progress) {
      userScrubbing = true;
      if (animator.isPlaying()) animator.pause();
      animator.scrubPreview(progress * 1000);
    },
    onScrubEnd(progress) {
      animator.scrubCommit(progress * 1000);
      userScrubbing = false;
    },
  });
}

function setPlaybackControlsEnabled(enabled) {
  btnPlay.disabled = !enabled;
  btnReset.disabled = !enabled;
  timeline.disabled = !enabled;
}

function updateExportEnabled() {
  const hasRoute = Boolean(getRouteDocument());
  const preparing = animator.isPreparingPlayback?.();
  btnExport.disabled = !hasRoute || preparing;
}

function clearProjectUI() {
  shell.hidePreparing();
  shell.showEmptyState();
  shell.setStatus('Drop a GPX to create a cinematic trail film');
  shell.updateProject({
    name: '—',
    length: '—',
    gain: '—',
    duration: '—',
  });
  shell.setTimes(0, 0);
  timeline.value = 0;
  setPlaybackControlsEnabled(false);
  updateExportEnabled();
  setNavVisible(true);
}

function renderProjectState() {
  const routeDoc = getRouteDocument();
  const playback = selectPlaybackConfig(getProjectState());
  const hasRoute = Boolean(routeDoc);

  if (hasRoute) {
    shell.hideEmptyState();
    const filmLength = animator.getDuration?.() || 0;
    shell.updateProject({
      name: routeDoc.name || 'Untitled trail',
      length: formatDistance(routeDoc.stats.totalDistance),
      gain: formatElevation(routeDoc.stats.elevationGain),
      duration: filmLength > 0 ? formatDuration(filmLength) : '—',
    });
  } else {
    shell.showEmptyState();
    shell.updateProject({ name: '—', length: '—', gain: '—', duration: '—' });
  }

  const mapStyleKey = resolveMapStyle(
    getProjectState().document.project.map?.styleKey,
  ).id;
  if (mapStyleSelect && mapStyleSelect.value !== mapStyleKey) {
    mapStyleSelect.value = mapStyleKey;
  }

  if (speedSelect && String(playback.speed) !== speedSelect.value) {
    speedSelect.value = String(playback.speed);
  }

  if (followDistance) {
    const stopIndex = getFollowBehindStopIndexForLevel(
      playback.followBehindZoomLevel ?? 33,
    );
    followDistance.value = String(stopIndex);
    if (followDistanceLabel) {
      const labels = ['Far', 'Far+', 'Medium−', 'Medium', 'Medium+', 'Close', 'Close+', 'Very close'];
      followDistanceLabel.textContent = labels[stopIndex] || 'Medium';
    }
  }

  const cameraMode = normalizeTrailReplayCameraMode(playback.cameraMode);
  if (cameraModeSelect && cameraModeSelect.value !== cameraMode) {
    cameraModeSelect.value = cameraMode;
  }

  if (cameraModeHint) {
    const hints = {
      cinematic: 'Smoothest: uses the known route ahead and behind the marker to glide through switchbacks.',
      'follow-behind': 'Classic chase camera: follows route direction with TrailReplay smoothing.',
      follow: 'Simple top-down follow camera with a fixed north-up view.',
      overview: 'Keeps the whole route visible while the route animation progresses.',
    };
    cameraModeHint.textContent = hints[cameraMode];
  }

  if (followDistanceGroup) {
    followDistanceGroup.classList.toggle(
      'hidden',
      cameraMode !== 'follow-behind' && cameraMode !== 'cinematic',
    );
  }

  if (cameraStabilityGroup) {
    cameraStabilityGroup.classList.toggle('hidden', cameraMode === 'overview');
  }

  if (cameraStability) {
    const stability = Number.isFinite(playback.cameraStability)
      ? playback.cameraStability
      : 0.3;
    cameraStability.value = String(stability);
    if (cameraStabilityLabel) {
      cameraStabilityLabel.textContent =
        stability <= 0.2 ? 'Very stable' :
        stability <= 0.4 ? 'Stable' :
        stability <= 0.65 ? 'Balanced' :
        stability <= 0.85 ? 'Reactive' :
        'Very reactive';
    }
  }

  const armed = hasRoute && animator.isPlaybackArmed() && !animator.isPreparingPlayback();
  if (armed || (hasRoute && animator.isPlaybackArmed())) {
    setPlaybackControlsEnabled(true);
  } else if (!hasRoute) {
    setPlaybackControlsEnabled(false);
  }
  updateExportEnabled();
}

function initKernel() {
  kernel = createStudioKernel({
    store,
    animator,
    map,
    shell,
    terrainStream,
    getDuration: () => animator.getDuration?.() || 0,
    renderProjectState,
  });
}

function enableCinematic3d() {
  syncMap3dGestures(map, true);
  animator.setMapViewMode?.('3d');
}

function handleGPX(text, filename = '') {
  try {
    shell.showPreparing('Opening GPX', 'Reading your trail…');
    const parsed = parseGPX(text);
    const fingerprint = fingerprintRoutePoints(parsed.points);
    if (fingerprint && fingerprint === lastLoadedRouteFingerprint) {
      shell.setStatus(`Same route reloaded: ${filename || parsed.name}`);
    }
    lastLoadedRouteFingerprint = fingerprint;
    cinematicStyleApplied = false;

    store.dispatch({
      type: 'project/load-gpx',
      payload: { route: parsed, sourceFile: filename },
    });

    const routeDoc = getRouteDocument();
    const suggestedFollowLevel = getSuggestedFollowBehindZoomLevel({
      totalDistanceMeters: routeDoc?.stats?.totalDistance ?? 0,
      videoDurationSeconds: 30,
      latitudeDeg: parsed.points?.[0]?.lat,
    });
    store.dispatch({
      type: 'project/set-follow-behind-zoom-level',
      payload: { level: suggestedFollowLevel },
    });

    const preset = 'cinematic';
    const rig = createDefaultCameraRig(preset);
    store.dispatch({
      type: 'project/set-camera-config',
      payload: { preset, rig, shot: null },
    });

    animator.load(parsed, { fitOnLoad: true });
    syncMap3dGestures(map, true);
    renderProjectState();
  } catch (err) {
    shell.hidePreparing();
    shell.setStatus(`Error: ${err.message || 'Failed to parse GPX'}`);
    console.error(err);
  }
}

async function loadGpxFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    handleGPX(text, file.name || 'trail.gpx');
  } catch {
    shell.setStatus('Error: Failed to read GPX file');
  }
}

gpxInput.addEventListener('change', () => {
  const file = gpxInput.files?.[0];
  if (file) loadGpxFile(file);
});

btnPlay.addEventListener('click', () => {
  if (animator.isPlaying()) animator.pause();
  else animator.play();
});
btnReset.addEventListener('click', () => animator.reset());
btnFullscreen.addEventListener('click', () => {
  const el = document.getElementById('viewport');
  if (!document.fullscreenElement) el.requestFullscreen?.();
  else document.exitFullscreen?.();
});

timeline.addEventListener('pointerdown', () => {
  userScrubbing = true;
});
timeline.addEventListener('pointerup', () => {
  userScrubbing = false;
});
timeline.addEventListener('pointercancel', () => {
  userScrubbing = false;
});

timeline.addEventListener('input', () => {
  // Capture value BEFORE pause HUD can rewrite the slider.
  const value = Number(timeline.value);
  userScrubbing = true;
  if (animator.isPlaying()) animator.pause();
  animator.scrubPreview(value);
});
timeline.addEventListener('change', () => {
  const value = Number(timeline.value);
  animator.scrubCommit(value);
  userScrubbing = false;
});

mapStyleSelect?.addEventListener('change', () => {
  const nextStyle = resolveMapStyle(mapStyleSelect.value);
  const currentStyle = resolveMapStyle(
    getProjectState().document.project.map?.styleKey,
  );
  if (nextStyle.id === currentStyle.id) return;

  const wasPlaying = animator.isPlaying();
  if (wasPlaying) animator.pause();

  store.dispatch({
    type: 'project/set-map-style',
    payload: { styleKey: nextStyle.id },
  });

  // TrailReplay architecture: the MapLibre style graph never changes.
  // Switch only the OpenFreeMap presentation layers; route/actor/terrain and
  // camera state stay alive throughout the operation.
  applyPersistentBasemapPresentation(
    map,
    persistentBasemap.presentations,
    nextStyle.id,
  );
  enforceBuildingsHidden(map);

  // Reassert film presentation and 3D ordering against the now-visible
  // basemap group. No setStyle(), no route rebuild, no terrain teardown.
  animator.setTerrainEnabled?.(true);
  animator.refreshCamera?.();
  scheduleCinematicMapLook();

  shell.setStatus(
    getRouteDocument()
      ? 'Preview ready — press Play'
      : 'Drop a GPX to create a cinematic trail film',
  );
  renderProjectState();
  updateExportEnabled();
});

speedSelect.addEventListener('change', () => {
  const speed = Number(speedSelect.value) || 1;
  store.dispatch({ type: 'project/set-playback-speed', payload: { speed } });
  animator.setSpeed(speed);
  renderProjectState();
});

cameraModeSelect?.addEventListener('change', () => {
  const mode = normalizeTrailReplayCameraMode(cameraModeSelect.value);
  store.dispatch({
    type: 'project/set-playback-camera-mode',
    payload: { mode },
  });
  animator.refreshCamera?.();
  renderProjectState();
});

cameraStability?.addEventListener('input', () => {
  const value = Math.max(0, Math.min(1, Number(cameraStability.value) || 0));
  store.dispatch({
    type: 'project/set-camera-stability',
    payload: { value },
  });
  animator.refreshCamera?.();
  renderProjectState();
});

followDistance?.addEventListener('input', () => {
  const stopIndex = Number(followDistance.value) || 0;
  const level = getFollowBehindLevelForStopIndex(stopIndex);
  store.dispatch({
    type: 'project/set-follow-behind-zoom-level',
    payload: { level },
  });
  if (followDistanceLabel) {
    const labels = ['Far', 'Far+', 'Medium−', 'Medium', 'Medium+', 'Close', 'Close+', 'Very close'];
    followDistanceLabel.textContent = labels[stopIndex] || 'Medium';
  }
  animator.refreshCamera?.();
});

function bindDropTarget(el) {
  if (!el) return;
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone?.classList.add('dragover');
  });
  el.addEventListener('dragleave', () => dropzone?.classList.remove('dragover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone?.classList.remove('dragover');
    const file = [...(e.dataTransfer?.files || [])].find((f) =>
      /\.gpx$/i.test(f.name) || f.type.includes('gpx') || f.type.includes('xml'),
    );
    if (file) loadGpxFile(file);
    else shell.setStatus('Please drop a .gpx file');
  });
}
bindDropTarget(document.getElementById('viewport-canvas'));
bindDropTarget(dropzone);

store.subscribe(() => renderProjectState());

map.on('load', () => {
  initKernel();
  enableCinematic3d();
  shell.hideLoading();
  shell.setStatus('Drop a GPX to create a cinematic trail film');
  clearProjectUI();
  map.resize();
});

map.once('idle', () => {
  if (getRouteDocument()) scheduleCinematicMapLook();
});

window.setTimeout(() => shell.hideLoading(), 4000);
window.addEventListener('resize', () => map.resize());

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('gpxDebug')) {
  window.__gpxStudio = {
    loadGpxText: (text, filename = 'debug.gpx') => handleGPX(text, filename),
    getState: () => store.getState(),
    dispatch: (action) => store.dispatch(action),
    get animator() { return animator; },
    get kernel() { return kernel; },
    map,
  };
}
