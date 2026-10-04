/**
 * Host-agnostic MapLibre + cinematic trail renderer mount.
 *
 * Used by:
 *   - standalone desktop/web studio (via main.js)
 *   - Ryodo website GPX Studio
 *
 * Export boundary is Blob-first: exportVideo() returns { blob, filename, mimeType, ... }
 * and never downloads or uploads. Hosts call downloadBlob() themselves if needed.
 *
 * No AWS / Firebase / S3 knowledge.
 */

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { createAnimator } from './animator.js';
import { createDefaultCameraRig } from './camera/rig.js';
import {
  attributionControlOptions,
  collapseMapAttribution,
  syncMap3dGestures,
} from './mapLibreShared.js';
import { DEFAULT_MAP_STYLE_ID } from './mapStyles.js';
import {
  applyPersistentBasemapPresentation,
  buildPersistentOpenFreeMapStyle,
} from './persistentMapStyle.js';
import { createTerrainStreamCoordinator } from './terrain/streamCoordinator.js';
import { normalizePrepareQuality } from './playback/preparePlans.js';
import { createReplayTileWarmup } from './playback/tileWarmup.js';
import {
  createVideoExporter,
  getExportResolution,
  normalizeExportAspectRatio,
  normalizeExportFps,
  normalizeExportQuality,
} from './export/videoExporter.js';
import {
  createDefaultAnimationConfig,
  normalizeAnimationConfig,
} from './host/animationConfig.js';

/** Reuse OpenFreeMap style merge across mounts (cold-start win). */
let cachedPersistentBasemapPromise = null;

function getCachedPersistentBasemap() {
  if (!cachedPersistentBasemapPromise) {
    cachedPersistentBasemapPromise = buildPersistentOpenFreeMapStyle(
      DEFAULT_MAP_STYLE_ID,
    ).catch((err) => {
      cachedPersistentBasemapPromise = null;
      throw err;
    });
  }
  return cachedPersistentBasemapPromise;
}

function sanitizeFilenameBase(value, fallback = 'trail-animation') {
  return (
    String(value || fallback)
      .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 80) || fallback
  );
}

/**
 * Mount the shared trail renderer into a DOM container.
 *
 * @param {{
 *   container: HTMLElement,
 *   route?: { name: string, points: object[] } | null,
 *   initialConfig?: object,
 *   initialPhotos?: object[],
 *   initialVisibleStats?: string[],
 *   prepareQuality?: string,
 *   enableTileWarmup?: boolean,
 *   showNavigationControl?: boolean,
 *   onHud?: (hud: object) => void,
 *   onStatus?: (status: string) => void,
 *   onArmed?: () => void,
 *   onError?: (err: Error) => void,
 *   onPlayingChange?: (playing: boolean) => void,
 *   createAnimatorUi?: (hooks: object) => object,
 *   getCameraDocument?: () => object,
 *   getPrepareQuality?: () => string,
 *   getTrackStyle?: () => object,
 *   getCameraMode?: () => string,
 *   getCameraStability?: () => number,
 *   getFollowBehindZoomLevel?: () => number,
 *   mapOptions?: object,
 * }} options
 */
export async function mountTrailRenderer(options = {}) {
  const {
    container,
    route: initialRoute = null,
    initialConfig,
    initialPhotos = [],
    initialVisibleStats = ['altitude', 'distance', 'speed'],
    prepareQuality,
    enableTileWarmup = true,
    showNavigationControl = false,
    onHud,
    onStatus,
    onArmed,
    onError,
    onPlayingChange,
    createAnimatorUi = null,
    getCameraDocument: getCameraDocumentOverride = null,
    getPrepareQuality: getPrepareQualityOverride = null,
    getTrackStyle: getTrackStyleOverride = null,
    getCameraMode: getCameraModeOverride = null,
    getCameraStability: getCameraStabilityOverride = null,
    getFollowBehindZoomLevel: getFollowBehindZoomLevelOverride = null,
    mapOptions = null,
  } = options;

  if (!container) throw new Error('Map container required');

  let disposed = false;
  let map = null;
  let animator = null;
  let terrainStream = null;
  let tileWarmup = null;
  let resizeObserver = null;
  let exporter = null;
  let liveRoute = initialRoute;
  let livePhotos = Array.isArray(initialPhotos) ? [...initialPhotos] : [];
  let liveVisibleStats = Array.isArray(initialVisibleStats)
    ? [...initialVisibleStats]
    : ['altitude', 'distance', 'speed'];

  const liveConfig = normalizeAnimationConfig(
    initialConfig || createDefaultAnimationConfig(),
  );
  if (prepareQuality) {
    liveConfig.playback.prepareQuality = normalizePrepareQuality(prepareQuality);
  }

  const cameraDocument = {
    preset: 'cinematic',
    mode: liveConfig.camera.mode || 'cinematic',
    rig: createDefaultCameraRig('cinematic'),
    shot: null,
  };

  const persistentBasemap = await getCachedPersistentBasemap();
  if (disposed) {
    return { dispose() {} };
  }

  const startLng = liveRoute?.points?.[0]?.lng;
  const startLat = liveRoute?.points?.[0]?.lat;

  map = new maplibregl.Map({
    container,
    style: persistentBasemap.style,
    center: [
      Number.isFinite(startLng) ? startLng : 34.01,
      Number.isFinite(startLat) ? startLat : 35.05,
    ],
    zoom: 13,
    pitch: liveRoute ? 60 : 0,
    bearing: 0,
    antialias: true,
    maxPitch: 85,
    pitchWithRotate: true,
    touchPitch: false,
    attributionControl: attributionControlOptions(),
    ...(mapOptions && typeof mapOptions === 'object' ? mapOptions : {}),
  });
  collapseMapAttribution(map);
  syncMap3dGestures(map, true);

  if (showNavigationControl) {
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      'top-right',
    );
  }

  terrainStream = createTerrainStreamCoordinator(map);

  await new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onMapError = (event) => {
      cleanup();
      reject(event?.error || new Error('Map failed to load'));
    };
    function cleanup() {
      map.off('load', onLoad);
      map.off('error', onMapError);
    }
    map.once('load', onLoad);
    map.once('error', onMapError);
  });

  if (disposed) {
    map.remove();
    return { dispose() {} };
  }

  try {
    applyPersistentBasemapPresentation(
      map,
      persistentBasemap.presentations,
      liveConfig.map.styleKey || DEFAULT_MAP_STYLE_ID,
    );
  } catch {
    // basemap polish is optional
  }

  if (enableTileWarmup) {
    tileWarmup = createReplayTileWarmup({
      visibleMap: map,
      persistentStyle: persistentBasemap.style,
      presentations: persistentBasemap.presentations,
      initialBasemapStyleId: liveConfig.map.styleKey || DEFAULT_MAP_STYLE_ID,
      getCameraMode: () => liveConfig.camera.mode || 'cinematic',
      getCameraStability: () => liveConfig.camera.stability ?? 0.5,
      getFollowBehindZoomLevel: () => liveConfig.camera.followBehindZoomLevel ?? 33,
      getPlaybackSpeed: () => liveConfig.playback.speed ?? 1,
      getDurationSec: () => animator?.getDuration?.() || 30,
    });
  }

  const defaultAnimatorUi = {
    setPlaying(on) {
      onPlayingChange?.(Boolean(on));
    },
    update(hud) {
      onHud?.(hud || {});
    },
    onRouteLoaded(name) {
      onStatus?.(`Loaded ${name || 'route'}`);
    },
    onRouteLoadFailed(err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    },
    onPreparePhase(phase) {
      onStatus?.(`Preparing: ${phase}`);
    },
    onPlaybackArmed() {
      onStatus?.('Ready');
      onArmed?.();
    },
    onPrepareFailed(error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    },
    onPlaybackDisarmed() {
      onStatus?.('Preparing playback…');
    },
  };

  const animatorUi =
    typeof createAnimatorUi === 'function'
      ? {
          ...defaultAnimatorUi,
          ...createAnimatorUi({
            onHud,
            onStatus,
            onArmed,
            onError,
            onPlayingChange,
          }),
        }
      : defaultAnimatorUi;

  animator = createAnimator(map, animatorUi, {
    terrainStream,
    getPrepareQuality:
      getPrepareQualityOverride ||
      (() =>
        normalizePrepareQuality(liveConfig.playback.prepareQuality || 'fast')),
    getCameraDocument:
      getCameraDocumentOverride ||
      (() => ({
        ...cameraDocument,
        mode: liveConfig.camera.mode,
      })),
    getCameraMode: getCameraModeOverride || (() => liveConfig.camera.mode),
    getCameraStability:
      getCameraStabilityOverride || (() => liveConfig.camera.stability),
    getFollowBehindZoomLevel:
      getFollowBehindZoomLevelOverride ||
      (() => liveConfig.camera.followBehindZoomLevel),
    getTrackStyle: getTrackStyleOverride || (() => ({ ...liveConfig.track })),
    tileWarmup,
  });

  resizeObserver = new ResizeObserver(() => {
    try {
      map?.resize();
    } catch {
      // ignore
    }
  });
  resizeObserver.observe(container);

  function applyLiveConfigToEngine({ reprepare = false } = {}) {
    if (!animator) return;
    try {
      cameraDocument.mode = liveConfig.camera.mode;
      animator.setSpeed?.(liveConfig.playback.speed);
      animator.applyTrackStyle?.(liveConfig.track);
      animator.setTerrainEnabled?.(liveConfig.map.terrainEnabled);
      animator.setTerrainExaggeration?.(liveConfig.map.terrain.exaggeration);
      animator.refreshCamera?.();
      if (reprepare) animator.reprepare?.('config');
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  function loadRoute(route, { fitOnLoad = true } = {}) {
    if (!route?.points?.length) {
      throw new Error('Route must contain at least 2 points');
    }
    liveRoute = route;
    animator.load(
      {
        name: route.name,
        points: route.points,
      },
      { fitOnLoad },
    );
    applyLiveConfigToEngine();
    return liveRoute;
  }

  if (liveRoute?.points?.length >= 2) {
    try {
      loadRoute(liveRoute, { fitOnLoad: true });
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  return {
    /** @deprecated advanced hosts only — prefer controller methods */
    map,
    /** @deprecated advanced hosts only — prefer controller methods */
    getAnimator: () => animator,
    getPersistentBasemap: () => persistentBasemap,
    getTerrainStream: () => terrainStream,
    getTileWarmup: () => tileWarmup,

    play() {
      animator?.play?.();
    },
    pause() {
      animator?.pause?.();
    },
    reset() {
      animator?.reset?.();
    },
    scrub(progress01) {
      animator?.scrub?.(progress01);
    },
    isArmed() {
      return Boolean(animator?.isPlaybackArmed?.());
    },
    getDuration() {
      return animator?.getDuration?.() || 0;
    },
    getRoute() {
      return animator?.getRoute?.() || null;
    },
    loadRoute,
    clearRoute() {
      liveRoute = null;
      animator?.clear?.();
    },
    getConfig() {
      return normalizeAnimationConfig(liveConfig);
    },
    updateConfig(partial = {}, opts = {}) {
      const next = normalizeAnimationConfig({
        ...liveConfig,
        ...partial,
        camera: { ...liveConfig.camera, ...(partial.camera || {}) },
        track: { ...liveConfig.track, ...(partial.track || {}) },
        map: {
          ...liveConfig.map,
          ...(partial.map || {}),
          terrain: {
            ...liveConfig.map.terrain,
            ...((partial.map && partial.map.terrain) || {}),
          },
        },
        playback: { ...liveConfig.playback, ...(partial.playback || {}) },
      });

      const styleChanged = next.map.styleKey !== liveConfig.map.styleKey;
      Object.assign(liveConfig, next);
      liveConfig.camera = next.camera;
      liveConfig.track = next.track;
      liveConfig.map = next.map;
      liveConfig.playback = next.playback;

      if (styleChanged && map && persistentBasemap.presentations) {
        try {
          applyPersistentBasemapPresentation(
            map,
            persistentBasemap.presentations,
            liveConfig.map.styleKey,
          );
          tileWarmup?.setBasemapStyle?.(liveConfig.map.styleKey);
          applyLiveConfigToEngine({ reprepare: true });
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        return liveConfig;
      }

      applyLiveConfigToEngine({ reprepare: Boolean(opts.reprepare) });
      return normalizeAnimationConfig(liveConfig);
    },
    setConfig(config) {
      return this.updateConfig(normalizeAnimationConfig(config), { reprepare: true });
    },
    setPhotos(photos = []) {
      livePhotos = Array.isArray(photos) ? [...photos] : [];
    },
    setVisibleStats(stats = []) {
      liveVisibleStats =
        Array.isArray(stats) && stats.length
          ? [...stats]
          : ['altitude', 'distance', 'speed'];
    },

    /**
     * Render MP4/WebM in-browser. Returns the finished Blob — does NOT download
     * and does NOT upload. Host decides Download vs Save to Cloud.
     */
    async exportVideo(options = {}) {
      if (!map || !animator) throw new Error('Renderer is not ready');
      if (!animator.getRoute?.()) throw new Error('No route loaded');
      if (!animator.isPlaybackArmed?.()) {
        throw new Error('Playback is still preparing — try again in a moment');
      }

      if (!exporter) {
        exporter = createVideoExporter({
          map,
          animator,
          getDuration: () => animator.getDuration?.() || 0,
          getPhotos: () => livePhotos,
          getVisibleStats: () => liveVisibleStats.slice(0, 3),
          onProgress: (p) => {
            const pct = Math.round((p.frame / p.totalFrames) * 100);
            onStatus?.(`Exporting ${pct}%`);
          },
          onStatus: (msg) => onStatus?.(msg),
        });
      }

      const filenameBase = sanitizeFilenameBase(
        options.filenameBase || liveRoute?.name || 'trail-animation',
      );
      const quality = normalizeExportQuality(options.quality || 'medium');
      const aspectRatio = normalizeExportAspectRatio(options.aspectRatio || '16:9');
      const fps = normalizeExportFps(options.fps || 30);
      const format = options.format === 'webm' ? 'webm' : 'mp4';
      const resolution = getExportResolution(quality, aspectRatio);

      const result = await exporter.exportVideo({
        quality,
        aspectRatio,
        fps,
        format,
        filenameBase,
      });

      onStatus?.('Export complete');
      return {
        blob: result.blob,
        filename: result.filename,
        mimeType: result.mimeType || (format === 'webm' ? 'video/webm' : 'video/mp4'),
        width: resolution.width,
        height: resolution.height,
        format,
      };
    },

    abortExport() {
      exporter?.abort?.();
    },

    getExportResolution(quality, aspectRatio) {
      return getExportResolution(quality, aspectRatio);
    },

    resize() {
      map?.resize();
    },

    dispose() {
      disposed = true;
      try {
        exporter?.abort?.();
      } catch {
        // ignore
      }
      exporter = null;
      try {
        resizeObserver?.disconnect();
      } catch {
        // ignore
      }
      resizeObserver = null;
      try {
        tileWarmup?.destroy?.();
      } catch {
        // ignore
      }
      tileWarmup = null;
      try {
        animator?.pause?.();
        animator?.clear?.();
      } catch {
        // ignore
      }
      animator = null;
      terrainStream = null;
      try {
        map?.remove();
      } catch {
        // ignore
      }
      map = null;
    },
  };
}

export {
  createDefaultAnimationConfig,
  normalizeAnimationConfig,
} from './host/animationConfig.js';
