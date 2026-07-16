import { CAMERA_PRESETS, normalizeCameraPreset } from '../camera.js';

export const CAMERA_MODES = ['follow', 'bird'];
export const BEARING_MODES = ['north-true', 'route', 'fixed'];

export const AVO_CAMERA_LIMITS = {
  altitude: { min: 0, max: 1500, step: 1, default: 80 },
  tilt: { min: 0, max: 80, step: 1, default: 48 },
  focusForward: { min: -120, max: 200, step: 1, default: 0 },
  focusRight: { min: -120, max: 120, step: 1, default: 0 },
};

export function createDefaultCameraRig(preset = 'follow') {
  const mode = preset === 'bird' ? 'bird' : 'follow';
  const p = CAMERA_PRESETS[mode];
  const tilt = Math.min(AVO_CAMERA_LIMITS.tilt.max, p.pitch);
  return {
    altitudeM: AVO_CAMERA_LIMITS.altitude.default,
    tiltDeg: tilt,
    pitchDeg: tilt,
    distanceM: Math.abs(p.forwardOffsetM) || 18,
    forwardOffsetM: p.forwardOffsetM,
    rightOffsetM: p.rightOffsetM,
    bearingMode: 'north-true',
    bearingDeg: p.bearingDeg ?? 0,
    relativeBearing: p.relativeBearing ?? 0,
    zoom: p.zoom,
    focusForwardM: 0,
    focusRightM: 0,
    smoothing: { position: 0.8, bearing: 0.6, elevation: 0.7 },
  };
}

export function rigFromPreset(preset) {
  return createDefaultCameraRig(preset);
}

export function rigToShot(rig, preset = 'follow') {
  const bearingMode = rig.bearingMode || 'north-true';
  const tilt = Number.isFinite(rig.tiltDeg) ? rig.tiltDeg : (rig.pitchDeg ?? 48);
  const focusForward = Number.isFinite(rig.focusForwardM)
    ? rig.focusForwardM
    : (Number.isFinite(rig.forwardOffsetM) ? rig.forwardOffsetM : -Math.max(0, rig.distanceM));
  const focusRight = Number.isFinite(rig.focusRightM)
    ? rig.focusRightM
    : (rig.rightOffsetM ?? 0);

  return {
    mode: preset,
    zoom: rig.zoom,
    pitch: Math.max(AVO_CAMERA_LIMITS.tilt.min, Math.min(AVO_CAMERA_LIMITS.tilt.max, tilt)),
    forwardOffsetM: focusForward,
    rightOffsetM: focusRight,
    focusForwardM: focusForward,
    focusRightM: focusRight,
    relativeBearing: bearingMode === 'route' ? (rig.relativeBearing ?? 0) : 0,
    bearingDeg: bearingMode === 'fixed'
      ? (rig.bearingDeg ?? 0)
      : bearingMode === 'north-true'
        ? 0
        : null,
    saved: Boolean(rig.saved),
    altitudeM: Math.max(
      AVO_CAMERA_LIMITS.altitude.min,
      Math.min(AVO_CAMERA_LIMITS.altitude.max, rig.altitudeM ?? AVO_CAMERA_LIMITS.altitude.default),
    ),
  };
}

export function shotToRig(shot, preset = 'follow') {
  const base = createDefaultCameraRig(preset);
  if (!shot) return base;
  return {
    ...base,
    pitchDeg: shot.pitch ?? base.pitchDeg,
    tiltDeg: shot.pitch ?? base.tiltDeg,
    zoom: shot.zoom ?? base.zoom,
    forwardOffsetM: shot.forwardOffsetM ?? base.forwardOffsetM,
    rightOffsetM: shot.rightOffsetM ?? base.rightOffsetM,
    distanceM: Math.abs(shot.forwardOffsetM ?? base.forwardOffsetM),
    relativeBearing: shot.relativeBearing ?? base.relativeBearing,
    bearingDeg: shot.bearingDeg ?? base.bearingDeg,
    bearingMode: shot.bearingDeg != null ? 'fixed' : (shot.relativeBearing ? 'route' : 'north-true'),
    saved: Boolean(shot.saved),
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function interpolateRig(rigA, rigB, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    ...rigA,
    altitudeM: lerp(rigA.altitudeM, rigB.altitudeM, clamped),
    tiltDeg: lerp(rigA.tiltDeg, rigB.tiltDeg, clamped),
    pitchDeg: lerp(rigA.pitchDeg, rigB.pitchDeg, clamped),
    distanceM: lerp(rigA.distanceM, rigB.distanceM, clamped),
    forwardOffsetM: lerp(rigA.forwardOffsetM, rigB.forwardOffsetM, clamped),
    rightOffsetM: lerp(rigA.rightOffsetM, rigB.rightOffsetM, clamped),
    bearingDeg: lerp(rigA.bearingDeg, rigB.bearingDeg, clamped),
    relativeBearing: lerp(rigA.relativeBearing, rigB.relativeBearing, clamped),
    zoom: lerp(rigA.zoom, rigB.zoom, clamped),
    focusForwardM: lerp(rigA.focusForwardM, rigB.focusForwardM, clamped),
    focusRightM: lerp(rigA.focusRightM, rigB.focusRightM, clamped),
    bearingMode: clamped < 0.5 ? rigA.bearingMode : rigB.bearingMode,
    smoothing: rigA.smoothing,
  };
}

export function resolveRigAtTime(baseRig, keyframes, animTime, duration) {
  if (!keyframes?.length || duration <= 0) return baseRig;

  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  if (animTime <= sorted[0].time) return { ...baseRig, ...sorted[0].rig };
  if (animTime >= sorted[sorted.length - 1].time) {
    return { ...baseRig, ...sorted[sorted.length - 1].rig };
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (animTime >= a.time && animTime <= b.time) {
      const span = b.time - a.time;
      const t = span > 0 ? (animTime - a.time) / span : 0;
      return interpolateRig({ ...baseRig, ...a.rig }, { ...baseRig, ...b.rig }, t);
    }
  }

  return baseRig;
}
