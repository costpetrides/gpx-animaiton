import maplibregl from 'maplibre-gl';
import { addTerrainSource, enableTerrain, fitOverview } from '../camera.js';

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

function emptyPointFeatureCollection() {
  return emptyFC();
}

const MARKER_PALETTE = {
  start: {
    glow: '#6ee7b7',
    core: '#059669',
    coreStroke: '#ecfdf5',
  },
  end: {
    glow: '#fda4af',
    core: '#be123c',
    coreStroke: '#fff1f2',
  },
  actor: {
    glow: '#93c5fd',
    core: '#ffffff',
    coreStroke: '#3b82f6',
  },
};

function addEndpointMarkerLayers(map, sourceId, kind) {
  const palette = MARKER_PALETTE[kind];
  const prefix = `marker-${kind}`;
  const filter = ['==', ['get', 't'], kind === 'start' ? 'start' : 'end'];

  map.addLayer({
    id: `${prefix}-glow`,
    type: 'circle',
    source: sourceId,
    filter,
    paint: {
      'circle-radius': 18,
      'circle-color': palette.glow,
      'circle-opacity': 0.24,
      'circle-blur': 0.85,
    },
  });
  map.addLayer({
    id: `${prefix}-core`,
    type: 'circle',
    source: sourceId,
    filter,
    paint: {
      'circle-radius': 5,
      'circle-color': palette.core,
      'circle-stroke-width': 1.75,
      'circle-stroke-color': palette.coreStroke,
    },
  });
}

function addActorMarkerLayers(map, sourceId) {
  const palette = MARKER_PALETTE.actor;

  map.addLayer({
    id: 'actor-glow',
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-radius': 20,
      'circle-color': palette.glow,
      'circle-opacity': 0.28,
      'circle-blur': 0.85,
    },
  });
  map.addLayer({
    id: 'actor-core',
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-radius': 5.5,
      'circle-color': palette.core,
      'circle-stroke-width': 2.25,
      'circle-stroke-color': palette.coreStroke,
    },
  });
}

function buildBounds(route) {
  const coords = route.coords();
  return coords.reduce(
    (acc, coord) => acc.extend(coord),
    new maplibregl.LngLatBounds(coords[0], coords[0]),
  );
}

export function createMapPlaybackRenderer(map) {
  let layersReady = false;
  let staticLayersSet = false;
  let overviewFrameId = 0;
  let lastRouteDoneBucket = -1;
  const ROUTE_DONE_BUCKET_M = 2;

  function addLayers() {
    if (!map.isStyleLoaded()) return;
    if (map.getSource('route') && map.getSource('actor')) {
      layersReady = true;
      staticLayersSet = false;
      return;
    }

    map.addSource('route', { type: 'geojson', lineMetrics: true, data: emptyFC() });
    map.addSource('route-done', { type: 'geojson', lineMetrics: true, data: emptyFC() });
    map.addSource('markers', { type: 'geojson', data: emptyFC() });
    map.addSource('actor', { type: 'geojson', data: emptyPointFeatureCollection() });

    map.addLayer({
      id: 'route-glow',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#94a3b8', 'line-width': 10, 'line-opacity': 0.15, 'line-blur': 4 },
    });
    map.addLayer({
      id: 'route-full',
      type: 'line',
      source: 'route',
      paint: { 'line-color': '#cbd5e1', 'line-width': 3, 'line-opacity': 0.4 },
    });
    map.addLayer({
      id: 'route-done-glow',
      type: 'line',
      source: 'route-done',
      paint: { 'line-color': '#3b82f6', 'line-width': 12, 'line-opacity': 0.35, 'line-blur': 3 },
    });
    map.addLayer({
      id: 'route-done',
      type: 'line',
      source: 'route-done',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 5,
        'line-gradient': [
          'interpolate', ['linear'], ['line-progress'],
          0, '#2563eb',
          0.85, '#60a5fa',
          1, '#fbbf24',
        ],
      },
    });

    addEndpointMarkerLayers(map, 'markers', 'start');
    addEndpointMarkerLayers(map, 'markers', 'end');
    addActorMarkerLayers(map, 'actor');

    addTerrainSource(map);
    layersReady = true;
    staticLayersSet = false;
  }

  function whenReady(fn) {
    const attempt = () => {
      if (!map.isStyleLoaded()) return false;
      addLayers();
      fn();
      return true;
    };

    if (attempt()) return;

    const onStyleLoad = () => attempt();
    const onMapLoad = () => attempt();

    map.once('style.load', onStyleLoad);
    map.once('load', onMapLoad);

    let attempts = 0;
    const poll = () => {
      if (attempt()) return;
      attempts += 1;
      if (attempts > 240) {
        addLayers();
        fn();
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  function clear() {
    if (!layersReady) return;
    map.getSource('route')?.setData(emptyFC());
    map.getSource('route-done')?.setData(emptyFC());
    map.getSource('markers')?.setData(emptyFC());
    map.getSource('actor')?.setData(emptyPointFeatureCollection());
  }

  function setStaticRouteState(route) {
    if (!route || !layersReady || staticLayersSet) return;
    const start = route.points[0];
    const end = route.points[route.points.length - 1];

    map.getSource('route')?.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: route.coords() },
    });
    map.getSource('markers')?.setData({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { t: 'start' }, geometry: { type: 'Point', coordinates: [start.lng, start.lat] } },
        { type: 'Feature', properties: { t: 'end' }, geometry: { type: 'Point', coordinates: [end.lng, end.lat] } },
      ],
    });
    staticLayersSet = true;
  }

  function renderFrameState(frameState, { requestRepaint = true } = {}) {
    const route = frameState?.route;
    const animDistance = frameState?.playback?.animDistance;
    const sample = frameState?.sample;
    if (!route || !layersReady) return;
    setStaticRouteState(route);

    map.getSource('actor')?.setData({
      type: 'FeatureCollection',
      features: sample
        ? [{
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [sample.point.lng, sample.point.lat] },
          }]
        : [],
    });

    const routeBucket = Math.floor((animDistance ?? 0) / ROUTE_DONE_BUCKET_M);
    if (routeBucket !== lastRouteDoneBucket) {
      map.getSource('route-done')?.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: route.traveledCoords(animDistance) },
      });
      lastRouteDoneBucket = routeBucket;
    }

    if (requestRepaint) {
      map.triggerRepaint();
    }
  }

  function refreshRouteFrameState(frameState) {
    const route = frameState?.route;
    if (!route) return;
    setStaticRouteState(route);
    renderFrameState(frameState);
  }

  function resetRouteState() {
    staticLayersSet = false;
    lastRouteDoneBucket = -1;
  }

  function resetProgressCache() {
    lastRouteDoneBucket = -1;
  }

  function hasPlaybackLayers() {
    if (!layersReady) return false;
    try {
      return Boolean(
        map.getSource('route') &&
        map.getLayer('route-full') &&
        map.getLayer('actor-core'),
      );
    } catch {
      return false;
    }
  }

  function scheduleOverview(route) {
    cancelAnimationFrame(overviewFrameId);
    overviewFrameId = requestAnimationFrame(() => {
      overviewFrameId = 0;
      map.resize();
      if (route) {
        const bounds = buildBounds(route);
        fitOverview(map, bounds);
      }
    });
  }

  function cancelOverview() {
    cancelAnimationFrame(overviewFrameId);
    overviewFrameId = 0;
  }

  function getBounds(route) {
    return route ? buildBounds(route) : null;
  }

  function applyTrackStyle(style = {}) {
    if (!layersReady) return;
    const color = style.color || '#3b82f6';
    const width = style.width ?? 5;
    const glowWidth = style.glowWidth ?? 12;
    const opacity = style.opacity ?? 1;

    if (map.getLayer('route-done')) {
      map.setPaintProperty('route-done', 'line-width', width);
      map.setPaintProperty('route-done-glow', 'line-width', glowWidth);
      map.setPaintProperty('route-done-glow', 'line-opacity', 0.35 * opacity);
    }
    if (map.getLayer('route-full')) {
      map.setPaintProperty('route-full', 'line-color', color);
      map.setPaintProperty('route-full', 'line-opacity', 0.4 * opacity);
    }
    if (map.getLayer('route-glow')) {
      map.setPaintProperty('route-glow', 'line-color', color);
    }
    if (style.showFullRoute === false && map.getLayer('route-full')) {
      map.setLayoutProperty('route-full', 'visibility', 'none');
      map.setLayoutProperty('route-glow', 'visibility', 'none');
    } else if (map.getLayer('route-full')) {
      map.setLayoutProperty('route-full', 'visibility', 'visible');
      map.setLayoutProperty('route-glow', 'visibility', 'visible');
    }
  }

  return {
    addLayers,
    whenReady,
    clear,
    renderFrameState,
    refreshRouteFrameState,
    resetRouteState,
    resetProgressCache,
    hasPlaybackLayers,
    scheduleOverview,
    cancelOverview,
    getBounds,
    applyTrackStyle,
  };
}

