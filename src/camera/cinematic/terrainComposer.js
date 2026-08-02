/**
 * TerrainComposer — drone-style Terrain Composition Score (TCS).
 *
 * Samples DEM in the proposed look direction and scores viewpoints for
 * landscape drama (relief, depth, ridges, panorama). Trail is a subject
 * accent, not the composition center.
 */

import { queryTerrainElevationAt } from '../../camera.js';

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function offsetLngLat(origin, forwardM, rightM, bearingDeg) {
  const rad = (bearingDeg * Math.PI) / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.cos((origin.lat * Math.PI) / 180) * 111320;
  const east = forwardM * Math.sin(rad) + rightM * Math.cos(rad);
  const north = forwardM * Math.cos(rad) - rightM * Math.sin(rad);
  return {
    lng: origin.lng + east / metersPerDegLng,
    lat: origin.lat + north / metersPerDegLat,
  };
}

/** Fixed automatic weights — no user controls. */
export const TCS_WEIGHTS = {
  elevationRange: 0.22,
  sceneDepth: 0.14,
  layerSeparation: 0.14,
  horizonSilhouette: 0.16,
  landscapeVolume: 0.12,
  canyonCliff: 0.12,
  panorama: 0.1,
};

/**
 * Probe DEM along near / mid / far rings in the look direction.
 * ~12 queries — keep budget tight for per-candidate scoring.
 *
 * @returns {{
 *   samples: Array<{ ring: string, distM: number, ele: number|null, lateral: number }>,
 *   metrics: object,
 *   compositionScore: number,
 * }}
 */
export function scoreTerrainComposition(map, eye, lookBearingDeg, subjectEle, shot = {}) {
  const hint = Number.isFinite(subjectEle) ? subjectEle : eye?.ele ?? 0;
  const bearing = lookBearingDeg ?? 0;
  const pitch = shot.pitch ?? 55;

  const rings = [
    { name: 'near', dists: [80, 140], laterals: [0, -55, 55] },
    { name: 'mid', dists: [280, 420], laterals: [0, -110, 110] },
    { name: 'far', dists: [700, 1100], laterals: [0, -180] },
  ];

  const samples = [];
  for (const ring of rings) {
    for (const distM of ring.dists) {
      for (const lateral of ring.laterals) {
        const pt = offsetLngLat(
          { lng: eye.lng, lat: eye.lat },
          distM,
          lateral,
          bearing,
        );
        const ele = queryTerrainElevationAt(map, pt.lng, pt.lat, hint);
        samples.push({ ring: ring.name, distM, ele, lateral });
      }
    }
  }

  const valid = samples.filter((s) => Number.isFinite(s.ele));
  if (valid.length < 4) {
    return {
      samples,
      metrics: {
        elevationRange: 0,
        sceneDepth: 0,
        layerSeparation: 0,
        horizonSilhouette: 0,
        landscapeVolume: 0,
        canyonCliff: 0,
        panorama: 0,
      },
      compositionScore: 0.15,
    };
  }

  const eles = valid.map((s) => s.ele);
  const minEle = Math.min(...eles);
  const maxEle = Math.max(...eles);
  const elevRangeM = maxEle - minEle;

  const byRing = { near: [], mid: [], far: [] };
  for (const s of valid) {
    byRing[s.ring]?.push(s.ele);
  }
  const ringAvg = (arr) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : hint;
  const nearAvg = ringAvg(byRing.near);
  const midAvg = ringAvg(byRing.mid);
  const farAvg = ringAvg(byRing.far);

  // Layer separation: elevation contrast across depth planes.
  const layerSepM =
    Math.abs(midAvg - nearAvg) + Math.abs(farAvg - midAvg) + Math.abs(farAvg - nearAvg) * 0.5;

  // Horizon / silhouette: far-ring relief + local peaks vs neighbors.
  const farEles = byRing.far;
  const farRelief = farEles.length
    ? Math.max(...farEles) - Math.min(...farEles)
    : 0;
  let silhouettePeaks = 0;
  for (let i = 1; i < valid.length - 1; i++) {
    if (valid[i].ring !== 'far' && valid[i].ring !== 'mid') continue;
    if (valid[i].ele > valid[i - 1].ele + 18 && valid[i].ele > valid[i + 1].ele + 18) {
      silhouettePeaks += 1;
    }
  }

  // Landscape volume: fraction of samples with meaningful slope vs flat.
  let rugged = 0;
  for (let i = 1; i < valid.length; i++) {
    if (Math.abs(valid[i].ele - valid[i - 1].ele) > 12) rugged += 1;
  }
  const ruggedFrac = rugged / Math.max(1, valid.length - 1);

  // Canyon / cliff: lateral gradients or walls above subject.
  let lateralGrad = 0;
  let lateralCount = 0;
  for (const s of valid) {
    if (s.lateral === 0) continue;
    const center = valid.find(
      (o) => o.ring === s.ring && o.distM === s.distM && o.lateral === 0,
    );
    if (center && Number.isFinite(center.ele)) {
      lateralGrad += Math.abs(s.ele - center.ele);
      lateralCount += 1;
    }
  }
  const avgLateralGrad = lateralCount > 0 ? lateralGrad / lateralCount : 0;
  const wallsAbove = Math.max(0, maxEle - (subjectEle ?? hint));

  // Scene depth proxy: how far we still see meaningful terrain variation.
  const farOk = farEles.length >= 2;
  const midOk = byRing.mid.length >= 2;
  const sceneDepth = (farOk ? 0.55 : 0) + (midOk ? 0.3 : 0) + (elevRangeM > 80 ? 0.15 : 0);

  // Panorama: open far field + lower pitch favors wide reveals.
  const panorama =
    (farOk ? 0.45 : 0.1) +
    clamp((farRelief - 40) / 200, 0, 0.35) +
    clamp((55 - pitch) / 40, 0, 0.25);

  // Flat low basin proxy (lake-ish) — mild bonus when a mid/far pocket is flat & low.
  let basinBonus = 0;
  if (byRing.mid.length >= 2) {
    const midMin = Math.min(...byRing.mid);
    const midMax = Math.max(...byRing.mid);
    if (midMax - midMin < 25 && midMin < (subjectEle ?? hint) - 40) {
      basinBonus = 0.08;
    }
  }

  const metrics01 = {
    elevationRange: clamp(elevRangeM / 350, 0, 1),
    sceneDepth: clamp(sceneDepth, 0, 1),
    layerSeparation: clamp(layerSepM / 280, 0, 1),
    horizonSilhouette: clamp(farRelief / 220 + silhouettePeaks * 0.12, 0, 1),
    landscapeVolume: clamp(ruggedFrac * 1.15, 0, 1),
    canyonCliff: clamp(avgLateralGrad / 120 + wallsAbove / 400, 0, 1),
    panorama: clamp(panorama + basinBonus, 0, 1),
  };

  let compositionScore = 0;
  for (const [key, w] of Object.entries(TCS_WEIGHTS)) {
    compositionScore += w * (metrics01[key] ?? 0);
  }
  compositionScore = clamp(compositionScore, 0, 1);

  return {
    samples,
    metrics: metrics01,
    compositionScore,
    elevRangeM,
  };
}

/**
 * Trail composition-region score: pin visible as accent, not centered.
 * Prefers lower-third / rule-of-thirds bands (drone cinematography).
 */
export function scoreTrailInFrame(map, actorPoint, options = {}) {
  if (!map || !actorPoint) return 0.4;
  try {
    const canvas = map.getCanvas?.();
    const w = canvas?.clientWidth || canvas?.width || 0;
    const h = canvas?.clientHeight || canvas?.height || 0;
    if (w < 32 || h < 32) return 0.4;

    const p = map.project([actorPoint.lng, actorPoint.lat]);
    const margin = options.margin ?? 0.03;
    const onScreen =
      p.x >= w * margin &&
      p.x <= w * (1 - margin) &&
      p.y >= h * margin &&
      p.y <= h * (1 - margin);

    if (!onScreen) {
      const near =
        p.x >= -w * 0.12 &&
        p.x <= w * 1.12 &&
        p.y >= -h * 0.12 &&
        p.y <= h * 1.12;
      return near ? 0.12 : 0;
    }

    const nx = p.x / w;
    const ny = p.y / h;
    // Rule-of-thirds vertical band (lower third preferred for trail accent).
    const thirdsY = 1 - Math.min(Math.abs(ny - 0.66), Math.abs(ny - 0.5)) / 0.5;
    const thirdsX = 1 - Math.min(Math.abs(nx - 0.33), Math.abs(nx - 0.67), Math.abs(nx - 0.5)) / 0.5;
    // Penalize dead-center strongly — landscape should own the frame.
    const centerPenalty = Math.hypot(nx - 0.5, ny - 0.45) < 0.1 ? 0.25 : 0;
    return clamp(0.35 + thirdsY * 0.35 + thirdsX * 0.25 - centerPenalty, 0, 1);
  } catch {
    return 0.4;
  }
}

/**
 * Approximate trail-in-frame without jumping the map: actor relative to lookAt
 * along camera bearing → expected screen bias (lower / side).
 */
export function estimateTrailCompositionFromLookAt(actorPoint, lookAt, bearingDeg) {
  if (!actorPoint || !lookAt) return 0.45;
  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.cos((actorPoint.lat * Math.PI) / 180) * 111320;
  const east = (actorPoint.lng - lookAt.lng) * metersPerDegLng;
  const north = (actorPoint.lat - lookAt.lat) * metersPerDegLat;
  const rad = ((bearingDeg ?? 0) * Math.PI) / 180;
  // Forward = along bearing from lookAt toward horizon; actor behind lookAt → lower frame.
  const forward = east * Math.sin(rad) + north * Math.cos(rad);
  const right = east * Math.cos(rad) - north * Math.sin(rad);
  const behind = -forward; // positive if actor is behind look-at (good accent)
  const behindScore = clamp(behind / 140, 0, 1);
  const sideScore = clamp(Math.abs(right) / 100, 0, 1) * 0.5;
  // Too far off → pin will leave frame.
  const dist = Math.hypot(east, north);
  if (dist > 320) return 0.15;
  return clamp(0.35 + behindScore * 0.4 + sideScore * 0.25, 0, 1);
}

export function createTerrainComposer() {
  return {
    scoreTerrainComposition,
    scoreTrailInFrame,
    estimateTrailCompositionFromLookAt,
    weights: TCS_WEIGHTS,
  };
}
