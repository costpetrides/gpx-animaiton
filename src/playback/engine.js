import { estimateSpeed } from '../route.js';
import { DEFAULT_SPEED_MPS } from './constants.js';

export { DEFAULT_SPEED_MPS, PLAYBACK_TIME_COMPRESSION } from './constants.js';

/**
 * Animation length at 1× from route length only (even speed).
 * Ignores GPX timestamps / recorded pace.
 */
export function getBaseAnimationDuration(route) {
  if (!route || !(route.totalDistance > 0)) return 1 / DEFAULT_SPEED_MPS;
  return route.totalDistance / DEFAULT_SPEED_MPS;
}

export function getPlaybackDuration(route, speedMul = 1) {
  const mul = Math.max(Number(speedMul) || 1, 0.001);
  return getBaseAnimationDuration(route) / mul;
}

export function clampPlaybackDistance(route, distance) {
  if (!route) return 0;
  return Math.max(0, Math.min(distance, route.totalDistance));
}

export function clampPlaybackTime(route, time, speedMul = 1) {
  return Math.max(0, Math.min(time, getPlaybackDuration(route, speedMul)));
}

export function createPlaybackState(route, state = {}, speedMul = 1) {
  const nextDistance =
    state.animDistance ?? ((state.progress ?? 0) * (route?.totalDistance ?? 0));

  return {
    animTime: clampPlaybackTime(route, state.animTime ?? 0, speedMul),
    animDistance: clampPlaybackDistance(route, nextDistance),
    currentSpeed: 0,
  };
}

export function seekPlaybackProgress(route, pct, speedMul = 1) {
  if (!route) {
    return {
      animTime: 0,
      animDistance: 0,
    };
  }

  const progress = Math.max(0, Math.min(1, pct));
  return {
    animTime: clampPlaybackTime(route, progress * getPlaybackDuration(route, speedMul), speedMul),
    animDistance: clampPlaybackDistance(route, progress * route.totalDistance),
  };
}

/**
 * Advance along the route at a constant distance rate.
 * Position is always sampled by distance — never by GPX time.
 */
export function samplePlaybackFrame(route, playbackState, dt, speedMul = 1) {
  if (!route) return null;

  const mul = Math.max(Number(speedMul) || 1, 0.001);
  const nextAnimTime = playbackState.animTime + dt;
  const previousDistance = playbackState.animDistance;
  const duration = getPlaybackDuration(route, mul);

  const animDistance = clampPlaybackDistance(
    route,
    nextAnimTime * DEFAULT_SPEED_MPS * mul,
  );
  const sample = route.atDistance(animDistance);
  const currentSpeed = estimateSpeed(route, animDistance, previousDistance, dt);
  const done = nextAnimTime >= duration || animDistance >= route.totalDistance;

  return {
    animTime: done ? Math.min(nextAnimTime, duration) : nextAnimTime,
    animDistance,
    currentSpeed,
    sample,
    duration,
    done,
    progress: route.totalDistance > 0 ? animDistance / route.totalDistance : 0,
  };
}
