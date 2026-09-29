/**
 * TrailReplay camera model adapted to this project's MapLibre/OpenFreeMap stack.
 *
 * The important bits are preserved:
 * - overview / follow / follow-behind / cinematic modes
 * - the same eight follow-behind distance stops
 * - terrain-aware framing
 * - time-based camera smoothing so 30/60fps behave the same
 * - cinematic zero-phase route smoothing (future + past route samples)
 * - a long-baseline cinematic heading that ignores rapid switchbacks
 */

export const TRAIL_REPLAY_CAMERA_MODES = [
  'overview',
  'follow',
  'follow-behind',
  'cinematic',
];

export const DEFAULT_TRAIL_REPLAY_CAMERA_MODE = 'cinematic';
export const DEFAULT_CAMERA_STABILITY = 0.5;

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

const FOLLOW_CAMERA_ZOOM = 14;

export const METERS_PER_PIXEL_AT_ZOOM_0 = 40075016.686 / 512;
export const REFERENCE_VIEWPORT_WIDTH_PX = 1280;
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
const CAMERA_SMOOTHING_REFERENCE_FRAME_MS = 1000 / 60;

const MAX_ANCHOR_SMOOTHING_SECONDS = 5;
const MIN_ANCHOR_SMOOTHING_SECONDS = 0.12;
const CINEMATIC_KERNEL_TAPS = 33;
const MAX_MARKER_OFFSET_VIEWPORT_FRACTION = 0.22;
const WINDOW_FIT_ITERATIONS = 6;
const METERS_PER_DEGREE_LATITUDE = 111320;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function normalizeBearing(deg) {
  return ((deg % 360) + 360) % 360;
}

function shortestBearingDelta(from, to) {
  return ((normalizeBearing(to - from) + 540) % 360) - 180;
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

function metersPerDegreeLongitude(latitudeDeg) {
  return METERS_PER_DEGREE_LATITUDE * Math.cos((latitudeDeg * Math.PI) / 180);
}

export function normalizeTrailReplayCameraMode(mode) {
  return TRAIL_REPLAY_CAMERA_MODES.includes(mode)
    ? mode
    : DEFAULT_TRAIL_REPLAY_CAMERA_MODE;
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

  return count
    ? { lat: lat / count, lng: lng / count }
    : interpolatedPoint(route, middle);
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
  const index = clamp01(progress) * last;
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

  const index = Math.round(clamp01(progress) * (points.length - 1));
  const elevation = smoothedElevationAt(route, index);
  const finite = points.map((point) => point.ele).filter(Number.isFinite);
  const routeBaseElevation = finite.length ? Math.min(...finite) : (elevation ?? 0);
  const relativeElevation = Math.max(
    0,
    (elevation ?? routeBaseElevation) - routeBaseElevation,
  );
  const elevationRisk = Math.min(
    relativeElevation / TERRAIN.ELEVATION_RISK_METERS,
    1,
  );

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

function blackmanWeight(offset, halfTaps) {
  if (halfTaps <= 0) return 1;
  const t = clamp01(Math.abs(offset) / halfTaps);
  const angle = Math.PI * (1 - t);
  return 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle);
}

function smoothRoutePosition(route, progress, smoothingHalfWindow) {
  const points = route?.points || [];
  const lastIndex = points.length - 1;
  if (lastIndex < 0) return null;

  const centerIndex = clamp01(progress) * lastIndex;
  const requestedHalfWindow = Math.max(0, smoothingHalfWindow) * lastIndex;
  const halfWindow = Math.min(
    requestedHalfWindow,
    centerIndex,
    lastIndex - centerIndex,
  );

  let lngSum = 0;
  let latSum = 0;
  let weightSum = 0;
  const halfTaps = (CINEMATIC_KERNEL_TAPS - 1) / 2;

  for (let tap = -halfTaps; tap <= halfTaps; tap += 1) {
    const sampleIndex =
      centerIndex + (halfTaps === 0 ? 0 : (tap / halfTaps) * halfWindow);
    const point = interpolatedPoint(route, sampleIndex);
    if (!point) continue;
    const weight = blackmanWeight(tap, halfTaps);
    lngSum += point.lng * weight;
    latSum += point.lat * weight;
    weightSum += weight;
  }

  if (weightSum <= 0) return null;
  return {
    lng: lngSum / weightSum,
    lat: latSum / weightSum,
  };
}

function visibleWidthMetersAtZoom(zoom, latitudeDeg) {
  const safeLatitude = clamp(latitudeDeg, -85, 85);
  const metersPerPixel =
    (METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos((safeLatitude * Math.PI) / 180)) /
    Math.pow(2, zoom);
  return metersPerPixel * REFERENCE_VIEWPORT_WIDTH_PX;
}

function offsetMetersFrom(from, to) {
  const lonScale = metersPerDegreeLongitude(from.lat);
  return Math.hypot(
    (to.lng - from.lng) * lonScale,
    (to.lat - from.lat) * METERS_PER_DEGREE_LATITUDE,
  );
}

function getSmoothedCameraAnchor(route, progress, smoothingHalfWindow, marker, zoom) {
  const allowanceMeters =
    visibleWidthMetersAtZoom(zoom, marker.lat) *
    MAX_MARKER_OFFSET_VIEWPORT_FRACTION;

  if (!Number.isFinite(allowanceMeters) || allowanceMeters <= 0) return marker;

  const requested = smoothRoutePosition(route, progress, smoothingHalfWindow);
  if (!requested) return marker;
  if (offsetMetersFrom(marker, requested) <= allowanceMeters) return requested;

  let tooWide = 1;
  let fits = 0;
  let best = marker;

  for (let iteration = 0; iteration < WINDOW_FIT_ITERATIONS; iteration += 1) {
    const scale = (fits + tooWide) / 2;
    const candidate = smoothRoutePosition(
      route,
      progress,
      smoothingHalfWindow * scale,
    );
    if (candidate && offsetMetersFrom(marker, candidate) <= allowanceMeters) {
      best = candidate;
      fits = scale;
    } else {
      tooWide = scale;
    }
  }

  return best;
}

function cinematicAnchorSmoothingHalfWindow(cameraStability, clipDurationSeconds) {
  if (!Number.isFinite(clipDurationSeconds) || clipDurationSeconds <= 0) return 0;

  const clamped = clamp01(
    Number.isFinite(cameraStability)
      ? cameraStability
      : DEFAULT_CAMERA_STABILITY,
  );
  const stability = 1 - clamped;
  const seconds =
    MIN_ANCHOR_SMOOTHING_SECONDS +
    (MAX_ANCHOR_SMOOTHING_SECONDS - MIN_ANCHOR_SMOOTHING_SECONDS) *
      Math.pow(stability, 1.5);

  return seconds / clipDurationSeconds;
}

function getSmoothedRouteHeading(route, progress, smoothingHalfWindow) {
  const baselineHalfWidth = Math.max(smoothingHalfWindow * 2, 0);
  const behindProgress = clamp01(progress - baselineHalfWidth);
  const aheadProgress = clamp01(progress + baselineHalfWidth);
  if (aheadProgress <= behindProgress) return null;

  const behind = smoothRoutePosition(
    route,
    behindProgress,
    smoothingHalfWindow,
  );
  const ahead = smoothRoutePosition(
    route,
    aheadProgress,
    smoothingHalfWindow,
  );
  if (!behind || !ahead) return null;
  if (behind.lng === ahead.lng && behind.lat === ahead.lat) return null;

  return bearingBetween(behind, ahead);
}

export function getTrailReplayCameraPose(
  route,
  progress,
  followBehindZoomLevel = DEFAULT_FOLLOW_BEHIND_LEVEL,
  {
    cameraMode = DEFAULT_TRAIL_REPLAY_CAMERA_MODE,
    cameraStability = DEFAULT_CAMERA_STABILITY,
    videoDurationSeconds = 30,
  } = {},
) {
  if (!route) return null;

  const mode = normalizeTrailReplayCameraMode(cameraMode);
  const p = clamp01(progress);
  const marker = route.atDistance(p * route.totalDistance)?.point;
  if (!marker) return null;

  if (mode === 'overview') return null;

  if (mode === 'follow') {
    return {
      center: marker,
      bearing: 0,
      zoom: FOLLOW_CAMERA_ZOOM,
      pitch: 0,
    };
  }

  const preset = getFollowBehindCameraTarget(followBehindZoomLevel);
  const { zoomAdjust, pitchAdjust } = terrainAdjustments(route, p);
  const zoom = Math.max(TERRAIN.MIN_ZOOM, preset.zoom - zoomAdjust);
  const pitch = Math.max(TERRAIN.MIN_PITCH, preset.pitch - pitchAdjust);

  if (mode === 'follow-behind') {
    return {
      center: marker,
      bearing: stableRouteBearing(route, p),
      zoom,
      pitch,
    };
  }

  // Cinematic: smooth the *route path* symmetrically, not the marker in time.
  // Because the entire GPX is known up front this removes rapid switchbacks
  // without introducing lag. The marker itself stays on the original route.
  const smoothingHalfWindow = cinematicAnchorSmoothingHalfWindow(
    cameraStability,
    videoDurationSeconds,
  );
  const center = getSmoothedCameraAnchor(
    route,
    p,
    smoothingHalfWindow,
    marker,
    zoom,
  );
  const bearing =
    getSmoothedRouteHeading(route, p, smoothingHalfWindow) ??
    stableRouteBearing(route, p);

  return {
    center: {
      ...center,
      ele: marker.ele,
    },
    bearing,
    zoom,
    pitch,
  };
}

export function createTrailReplayMotionState() {
  return {
    lastTimeSec: null,
    center: null,
    bearing: null,
    zoom: null,
    zoomTarget: null,
    pitch: null,
  };
}

export function resetTrailReplayMotionState(state) {
  if (!state) return;
  state.lastTimeSec = null;
  state.center = null;
  state.bearing = null;
  state.zoom = null;
  state.zoomTarget = null;
  state.pitch = null;
}

function cameraReactivityFromStability(cameraStability) {
  const value = clamp01(
    Number.isFinite(cameraStability)
      ? cameraStability
      : DEFAULT_CAMERA_STABILITY,
  );
  return 0.25 + value * 1.5;
}

function frameTimeMultiplierFromDeltaMs(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return 1;
  const clamped = Math.min(
    deltaMs,
    CAMERA_SMOOTHING_REFERENCE_FRAME_MS * 4,
  );
  return clamped / CAMERA_SMOOTHING_REFERENCE_FRAME_MS;
}

function bearingTurnReactivity(reactivity) {
  return reactivity >= 1 ? reactivity : 1 - (1 - reactivity) * 0.5;
}

function bearingDeadbandScale(reactivity) {
  return reactivity >= 1
    ? 1 / reactivity
    : Math.min(1.5, 1 / reactivity);
}

function smoothBearing(current, target, reactivity, frameTimeMultiplier) {
  if (!Number.isFinite(current)) return target;

  const diff = shortestBearingDelta(current, target);
  const deadband = 4 * bearingDeadbandScale(reactivity);
  if (Math.abs(diff) < deadband) return normalizeBearing(current);

  const speed = bearingTurnReactivity(reactivity) * frameTimeMultiplier;
  const maxChange = 0.85 * speed;
  const change = clamp(diff * 0.03 * speed, -maxChange, maxChange);
  return normalizeBearing(current + change);
}

function smoothZoom(current, target, reactivity, frameTimeMultiplier) {
  if (!Number.isFinite(current)) return target;
  const diff = target - current;
  const deadband = 0.1 / reactivity;
  if (Math.abs(diff) < deadband) return current;

  const speed = reactivity * frameTimeMultiplier;
  const maxChange = (diff < 0 ? 0.12 : 0.035) * speed;
  return current + clamp(diff * 0.12 * speed, -maxChange, maxChange);
}

function smoothZoomTarget(currentTarget, nextTarget, deltaMs, cameraStability) {
  if (!Number.isFinite(currentTarget)) return nextTarget;

  const stability = clamp01(
    Number.isFinite(cameraStability)
      ? cameraStability
      : DEFAULT_CAMERA_STABILITY,
  );
  const cinematicPosition = Math.max(0, (0.5 - stability) / 0.5);
  const cinematicAmount = cinematicPosition * cinematicPosition;

  if (cinematicAmount === 0 || !Number.isFinite(deltaMs) || deltaMs <= 0) {
    return nextTarget;
  }

  const difference = nextTarget - currentTarget;
  const deadband = 0.035 + 0.265 * cinematicAmount;
  if (Math.abs(difference) <= deadband) return currentTarget;

  const openingFrame = difference < 0;
  const responseDurationMs = openingFrame
    ? 100 + 1100 * cinematicAmount
    : 100 + 4900 * cinematicAmount;
  const interpolation = 1 - Math.exp(-deltaMs / responseDurationMs);
  return currentTarget + difference * interpolation;
}

function smoothPitch(current, target, reactivity, frameTimeMultiplier) {
  if (!Number.isFinite(current)) return target;
  const diff = target - current;
  const deadband = 0.35 / reactivity;
  if (Math.abs(diff) < deadband) return current;

  const speed = reactivity * frameTimeMultiplier;
  const maxChange = (diff < 0 ? 0.6 : 0.22) * speed;
  return current + clamp(diff * 0.12 * speed, -maxChange, maxChange);
}

function cameraCenterChaseDurationFromStability(cameraStability) {
  const value = clamp01(
    Number.isFinite(cameraStability)
      ? cameraStability
      : DEFAULT_CAMERA_STABILITY,
  );

  if (value < 0.5) {
    const cinematicAmount = (0.5 - value) / 0.5;
    return 100 + 800 * cinematicAmount * cinematicAmount;
  }

  const reactiveAmount = (value - 0.5) / 0.5;
  return 100 - 45 * reactiveAmount;
}

function smoothCoordinate(current, target, deltaMs, chaseDurationMs) {
  if (!current || !Number.isFinite(deltaMs) || deltaMs <= 0) return target;
  const t = clamp01(deltaMs / Math.max(1, chaseDurationMs));
  return {
    lng: current.lng + (target.lng - current.lng) * t,
    lat: current.lat + (target.lat - current.lat) * t,
    ele: target.ele,
  };
}

export function smoothTrailReplayCameraPose(
  state,
  targetPose,
  {
    cameraMode = DEFAULT_TRAIL_REPLAY_CAMERA_MODE,
    cameraStability = DEFAULT_CAMERA_STABILITY,
    currentTimeSec = 0,
  } = {},
) {
  if (!state || !targetPose) return targetPose;

  const mode = normalizeTrailReplayCameraMode(cameraMode);

  // TrailReplay's plain Follow mode is intentionally direct/top-down.
  if (mode === 'follow') {
    state.lastTimeSec = currentTimeSec;
    state.center = { ...targetPose.center };
    state.bearing = targetPose.bearing;
    state.zoom = targetPose.zoom;
    state.zoomTarget = targetPose.zoom;
    state.pitch = targetPose.pitch;
    return targetPose;
  }

  const deltaMs = Number.isFinite(state.lastTimeSec)
    ? Math.max(0, (currentTimeSec - state.lastTimeSec) * 1000)
    : null;

  if (
    deltaMs == null ||
    !state.center ||
    !Number.isFinite(state.bearing) ||
    !Number.isFinite(state.zoom) ||
    !Number.isFinite(state.pitch)
  ) {
    state.lastTimeSec = currentTimeSec;
    state.center = { ...targetPose.center };
    state.bearing = targetPose.bearing;
    state.zoom = targetPose.zoom;
    state.zoomTarget = targetPose.zoom;
    state.pitch = targetPose.pitch;
    return targetPose;
  }

  const reactivity = cameraReactivityFromStability(cameraStability);
  const frameMultiplier = frameTimeMultiplierFromDeltaMs(deltaMs);

  state.bearing = smoothBearing(
    state.bearing,
    targetPose.bearing,
    reactivity,
    frameMultiplier,
  );

  state.zoomTarget = smoothZoomTarget(
    state.zoomTarget,
    targetPose.zoom,
    deltaMs,
    cameraStability,
  );
  state.zoom = smoothZoom(
    state.zoom,
    state.zoomTarget,
    reactivity,
    frameMultiplier,
  );
  state.pitch = smoothPitch(
    state.pitch,
    targetPose.pitch,
    reactivity,
    frameMultiplier,
  );

  // Cinematic already uses a zero-phase spatially-smoothed anchor. Adding a
  // temporal chase would reintroduce lag, so use it directly. Follow-behind
  // keeps TrailReplay's explicit center chase.
  state.center = mode === 'cinematic'
    ? { ...targetPose.center }
    : smoothCoordinate(
        state.center,
        targetPose.center,
        deltaMs,
        cameraCenterChaseDurationFromStability(cameraStability),
      );

  state.lastTimeSec = currentTimeSec;

  return {
    center: state.center,
    bearing: state.bearing,
    zoom: state.zoom,
    pitch: state.pitch,
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
