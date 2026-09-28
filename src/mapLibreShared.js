/**
 * MapLibre helpers adopted from Peak Explorer mapLibreShared logic.
 * Lives only in gpx-animaiton — Peak Explorer is never modified.
 */

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

// Cinematic baseline: buildings are intentionally disabled globally.
const BUILDINGS_ENABLED = false;

const MAPTERHORN_TILES = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
const MAPTERHORN_ATTRIBUTION =
  '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>';

function findFirstVisibleSymbolLayerId(map) {
  const layers = map.getStyle()?.layers || [];
  for (const layer of layers) {
    if (layer.type !== 'symbol') continue;
    const visibility = layer.layout?.visibility ?? 'visible';
    if (visibility !== 'none') return layer.id;
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

function isBuildingStyleLayer(layer) {
  if (!layer || layer.id === BUILDINGS_3D_LAYER_ID) return false;

  const id = String(layer.id || '').toLowerCase();
  const sourceLayer = String(layer['source-layer'] || '').toLowerCase();

  // OpenFreeMap styles are not guaranteed to use exactly
  // source-layer="building" for every building-related layer. Match both the
  // vector source-layer and common building layer ids so flat fills, outlines,
  // and any style-provided extrusions are all suppressed.
  const buildingSource =
    sourceLayer === 'building' ||
    sourceLayer === 'buildings' ||
    sourceLayer.includes('building');

  const buildingId =
    /(^|[-_ ])buildings?($|[-_ ])/i.test(id) ||
    id.includes('building-') ||
    id.includes('-building');

  return buildingSource || buildingId;
}

function findBuildingLayerIds(map) {
  const layers = map.getStyle()?.layers || [];
  return layers
    .filter((layer) => isBuildingStyleLayer(layer))
    .map((layer) => layer.id);
}

function setStyleBuildingsVisible(map, visible) {
  for (const id of findBuildingLayerIds(map)) {
    try {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    } catch {
      // Layer may have been removed during a style swap.
    }
  }
}

export function enforceBuildingsHidden(map) {
  if (!map) return;
  setStyleBuildingsVisible(map, false);
  try {
    if (map.getLayer(BUILDINGS_3D_LAYER_ID)) {
      map.removeLayer(BUILDINGS_3D_LAYER_ID);
    }
  } catch {
    // Keep film rendering alive even if the style graph is mid-update.
  }
}

function ensureTerrainHillshade(map) {
  const beforeId = findFirstVisibleSymbolLayerId(map);
  const layer = map.getLayer(HILLSHADE_LAYER_ID);

  if (!layer) {
    const hillshade = {
      id: HILLSHADE_LAYER_ID,
      type: 'hillshade',
      source: TERRAIN_SOURCE_ID,
      layout: { visibility: 'visible' },
      paint: {
        // Terrain-first presentation: enough relief to read the landscape,
        // restrained enough to keep OpenFreeMap roads and fills crisp.
        'hillshade-exaggeration': 0.34,
        'hillshade-shadow-color': '#172033',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#6b7280',
      },
    };
    if (beforeId) map.addLayer(hillshade, beforeId);
    else map.addLayer(hillshade);
    return;
  }

  map.setLayoutProperty(HILLSHADE_LAYER_ID, 'visibility', 'visible');
  map.setPaintProperty(HILLSHADE_LAYER_ID, 'hillshade-exaggeration', 0.34);
  try {
    if (beforeId) map.moveLayer(HILLSHADE_LAYER_ID, beforeId);
  } catch {
    // Best-effort ordering while the style graph settles.
  }
}

/**
 * Enable/disable 3D terrain on the current basemap.
 *
 * Terrain-first presentation: preserve the TrailReplay-style 1.5 terrain
 * geometry and add restrained hillshade for depth while retaining basemap detail.
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
    exaggeration = 1.5,
    buildings: buildingsRequested = true,
    animate = true,
  } = options;
  const buildings = BUILDINGS_ENABLED && buildingsRequested;

  ensureTerrainSource(map);

  if (enabled) {
    try {
      map.dragRotate?.enable?.();
      map.touchPitch?.enable?.();
      map.setMaxPitch(85);
    } catch {
      // Older MapLibre builds may not expose these helpers the same way.
    }

    // Terrain-first visual balance (~60% relief / 40% basemap detail).
    // Keep the reference-style 1.5 terrain geometry, but add only a restrained
    // hillshade so relief reads clearly without washing out roads/fills.
    ensureTerrainHillshade(map);
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
      setStyleBuildingsVisible(map, false);
      const vectorSource = findVectorSourceId(map);
      if (vectorSource && !map.getLayer(BUILDINGS_3D_LAYER_ID)) {
        const beforeId = findFirstVisibleSymbolLayerId(map);
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
      // Buildings are off: hide flat basemap building fills too.
      enforceBuildingsHidden(map);
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
  enforceBuildingsHidden(map);
  if (map.getLayer(HILLSHADE_LAYER_ID)) map.removeLayer(HILLSHADE_LAYER_ID);
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
 * Film-mode map presentation: keep road/street names, hide all other map
 * symbols (POIs, bus stops, transit/station icons and labels), and mute the
 * road geometry so the trail remains dominant.
 */
export function applyCinematicPresentation(map, {
  hideLabels = true,
  muteRoads = true,
  activeBasemapStyleId = null,
} = {}) {
  if (!map) return;
  // Film invariant: buildings are always off, regardless of which persistent
  // OpenFreeMap presentation is currently visible.
  enforceBuildingsHidden(map);
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
      const layerBasemapStyleId = layer.metadata?.['ryodo:basemap-style'];
      if (
        activeBasemapStyleId &&
        layerBasemapStyleId &&
        layerBasemapStyleId !== activeBasemapStyleId
      ) {
        map.setLayoutProperty(id, 'visibility', 'none');
        continue;
      }

      if (hideLabels && layer.type === 'symbol') {
        const sourceLayer = String(layer['source-layer'] || '').toLowerCase();
        const normalizedId = String(id).toLowerCase();

        // OpenMapTiles/OpenFreeMap road-name symbols normally come from
        // transportation_name. Keep those, plus defensively named road/street
        // label layers. Everything else (POI/transit/bus/station/place icons
        // and labels) stays hidden.
        const isRoadLabel =
          sourceLayer === 'transportation_name' ||
          sourceLayer.includes('transportation_name') ||
          /road|street|highway|motorway|trunk|primary|secondary|tertiary|residential|service/.test(normalizedId);

        map.setLayoutProperty(id, 'visibility', isRoadLabel ? 'visible' : 'none');
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


