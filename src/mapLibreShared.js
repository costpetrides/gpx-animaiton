/**
 * MapLibre helpers adopted from Peak Explorer mapLibreShared logic.
 * Lives only in gpx-animaiton — Peak Explorer is never modified.
 */

import {
  DEFAULT_MAP_STYLE_ID,
  getMapStyle,
  resolveMapStyle,
} from './mapStyles.js';

export function getResolvedStyle(styleId = DEFAULT_MAP_STYLE_ID) {
  const resolvedStyle = resolveMapStyle(styleId);
  return {
    resolvedStyle,
    style: getMapStyle(styleId),
    styleUrl: resolvedStyle.styleUrl || null,
  };
}

/**
 * Run callback once the current style is ready for source/layer mutation.
 * @param {import('maplibre-gl').Map} map
 * @param {() => void} callback
 */
export function whenStyleReady(map, callback) {
  if (!map) return;
  if (map.isStyleLoaded()) {
    callback();
    return;
  }
  map.once('load', callback);
}

/**
 * Apply an OpenFreeMap vector style URL and invoke onReady after overlays
 * can be attached.
 * @param {import('maplibre-gl').Map} map
 * @param {string} styleUrl
 * @param {() => void} onReady
 */
export function setMapStyle(map, styleUrl, onReady) {
  if (!map || !styleUrl) return;

  const handle = () => {
    onReady?.();
  };

  map.once('style.load', handle);
  map.setStyle(styleUrl, { diff: false });
}

/** @deprecated Prefer setMapStyle — same behavior. */
export function setVectorStyle(map, styleUrl, onReady) {
  setMapStyle(map, styleUrl, onReady);
}

export function attributionControlOptions() {
  return {
    compact: true,
  };
}

/**
 * MapLibre's AttributionControl starts compact mode *expanded*.
 * Force the collapsed "i" chip until the user taps it.
 */
export function collapseMapAttribution(map) {
  if (!map) return;

  const apply = () => {
    try {
      const el = map.getContainer?.()?.querySelector?.('.maplibregl-ctrl-attrib');
      if (!el || el.classList.contains('maplibregl-attrib-empty')) return;
      el.classList.add('maplibregl-compact');
      el.classList.remove('maplibregl-compact-show');
      el.setAttribute('open', '');
    } catch {
      // ignore
    }
  };

  apply();
  requestAnimationFrame(apply);
  if (typeof map.once === 'function') {
    map.once('load', apply);
  }
}

/** Mapterhorn Terrarium DEM — open terrain tiles (commercial-safe with attribution). */
export const TERRAIN_SOURCE_ID = 'pe-terrain';
export const HILLSHADE_LAYER_ID = 'pe-hillshade';
export const BUILDINGS_3D_LAYER_ID = 'pe-buildings-3d';

const MAPTERHORN_TILES = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const MAPTERHORN_ATTRIBUTION =
  '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>';

function findFirstSymbolLayerId(map) {
  const layers = map.getStyle()?.layers || [];
  for (const layer of layers) {
    if (layer.type === 'symbol') return layer.id;
  }
  return undefined;
}

function findVectorSourceId(map) {
  const sources = map.getStyle()?.sources || {};
  if (sources.openmaptiles) return 'openmaptiles';
  for (const [id, source] of Object.entries(sources)) {
    if (source?.type === 'vector') return id;
  }
  return null;
}

export function ensureTerrainSource(map) {
  if (!map || map.getSource(TERRAIN_SOURCE_ID)) return;
  map.addSource(TERRAIN_SOURCE_ID, {
    type: 'raster-dem',
    tiles: [MAPTERHORN_TILES],
    tileSize: 512,
    encoding: 'terrarium',
    maxzoom: 14,
    attribution: MAPTERHORN_ATTRIBUTION,
  });
}

function findBuildingFillLayerIds(map) {
  const layers = map.getStyle()?.layers || [];
  return layers
    .filter(
      (layer) =>
        (layer.type === 'fill' || layer.type === 'fill-extrusion') &&
        layer.id !== BUILDINGS_3D_LAYER_ID &&
        layer['source-layer'] === 'building',
    )
    .map((layer) => layer.id);
}

function setStyleBuildingFillsVisible(map, visible) {
  for (const id of findBuildingFillLayerIds(map)) {
    try {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    } catch {
      // Layer may have been removed during a style swap.
    }
  }
}

function ensureHillshade(map) {
  if (map.getLayer(HILLSHADE_LAYER_ID)) {
    map.setLayoutProperty(HILLSHADE_LAYER_ID, 'visibility', 'visible');
    return;
  }
  const beforeId = findFirstSymbolLayerId(map);
  const layer = {
    id: HILLSHADE_LAYER_ID,
    type: 'hillshade',
    source: TERRAIN_SOURCE_ID,
    layout: { visibility: 'visible' },
    paint: {
      'hillshade-exaggeration': 0.55,
      'hillshade-shadow-color': '#0f172a',
      'hillshade-highlight-color': '#f8fafc',
      'hillshade-accent-color': '#64748b',
    },
  };
  if (beforeId) map.addLayer(layer, beforeId);
  else map.addLayer(layer);
}

/**
 * Enable/disable 3D terrain + hillshade + building extrusions on the current
 * basemap. Does not change the map style — call after any style load/switch.
 * @param {import('maplibre-gl').Map} map
 * @param {boolean} enabled
 * @param {{ pitch?: number, bearing?: number, exaggeration?: number, buildings?: boolean, animate?: boolean }} [options]
 */
export function applyMap3dMode(map, enabled, options = {}) {
  if (!map) return;
  try {
    if (!map.isStyleLoaded()) return;
  } catch {
    return;
  }

  const {
    pitch = 58,
    bearing,
    exaggeration = 1.6,
    buildings = true,
    animate = true,
  } = options;

  ensureTerrainSource(map);

  if (enabled) {
    try {
      map.dragRotate?.enable?.();
      map.touchPitch?.enable?.();
      map.setMaxPitch(85);
    } catch {
      // Older MapLibre builds may not expose these helpers the same way.
    }

    ensureHillshade(map);
    map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
    try {
      map.setCenterClampedToGround?.(false);
    } catch {
      // ignore
    }

    const nextBearing =
      Number.isFinite(bearing) ? bearing : (map.getBearing?.() ?? 0);
    // Force a clear pitched view — fitBounds often leaves pitch at 0.
    const nextPitch = Math.max(pitch, 50);

    try {
      map.setPitch(nextPitch);
      if (Number.isFinite(nextBearing)) map.setBearing(nextBearing);
    } catch {
      // fall through to easeTo
    }

    if (animate) {
      map.easeTo({
        pitch: nextPitch,
        bearing: nextBearing,
        duration: 650,
      });
    }

    if (buildings) {
      setStyleBuildingFillsVisible(map, false);
      const vectorSource = findVectorSourceId(map);
      if (vectorSource && !map.getLayer(BUILDINGS_3D_LAYER_ID)) {
        const beforeId = findFirstSymbolLayerId(map);
        const buildingLayer = {
          id: BUILDINGS_3D_LAYER_ID,
          source: vectorSource,
          'source-layer': 'building',
          type: 'fill-extrusion',
          minzoom: 14,
          filter: ['!=', ['get', 'hide_3d'], true],
          paint: {
            'fill-extrusion-color': [
              'interpolate',
              ['linear'],
              ['zoom'],
              14,
              '#a8b4c4',
              16,
              '#8b9aab',
            ],
            'fill-extrusion-opacity': 0.78,
            'fill-extrusion-height': [
              'coalesce',
              ['get', 'render_height'],
              ['get', 'height'],
              8,
            ],
            'fill-extrusion-base': [
              'coalesce',
              ['get', 'render_min_height'],
              ['get', 'min_height'],
              0,
            ],
          },
        };
        if (beforeId) map.addLayer(buildingLayer, beforeId);
        else map.addLayer(buildingLayer);
      }
    } else {
      setStyleBuildingFillsVisible(map, true);
      if (map.getLayer(BUILDINGS_3D_LAYER_ID)) map.removeLayer(BUILDINGS_3D_LAYER_ID);
    }
    return;
  }

  try {
    map.touchPitch?.disable?.();
    map.dragRotate?.disable?.();
    // Do not clamp maxPitch to 0 — style swaps need room to restore 3D pitch.
    map.setPitch(0);
  } catch {
    // ignore
  }

  map.setTerrain(null);
  if (map.getLayer(BUILDINGS_3D_LAYER_ID)) map.removeLayer(BUILDINGS_3D_LAYER_ID);
  if (map.getLayer(HILLSHADE_LAYER_ID)) map.removeLayer(HILLSHADE_LAYER_ID);
  setStyleBuildingFillsVisible(map, true);
  if (animate) {
    map.easeTo({ pitch: 0, bearing: map.getBearing(), duration: 450 });
  }
}

/**
 * Sync rotate / pitch gestures with Peak Explorer 2D/3D behavior.
 * @param {import('maplibre-gl').Map} map
 * @param {boolean} enabled
 */
export function syncMap3dGestures(map, enabled) {
  if (!map) return;
  try {
    map.setMaxPitch(85);
    if (enabled) {
      map.touchPitch?.enable?.();
      map.dragRotate?.enable?.();
    } else {
      map.touchPitch?.disable?.();
      map.dragRotate?.disable?.();
      map.setPitch(0);
    }
  } catch {
    // ignore
  }
}

/**
 * Film-mode map presentation: hide labels / mute roads so the trail dominates.
 */
export function applyCinematicPresentation(map, {
  hideLabels = true,
  muteRoads = true,
} = {}) {
  if (!map) return;
  try {
    if (!map.isStyleLoaded()) return;
  } catch {
    return;
  }

  const layers = map.getStyle()?.layers || [];
  for (const layer of layers) {
    const id = layer.id;
    if (!id || id.startsWith('route') || id.startsWith('marker') || id.startsWith('actor')) {
      continue;
    }
    if (id === HILLSHADE_LAYER_ID || id === BUILDINGS_3D_LAYER_ID) continue;

    try {
      if (hideLabels && layer.type === 'symbol') {
        map.setLayoutProperty(id, 'visibility', 'none');
        continue;
      }

      if (!muteRoads) continue;
      const isRoad =
        /road|street|path|track|bridge|tunnel|motorway|trunk|primary|secondary|tertiary|rail|highway/i.test(id);
      if (!isRoad) continue;
      if (layer.type === 'line') {
        map.setPaintProperty(id, 'line-opacity', 0.15);
      }
    } catch {
      // Layer may not support the property.
    }
  }
}


