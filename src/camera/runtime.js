import { applyShot, defaultShotForMode } from '../camera.js';

export function createCameraRuntimeState(preset = 'cinematic', shot = null) {
  return {
    preset,
    shot: shot || defaultShotForMode(preset),
    terrainGuard: {
      enabled: true,
      minClearanceM: 40,
      sampleRadiusM: 70,
      sampleCount: 10,
      lastEnvelopeM: null,
      smoothedElevationM: null,
      elevationSmoothing: 0.18,
      // MapLibre terrain streaming is extremely sensitive to rapid bearing
      // changes (it changes the visible frustum -> new tiles).
      // This "bearingGuard" keeps the camera direction stable during playback.
      bearingGuard: {
        enabled: true,
        lastBearingDeg: null,
        maxDeltaDegPerUpdate: 2.5,
        minDeltaDeg: 0.8,
      },
    },
  };
}

export function resolveCameraFrame(frameState, cameraState) {
  if (!frameState?.sample || !cameraState) return null;
  const shot = cameraState.shot || defaultShotForMode(cameraState.preset);
  return {
    sample: frameState.sample,
    shot,
    terrainGuard: cameraState.terrainGuard,
  };
}

export function applyCameraFrame(
  map,
  cameraFrame,
  { continuous = false, durationMs = 180 } = {},
) {
  if (!cameraFrame) return;
  return applyShot(map, cameraFrame.shot, cameraFrame.sample, {
    continuous,
    durationMs,
    terrainGuard: cameraFrame.terrainGuard,
  });
}

