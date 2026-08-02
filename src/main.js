/**
 * GPX 3D Renderer — cinematic trail film entrypoint.
 * Open GPX → build terrain once → preview → export MP4.
 */
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { parseGPX, formatDistance, formatDuration, formatElevation } from './gpx.js';
import { DEFAULT_MAP_STYLE_ID, getMapStyleUrl } from './mapStyles.js';
import {
  applyCinematicPresentation,
  attributionControlOptions,
  collapseMapAttribution,
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

const map = new maplibregl.Map({
  container: 'map',
  style: getMapStyleUrl(DEFAULT_MAP_STYLE_ID),
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
const speedSelect = document.getElementById('speed-select');
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
  applyCinematicPresentation(map, { hideLabels: true, muteRoads: true });
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
});

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

  if (speedSelect && String(playback.speed) !== speedSelect.value) {
    speedSelect.value = String(playback.speed);
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

speedSelect.addEventListener('change', () => {
  const speed = Number(speedSelect.value) || 1;
  store.dispatch({ type: 'project/set-playback-speed', payload: { speed } });
  animator.setSpeed(speed);
  renderProjectState();
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
