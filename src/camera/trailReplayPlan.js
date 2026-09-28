/**
 * TrailReplay-style automatic follow-behind camera plan, adapted to this
 * project's MapLibre/OpenFreeMap stack.
 *
 * The pose is a pure function of route + progress so preview and export see
 * the same target. Terrain only nudges zoom/pitch; DEM clearance remains a
 * separate safety layer in camera.js.
 */

const PLAYBACK_ZOOM = 14.5;
const PLAYBACK_PITCH = 40;
const MIN_ZOOM = 8;
const MIN_PITCH = 15;

const MAX_ZOOM_OUT = 0.8;
const MAX_PITCH_REDUCE = 4;
const LOOK_AROUND_PROGRESS = 0.15;
const FULL_RISK_GRADIENT = 0.12;
const ELEVATION_RISK_METERS = 1200;
const ELEVATION_RISK_WEIGHT = 0.5;

const BEARING_FROM_WINDOW = 0.006;
const BEARING_LOOK_AHEAD = 0.024;

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

function sample(route, progress) {
  if (!route) return null;
  const p = clamp(progress, 0, 1);
  return route.atDistance(p * route.totalDistance)?.point || null;
}

function centroid(route, progress, halfWindow) {
  const offsets = [-1, -0.5, 0, 0.5, 1];
  let lat = 0;
  let lng = 0;
  let count = 0;

  for (const offset of offsets) {
    const point = sample(route, progress + offset * halfWindow);
    if (!point) continue;
    lat += point.lat;
    lng += point.lng;
    count += 1;
  }

  if (!count) return sample(route, progress);
  return { lat: lat / count, lng: lng / count };
}

function stableRouteBearing(route, progress) {
  const from = centroid(route, progress, BEARING_FROM_WINDOW);
  const to = centroid(
    route,
    Math.min(1, progress + BEARING_LOOK_AHEAD),
    BEARING_FROM_WINDOW,
  );
  if (!from || !to) return 0;
  if (from.lat === to.lat && from.lng === to.lng) {
    const here = sample(route, progress);
    const ahead = sample(route, Math.min(1, progress + 0.01));
    if (!here || !ahead) return 0;
    return bearingBetween(here, ahead);
  }
  return bearingBetween(from, to);
}

function routeBaseElevation(route) {
  if (Number.isFinite(route?._trailReplayBaseElevation)) {
    return route._trailReplayBaseElevation;
  }
  const elevations = (route?.raw || [])
    .map((point) => point.ele)
    .filter(Number.isFinite);
  const base = elevations.length ? Math.min(...elevations) : 0;
  if (route) route._trailReplayBaseElevation = base;
  return base;
}

function terrainRisk(route, progress) {
  const center = sample(route, progress);
  if (!center) return 0;

  const elevation = Number.isFinite(center.ele) ? center.ele : routeBaseElevation(route);
  const relativeElevation = Math.max(0, elevation - routeBaseElevation(route));
  const elevationRisk = Math.min(relativeElevation / ELEVATION_RISK_METERS, 1);

  const behindProgress = clamp(progress - LOOK_AROUND_PROGRESS, 0, 1);
  const aheadProgress = clamp(progress + LOOK_AROUND_PROGRESS, 0, 1);
  const behind = sample(route, behindProgress);
  const ahead = sample(route, aheadProgress);

  let steepnessRisk = 0;
  if (behind && ahead && Number.isFinite(behind.ele) && Number.isFinite(ahead.ele)) {
    const run = Math.max(
      1,
      (aheadProgress - behindProgress) * Math.max(1, route.totalDistance),
    );
    const gradient = Math.abs(ahead.ele - behind.ele) / run;
    steepnessRisk = Math.min(gradient / FULL_RISK_GRADIENT, 1);
  }

  return Math.max(elevationRisk * ELEVATION_RISK_WEIGHT, steepnessRisk);
}

export function getTrailReplayCameraPose(route, progress) {
  if (!route) return null;
  const p = clamp(progress, 0, 1);
  const center = sample(route, p);
  if (!center) return null;

  const risk = terrainRisk(route, p);
  return {
    center,
    bearing: stableRouteBearing(route, p),
    zoom: Math.max(MIN_ZOOM, PLAYBACK_ZOOM - risk * MAX_ZOOM_OUT),
    pitch: Math.max(MIN_PITCH, PLAYBACK_PITCH - risk * MAX_PITCH_REDUCE),
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
