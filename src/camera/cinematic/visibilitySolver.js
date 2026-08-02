/**
 * VisibilitySolver — terrain line-of-sight between camera eye and subject.
 */

import { queryTerrainElevationAt } from '../../camera.js';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Approximate MapLibre camera eye from jumpTo-style parameters.
 * Camera sits behind the focal center opposite to bearing.
 */
export function estimateCameraEye(center, bearingDeg, pitchDeg, elevationM, groundEleHint = null) {
  const pitch = Math.max(8, Math.min(85, pitchDeg));
  const ground = Number.isFinite(groundEleHint) ? groundEleHint : 0;
  const heightAbove = Math.max(12, elevationM - ground);
  const groundDist = heightAbove / Math.tan((pitch * Math.PI) / 180);
  const backBearing = ((bearingDeg + 180) % 360 + 360) % 360;
  const rad = (backBearing * Math.PI) / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.cos((center.lat * Math.PI) / 180) * 111320;
  return {
    lng: center.lng + (Math.sin(rad) * groundDist) / metersPerDegLng,
    lat: center.lat + (Math.cos(rad) * groundDist) / metersPerDegLat,
    ele: elevationM,
  };
}

/**
 * @returns {{ clear: boolean, blockedFraction: number, maxIntrusionM: number }}
 */
export function testLineOfSight(map, eye, target, options = {}) {
  const samples = options.samples ?? 5;
  const marginM = options.marginM ?? 12;
  if (!eye || !target || !map) {
    return { clear: true, blockedFraction: 0, maxIntrusionM: 0 };
  }

  let blocked = 0;
  let maxIntrusionM = 0;
  const hint = Number.isFinite(target.ele) ? target.ele : eye.ele;

  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    // Skip near endpoints — DEM noise / subject clearance.
    if (t < 0.12 || t > 0.88) continue;
    const lng = lerp(eye.lng, target.lng, t);
    const lat = lerp(eye.lat, target.lat, t);
    const lineEle = lerp(eye.ele, target.ele ?? eye.ele, t);
    const terrainEle = queryTerrainElevationAt(map, lng, lat, hint);
    if (terrainEle == null) continue;
    const intrusion = terrainEle - (lineEle - marginM);
    if (intrusion > 0) {
      blocked += 1;
      maxIntrusionM = Math.max(maxIntrusionM, intrusion);
    }
  }

  const tested = Math.max(1, samples - 2);
  const blockedFraction = blocked / tested;
  return {
    clear: blockedFraction < 0.12 && maxIntrusionM < 25,
    blockedFraction,
    maxIntrusionM,
  };
}

export function createVisibilitySolver() {
  return {
    estimateCameraEye,
    testLineOfSight,
  };
}
