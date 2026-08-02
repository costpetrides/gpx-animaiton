/**
 * ViewpointGenerator — terrain-first camera candidates.
 * Look-at targets landscape features; trail bearing only biases orbit side.
 */

import { normalizeCameraStyle, readCameraControlRig } from '../rig.js';
import {
  SHOT_TYPE,
  SHOT_PRIORS,
  selectShotType,
} from './shotTypes.js';
import {
  featuresNearDistance,
  resolveLandscapeLookAt,
} from './terrainFeatures.js';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeBearing(deg) {
  return ((deg % 360) + 360) % 360;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Seed framing from shot grammar + landscape look-at.
 */
export function proposeIdealFraming(context, sample, options = {}) {
  const controls = readCameraControlRig(options.rig || {});
  const style = normalizeCameraStyle(controls.cameraStyle);
  const side = options.orbitSide === -1 ? -1 : 1;
  const trailBearing = context?.lookaheadBearing ?? sample?.bearing ?? 0;
  const near = options.nearFeatures || featuresNearDistance(options.featureGraph, options.animDistance ?? 0);
  const shotType = options.shotType || selectShotType(context, near);
  const priors = { ...SHOT_PRIORS[shotType] };

  // Style overlay (aerial pulls slightly wider — still close to trail).
  if (style === 'aerial') {
    priors.zoom = Math.min(priors.zoom, 13.2);
    priors.altitudeM = Math.max(priors.altitudeM, 210);
    priors.pitch = Math.min(priors.pitch, 50);
  } else if (style === 'intimate') {
    priors.zoom = Math.min(15.2, priors.zoom + 0.5);
    priors.altitudeM *= 0.85;
  }

  let orbitDeg = priors.orbitDeg;
  if (Number.isFinite(options.stickyOrbitDeg)) {
    orbitDeg = lerp(options.stickyOrbitDeg, orbitDeg, 0.06);
  }

  const lookBearing = normalizeBearing(trailBearing + orbitDeg * side);
  const lookAt = resolveLandscapeLookAt(sample.point, lookBearing, priors, near, side);

  return {
    mode: 'cinematic',
    shotType,
    pitch: clamp(priors.pitch, 44, 68),
    zoom: clamp(priors.zoom, 12.8, 15.4),
    altitudeM: clamp(priors.altitudeM, 90, 320),
    bearingDeg: lookBearing,
    relativeBearing: 0,
    lookAtLng: lookAt.lng,
    lookAtLat: lookAt.lat,
    lookAtEle: lookAt.ele,
    lookAtSource: lookAt.source,
    focusForwardM: priors.lookAtForwardM,
    focusRightM: priors.lookAtRightM * side,
    forwardOffsetM: priors.lookAtForwardM,
    rightOffsetM: priors.lookAtRightM * side,
    orbitDeg,
    orbitSide: side,
  };
}

/**
 * Build ≤14 feature-biased drone viewpoints.
 */
export function buildCompositionCandidates(baseShot, sample, context = {}, options = {}) {
  const trailBearing = sample?.bearing ?? baseShot.bearingDeg ?? 0;
  const side = baseShot.orbitSide === -1 ? -1 : 1;
  const near = options.nearFeatures || {};
  const shotType = baseShot.shotType || selectShotType(context, near);
  const out = [];

  const preferAcross = shotType === SHOT_TYPE.VALLEY || Boolean(near.hasValley) || (context?.reliefM ?? 0) > 140;
  const preferWide = shotType === SHOT_TYPE.SUMMIT || shotType === SHOT_TYPE.ESTABLISH || Boolean(near.hasPeak);

  const orbits = preferAcross
    ? [85 * side, 105 * side, 60 * -side, 95 * side, 45 * side, 110 * -side]
    : [40 * side, 65 * side, 35 * -side, 85 * side, 55 * side, 100 * -side];

  const lifts = preferWide ? [1.0, 1.25, 1.55, 1.9] : [0.95, 1.15, 1.4, 1.7];
  const pitches = preferWide ? [48, 52, 56, 60] : [54, 58, 60, 64];

  let i = 0;
  for (const orbit of orbits) {
    for (let li = 0; li < lifts.length; li++) {
      if (out.length >= 14) return out;
      const lookBearing = normalizeBearing(trailBearing + orbit);
      const priors = {
        lookAtForwardM: 30 + li * 14,
        lookAtRightM: 18 + (i % 3) * 12,
      };
      const lookAt = resolveLandscapeLookAt(sample.point, lookBearing, priors, near, orbit >= 0 ? 1 : -1);
      out.push({
        ...baseShot,
        shotType,
        bearingDeg: lookBearing,
        altitudeM: clamp((baseShot.altitudeM ?? 140) * lifts[li], 90, 320),
        zoom: clamp((baseShot.zoom ?? 14.2) - li * 0.18, 12.8, 15.4),
        pitch: clamp(pitches[li % pitches.length], 44, 68),
        lookAtLng: lookAt.lng,
        lookAtLat: lookAt.lat,
        lookAtEle: lookAt.ele,
        lookAtSource: lookAt.source,
        focusForwardM: priors.lookAtForwardM,
        focusRightM: priors.lookAtRightM * (orbit >= 0 ? 1 : -1),
        orbitDeg: Math.abs(orbit),
        orbitSide: orbit >= 0 ? 1 : -1,
      });
      i += 1;
    }
  }
  return out;
}

export function buildVisibilityCandidates(baseShot, sample) {
  return buildCompositionCandidates(baseShot, sample, {});
}

export function createCameraPathOptimizer() {
  return {
    proposeIdealFraming,
    buildCompositionCandidates,
    buildVisibilityCandidates,
  };
}
