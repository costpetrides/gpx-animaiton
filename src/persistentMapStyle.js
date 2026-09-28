import {
  DEFAULT_MAP_STYLE_ID,
  MAP_STYLE_ORDER,
  resolveMapStyle,
} from './mapStyles.js';

const META_STYLE_KEY = 'ryodo:basemap-style';
const META_ORIGINAL_VISIBILITY = 'ryodo:original-visibility';

function absoluteUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return value;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return value;
  }
}

function normalizeSource(source, styleUrl) {
  const next = structuredClone(source);
  if (typeof next.url === 'string') next.url = absoluteUrl(next.url, styleUrl);
  if (Array.isArray(next.tiles)) {
    next.tiles = next.tiles.map((tile) => absoluteUrl(tile, styleUrl));
  }
  return next;
}

async function fetchStyle(styleId) {
  const config = resolveMapStyle(styleId);
  const response = await fetch(config.styleUrl, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(
      `Failed to load ${config.label} style (${response.status})`,
    );
  }
  const style = await response.json();
  if (style?.version !== 8 || !Array.isArray(style.layers)) {
    throw new Error(`Invalid MapLibre style returned for ${config.label}`);
  }
  return { config, style };
}

function prefixSourceId(styleId, sourceId) {
  return `basemap-${styleId}-source-${sourceId}`;
}

function prefixLayerId(styleId, layerId) {
  return `basemap-${styleId}-layer-${layerId}`;
}

function cloneLayer(styleId, layer, active) {
  const originalVisibility = layer.layout?.visibility ?? 'visible';
  const cloned = structuredClone(layer);

  cloned.id = prefixLayerId(styleId, layer.id);
  if (layer.source) cloned.source = prefixSourceId(styleId, layer.source);
  if (layer.ref) cloned.ref = prefixLayerId(styleId, layer.ref);

  cloned.metadata = {
    ...(cloned.metadata || {}),
    [META_STYLE_KEY]: styleId,
    [META_ORIGINAL_VISIBILITY]: originalVisibility,
  };
  cloned.layout = {
    ...(cloned.layout || {}),
    visibility: active ? originalVisibility : 'none',
  };

  return cloned;
}

/**
 * Build one persistent MapLibre style containing all OpenFreeMap presentations.
 *
 * TrailReplay keeps one style graph alive and changes basemaps by toggling
 * layer visibility. We do the same here: route sources, terrain DEM, hillshade,
 * actor and camera state are never destroyed when the user changes the visual
 * basemap.
 */
export async function buildPersistentOpenFreeMapStyle(
  initialStyleId = DEFAULT_MAP_STYLE_ID,
) {
  const activeId = resolveMapStyle(initialStyleId).id;
  const loaded = await Promise.all(MAP_STYLE_ORDER.map(fetchStyle));
  const primary =
    loaded.find(({ config }) => config.id === activeId) ||
    loaded[0];

  const sources = {};
  const layers = [];
  const presentations = {};

  for (const { config, style } of loaded) {
    const styleId = config.id;
    presentations[styleId] = [];

    for (const [sourceId, source] of Object.entries(style.sources || {})) {
      sources[prefixSourceId(styleId, sourceId)] = normalizeSource(
        source,
        config.styleUrl,
      );
    }

    for (const layer of style.layers) {
      const cloned = cloneLayer(styleId, layer, styleId === activeId);
      layers.push(cloned);
      presentations[styleId].push({
        layerId: cloned.id,
        originalVisibility:
          cloned.metadata?.[META_ORIGINAL_VISIBILITY] ?? 'visible',
      });
    }
  }

  const style = {
    version: 8,
    name: 'Ryodo Persistent OpenFreeMap',
    sources,
    layers,
  };

  // A MapLibre style can expose only one sprite/glyph endpoint. OpenFreeMap's
  // default styles are compatible with the same OpenMapTiles schema; use the
  // active style's endpoints for text/icons while keeping every presentation
  // in the same persistent style graph.
  if (primary.style.sprite) {
    style.sprite = absoluteUrl(primary.style.sprite, primary.config.styleUrl);
  }
  if (primary.style.glyphs) {
    style.glyphs = absoluteUrl(primary.style.glyphs, primary.config.styleUrl);
  }

  return { style, presentations, activeStyleId: activeId };
}

export function applyPersistentBasemapPresentation(
  map,
  presentations,
  styleId,
) {
  if (!map || !presentations) return false;
  const nextId = resolveMapStyle(styleId).id;
  if (!presentations[nextId]) return false;

  for (const [presentationId, entries] of Object.entries(presentations)) {
    const active = presentationId === nextId;
    for (const entry of entries) {
      if (!map.getLayer(entry.layerId)) continue;
      try {
        map.setLayoutProperty(
          entry.layerId,
          'visibility',
          active ? entry.originalVisibility : 'none',
        );
      } catch {
        // A malformed optional layer must never break the basemap switch.
      }
    }
  }

  map.triggerRepaint?.();
  return true;
}

export function getPersistentBasemapStyleId(layer) {
  return layer?.metadata?.[META_STYLE_KEY] || null;
}
