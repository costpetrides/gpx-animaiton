import { estimateSpeed } from '../route.js';
import { DEFAULT_SPEED_MPS } from './constants.js';

export { DEFAULT_SPEED_MPS };

export function getPlaybackDuration(route, speedMul = 1) {
  if (!route) return 1;
  return route.hasTime
    ? route.duration / speedMul
    : route.totalDistance / DEFAULT_SPEED_MPS / speedMul;
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

  return {
    animTime: clampPlaybackTime(route, pct * getPlaybackDuration(route, speedMul), speedMul),
    animDistance: clampPlaybackDistance(route, pct * route.totalDistance),
  };
}

export function samplePlaybackFrame(route, playbackState, dt, speedMul = 1) {
  if (!route) return null;

  const nextAnimTime = playbackState.animTime + dt;
  const previousDistance = playbackState.animDistance;

  let animDistance;
  let sample;

  if (route.hasTime) {
    sample = route.atTime(nextAnimTime * speedMul);
    animDistance = route.distanceAtTime(nextAnimTime * speedMul);
  } else {
    animDistance = Math.min(
      nextAnimTime * DEFAULT_SPEED_MPS * speedMul,
      route.totalDistance,
    );
    sample = route.atDistance(animDistance);
  }

  const currentSpeed = estimateSpeed(route, animDistance, previousDistance, dt);
  const duration = getPlaybackDuration(route, speedMul);
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

