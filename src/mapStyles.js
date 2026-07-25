const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO = OSM + ' &copy; <a href="https://carto.com/">CARTO</a>';
const ESRI = 'Tiles &copy; Esri';

function rasterStyle(sourceId, tiles, attribution, extra = {}) {
  return {
    version: 8,
    sources: {
      [sourceId]: {
        type: 'raster',
        tiles: Array.isArray(tiles) ? tiles : [tiles],
        tileSize: 256,
        attribution,
        ...extra,
      },
    },
    layers: [{ id: sourceId, type: 'raster', source: sourceId }],
  };
}

/**
 * Free basemaps only (no API key). Style chips are built from this map.
 */
export const MAP_STYLES = {
  liberty: {
    label: 'Liberty',
    url: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: OSM,
  },
  bright: {
    label: 'Bright',
    url: 'https://tiles.openfreemap.org/styles/bright',
    attribution: OSM,
  },
  positron: {
    label: 'Positron',
    url: 'https://tiles.openfreemap.org/styles/positron',
    attribution: OSM,
  },
  darkMatter: {
    label: 'Dark Matter',
    url: 'https://tiles.openfreemap.org/styles/dark',
    attribution: OSM,
  },
  voyager: {
    label: 'Voyager',
    style: rasterStyle(
      'carto-voyager',
      [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
      ],
      CARTO,
    ),
  },
  light: {
    label: 'Light',
    style: rasterStyle(
      'carto-light',
      [
        'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
      ],
      CARTO,
    ),
  },
  dark: {
    label: 'Dark',
    style: rasterStyle(
      'carto-dark',
      [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      CARTO,
    ),
  },
  cyclosm: {
    label: 'CyclOSM',
    style: rasterStyle(
      'cyclosm',
      [
        'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        'https://b.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
        'https://c.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      ],
      OSM + ' &copy; <a href="https://www.cyclosm.org">CyclOSM</a>',
      { maxzoom: 20 },
    ),
  },
  topo: {
    label: 'Topo',
    style: rasterStyle(
      'topo',
      [
        'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
        'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
      ],
      OSM + ' &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
      { maxzoom: 17 },
    ),
  },
  satellite: {
    label: 'Satellite',
    style: rasterStyle(
      'esri',
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ESRI,
    ),
  },
  streets: {
    label: 'Streets',
    style: rasterStyle(
      'esri-streets',
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      ESRI,
    ),
  },
  hybrid: {
    label: 'Hybrid',
    style: {
      version: 8,
      sources: {
        esriImagery: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: ESRI,
        },
        esriLabels: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: ESRI,
        },
      },
      layers: [
        { id: 'esri-imagery', type: 'raster', source: 'esriImagery' },
        { id: 'esri-labels', type: 'raster', source: 'esriLabels' },
      ],
    },
  },
};

export function getStyleConfig(key) {
  const cfg = MAP_STYLES[key] || MAP_STYLES.liberty;
  return cfg.url ? { url: cfg.url } : { style: cfg.style };
}
