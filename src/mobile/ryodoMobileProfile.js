import { DEFAULT_MAP_STYLE_ID, MAP_STYLE_ORDER, resolveMapStyle } from '../mapStyles.js';

export const RYODO_MOBILE_ALLOWED_MAP_STYLES = Object.freeze([...MAP_STYLE_ORDER]);

export const RYODO_MOBILE_RENDER_PROFILE = Object.freeze({
  aspectRatio: '9:16',
  quality: 'medium',
  fps: 30,
  format: 'mp4',
  cameraMode: 'cinematic',
  defaultMapStyle: DEFAULT_MAP_STYLE_ID,
  visibleStats: Object.freeze(['altitude', 'distance', 'speed']),
});

export const RYODO_MOBILE_UI_CAPABILITIES = Object.freeze({
  mapStylePicker: true,
  aspectRatioPicker: false,
  qualityPicker: false,
  fpsPicker: false,
  cameraModePicker: false,
  zoomControls: false,
  photoImportPicker: false,
});

export function normalizeRyodoMobileMapStyle(styleId) {
  const resolved = resolveMapStyle(styleId);
  return RYODO_MOBILE_ALLOWED_MAP_STYLES.includes(resolved.id)
    ? resolved.id
    : DEFAULT_MAP_STYLE_ID;
}

/**
 * Ryodo mobile receives photos selected by the host app during recording.
 * The renderer never opens a photo picker and never imports unrelated library
 * photos. Route photos are the only accepted media input.
 */
export function normalizeRyodoMobileRoutePhotos(selectedRoutePhotos = []) {
  if (!Array.isArray(selectedRoutePhotos)) return [];

  return selectedRoutePhotos.filter(
    (photo) => photo && typeof photo === 'object' && photo.kind === 'route',
  );
}

/**
 * Build the locked mobile render configuration consumed by the future Ryodo
 * host integration. Callers may choose one of the three supported basemaps and
 * provide already-selected route photos; cinematic/export settings stay fixed.
 */
export function createRyodoMobileRenderConfig({
  mapStyle = DEFAULT_MAP_STYLE_ID,
  selectedRoutePhotos = [],
} = {}) {
  return {
    ...RYODO_MOBILE_RENDER_PROFILE,
    mapStyle: normalizeRyodoMobileMapStyle(mapStyle),
    photos: normalizeRyodoMobileRoutePhotos(selectedRoutePhotos),
    ui: RYODO_MOBILE_UI_CAPABILITIES,
  };
}
