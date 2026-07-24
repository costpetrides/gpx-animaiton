import { estimateSpeed } from '../route.js';
import {
  DEFAULT_SPEED_MPS,
  PLAYBACK_TIME_COMPRESSION,
} from './constants.js';

export { DEFAULT_SPEED_MPS, PLAYBACK_TIME_COMPRESSION };

/** Animation length at 1× before applying the UI speed multiplier. */
export function getBaseAnimationDuration(route) {
  if (!route) return 1;
  if (route.hasTime) {
    return Math.max(route.duration / PLAYBACK_TIME_COMPRESSION, 1 / PLAYBACK_TIME_COMPRESSION);
  }
  return Math.max(route.totalDistance / DEFAULT_SPEED_MPS, 1 / PLAYBACK_TIME_COMPRESSION);
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

/** Map animation clock → GPX timeline seconds (timed routes). */
function animationTimeToRouteTime(animTime, speedMul = 1) {
  return animTime * Math.max(Number(speedMul) || 1, 0.001) * PLAYBACK_TIME_COMPRESSION;
}

export function samplePlaybackFrame(route, playbackState, dt, speedMul = 1) {
  if (!route) return null;

  const mul = Math.max(Number(speedMul) || 1, 0.001);
  const nextAnimTime = playbackState.animTime + dt;
  const previousDistance = playbackState.animDistance;

  let animDistance;
  let sample;

  if (route.hasTime) {
    const routeTime = animationTimeToRouteTime(nextAnimTime, mul);
    sample = route.atTime(routeTime);
    animDistance = route.distanceAtTime(routeTime);
  } else {
    animDistance = Math.min(
      nextAnimTime * DEFAULT_SPEED_MPS * mul,
      route.totalDistance,
    );
    sample = route.atDistance(animDistance);
  }

  const currentSpeed = estimateSpeed(route, animDistance, previousDistance, dt);
  const duration = getPlaybackDuration(route, mul);
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
