/**
 * Deterministic follow-behind camera plan inspired by TrailReplay's good
 * practices, reimplemented for this project's MapLibre/OpenFreeMap stack.
 *
 * Goals:
 * - same pose for preview and export at the same route progress
 * - no per-frame terrain/director candidate hunting
 * - symmetric route smoothing (no temporal lag)
 * - stable route bearing from averaged route positions
 * - terrain affects framing gently; terrain collision remains a separate safety
 */

const ANCHOR_HALF_WINDOW_PROGRESS = 0.018;
const BEARING_HALF_WINDOW_PROGRESS = 0.008;
const BEARING_LOOK_AHEAD_PROGRESS = 0.028;

const BASE_ZOOM = 15.15;
const BASE_PITCH = 49;
const MIN_ZOOM = 14.35;
const MIN_PITCH = 43;
const MAX_TERRAIN_ZOOM_OUT = 0.65;
const MAX_TERRAIN_PITCH_REDUCE = 4;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeBearing(deg) {
  return ((deg % 360) + 360) % 360;
}

function bearingBetween(a, b) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
}

function samplePoint(route, progress) {
  if (!route) return null;
  const p = clamp(progress, 0, 1);
  return route.atDistance(p * route.totalDistance)?.point || null;
}

function averageRoutePoint(route, progress, halfWindow) {
  const offsets = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];
  let lat = 0;
  let lng = 0;
  let ele = 0;
  let eleCount = 0;
  let count = 0;

  for (const offset of offsets) {
    const point = samplePoint(route, progress + offset * halfWindow);
    if (!point) continue;
    lat += point.lat;
    lng += point.lng;
    if (Number.isFinite(point.ele)) {
      ele += point.ele;
      eleCount += 1;
    }
    count += 1;
  }

  if (!count) return samplePoint(route, progress);
  return {
    lat: lat / count,
    lng: lng / count,
    ele: eleCount ? ele / eleCount : null,
  };
}

function stableRouteBearing(route, progress) {
  const from = averageRoutePoint(
    route,
    progress - BEARING_LOOK_AHEAD_PROGRESS * 0.35,
    BEARING_HALF_WINDOW_PROGRESS,
  );
  const to = averageRoutePoint(
    route,
    progress + BEARING_LOOK_AHEAD_PROGRESS,
    BEARING_HALF_WINDOW_PROGRESS,
  );
  if (!from || !to) return 0;
  return bearingBetween(from, to);
}

function terrainRisk(route, progress) {
  const center = samplePoint(route, progress);
  const ahead = samplePoint(route, progress + 0.035);
  const behind = samplePoint(route, progress - 0.02);
  if (!center || !ahead || !behind) return 0;
  if (![center.ele, ahead.ele, behind.ele].every(Number.isFinite)) return 0;

  const localRelief = Math.max(
    Math.abs(ahead.ele - center.ele),
    Math.abs(center.ele - behind.ele),
    Math.abs(ahead.ele - behind.ele) * 0.5,
  );

  // Dimensionless-ish local relief proxy with a conservative cap. This only
  // nudges the authored framing; the DEM terrain guard handles true clearance.
  return clamp(localRelief / 170, 0, 1);
}

export function getTrailReplayCameraPose(route, progress) {
  if (!route) return null;
  const p = clamp(progress, 0, 1);
  const center = averageRoutePoint(route, p, ANCHOR_HALF_WINDOW_PROGRESS);
  if (!center) return null;

  const risk = terrainRisk(route, p);
  return {
    center,
    bearing: stableRouteBearing(route, p),
    pitch: Math.max(MIN_PITCH, BASE_PITCH - risk * MAX_TERRAIN_PITCH_REDUCE),
    zoom: Math.max(MIN_ZOOM, BASE_ZOOM - risk * MAX_TERRAIN_ZOOM_OUT),
  };
}

export function cameraPoseToShot(pose) {
  if (!pose) return null;
  return {
    mode: 'cinematic',
    zoom: pose.zoom,
    pitch: pose.pitch,
    bearingDeg: pose.bearing,
    relativeBearing: 0,
    lookAtLng: pose.center.lng,
    lookAtLat: pose.center.lat,
    lookAtEle: pose.center.ele,
    focusForwardM: 0,
    focusRightM: 0,
    forwardOffsetM: 0,
    rightOffsetM: 0,
  };
}
