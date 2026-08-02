/**
 * Central map basemap configuration — matches Peak Explorer.
 * Outdoor is the global default.
 *
 * OpenFreeMap vector styles only (commercial-safe, no API key).
 * 3D is a separate toggle (terrain / buildings) — not a map style.
 */

export const DEFAULT_MAP_STYLE_ID = 'outdoor';

export const MAP_STYLES = {
  outdoor: {
    id: 'outdoor',
    label: 'Outdoor',
    description: 'Trails & terrain detail',
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: '© OpenFreeMap © OpenStreetMap contributors',
  },
  positron: {
    id: 'positron',
    label: 'Positron',
    description: 'Clean light streets',
    styleUrl: 'https://tiles.openfreemap.org/styles/positron',
    attribution: '© OpenFreeMap © OpenStreetMap contributors',
  },
  dark: {
    id: 'dark',
    label: 'Dark',
    description: 'Night-friendly basemap',
    styleUrl: 'https://tiles.openfreemap.org/styles/dark',
    attribution: '© OpenFreeMap © OpenStreetMap contributors',
  },
};

/** Legacy ids from older animator projects / Peak Explorer aliases. */
const STYLE_ALIASES = {
  liberty: 'outdoor',
  standard: 'positron',
  satellite: 'outdoor',
  topo: 'outdoor',
};

/** Picker order — default style first. 3D is never a style entry. */
export const MAP_STYLE_ORDER = ['outdoor', 'positron', 'dark'];

/**
 * @param {string | undefined | null} styleId
 * @returns {typeof MAP_STYLES.outdoor}
 */
export function resolveMapStyle(styleId) {
  const normalized = STYLE_ALIASES[styleId] || styleId;
  if (normalized && MAP_STYLES[normalized]) {
    return MAP_STYLES[normalized];
  }
  return MAP_STYLES[DEFAULT_MAP_STYLE_ID];
}

/**
 * MapLibre style URL for the given basemap id.
 * @param {string | undefined | null} styleId
 * @returns {string}
 */
export function getMapStyle(styleId) {
  return resolveMapStyle(styleId).styleUrl;
}

/**
 * @param {string | undefined | null} styleId
 * @returns {string}
 */
export function getMapStyleUrl(styleId) {
  return getMapStyle(styleId);
}

export function getDefaultMapStyleId() {
  return DEFAULT_MAP_STYLE_ID;
}

/** MapLibre constructor / setStyle helper used by the animator. */
export function getStyleConfig(styleId) {
  return { style: getMapStyleUrl(styleId) };
}
