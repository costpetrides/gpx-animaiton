/**
 * Prepare-time terrain feature extraction from MapLibre DEM along the route.
 * Builds a lightweight TerrainFeatureGraph for viewpoint generation.
 */

import { queryTerrainElevationAt } from '../../camera.js';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function offsetLngLat(origin, eastM, northM) {
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.cos((origin.lat * Math.PI) / 180) * 111320;
  return {
    lng: origin.lng + eastM / metersPerDegLng,
    lat: origin.lat + northM / metersPerDegLat,
  };
}

function distM(a, b) {
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.cos((a.lat * Math.PI) / 180) * 111320;
  const dn = (b.lat - a.lat) * metersPerDegLat;
  const de = (b.lng - a.lng) * metersPerDegLng;
  return Math.hypot(de, dn);
}

/**
 * Sample DEM along the route and lateral offsets; classify peaks / ridges / valleys
 * via a coarse TPI-like score (cell elev − neighborhood mean).
 *
 * @param {import('maplibre-gl').Map} map
 * @param {import('../../route.js').RoutePath} route
 * @param {{ stepM?: number, lateralM?: number }} [options]
 */
export function extractTerrainFeatures(map, route, options = {}) {
  const stepM = options.stepM ?? 80;
  const lateralM = options.lateralM ?? 120;
  const empty = {
    peaks: [],
    ridges: [],
    valleys: [],
    samples: [],
    ready: false,
  };
  if (!map || !route?.totalDistance) return empty;

  const samples = [];
  const total = route.totalDistance;
  for (let d = 0; d <= total; d += stepM) {
    const s = route.atDistance(Math.min(d, total));
    if (!s?.point) continue;
    const p = s.point;
    const hint = Number.isFinite(p.ele) ? p.ele : null;
    const centerEle = queryTerrainElevationAt(map, p.lng, p.lat, hint) ?? hint;
    if (!Number.isFinite(centerEle)) continue;

    const neighbors = [];
    for (const [e, n] of [
      [lateralM, 0],
      [-lateralM, 0],
      [0, lateralM],
      [0, -lateralM],
      [lateralM * 0.7, lateralM * 0.7],
      [-lateralM * 0.7, -lateralM * 0.7],
    ]) {
      const q = offsetLngLat(p, e, n);
      const ele = queryTerrainElevationAt(map, q.lng, q.lat, centerEle);
      if (Number.isFinite(ele)) neighbors.push(ele);
    }
    if (neighbors.length < 3) continue;
    const mean = neighbors.reduce((a, b) => a + b, 0) / neighbors.length;
    const tpi = centerEle - mean;
    const relief = Math.max(...neighbors, centerEle) - Math.min(...neighbors, centerEle);

    samples.push({
      distance: d,
      lng: p.lng,
      lat: p.lat,
      ele: centerEle,
      tpi,
      relief,
      bearing: s.bearing ?? 0,
    });
  }

  if (samples.length < 4) return { ...empty, samples, ready: true };

  const tpiVals = samples.map((s) => s.tpi);
  const tpiMean = tpiVals.reduce((a, b) => a + b, 0) / tpiVals.length;
  const tpiStd = Math.sqrt(
    tpiVals.reduce((a, b) => a + (b - tpiMean) ** 2, 0) / tpiVals.length,
  ) || 1;

  const peaks = [];
  const ridges = [];
  const valleys = [];

  for (let i = 1; i < samples.length - 1; i++) {
    const s = samples[i];
    const z = (s.tpi - tpiMean) / tpiStd;
    if (z > 1.0 && s.tpi > samples[i - 1].tpi && s.tpi >= samples[i + 1].tpi) {
      peaks.push({
        id: `peak-${i}`,
        lng: s.lng,
        lat: s.lat,
        ele: s.ele,
        prominence: s.tpi,
        distance: s.distance,
      });
    }
    if (z > 0.7) {
      ridges.push({
        id: `ridge-${i}`,
        lng: s.lng,
        lat: s.lat,
        ele: s.ele,
        strength: z,
        distance: s.distance,
      });
    }
    if (z < -0.85) {
      valleys.push({
        id: `valley-${i}`,
        lng: s.lng,
        lat: s.lat,
        ele: s.ele,
        depthM: -s.tpi,
        distance: s.distance,
      });
    }
  }

  // Thin peaks — keep local maxima only.
  const thinPeaks = [];
  for (const peak of peaks) {
    if (thinPeaks.some((p) => distM(p, peak) < 200)) continue;
    thinPeaks.push(peak);
  }

  return {
    peaks: thinPeaks.slice(0, 24),
    ridges: ridges.filter((_, i) => i % 2 === 0).slice(0, 40),
    valleys: valleys.filter((_, i) => i % 2 === 0).slice(0, 40),
    samples,
    ready: true,
  };
}

/**
 * Features near a route distance for shot/viewpoint biasing.
 */
export function featuresNearDistance(graph, distanceM, radiusM = 450) {
  if (!graph?.ready) {
    return { hasPeak: false, hasRidge: false, hasValley: false, peak: null, ridge: null, valley: null };
  }
  const inRange = (list) =>
    list.filter((f) => Math.abs((f.distance ?? 0) - distanceM) <= radiusM);

  const peaks = inRange(graph.peaks || []);
  const ridges = inRange(graph.ridges || []);
  const valleys = inRange(graph.valleys || []);

  const nearest = (list) => {
    if (!list.length) return null;
    return list.reduce((best, f) =>
      Math.abs(f.distance - distanceM) < Math.abs(best.distance - distanceM) ? f : best,
    );
  };

  return {
    hasPeak: peaks.length > 0,
    hasRidge: ridges.length > 0,
    hasValley: valleys.length > 0,
    peak: nearest(peaks),
    ridge: nearest(ridges),
    valley: nearest(valleys),
  };
}

/**
 * Pick a landscape look-at point from features + actor (mountain first).
 */
export function resolveLandscapeLookAt(actorPoint, bearingDeg, priors, nearFeatures, side = 1) {
  const forwardM = priors?.lookAtForwardM ?? 100;
  const rightM = (priors?.lookAtRightM ?? 40) * side;

  // Prefer named terrain features when available — keep look-at near the trail.
  const feature = nearFeatures?.peak || nearFeatures?.ridge || nearFeatures?.valley;
  if (feature && Number.isFinite(feature.lng) && Number.isFinite(feature.lat)) {
    const blend = nearFeatures?.peak ? 0.38 : nearFeatures?.valley ? 0.32 : 0.28;
    return {
      lng: actorPoint.lng + (feature.lng - actorPoint.lng) * blend,
      lat: actorPoint.lat + (feature.lat - actorPoint.lat) * blend,
      ele: feature.ele ?? actorPoint.ele,
      source: feature.id || 'feature',
    };
  }

  const rad = (bearingDeg * Math.PI) / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.cos((actorPoint.lat * Math.PI) / 180) * 111320;
  const east = forwardM * Math.sin(rad) + rightM * Math.cos(rad);
  const north = forwardM * Math.cos(rad) - rightM * Math.sin(rad);
  return {
    lng: actorPoint.lng + east / metersPerDegLng,
    lat: actorPoint.lat + north / metersPerDegLat,
    ele: actorPoint.ele,
    source: 'offset',
  };
}

export function featureAffinityScore(lookAtSource, nearFeatures, shotType) {
  if (!lookAtSource || lookAtSource === 'offset') return 0.45;
  if (String(lookAtSource).startsWith('peak')) return shotType === 'summit' || shotType === 'reveal' ? 1 : 0.85;
  if (String(lookAtSource).startsWith('ridge')) return 0.9;
  if (String(lookAtSource).startsWith('valley')) return shotType === 'valley' ? 1 : 0.8;
  return 0.6;
}

export function createEmptyFeatureGraph() {
  return { peaks: [], ridges: [], valleys: [], samples: [], ready: false };
}
