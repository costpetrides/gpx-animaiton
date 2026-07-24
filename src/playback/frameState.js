import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatSpeed,
} from '../gpx.js';

export function createFrameState({
  routeName,
  route,
  playbackFrame,
}) {
  if (!route || !playbackFrame) return null;

  const progress = route.totalDistance > 0
    ? playbackFrame.animDistance / route.totalDistance
    : 0;
  const timeline = progress * 1000;
  const progressPct = Math.round(progress * 100);
  const cadenceTick = Math.floor(playbackFrame.animTime * 15);

  return {
    routeName,
    route,
    playback: {
      animTime: playbackFrame.animTime,
      animDistance: playbackFrame.animDistance,
      currentSpeed: playbackFrame.currentSpeed,
      duration: playbackFrame.duration,
      done: playbackFrame.done,
      progress,
      progressPct,
      timeline,
      cadenceTick,
    },
    sample: playbackFrame.sample,
    hud: {
      distance: formatDistance(playbackFrame.animDistance),
      total: formatDistance(route.totalDistance),
      speed: formatSpeed(playbackFrame.currentSpeed),
      elevation: formatElevation(playbackFrame.sample?.point?.ele),
      progress: progressPct,
      duration: formatDuration(playbackFrame.duration),
      timeline,
      chartProgress: progress,
    },
  };
}

