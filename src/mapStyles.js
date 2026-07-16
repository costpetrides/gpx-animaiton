const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export const MAP_STYLES = {
  liberty: {
    label: 'Liberty',
    url: 'https://tiles.openfreemap.org/styles/liberty',
    attribution: OSM,
  },
  dark: {
    label: 'Dark',
    style: {
      version: 8,
      sources: {
        carto: {
          type: 'raster',
          tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
          tileSize: 256,
          attribution: OSM + ' &copy; <a href="https://carto.com/">CARTO</a>',
        },
      },
      layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
    },
  },
  satellite: {
    label: 'Satellite',
    style: {
      version: 8,
      sources: {
        esri: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: 'Tiles &copy; Esri',
        },
      },
      layers: [{ id: 'esri', type: 'raster', source: 'esri' }],
    },
  },
  topo: {
    label: 'Topo',
    style: {
      version: 8,
      sources: {
        topo: {
          type: 'raster',
          tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 17,
          attribution: OSM + ' &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
        },
      },
      layers: [{ id: 'topo', type: 'raster', source: 'topo' }],
    },
  },
};

export function getStyleConfig(key) {
  const cfg = MAP_STYLES[key] || MAP_STYLES.liberty;
  return cfg.url ? { url: cfg.url } : { style: cfg.style };
}
