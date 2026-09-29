import {
  formatDistance,
  formatDuration,
  formatElevation,
  formatPace,
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
  const recordedSpeedMps = route.recordedSpeedAtDistance?.(playbackFrame.animDistance) ?? null;
  const recordedElapsedSec =
    route.hasTime &&
    Number.isFinite(playbackFrame.sample?.point?.time) &&
    Number.isFinite(route.raw?.[0]?.time)
      ? Math.max(0, (playbackFrame.sample.point.time - route.raw[0].time) / 1000)
      : playbackFrame.animTime;

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
      recordedSpeed: recordedSpeedMps == null ? '—' : formatSpeed(recordedSpeedMps),
      pace: recordedSpeedMps == null ? '—' : formatPace(recordedSpeedMps),
      elevation: formatElevation(playbackFrame.sample?.point?.ele),
      elevationGain: formatElevation(route.elevationGainAtDistance?.(playbackFrame.animDistance) ?? 0),
      recordedTime: formatDuration(recordedElapsedSec),
      progress: progressPct,
      duration: formatDuration(playbackFrame.duration),
      timeline,
      chartProgress: progress,
    },
  };
}

