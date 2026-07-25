import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { parseGPX, formatDistance } from './gpx.js';
import { DEFAULT_SPEED_MPS } from './playback/engine.js';
import { MAP_STYLES, getStyleConfig } from './mapStyles.js';
import { createAnimator } from './animator.js';
import { createElevationChart } from './elevationChart.js';
import { initShell } from './ui/shell.js';
import { createStudioStore } from './project/store.js';
import {
  selectCameraConfig,
  selectMapConfig,
  selectPlaybackConfig,
  selectProject,
  selectRouteDocument,
  selectRuntimePlayback,
  selectOverlaysConfig,
} from './project/selectors.js';
import { createGpxLoadTrace, fetchAutoGpx } from './debug/gpxLoadTrace.js';
import { createTerrainStreamCoordinator } from './terrain/streamCoordinator.js';
import { fingerprintRoutePoints } from './gpxFingerprint.js';
import { PREPARE_QUALITY_LABELS, normalizePrepareQuality } from './playback/preparePlans.js';
import { normalizeCameraPreset } from './camera.js';
import { createStudioKernel } from './studio/kernel.js';
import {
  initModulePanels,
  syncRigControls,
  syncTrackControls,
  syncTerrainControls,
  syncLayerControls,
  syncExportControls,
  syncOverlayControls,
  renderKeyframeList,
  renderKeyframeMarkers,
} from './ui/modulePanels.js';
import {
  selectTrackConfig,
  selectLayersConfig,
  selectExportConfig,
  selectTimelineConfig,
  selectEditorState,
} from './project/selectors.js';

const urlParams = new URLSearchParams(window.location.search);
const gpxDebug = urlParams.has('gpxDebug');
const gpxTrace = createGpxLoadTrace({ enabled: gpxDebug });
const autoGpxFile = urlParams.get('autoGpx');

const store = createStudioStore();
let totalAnimSec = 0;
let suppressSpeedSync = false;

function getProjectState() {
  return store.getState();
}

function getProject() {
  return selectProject(getProjectState());
}

function getRouteDocument() {
  return selectRouteDocument(getProjectState());
}

/** Playback clock length at 1× — even speed from distance only (ignores GPX pace). */
function getAnimationDuration(routeDoc = getRouteDocument()) {
  if (!routeDoc) return 0;
  return routeDoc.stats.totalDistance / DEFAULT_SPEED_MPS;
}

const map = new maplibregl.Map({
  container: 'map',
  ...getStyleConfig(selectMapConfig(getProjectState()).styleKey),
  center: [34.01, 35.05],
  zoom: 13,
  pitch: 0,
  antialias: true,
});

const terrainStream = createTerrainStreamCoordinator(map);

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

// ── DOM refs ────────────────────────────────────────────────
const gpxInput = document.getElementById('gpx-input');
const dropzone = document.getElementById('dropzone');
const btnPlay = document.getElementById('btn-play');
const btnReset = document.getElementById('btn-skip-start');
const btnFullscreen = document.getElementById('btn-fullscreen');
const speedSlider = document.getElementById('speed-slider');
const speedSelect = document.getElementById('speed-select');
const speedLabel = document.getElementById('speed-label');
const prepareQualitySelect = document.getElementById('prepare-quality-select');
const prepareQualityHint = document.getElementById('prepare-quality-hint');
const timeline = document.getElementById('timeline');
const stylePicker = document.getElementById('style-picker');
const cameraPicker = document.getElementById('camera-picker');
const shotStatus = document.getElementById('shot-status');
const iconPlay = btnPlay.querySelector('.icon-play');
const iconPause = btnPlay.querySelector('.icon-pause');
const mapMode3d = document.getElementById('map-mode-3d');
const mapMode2d = document.getElementById('map-mode-2d');
const chart = createElevationChart(document.getElementById('elevation-chart'), {
  onScrub: (progress) => {
    animator.pause();
    animator.scrubPreview(progress * 1000);
  },
  onScrubEnd: (progress) => {
    animator.scrubCommit(progress * 1000);
  },
});

let mapViewMode = '3d';
let lastLoadedRouteFingerprint = null;
let lastLoadedRouteSource = '';
let pendingDuplicateWarning = false;

const hud = {
  distance: document.getElementById('hud-distance'),
  total: document.getElementById('hud-total'),
  speed: document.getElementById('hud-speed'),
  elevation: document.getElementById('hud-elevation'),
  progress: document.getElementById('hud-progress'),
  duration: document.getElementById('hud-duration'),
};

// ── Shell (layout, menus, status) ─────────────────────────
const shell = initShell({
  openGpx: () => {
    gpxTrace.step('open-click');
    // Allow re-selecting the same GPX file repeatedly.
    gpxInput.value = '';
    if (typeof gpxInput.showPicker === 'function') {
      try {
        gpxInput.showPicker();
        return;
      } catch {
        // showPicker can throw if not in a user-gesture context
      }
    }
    gpxInput.click();
  },
  newProject: () => resetProject(),
  fullscreen: () => toggleFullscreen(),
  togglePlay: () => (animator.isPlaying() ? animator.pause() : animator.play()),
  reset: () => animator.reset(),
  captureShot: () => kernel?.emit('capture-shot', { module: 'camera' }),
  resetShot: () => kernel?.emit('reset-shot', { module: 'camera' }),
  saveProject: () => kernel?.emit('save-project', { module: 'route' }),
  exportProject: () => kernel?.emit('save-project', { module: 'route' }),
  exportVideo: () => kernel?.emit('export-video', { module: 'export' }),
  exportImage: () => {
    if (!animator.getRoute?.()) {
      shell.setStatus('Load a GPX route before exporting an image');
      return;
    }
    map.triggerRepaint?.();
    requestAnimationFrame(() => {
      try {
        const canvas = map.getCanvas();
        canvas.toBlob((blob) => {
          if (!blob) {
            shell.setStatus('Image export failed');
            return;
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${getRouteDocument()?.name || 'gpx-route'}.png`;
          a.click();
          URL.revokeObjectURL(url);
          shell.setStatus('Image exported');
        }, 'image/png');
      } catch (err) {
        shell.setStatus(`Image export failed: ${err.message}`);
      }
    });
  },
  focusModule: (id) => kernel?.setActiveModule(id),
  onAbout: () => shell.setStatus('GPX Animator Studio — MapLibre route animation editor'),
  scrubTo: (pct) => {
    animator.pause();
    animator.scrubCommit(pct * 1000);
  },
  onResize: () => {
    chart.resize();
    map.resize();
  },
});

let lastHudTimeUpdate = 0;

const animator = createAnimator(map, {
  setPlaying(on) {
    store.dispatch({ type: 'runtime/set-playback', payload: { playing: on } });
    iconPlay.classList.toggle('hidden', on);
    iconPause.classList.toggle('hidden', !on);
  },
  onRouteLoaded(name, route) {
    gpxTrace.step('animator-load-done', { name, points: route?.raw?.length ?? 0 });
    gpxTrace.flush('loaded');
    const routeDoc = getRouteDocument();
    totalAnimSec = getAnimationDuration(routeDoc);
    chart.setData(route.raw.map((p) => p.ele));
    shell.hideEmptyState();
    if (pendingDuplicateWarning) {
      shell.setGpxStatus(`Duplicate route content: ${getProject().sourceFile || name}`);
      pendingDuplicateWarning = false;
    } else {
      shell.setGpxStatus(`Loaded: ${routeDoc?.name || name}`);
    }
    shell.setStatus('Preparing playback…');
    shell.showPreparing('Preparing route for playback', 'Building route view…');
    setPlaybackControlsEnabled(false);
    renderProjectState();
    shell.setTimes(0, totalAnimSec);
  },
  onPlaybackDisarmed() {
    const routeDoc = getRouteDocument();
    if (routeDoc) {
      shell.setStatus('Preparing playback…');
      shell.showPreparing('Preparing route for playback', 'Loading map tiles…');
    }
    renderProjectState();
  },
  onPreparePhase(phase, detail = {}) {
    const qualityLabel = PREPARE_QUALITY_LABELS[detail?.plan?.quality] || 'Balanced';
    const phaseMessages = {
      layers: 'Setting up route layers…',
      route_graphics: 'Fitting route overview…',
      playback_camera: 'Positioning camera…',
      terrain_mode: 'Loading 3D terrain…',
      view_tiles: `Loading map tiles (${qualityLabel})…`,
      corridor_prefetch: `Prefetching route corridor (${qualityLabel})…`,
      full_route_prefetch: `Prefetching full route (${qualityLabel})…`,
      first_frame: 'Rendering first frame…',
    };

    if (phase === 'armed') {
      shell.hidePreparing();
      return;
    }

    if (detail?.reason === 'view_mode') {
      const msg = `Preparing ${mapViewMode === '2d' ? '2D' : '3D'} view…`;
      shell.setStatus(msg);
      shell.updatePreparing(msg, 'Preparing route for playback');
      return;
    }

    if (detail?.reason === 'scrub') {
      const msg = `Preparing playback position (${qualityLabel})…`;
      shell.setStatus(msg);
      shell.updatePreparing(msg);
      return;
    }

    const msg = phaseMessages[phase] || 'Preparing playback…';
    shell.setStatus(msg);
    shell.updatePreparing(msg);
  },
  onPlaybackArmed(_reason, isDegraded = false) {
    shell.hidePreparing();
    const plan = animator.getPreparePlan?.();
    const qualityLabel = plan ? PREPARE_QUALITY_LABELS[plan.quality] : '';
    const qualitySuffix = qualityLabel ? ` · ${qualityLabel}` : '';
    shell.setStatus(
      isDegraded
        ? `Ready to play (flat map${qualitySuffix})`
        : `Ready to play${qualitySuffix}`,
    );
    renderProjectState();
  },
  onPrepareSettled() {
    renderProjectState();
  },
  onPrepareFailed(error, { recovered } = {}) {
    if (recovered) {
      shell.hidePreparing();
      shell.setStatus(`Ready to play (recovered: ${error})`);
    } else {
      shell.updatePreparing(`Playback prep failed: ${error}`);
      shell.setStatus(`Playback prep failed: ${error}`);
    }
    renderProjectState();
  },
  onRouteCleared() {
    totalAnimSec = 0;
    shell.hidePreparing();
    setPlaybackControlsEnabled(false);
    renderProjectState();
  },
  onRouteLoadFailed(err) {
    gpxTrace.step('error', { message: err?.message || String(err) });
    shell.setStatus(`Route load failed: ${err?.message || err}`);
    animator.clear();
    store.dispatch({ type: 'project/reset' });
    gpxInput.value = '';
    lastLoadedRouteFingerprint = null;
    lastLoadedRouteSource = '';
    clearProjectUI();
  },
  onShotChanged() {
    renderProjectState();
  },
  update({ distance, total, speed, elevation, progress, duration, timeline: tl, chartProgress }) {
    hud.distance.textContent = distance;
    hud.total.textContent = total;
    hud.speed.textContent = speed;
    hud.elevation.textContent = elevation;
    hud.progress.textContent = progress + '%';
    hud.duration.textContent = duration;
    timeline.value = tl;
    chart.setProgress(chartProgress);
    const now = performance.now();
    if (now - lastHudTimeUpdate > 120) {
      shell.setTimes((tl / 1000) * totalAnimSec, totalAnimSec);
      document.getElementById('stat-avg-speed').textContent = speed;
      lastHudTimeUpdate = now;
    }
    kernel?.registry?.get('overlays')?.updateStatsOverlay?.(
      selectOverlaysConfig(getProjectState()),
      getRouteDocument(),
      { distance, speed, elevation, progress },
    );
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
  getTrackStyle: () => selectTrackConfig(getProjectState()),
});

let kernel;
let modulePanels;

function initStudioKernel() {
  kernel = createStudioKernel({
    store,
    animator,
    map,
    shell,
    terrainStream,
    getDuration: () => getAnimationDuration(),
    renderProjectState,
  });
  modulePanels = initModulePanels(kernel, {
    shell,
    renderProjectState,
    getRouteDocument,
    getState: getProjectState,
    getDuration: () => getAnimationDuration(),
    animator,
  });
  kernel.setActiveModule(selectEditorState(getProjectState()).activeTool || 'route');
  modulePanels.syncModuleUI();
}

function formatDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setPlaybackControlsEnabled(enabled, { timeline: timelineEnabled = enabled } = {}) {
  btnPlay.disabled = !enabled;
  btnPlay.setAttribute('aria-disabled', String(!enabled));
  btnReset.disabled = !enabled;
  btnReset.setAttribute('aria-disabled', String(!enabled));
  timeline.disabled = !timelineEnabled;
  timeline.setAttribute('aria-disabled', String(!timelineEnabled));
  document.getElementById('btn-step-back')?.toggleAttribute('disabled', !enabled);
  document.getElementById('btn-step-fwd')?.toggleAttribute('disabled', !enabled);
  document.getElementById('btn-skip-end')?.toggleAttribute('disabled', !enabled);
  document.getElementById('loop-check')?.toggleAttribute('disabled', !enabled);
}

function setMapViewMode(mode) {
  mapViewMode = mode === '2d' ? '2d' : '3d';
  mapMode3d?.classList.toggle('active', mapViewMode === '3d');
  mapMode2d?.classList.toggle('active', mapViewMode === '2d');
  map.stop?.();
  if (getRouteDocument()) {
    shell.setStatus(`Switching to ${mapViewMode === '2d' ? '2D' : '3D'} view…`);
  }
  animator?.setMapViewMode?.(mapViewMode);
}

function clearProjectUI() {
  chart.setData([]);
  chart.setProgress(0);
  shell.hidePreparing();
  shell.showEmptyState();
  shell.setGpxStatus('No GPX loaded');
  shell.setStatus('Ready');
  shell.updateProject({
    name: '—',
    file: '—',
    length: '—',
    duration: '—',
    points: '—',
  });
  shell.updateWaypoints([]);
  shell.setTimes(0, 0);
  hud.distance.textContent = '—';
  hud.total.textContent = '—';
  hud.speed.textContent = '—';
  hud.elevation.textContent = '—';
  hud.progress.textContent = '0%';
  hud.duration.textContent = '—';
  timeline.value = 0;
  document.getElementById('stat-avg-speed').textContent = '—';
  document.getElementById('stat-max-speed').textContent = '—';
  document.getElementById('stat-distance').textContent = '—';
  document.getElementById('stat-points').textContent = '—';
  document.getElementById('route-name').value = '—';
  setPlaybackControlsEnabled(false);
}

function buildWaypointRows(routeDoc) {
  return routeDoc.stops.map((stop) => ({
    name: stop.name,
    dist: formatDistance(stop.progress * routeDoc.stats.totalDistance),
    ele: stop.point?.ele != null ? Math.round(stop.point.ele) + ' m' : '—',
    pct: stop.progress,
  }));
}

function renderProjectState() {
  const state = getProjectState();
  const project = selectProject(state);
  const routeDoc = selectRouteDocument(state);
  const camera = selectCameraConfig(state);
  const mapConfig = selectMapConfig(state);
  const playback = selectPlaybackConfig(state);
  const runtimePlayback = selectRuntimePlayback(state);
  const track = selectTrackConfig(state);
  const layers = selectLayersConfig(state);
  const exportConfig = selectExportConfig(state);
  const overlays = selectOverlaysConfig(state);
  const timelineConfig = selectTimelineConfig(state);
  const editor = selectEditorState(state);
  const routeReady = !!(routeDoc && animator.getRoute());
  const playbackArmed = animator.isPlaybackArmed();
  const preparing = animator.isPreparingPlayback();
  const playReady = routeReady && playbackArmed && !preparing;
  const timelineReady = routeReady && !preparing;

  if (!routeDoc) {
    clearProjectUI();
  } else {
    setPlaybackControlsEnabled(playReady, { timeline: timelineReady });
    shell.hideEmptyState();
    shell.updateProject({
      name: routeDoc.name,
      file: project.sourceFile || '—',
      length: formatDistance(routeDoc.stats.totalDistance),
      duration: routeDoc.stats.hasTime
        ? formatDuration(routeDoc.stats.duration)
        : formatDuration(getAnimationDuration(routeDoc)),
      points: routeDoc.stats.pointCount.toLocaleString(),
    });
    shell.updateWaypoints(buildWaypointRows(routeDoc));
    document.getElementById('stat-distance').textContent = formatDistance(routeDoc.stats.totalDistance);
    document.getElementById('stat-points').textContent = routeDoc.stats.pointCount.toLocaleString();
  }

  cameraPicker.querySelectorAll('.chip').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.camera === normalizeCameraPreset(camera.preset)),
  );
  stylePicker.querySelectorAll('.chip').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.style === mapConfig.styleKey),
  );

  if (shotStatus) {
    const presetLabel = (() => {
      const p = normalizeCameraPreset(camera.preset);
      return p[0].toUpperCase() + p.slice(1);
    })();
    shotStatus.textContent = camera.shot?.saved
      ? `Playback shot saved (${presetLabel})`
      : `Preset shot: ${presetLabel}`;
  }

  suppressSpeedSync = true;
  speedLabel.textContent = playback.speed + '×';
  if (speedSelect) speedSelect.value = String(playback.speed);
  if (speedSlider) speedSlider.value = String(playback.speed);
  if (prepareQualitySelect) {
    prepareQualitySelect.value = normalizePrepareQuality(playback.prepareQuality);
  }
  if (prepareQualityHint) {
    const q = normalizePrepareQuality(playback.prepareQuality);
    prepareQualityHint.textContent = q === 'fast'
      ? 'Fast: initial view only — quickest preview.'
      : q === 'maximum'
        ? 'Maximum: aggressive corridor and full-route prefetch.'
        : 'Balanced: initial view plus corridor prefetch.';
  }
  suppressSpeedSync = false;

  if (!routeDoc) return;

  const lastAction = state.editor?.lastAction || '';
  if (lastAction.includes('track') || lastAction.includes('load-gpx')) {
    animator.applyTrackStyle?.(track);
  }

  if (lastAction !== 'project/set-camera-rig') {
    syncRigControls(camera, modulePanels?.cameraRigPanel);
  }
  syncTrackControls(track);
  const routeColor = document.getElementById('route-color');
  const trackColor = document.getElementById('track-color');
  if (routeColor && track.color) routeColor.value = track.color;
  if (trackColor && track.color) trackColor.value = track.color;
  syncTerrainControls(mapConfig);
  syncLayerControls(layers);
  syncExportControls(exportConfig);
  syncOverlayControls(overlays);
  kernel?.registry?.get('overlays')?.updateStatsOverlay?.(overlays, routeDoc);
  renderKeyframeList(timelineConfig.keyframes || [], (id) => {
    kernel?.emit('remove-keyframe', { id, module: 'camera' });
    modulePanels?.renderKeyframeMarkers();
  });
  modulePanels?.renderKeyframeMarkers();
  modulePanels?.syncModuleUI();

  const routeLoaded = !!routeDoc;
  document.getElementById('toolbar-export-image')?.toggleAttribute('disabled', !routeLoaded);
  document.getElementById('toolbar-settings')?.toggleAttribute('disabled', !routeLoaded);
  document.querySelector('.tool-btn[title="Export Image"]')?.toggleAttribute('disabled', !routeLoaded);
  document.querySelector('.tool-btn[title="Settings"]')?.toggleAttribute('disabled', !routeLoaded);

  const speedTab = document.querySelector('.btab[data-btab="speed"]');
  if (speedTab) {
    const hasTimedRoute = Boolean(routeDoc?.stats?.hasTime);
    speedTab.toggleAttribute('disabled', !hasTimedRoute);
  }
  document.querySelector('.btab[data-btab="stats"]')?.toggleAttribute('disabled', !routeDoc);

  if (!runtimePlayback.playing && runtimePlayback.speedText !== '—') {
    document.getElementById('stat-avg-speed').textContent = runtimePlayback.speedText;
  }
}

// ── Map init ──────────────────────────────────────────────
function onStyleReady() {
  animator.addLayers();
  animator?.setMapViewMode?.(mapViewMode);
}

map.on('style.load', () => {
  onStyleReady();
  shell.hideLoading();
});

map.on('load', () => {
  onStyleReady();
  shell.hideLoading();
  shell.setStatus('Ready');
  initStudioKernel();
  bootstrapAutoGpx();
});

// Never leave the splash screen up if the map stalls on external tiles.
window.setTimeout(() => shell.hideLoading(), 4000);

map.on('zoom', () => shell.setZoom(map.getZoom()));
map.on('rotate', () => shell.setCompass(map.getBearing()));
map.on('mousemove', (e) => shell.setCoords(e.lngLat.lng, e.lngLat.lat));

// FPS counter
let frames = 0;
let lastFps = performance.now();
function countFps() {
  frames++;
  const now = performance.now();
  if (now - lastFps >= 1000) {
    shell.setFps(frames);
    frames = 0;
    lastFps = now;
  }
  requestAnimationFrame(countFps);
}
countFps();

// ── Style picker ──────────────────────────────────────────
Object.entries(MAP_STYLES).forEach(([key, cfg]) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.textContent = cfg.label;
  btn.dataset.style = key;
  btn.addEventListener('click', () => switchStyle(key));
  stylePicker.appendChild(btn);
});

function switchStyle(key) {
  store.dispatch({ type: 'project/set-map-style', payload: { styleKey: key } });
  const routeDoc = getRouteDocument();
  const playbackState = animator.getPlaybackState();
  const mapViewModeAtStart = mapViewMode;
  animator.pause();
  shell.showPreparing('Switching map style…', 'Reloading map tiles…');
  shell.setStatus('Switching map style…');
  setPlaybackControlsEnabled(false);
  map.once('style.load', () => {
    const finishStyleSwitch = () => {
      if (routeDoc) {
        animator.setMapViewMode?.(mapViewModeAtStart);
        animator.load(
          { name: routeDoc.name, points: routeDoc.points },
          {
            playbackState,
            fitOnLoad: false,
            resumePlayback: playbackState.playing,
          },
        );
      } else {
        animator.addLayers?.();
        renderProjectState();
      }
      setMapViewMode(mapViewModeAtStart);
    };

    requestAnimationFrame(() => {
      animator.addLayers?.();
      let attempts = 0;
      const waitForLayers = () => {
        if (!routeDoc || animator.hasPlaybackLayers?.()) {
          finishStyleSwitch();
          return;
        }
        attempts += 1;
        if (attempts > 120) {
          finishStyleSwitch();
          return;
        }
        requestAnimationFrame(waitForLayers);
      };
      waitForLayers();
    });
  });
  const s = getStyleConfig(key);
  map.setStyle(s.url || s.style);
}

// ── Camera picker ─────────────────────────────────────────
cameraPicker.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    kernel?.emit('set-preset', { preset: btn.dataset.camera, module: 'camera' });
    renderProjectState();
  });
});

document.getElementById('route-color')?.addEventListener('input', (e) => {
  kernel?.emit('set-style', { color: e.target.value, module: 'track' });
});

document.getElementById('overlay-stats')?.addEventListener('change', (e) => {
  kernel?.emit('set-overlay', { config: { stats: e.target.checked }, module: 'overlays' });
});
document.getElementById('overlay-title')?.addEventListener('input', (e) => {
  kernel?.emit('set-overlay', { config: { title: e.target.value }, module: 'overlays' });
});

// Layer visibility handled in modulePanels.js

// ── GPX loading ───────────────────────────────────────────
function handleGPX(text, filename = '', source = 'unknown') {
  try {
    shell.showPreparing('Loading GPX file…', 'Parsing track points…');
    gpxTrace.step('parse-start', { source, filename, bytes: text?.length ?? 0 });
    const parsed = parseGPX(text);
    gpxTrace.step('parse-done', { name: parsed.name, points: parsed.points?.length ?? 0 });

    if (!parsed.points?.length || parsed.points.length < 2) {
      throw new Error('GPX must contain at least 2 track points');
    }

    const fingerprint = fingerprintRoutePoints(parsed.points);
    if (
      lastLoadedRouteFingerprint &&
      fingerprint === lastLoadedRouteFingerprint &&
      filename &&
      filename !== lastLoadedRouteSource
    ) {
      pendingDuplicateWarning = true;
    }
    lastLoadedRouteFingerprint = fingerprint;
    lastLoadedRouteSource = filename;

    store.dispatch({
      type: 'project/load-gpx',
      payload: {
        route: parsed,
        sourceFile: filename,
      },
    });
    gpxTrace.step('store-dispatch', { name: parsed.name });
    gpxTrace.step('animator-load-start');
    animator.load(parsed);
    animator.applyTrackStyle?.(selectTrackConfig(getProjectState()));
    animator.setCameraFromDocument?.(selectCameraConfig(getProjectState()));
  } catch (err) {
    gpxTrace.step('error', { source, message: err.message || String(err) });
    gpxTrace.flush('error');
    shell.hidePreparing();
    store.dispatch({ type: 'project/reset' });
    animator.clear();
    shell.setStatus('Error: ' + (err.message || 'Failed to parse GPX'));
    alert(err.message || 'Failed to parse GPX');
  }
}

function loadGpxFile(file, source = 'picker') {
  if (!file) return;
  gpxTrace.step('file-selected', { source, name: file.name, size: file.size, type: file.type });
  const r = new FileReader();
  r.onerror = () => {
    gpxTrace.step('error', { source, message: 'FileReader failed' });
    shell.setStatus('Error: Failed to read GPX file');
  };
  r.onloadstart = () => gpxTrace.step('read-start', { source, name: file.name });
  r.onload = (ev) => {
    gpxTrace.step('read-done', { source, name: file.name, bytes: ev.target.result?.length ?? 0 });
    handleGPX(ev.target.result, file.name, source);
  };
  r.readAsText(file);
}

function resetProject() {
  animator.clear();
  store.dispatch({ type: 'project/reset' });
  gpxInput.value = '';
  lastLoadedRouteFingerprint = null;
  lastLoadedRouteSource = '';
  pendingDuplicateWarning = false;
}

gpxInput.addEventListener('change', (e) => {
  gpxTrace.step('input-change', { fileCount: e.target.files?.length ?? 0 });
  loadGpxFile(e.target.files[0], 'picker');
});

dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone?.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  gpxTrace.step('drop-received', { fileCount: e.dataTransfer.files?.length ?? 0 });
  loadGpxFile(e.dataTransfer.files[0], 'drop');
});

mapMode3d?.addEventListener('click', () => setMapViewMode('3d'));
mapMode2d?.addEventListener('click', () => setMapViewMode('2d'));

// ── Playback controls ─────────────────────────────────────
btnPlay.addEventListener('click', () => animator.isPlaying() ? animator.pause() : animator.play());
btnReset.addEventListener('click', () => animator.reset());
btnFullscreen?.addEventListener('click', toggleFullscreen);

function setSpeed(val) {
  const speed = parseFloat(val);
  store.dispatch({ type: 'project/set-playback-speed', payload: { speed } });
  animator.setSpeed(speed);
  renderProjectState();
}

speedSlider?.addEventListener('input', () => {
  if (!suppressSpeedSync) setSpeed(speedSlider.value);
});
speedSelect?.addEventListener('change', () => {
  if (!suppressSpeedSync) setSpeed(speedSelect.value);
});

function setPrepareQuality(value) {
  const prepareQuality = normalizePrepareQuality(value);
  store.dispatch({ type: 'project/set-prepare-quality', payload: { prepareQuality } });
  renderProjectState();
  if (getRouteDocument()) {
    shell.showPreparing('Updating prepare quality…', 'Reloading map tiles…');
    animator.reprepare('quality');
  }
}

prepareQualitySelect?.addEventListener('change', () => {
  setPrepareQuality(prepareQualitySelect.value);
});

document.getElementById('loop-check')?.addEventListener('change', (e) => {
  animator.setLoopEnabled?.(e.target.checked);
});

document.getElementById('toolbar-settings')?.addEventListener('click', () => {
  kernel?.setActiveModule('route');
  shell.focusProperties();
  prepareQualitySelect?.focus();
});

timeline.addEventListener('input', () => {
  animator.pause();
  animator.scrubPreview(parseFloat(timeline.value));
});
timeline.addEventListener('change', () => {
  animator.scrubCommit(parseFloat(timeline.value));
});

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.getElementById('viewport-canvas')?.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

// Initial layout sizing
document.documentElement.style.setProperty('--panel-left', '260px');
document.documentElement.style.setProperty('--panel-right', '300px');
document.documentElement.style.setProperty('--panel-bottom', '180px');

store.subscribe((_state, action) => {
  if (action?.type?.startsWith('runtime/')) return;
  renderProjectState();
});

renderProjectState();
setPlaybackControlsEnabled(false);

async function bootstrapAutoGpx() {
  if (!autoGpxFile) return;
  try {
    gpxTrace.step('auto-fetch-start', { file: autoGpxFile });
    const { text, name } = await fetchAutoGpx(autoGpxFile);
    gpxTrace.step('auto-fetch-done', { file: autoGpxFile, bytes: text.length });
    handleGPX(text, name, 'auto-fetch');
  } catch (err) {
    gpxTrace.step('error', { source: 'auto-fetch', message: err.message || String(err) });
    shell.setStatus('Error: ' + (err.message || 'Failed to auto-load GPX'));
  }
}

if (gpxDebug) {
  window.__gpxStudio = {
    loadGpxText: (text, filename = 'debug.gpx') => handleGPX(text, filename, 'debug-api'),
    getLoadTrace: () => gpxTrace.getSteps(),
    getState: () => store.getState(),
    setMapViewMode,
    get animator() { return animator; },
    get kernel() { return kernel; },
    map,
    terrainStream,
  };
}
