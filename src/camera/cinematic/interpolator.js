/**
 * CameraInterpolator — cinematic smoothing with vista dwell.
 */

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  const delta = ((b - a + 540) % 360) - 180;
  return a + delta * t;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function clampAngleStep(from, to, maxDelta) {
  const delta = ((to - from + 540) % 360) - 180;
  return from + clamp(delta, -maxDelta, maxDelta);
}

export function createCameraInterpolator(options = {}) {
  let baseAlpha = options.alpha ?? 0.055;
  let current = null;

  function setSmoothness(smoothness01 = 0.7) {
    // High smoothness → slower chase; low → more responsive.
    const s = clamp(smoothness01, 0, 1);
    baseAlpha = lerp(0.12, 0.028, s);
  }

  function reset(shot = null) {
    current = shot ? { ...shot } : null;
  }

  function step(targetShot, opts = {}) {
    if (!targetShot) return current;
    if (!current) {
      current = { ...targetShot };
      return { ...current };
    }

    if (Number.isFinite(opts.smoothness)) setSmoothness(opts.smoothness);

    // Dwell on dramatic vistas — slower bearing/altitude chase.
    const dwellMul = opts.dwell ? 0.62 : 1;
    const alpha = clamp(
      baseAlpha * (opts.continuous ? 1 : 2.4) * Math.min(opts.boost ?? 1, 1.35) * dwellMul,
      0.018,
      0.2,
    );
    const maxBearingStep = opts.continuous ? (opts.dwell ? 1.4 : 1.8) : 8;
    const nextBearing = clampAngleStep(
      current.bearingDeg ?? targetShot.bearingDeg ?? 0,
      targetShot.bearingDeg ?? 0,
      maxBearingStep,
    );

    current = {
      ...current,
      ...targetShot,
      pitch: lerp(current.pitch ?? targetShot.pitch, targetShot.pitch, alpha * 0.85),
      zoom: lerp(current.zoom ?? targetShot.zoom, targetShot.zoom, alpha * 0.65),
      altitudeM: lerp(
        current.altitudeM ?? targetShot.altitudeM,
        targetShot.altitudeM,
        alpha * 0.55,
      ),
      bearingDeg: lerpAngle(
        current.bearingDeg ?? targetShot.bearingDeg ?? 0,
        nextBearing,
        alpha * 0.55,
      ),
      lookAtLng: Number.isFinite(targetShot.lookAtLng)
        ? lerp(
            Number.isFinite(current.lookAtLng) ? current.lookAtLng : targetShot.lookAtLng,
            targetShot.lookAtLng,
            alpha * 0.65,
          )
        : current.lookAtLng,
      lookAtLat: Number.isFinite(targetShot.lookAtLat)
        ? lerp(
            Number.isFinite(current.lookAtLat) ? current.lookAtLat : targetShot.lookAtLat,
            targetShot.lookAtLat,
            alpha * 0.65,
          )
        : current.lookAtLat,
      lookAtEle: Number.isFinite(targetShot.lookAtEle)
        ? lerp(
            Number.isFinite(current.lookAtEle) ? current.lookAtEle : targetShot.lookAtEle,
            targetShot.lookAtEle,
            alpha * 0.55,
          )
        : current.lookAtEle,
      lookAtSource: targetShot.lookAtSource ?? current.lookAtSource,
      shotType: targetShot.shotType ?? current.shotType,
      focusForwardM: lerp(
        current.focusForwardM ?? targetShot.focusForwardM ?? 0,
        targetShot.focusForwardM ?? 0,
        alpha * 0.7,
      ),
      focusRightM: lerp(
        current.focusRightM ?? targetShot.focusRightM ?? 0,
        targetShot.focusRightM ?? 0,
        alpha * 0.7,
      ),
      forwardOffsetM: lerp(
        current.forwardOffsetM ?? targetShot.forwardOffsetM ?? 0,
        targetShot.forwardOffsetM ?? 0,
        alpha * 0.7,
      ),
      rightOffsetM: lerp(
        current.rightOffsetM ?? targetShot.rightOffsetM ?? 0,
        targetShot.rightOffsetM ?? 0,
        alpha * 0.7,
      ),
      relativeBearing: 0,
      mode: 'cinematic',
    };

    return { ...current };
  }

  return {
    reset,
    step,
    setSmoothness,
    getCurrent: () => (current ? { ...current } : null),
  };
}
