import { estimateSpeed } from '../route.js';
import {
  CINEMATIC_GROUND_MPS,
  DEFAULT_SPEED_MPS,
  MAX_ANIMATION_DURATION_SEC,
  MIN_ANIMATION_DURATION_SEC,
  PLAYBACK_TIME_COMPRESSION,
} from './constants.js';

export {
  CINEMATIC_GROUND_MPS,
  DEFAULT_SPEED_MPS,
  PLAYBACK_TIME_COMPRESSION,
};

/**
 * Animation length at 1× — always distance-paced for cinematic video.
 * GPS timestamps no longer dictate flythrough length (that made short
 * recordings scream through the trail in seconds).
 */
export function getBaseAnimationDuration(route) {
  if (!route?.totalDistance) return MIN_ANIMATION_DURATION_SEC;
  const byDistance = route.totalDistance / CINEMATIC_GROUND_MPS;
  return Math.max(
    MIN_ANIMATION_DURATION_SEC,
    Math.min(MAX_ANIMATION_DURATION_SEC, byDistance),
  );
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

  return {
    animTime: clampPlaybackTime(route, pct * getPlaybackDuration(route, speedMul), speedMul),
    animDistance: clampPlaybackDistance(route, pct * route.totalDistance),
  };
}

/**
 * Advance the subject along the trail by distance (even, cinematic pacing).
 */
export function samplePlaybackFrame(route, playbackState, dt, speedMul = 1) {
  if (!route) return null;

  const mul = Math.max(Number(speedMul) || 1, 0.001);
  const duration = getPlaybackDuration(route, mul);
  const nextAnimTime = playbackState.animTime + dt;
  const previousDistance = playbackState.animDistance;

  // Pace by fraction of route so duration clamps still land exactly at the end.
  const progress = duration > 0 ? Math.min(1, nextAnimTime / duration) : 1;
  const animDistance = clampPlaybackDistance(route, progress * route.totalDistance);
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
