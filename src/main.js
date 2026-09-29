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
import { createReplayTileWarmup } from './playback/tileWarmup.js';
import {
  createPhotoRecord,
  readPhotoMetadata,
  resolvePhotoPlacement,
} from './media/photoPlacement.js';
import { createPhotoController } from './media/photoController.js';
import { createStudioKernel } from './studio/kernel.js';
import { createDefaultCameraRig } from './camera/rig.js';
import { createElevationChart } from './elevationChart.js';
import { getExportResolution } from './export/videoExporter.js';
import { getCropPreviewMetrics } from './export/crop.js';
import {
  getFollowBehindLevelForStopIndex,
  getFollowBehindStopIndexForLevel,
  getSuggestedFollowBehindZoomLevel,
  normalizeTrailReplayCameraMode,
} from './camera/trailReplayPlan.js';

async function bootstrap() {
const store = createStudioStore();
let lastLoadedRouteFingerprint = null;
let kernel = null;
let userScrubbing = false;
let cinematicStyleApplied = false;
let photoController = null;
let lastPhotoListSignature = '';
let lastSuggestedFollowLevel = null;
let lastSuggestedRouteKey = null;

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
const photoInput = document.getElementById('photo-input');
const btnAddPhotos = document.getElementById('btn-add-photos');
const btnAddPhotosHeader = document.getElementById('btn-add-photos-header');
const photoDropzone = document.getElementById('photo-dropzone');
const photoList = document.getElementById('photo-list');
const photosCount = document.getElementById('photos-count');
const editorTabs = [...document.querySelectorAll('[data-editor-tab]')];
const editorPanels = [...document.querySelectorAll('[data-editor-panel]')];
const viewportCanvas = document.getElementById('viewport-canvas');
const dropzone = document.getElementById('dropzone');
const btnPlay = document.getElementById('btn-play');
const btnReset = document.getElementById('btn-skip-start');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnExport = document.getElementById('btn-export-video');
const exportSettingsModal = document.getElementById('export-settings-modal');
const btnCloseExportSettings = document.getElementById('btn-close-export-settings');
const btnGenerateExport = document.getElementById('btn-generate-export');
const exportResolutionSummary = document.getElementById('export-resolution-summary');
const exportRatioButtons = [...document.querySelectorAll('[data-export-ratio]')];
const exportQualityButtons = [...document.querySelectorAll('[data-export-quality]')];
const exportFpsButtons = [...document.querySelectorAll('[data-export-fps]')];
const exportCropPreview = document.getElementById('export-crop-preview');
const exportCropRatioLabel = document.getElementById('export-crop-label-ratio');
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
const statToggles = [...document.querySelectorAll('[data-stat-toggle]')];
const liveStatItems = [...document.querySelectorAll('[data-live-stat]')];
const elevationProfileWrap = document.getElementById('elevation-profile-wrap');
const elevationCanvas = document.getElementById('elevation-profile');
const timeline = document.getElementById('timeline');
const iconPlay = btnPlay.querySelector('.icon-play');
const iconPause = btnPlay.querySelector('.icon-pause');

function updateExportCropPreview() {
  if (!exportCropPreview || !viewportCanvas) return;
  const config = getExportConfig();
  const ratio = config.aspectRatio || '16:9';
  const width = viewportCanvas.clientWidth;
  const height = viewportCanvas.clientHeight;
  if (!width || !height) return;

  const metrics = getCropPreviewMetrics(width, height, ratio);
  const left = exportCropPreview.querySelector('.export-crop-shade--left');
  const right = exportCropPreview.querySelector('.export-crop-shade--right');
  const top = exportCropPreview.querySelector('.export-crop-shade--top');
  const bottom = exportCropPreview.querySelector('.export-crop-shade--bottom');
  const frame = exportCropPreview.querySelector('.export-crop-frame');

  if (left) Object.assign(left.style, {
    left: '0px',
    top: '0px',
    bottom: '0px',
    width: `${metrics.left}px`,
  });
  if (right) Object.assign(right.style, {
    right: '0px',
    top: '0px',
    bottom: '0px',
    width: `${metrics.right}px`,
  });
  if (top) Object.assign(top.style, {
    left: '0px',
    right: '0px',
    top: '0px',
    height: `${metrics.top}px`,
  });
  if (bottom) Object.assign(bottom.style, {
    left: '0px',
    right: '0px',
    bottom: '0px',
    height: `${metrics.bottom}px`,
  });
  if (frame) Object.assign(frame.style, {
    left: `${metrics.frameLeft}px`,
    top: `${metrics.frameTop}px`,
    width: `${metrics.frameWidth}px`,
    height: `${metrics.frameHeight}px`,
  });
  if (exportCropRatioLabel) exportCropRatioLabel.textContent = ratio;
}

const DEFAULT_VISIBLE_STATS = ['altitude', 'distance', 'speed'];
const TIME_DEPENDENT_STATS = new Set(['time', 'speed', 'pace']);

function getConfiguredVisibleStats() {
  const configured = getProjectState().document.project.overlays?.visibleStats;
  const source = Array.isArray(configured) ? configured : DEFAULT_VISIBLE_STATS;
  const unique = [];
  source.forEach((id) => {
    if (!unique.includes(id)) unique.push(id);
  });
  return unique.slice(0, 3);
}

function getAvailableVisibleStats() {
  const routeDoc = getRouteDocument();
  const hasRecordedTime = Boolean(routeDoc?.stats?.hasTime);
  return getConfiguredVisibleStats()
    .filter((id) => !TIME_DEPENDENT_STATS.has(id) || hasRecordedTime)
    .slice(0, 3);
}

function splitStatDisplay(value) {
  const text = String(value ?? '—').trim();
  if (!text || text === '—') return { value: '—', unit: '' };
  const match = text.match(/^(.+?)\s+(km\/h|km|m|\/km)$/i);
  if (!match) return { value: text, unit: '' };
  return { value: match[1], unit: match[2] };
}

function setLiveStat(id, rawValue) {
  const parsed = splitStatDisplay(rawValue);
  const valueEl = document.getElementById(`live-${id}`);
  const unitEl = document.getElementById(`live-${id}-unit`);
  if (valueEl) valueEl.textContent = parsed.value;
  if (unitEl) unitEl.textContent = parsed.unit;
}

function syncStatsUI() {
  const routeDoc = getRouteDocument();
  const hasRoute = Boolean(routeDoc);
  const hasRecordedTime = Boolean(routeDoc?.stats?.hasTime);
  const configured = new Set(getConfiguredVisibleStats());
  const available = new Set(getAvailableVisibleStats());

  const configuredOrder = getConfiguredVisibleStats();
  const atLimit = configuredOrder.length >= 3;

  statToggles.forEach((input) => {
    const id = input.dataset.statToggle;
    const unavailable = TIME_DEPENDENT_STATS.has(id) && hasRoute && !hasRecordedTime;
    const checked = configured.has(id);
    input.checked = checked;
    input.disabled = !hasRoute || unavailable || (!checked && atLimit);
    input.closest('.stats-choice')?.classList.toggle('is-unavailable', unavailable || (!checked && atLimit));
  });

  const visibleOrder = getAvailableVisibleStats();
  liveStatItems.forEach((item) => {
    item.classList.toggle('hidden', !available.has(item.dataset.liveStat));
  });

  if (filmStats) {
    // Grid placement follows selection order. A newly enabled metric is
    // appended to the next free slot in the fixed 3 × 2 layout.
    visibleOrder.forEach((id) => {
      const item = liveStatItems.find((candidate) => candidate.dataset.liveStat === id);
      if (item) filmStats.appendChild(item);
    });
    liveStatItems
      .filter((item) => !available.has(item.dataset.liveStat))
      .forEach((item) => filmStats.appendChild(item));

    filmStats.classList.toggle('hidden', !hasRoute || available.size === 0);
    filmStats.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
  }
}

statToggles.forEach((input) => {
  input.addEventListener('change', () => {
    const id = input.dataset.statToggle;
    const next = getConfiguredVisibleStats().filter((value) => value !== id);

    if (input.checked) {
      if (next.length >= 3) {
        input.checked = false;
        syncStatsUI();
        return;
      }
      next.push(id);
    }

    store.dispatch({
      type: 'project/set-overlay-config',
      payload: { visibleStats: next },
    });
    syncStatsUI();
  });
});

function getExportConfig() {
  return getProjectState().document.project.export || {};
}

function syncExportSettingsUI() {
  const config = getExportConfig();
  const aspectRatio = config.aspectRatio || '16:9';
  const quality = ['low', 'medium', 'high', 'ultra'].includes(config.quality)
    ? config.quality
    : config.quality === 'draft'
      ? 'low'
      : 'medium';
  const fps = [24, 30, 60].includes(Number(config.fps)) ? Number(config.fps) : 30;
  const resolution = getExportResolution(quality, aspectRatio);

  exportRatioButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.exportRatio === aspectRatio);
  });
  exportQualityButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.exportQuality === quality);
  });
  exportFpsButtons.forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.exportFps) === fps);
  });
  if (exportResolutionSummary) {
    exportResolutionSummary.textContent = `${resolution.width} × ${resolution.height}`;
  }
}

function setExportConfig(patch) {
  const current = getExportConfig();
  const next = { ...current, ...patch };
  const quality = ['low', 'medium', 'high', 'ultra'].includes(next.quality)
    ? next.quality
    : 'medium';
  const aspectRatio = ['16:9', '1:1', '9:16'].includes(next.aspectRatio)
    ? next.aspectRatio
    : '16:9';
  const fps = [24, 30, 60].includes(Number(next.fps)) ? Number(next.fps) : 30;
  const resolution = getExportResolution(quality, aspectRatio);

  store.dispatch({
    type: 'project/set-export-config',
    payload: {
      config: {
        ...patch,
        quality,
        aspectRatio,
        fps,
        resolution,
      },
    },
  });
  syncExportSettingsUI();
  if (exportCropPreview && !exportCropPreview.classList.contains('hidden')) {
    updateExportCropPreview();
  }
}

function openExportSettings() {
  if (!getRouteDocument()) return;
  syncExportSettingsUI();
  updateExportCropPreview();
  exportCropPreview?.classList.remove('hidden');
  exportSettingsModal?.classList.remove('hidden');
}

function closeExportSettings() {
  exportSettingsModal?.classList.add('hidden');
  exportCropPreview?.classList.add('hidden');
}

function setEditorTab(tabId) {
  editorTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.editorTab === tabId);
  });
  editorPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.editorPanel === tabId);
  });
}

editorTabs.forEach((tab) => {
  tab.addEventListener('click', () => setEditorTab(tab.dataset.editorTab));
});

btnExport?.addEventListener('click', openExportSettings);
btnCloseExportSettings?.addEventListener('click', closeExportSettings);
exportSettingsModal?.addEventListener('click', (event) => {
  if (event.target === exportSettingsModal) closeExportSettings();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !exportSettingsModal?.classList.contains('hidden')) {
    closeExportSettings();
  }
});

exportRatioButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setExportConfig({ aspectRatio: button.dataset.exportRatio });
  });
});
exportQualityButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setExportConfig({ quality: button.dataset.exportQuality });
  });
});
exportFpsButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setExportConfig({ fps: Number(button.dataset.exportFps) });
  });
});

btnGenerateExport?.addEventListener('click', () => {
  if (!getRouteDocument()) return;
  closeExportSettings();
  shell.setStatus('Exporting MP4…');
  kernel?.emit('export-video', { module: 'export' });
});

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
    // TrailReplay keeps the selected basemap's own road contrast intact.
    // Muting road layers to 0.15 made Positron/Outdoor look washed during film.
    muteRoads: false,
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
let animator = null;

const tileWarmup = createReplayTileWarmup({
  visibleMap: map,
  persistentStyle: persistentBasemap.style,
  presentations: persistentBasemap.presentations,
  initialBasemapStyleId: DEFAULT_MAP_STYLE_ID,
  getCameraMode: () => (
    selectPlaybackConfig(getProjectState()).cameraMode || 'cinematic'
  ),
  getCameraStability: () => (
    selectPlaybackConfig(getProjectState()).cameraStability ?? 0.5
  ),
  getFollowBehindZoomLevel: () => (
    selectPlaybackConfig(getProjectState()).followBehindZoomLevel ?? 33
  ),
  getPlaybackSpeed: () => (
    selectPlaybackConfig(getProjectState()).speed ?? 1
  ),
  getDurationSec: () => animator?.getDuration?.() || 30,
});

animator = createAnimator(map, {
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
    shell.showPreparing('Preparing your film', 'Loading map detail and terrain…');
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
      corridor_prefetch: 'Warming nearby map detail…',
      opening_warmup: 'Warming the opening views…',
      full_route_prefetch: 'Warming the full route…',
      corridor: 'Warming nearby map detail…',
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
    photoController?.onPlaybackProgress?.(progress, Boolean(hud.playing));

    setLiveStat('distance', hud.distance);
    setLiveStat('gain', hud.elevationGain);
    setLiveStat('elevation', hud.elevation);
    setLiveStat('time', hud.recordedTime || '00:00');
    setLiveStat('speed', hud.recordedSpeed || '—');
    setLiveStat('pace', hud.pace || '—');

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
  tileWarmup,
});

photoController = createPhotoController({
  map,
  store,
  getRoute: () => animator?.getRoute?.(),
  getAnimator: () => animator,
  shell,
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

function getProjectPhotos() {
  return getProjectState().document.project.media?.photos || [];
}

function photoPlacementLabel(photo) {
  if (photo.placementSource === 'pointIndex') return 'Route point';
  if (photo.placementSource === 'routeDistance') return 'Route distance';
  if (photo.placementSource === 'gps') return 'GPS';
  if (photo.placementSource === 'timestamp') return 'Capture time';
  if (photo.placementSource === 'manual') return 'Manual';
  return 'Needs placement';
}

function renderPhotoList({ force = false } = {}) {
  const photos = getProjectPhotos();
  if (photosCount) photosCount.textContent = String(photos.length);
  if (!photoList) return;

  const signature = photos
    .map((photo) => [
      photo.id,
      photo.originalFileName,
      photo.progress ?? 'pending',
      photo.placementSource,
      photo.displayDurationMs,
      photo.url,
    ].join(':'))
    .join('|');

  if (!force && signature === lastPhotoListSignature) return;
  lastPhotoListSignature = signature;
  photoList.replaceChildren();

  photos.forEach((photo) => {
    const row = document.createElement('div');
    const placed = Number.isFinite(photo.progress);
    row.className = `photo-row${placed ? '' : ' is-unplaced'}`;
    row.draggable = true;
    row.dataset.photoId = photo.id;
    row.title = placed
      ? 'Drag onto the map to move this photo'
      : 'Drag onto the map to place this photo';
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-gpx-photo-id', photo.id);
      event.dataTransfer?.setData('text/plain', photo.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
      viewportCanvas?.classList.add('photo-drop-active');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      viewportCanvas?.classList.remove('photo-drop-active');
    });

    const thumb = document.createElement('img');
    thumb.className = 'photo-thumb';
    thumb.src = photo.url || '';
    thumb.alt = '';
    row.appendChild(thumb);

    const main = document.createElement('div');
    main.className = 'photo-row-main';

    const name = document.createElement('div');
    name.className = 'photo-row-name';
    name.textContent = photo.originalFileName || 'Photo';
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'photo-row-meta';
    meta.textContent = Number.isFinite(photo.progress)
      ? `${photoPlacementLabel(photo)} · ${Math.round(photo.progress * 100)}% of route`
      : 'Unplaced · drag onto route';
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'photo-row-actions';

    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'photo-action';
    preview.textContent = 'Preview';
    preview.addEventListener('click', () => photoController?.previewPhoto?.(photo.id));
    actions.appendChild(preview);

    const place = document.createElement('button');
    place.type = 'button';
    place.className = 'photo-action is-primary';
    place.textContent = Number.isFinite(photo.progress) ? 'Move' : 'Place';
    place.addEventListener('click', () => photoController?.setManualPlacement?.(photo.id));
    actions.appendChild(place);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'photo-action is-danger';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      if (photo.url?.startsWith?.('blob:')) URL.revokeObjectURL(photo.url);
      store.dispatch({ type: 'project/remove-photo', payload: { id: photo.id } });
      photoController?.syncMarkers?.();
    });
    actions.appendChild(remove);

    main.appendChild(actions);
    row.appendChild(main);
    photoList.appendChild(row);
  });
}

function makePhotoId() {
  if (globalThis.crypto?.randomUUID) return `photo-${crypto.randomUUID()}`;
  return `photo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function addPhotoFiles(files) {
  const route = animator?.getRoute?.();
  if (!route) {
    shell.setStatus('Wait for the route preview to finish preparing before adding photos');
    return;
  }

  const imageFiles = Array.from(files || []).filter((file) =>
    file.type?.startsWith?.('image/')
  );
  if (!imageFiles.length) return;

  shell.setStatus(`Reading ${imageFiles.length} photo${imageFiles.length === 1 ? '' : 's'}…`);
  let unresolved = 0;

  for (const file of imageFiles) {
    const metadata = await readPhotoMetadata(file);
    const placement = resolvePhotoPlacement(route, metadata);
    const url = URL.createObjectURL(file);
    const photo = createPhotoRecord({
      id: makePhotoId(),
      file,
      url,
      metadata,
      placement,
    });
    if (!placement) unresolved += 1;
    store.dispatch({ type: 'project/add-photo', payload: { photo } });
  }

  photoController?.syncMarkers?.();
  renderPhotoList({ force: true });

  if (unresolved > 0) {
    shell.setStatus(
      `${imageFiles.length} photo${imageFiles.length === 1 ? '' : 's'} added · ${unresolved} need manual placement`,
    );
  } else {
    shell.setStatus(
      `${imageFiles.length} photo${imageFiles.length === 1 ? '' : 's'} placed on the route`,
    );
  }
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
  if (btnAddPhotos) btnAddPhotos.disabled = !hasRoute;
  if (btnAddPhotosHeader) btnAddPhotosHeader.disabled = !hasRoute;
  photoDropzone?.classList.toggle('is-disabled', !hasRoute);
  renderPhotoList();
  syncStatsUI();

  if (hasRoute) {
    shell.hideEmptyState();
    const routeFilmLength = animator.getDuration?.() || 0;
    const photoHoldSeconds = getProjectPhotos()
      .filter((photo) => Number.isFinite(photo.progress))
      .reduce((sum, photo) => sum + Math.max(500, photo.displayDurationMs || 3000) / 1000, 0);
    const filmLength = routeFilmLength + photoHoldSeconds;
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
      : 0.5;
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
  if (exportSettingsModal && !exportSettingsModal.classList.contains('hidden')) {
    syncExportSettingsUI();
  }
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

function applyTrailReplaySuggestedDistance(parsed) {
  const points = Array.isArray(parsed?.points) ? parsed.points : [];
  if (!points.length) return;

  const routeDoc = getRouteDocument();
  const totalDistanceMeters = routeDoc?.stats?.totalDistance ?? 0;
  const videoDurationSeconds = animator.getDuration?.() || 30;
  if (!(totalDistanceMeters > 0) || !(videoDurationSeconds > 0)) return;

  const middlePoint = points[Math.floor(points.length / 2)];
  const latitudeDeg = middlePoint?.lat;
  if (!Number.isFinite(latitudeDeg)) return;

  const routeKey = `${points.length}:${Math.round(totalDistanceMeters)}`;
  const currentLevel = selectPlaybackConfig(getProjectState()).followBehindZoomLevel ?? 33;
  const isNewRoute = lastSuggestedRouteKey !== routeKey;

  // Exact TrailReplay ownership rule:
  // new route -> suggest;
  // same route -> only re-suggest while current value still equals last suggestion.
  const canApply =
    isNewRoute ||
    lastSuggestedFollowLevel == null ||
    currentLevel === lastSuggestedFollowLevel;

  if (!canApply) return;

  const level = getSuggestedFollowBehindZoomLevel({
    totalDistanceMeters,
    videoDurationSeconds,
    latitudeDeg,
  });

  lastSuggestedRouteKey = routeKey;
  lastSuggestedFollowLevel = level;

  if (level === currentLevel) return;

  store.dispatch({
    type: 'project/set-follow-behind-zoom-level',
    payload: { level },
  });
}

function handleGPX(text, filename = '') {
  try {
    getProjectPhotos().forEach((photo) => {
      if (photo.url?.startsWith?.('blob:')) URL.revokeObjectURL(photo.url);
    });
    photoController?.resetPlaybackTriggers?.(0);
    lastPhotoListSignature = '';
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

    // Keep Cinematic as this product's default camera mode.
    const preset = 'cinematic';
    const rig = createDefaultCameraRig(preset);
    store.dispatch({
      type: 'project/set-camera-config',
      payload: { preset, rig, shot: null },
    });

    animator.load(parsed, { fitOnLoad: true });
    applyTrailReplaySuggestedDistance(parsed);
    animator.refreshCamera?.();
    photoController?.syncMarkers?.();
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

function openPhotoPicker() {
  if (!getRouteDocument()) return;
  photoInput.value = '';
  photoInput.click();
}

btnAddPhotos?.addEventListener('click', openPhotoPicker);
btnAddPhotosHeader?.addEventListener('click', () => {
  setEditorTab('photos');
  openPhotoPicker();
});
photoDropzone?.addEventListener('click', openPhotoPicker);

photoDropzone?.addEventListener('dragover', (event) => {
  if (!getRouteDocument()) return;
  event.preventDefault();
  photoDropzone.classList.add('dragover');
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
photoDropzone?.addEventListener('dragleave', () => {
  photoDropzone.classList.remove('dragover');
});
photoDropzone?.addEventListener('drop', (event) => {
  event.preventDefault();
  photoDropzone.classList.remove('dragover');
  if (!getRouteDocument()) return;
  const files = [...(event.dataTransfer?.files || [])];
  void addPhotoFiles(files);
});

photoInput?.addEventListener('change', () => {
  void addPhotoFiles(photoInput.files);
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
  tileWarmup.setBasemapStyle(nextStyle.id);

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

viewportCanvas?.addEventListener('dragover', (event) => {
  const photoId =
    event.dataTransfer?.getData('application/x-gpx-photo-id') ||
    event.dataTransfer?.getData('text/plain');
  if (!photoId || !getProjectPhotos().some((photo) => photo.id === photoId)) return;
  event.preventDefault();
  viewportCanvas.classList.add('photo-drop-active');
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
});

viewportCanvas?.addEventListener('dragleave', (event) => {
  if (!viewportCanvas.contains(event.relatedTarget)) {
    viewportCanvas.classList.remove('photo-drop-active');
  }
});

viewportCanvas?.addEventListener('drop', (event) => {
  const photoId =
    event.dataTransfer?.getData('application/x-gpx-photo-id') ||
    event.dataTransfer?.getData('text/plain');
  if (!photoId || !getProjectPhotos().some((photo) => photo.id === photoId)) return;

  event.preventDefault();
  viewportCanvas.classList.remove('photo-drop-active');

  const canvas = map.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const point = [
    event.clientX - rect.left,
    event.clientY - rect.top,
  ];
  const lngLat = map.unproject(point);
  const placed = photoController?.placePhotoAt?.(photoId, lngLat, 'manual');
  if (placed) {
    const photo = getProjectPhotos().find((item) => item.id === photoId);
    shell.setStatus(
      `Placed ${photo?.originalFileName || 'photo'} on the route`,
    );
    setEditorTab('photos');
    renderPhotoList({ force: true });
  }
});

function bindDropTarget(el) {
  if (!el) return;
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone?.classList.add('dragover');
  });
  el.addEventListener('dragleave', () => dropzone?.classList.remove('dragover'));
  el.addEventListener('drop', (e) => {
    const photoId =
      e.dataTransfer?.getData('application/x-gpx-photo-id') ||
      e.dataTransfer?.getData('text/plain');
    if (photoId && getProjectPhotos().some((photo) => photo.id === photoId)) return;

    e.preventDefault();
    dropzone?.classList.remove('dragover');
    const files = [...(e.dataTransfer?.files || [])];
    const file = files.find((f) =>
      /\.gpx$/i.test(f.name) || f.type.includes('gpx') || f.type.includes('xml'),
    );
    if (file) {
      loadGpxFile(file);
      return;
    }
    const imageFiles = files.filter((f) => f.type?.startsWith?.('image/'));
    if (imageFiles.length && getRouteDocument()) {
      setEditorTab('photos');
      void addPhotoFiles(imageFiles);
      return;
    }
    shell.setStatus(getRouteDocument() ? 'Drop photos in Photos, or a GPX to replace the trail' : 'Please drop a .gpx file');
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
  photoController?.syncMarkers?.();
  map.resize();
});

map.once('idle', () => {
  if (getRouteDocument()) scheduleCinematicMapLook();
});

window.setTimeout(() => shell.hideLoading(), 4000);
window.addEventListener('resize', () => {
  map.resize();
  if (exportCropPreview && !exportCropPreview.classList.contains('hidden')) {
    updateExportCropPreview();
  }
});
window.addEventListener('beforeunload', () => {
  tileWarmup.destroy();
  photoController?.destroy?.();
  getProjectPhotos().forEach((photo) => {
    if (photo.url?.startsWith?.('blob:')) URL.revokeObjectURL(photo.url);
  });
});

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
}

bootstrap().catch((error) => {
  console.error('Application startup failed:', error);
  const loading = document.getElementById('loading-screen');
  const status = document.getElementById('status-message');
  if (status) status.textContent = `Startup failed: ${error?.message || error}`;
  if (loading) loading.classList.add('hidden');
});
