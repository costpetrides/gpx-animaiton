/**
 * TrailReplay follow-behind camera practices adapted to this project's
 * MapLibre/OpenFreeMap stack.
 *
 * Kept deliberately close to TrailReplay:
 * - eight discrete follow-distance stops
 * - route-length/video-duration-aware suggested starting stop
 * - stable averaged route bearing
 * - terrain-aware zoom/pitch budget with a wide progress window
 */

export const DEFAULT_FOLLOW_BEHIND_LEVEL = 33;
export const FOLLOW_BEHIND_STOP_LEVELS = [0, 11, 22, 33, 49.5, 66, 83, 100];

const PLAYBACK_CAMERA_ANCHORS = [
  { id: 'far', level: 0, zoom: 12, pitch: 32 },
  { level: 11, zoom: 12.8, pitch: 34 },
  { level: 22, zoom: 13.6, pitch: 36 },
  { id: 'medium', level: 33, zoom: 14.5, pitch: 40 },
  { level: 49.5, zoom: 15, pitch: 44 },
  { id: 'close', level: 66, zoom: 15.5, pitch: 48 },
  { level: 83, zoom: 16, pitch: 52 },
  { id: 'very-close', level: 100, zoom: 16.5, pitch: 56 },
];

const METERS_PER_PIXEL_AT_ZOOM_0 = 40075016.686 / 512;
const REFERENCE_VIEWPORT_WIDTH_PX = 1280;
const SECONDS_TO_CROSS_VIEWPORT = 13;

const TERRAIN = {
  LOOK_AHEAD_PROGRESS: 0.15,
  FULL_RISK_GRADIENT: 0.12,
  MIN_GRADIENT_SPAN_METERS: 200,
  ELEVATION_RISK_METERS: 1200,
  ELEVATION_RISK_WEIGHT: 0.5,
  MAX_ZOOM_OUT: 0.8,
  MAX_PITCH_REDUCE: 4,
  MIN_ZOOM: 8,
  MIN_PITCH: 15,
};

const BEARING_LOOK_AHEAD_SAMPLES = 16;
const BEARING_SMOOTHING_HALF_WINDOW = 4;

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

function interpolateAnchor(level) {
  const value = clamp(
    Number.isFinite(level) ? level : DEFAULT_FOLLOW_BEHIND_LEVEL,
    0,
    100,
  );
  let lower = PLAYBACK_CAMERA_ANCHORS[0];
  let upper = PLAYBACK_CAMERA_ANCHORS[PLAYBACK_CAMERA_ANCHORS.length - 1];

  for (const anchor of PLAYBACK_CAMERA_ANCHORS) {
    if (anchor.level <= value) lower = anchor;
    if (anchor.level >= value) {
      upper = anchor;
      break;
    }
  }

  if (lower.level === upper.level) {
    return { zoom: lower.zoom, pitch: lower.pitch };
  }

  const t = (value - lower.level) / (upper.level - lower.level);
  return {
    zoom: lower.zoom + (upper.zoom - lower.zoom) * t,
    pitch: lower.pitch + (upper.pitch - lower.pitch) * t,
  };
}

export function getFollowBehindCameraTarget(level) {
  return interpolateAnchor(level);
}

export function getFollowBehindLevelForStopIndex(index) {
  const i = Math.max(0, Math.min(FOLLOW_BEHIND_STOP_LEVELS.length - 1, Math.round(index)));
  return FOLLOW_BEHIND_STOP_LEVELS[i];
}

export function getFollowBehindStopIndexForLevel(level) {
  const value = clamp(Number(level) || 0, 0, 100);
  let bestIndex = 0;
  let bestDistance = Infinity;
  FOLLOW_BEHIND_STOP_LEVELS.forEach((candidate, index) => {
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

export function getSuggestedFollowBehindZoomLevel({
  totalDistanceMeters,
  videoDurationSeconds,
  latitudeDeg,
}) {
  if (!Number.isFinite(totalDistanceMeters) || totalDistanceMeters <= 0) {
    return DEFAULT_FOLLOW_BEHIND_LEVEL;
  }
  if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds <= 0) {
    return DEFAULT_FOLLOW_BEHIND_LEVEL;
  }
  if (!Number.isFinite(latitudeDeg)) return DEFAULT_FOLLOW_BEHIND_LEVEL;

  const desiredVisibleWidthMeters =
    (totalDistanceMeters / videoDurationSeconds) * SECONDS_TO_CROSS_VIEWPORT;
  const safeLatitude = clamp(latitudeDeg, -85, 85);
  const metersPerPixelAtZoom0 =
    METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos((safeLatitude * Math.PI) / 180);
  const desiredZoom = Math.log2(
    (metersPerPixelAtZoom0 * REFERENCE_VIEWPORT_WIDTH_PX) / desiredVisibleWidthMeters,
  );
  if (!Number.isFinite(desiredZoom)) return DEFAULT_FOLLOW_BEHIND_LEVEL;

  let bestIndex = 0;
  let bestDistance = Infinity;
  PLAYBACK_CAMERA_ANCHORS.forEach((anchor, index) => {
    const distance = Math.abs(anchor.zoom - desiredZoom);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return getFollowBehindLevelForStopIndex(bestIndex);
}

function interpolatedPoint(route, fractionalIndex) {
  const points = route?.points || [];
  if (!points.length) return null;
  const last = points.length - 1;
  const clamped = clamp(fractionalIndex, 0, last);
  const lo = Math.floor(clamped);
  const hi = Math.min(last, lo + 1);
  const t = clamped - lo;
  const a = points[lo];
  const b = points[hi];
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
    ele: Number.isFinite(a.ele) && Number.isFinite(b.ele)
      ? a.ele + (b.ele - a.ele) * t
      : (Number.isFinite(a.ele) ? a.ele : b.ele),
  };
}

function centroidAtSample(route, center, halfWindow) {
  const points = route?.points || [];
  const last = points.length - 1;
  const middle = clamp(Math.round(center), 0, last);
  let lat = 0;
  let lng = 0;
  let count = 0;
  for (
    let index = Math.max(0, middle - halfWindow);
    index <= Math.min(last, middle + halfWindow);
    index += 1
  ) {
    const point = points[index];
    lat += point.lat;
    lng += point.lng;
    count += 1;
  }
  return count ? { lat: lat / count, lng: lng / count } : interpolatedPoint(route, middle);
}

function localCentroid(route, center, halfWindow) {
  const points = route?.points || [];
  if (!points.length) return null;
  const last = points.length - 1;
  const clamped = clamp(center, 0, last);
  const lowerIndex = Math.floor(clamped);
  const fraction = clamped - lowerIndex;
  const lower = centroidAtSample(route, lowerIndex, halfWindow);
  if (fraction === 0) return lower;
  const upper = centroidAtSample(route, Math.min(last, lowerIndex + 1), halfWindow);
  return {
    lat: lower.lat + (upper.lat - lower.lat) * fraction,
    lng: lower.lng + (upper.lng - lower.lng) * fraction,
  };
}

function stableRouteBearing(route, progress) {
  const points = route?.points || [];
  if (points.length < 2) return 0;
  const last = points.length - 1;
  const index = clamp(progress, 0, 1) * last;
  const aheadIndex = Math.min(index + BEARING_LOOK_AHEAD_SAMPLES, last);
  const from = localCentroid(route, index, BEARING_SMOOTHING_HALF_WINDOW);
  const to = localCentroid(route, aheadIndex, BEARING_SMOOTHING_HALF_WINDOW);
  if (!from || !to) return 0;
  if (from.lat === to.lat && from.lng === to.lng) {
    const a = interpolatedPoint(route, index);
    const b = interpolatedPoint(route, aheadIndex);
    if (!a || !b) return 0;
    return bearingBetween(a, b);
  }
  return bearingBetween(from, to);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function smoothedElevationAt(route, index) {
  const points = route?.points || [];
  const values = [];
  for (let offset = -2; offset <= 2; offset += 1) {
    const p = points[clamp(index + offset, 0, points.length - 1)];
    if (Number.isFinite(p?.ele)) values.push(p.ele);
  }
  return values.length ? median(values) : null;
}

function meanAbsoluteGradient(route, startIndex, endIndex) {
  if (!route || endIndex <= startIndex) return null;
  let gradientSum = 0;
  let sampleCount = 0;
  let spanStart = startIndex;

  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    const run = (route.cumDist[index] ?? 0) - (route.cumDist[spanStart] ?? 0);
    if (run < TERRAIN.MIN_GRADIENT_SPAN_METERS) continue;
    const fromEle = smoothedElevationAt(route, spanStart);
    const toEle = smoothedElevationAt(route, index);
    if (Number.isFinite(fromEle) && Number.isFinite(toEle) && run > 0) {
      gradientSum += Math.abs(toEle - fromEle) / run;
      sampleCount += 1;
    }
    spanStart = index;
  }

  return sampleCount ? gradientSum / sampleCount : null;
}

function terrainAdjustments(route, progress) {
  const points = route?.points || [];
  if (!points.length) return { zoomAdjust: 0, pitchAdjust: 0 };

  const index = Math.round(clamp(progress, 0, 1) * (points.length - 1));
  const elevation = smoothedElevationAt(route, index);
  const finite = points.map((p) => p.ele).filter(Number.isFinite);
  const routeBaseElevation = finite.length ? Math.min(...finite) : (elevation ?? 0);
  const relativeElevation = Math.max(0, (elevation ?? routeBaseElevation) - routeBaseElevation);
  const elevationRisk = Math.min(relativeElevation / TERRAIN.ELEVATION_RISK_METERS, 1);

  const behind = Math.max(
    0,
    Math.floor((progress - TERRAIN.LOOK_AHEAD_PROGRESS) * (points.length - 1)),
  );
  const ahead = Math.min(
    points.length - 1,
    Math.floor((progress + TERRAIN.LOOK_AHEAD_PROGRESS) * (points.length - 1)),
  );
  const gradient = meanAbsoluteGradient(route, behind, ahead);
  const steepnessRisk = gradient == null
    ? 0
    : Math.min(gradient / TERRAIN.FULL_RISK_GRADIENT, 1);
  const combinedRisk = Math.max(
    elevationRisk * TERRAIN.ELEVATION_RISK_WEIGHT,
    steepnessRisk,
  );

  return {
    zoomAdjust: combinedRisk * TERRAIN.MAX_ZOOM_OUT,
    pitchAdjust: combinedRisk * TERRAIN.MAX_PITCH_REDUCE,
  };
}

export function getTrailReplayCameraPose(
  route,
  progress,
  followBehindZoomLevel = DEFAULT_FOLLOW_BEHIND_LEVEL,
) {
  if (!route) return null;
  const p = clamp(progress, 0, 1);
  const center = route.atDistance(p * route.totalDistance)?.point;
  if (!center) return null;

  const preset = getFollowBehindCameraTarget(followBehindZoomLevel);
  const { zoomAdjust, pitchAdjust } = terrainAdjustments(route, p);

  return {
    center,
    bearing: stableRouteBearing(route, p),
    zoom: Math.max(TERRAIN.MIN_ZOOM, preset.zoom - zoomAdjust),
    pitch: Math.max(TERRAIN.MIN_PITCH, preset.pitch - pitchAdjust),
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
