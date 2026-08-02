/**
 * CameraDirector — Terrain-Aware Cinematic Director.
 *
 * Landscape look-at is primary; trail is a composition accent.
 * Shot grammar + feature graph + TCS + LOS + film-time dwell.
 */

import { analyzeTrailContext } from './context.js';
import { createVisibilitySolver } from './visibilitySolver.js';
import { createTerrainCollisionSolver } from './terrainCollision.js';
import { createCameraPathOptimizer } from './pathOptimizer.js';
import { createCameraInterpolator } from './interpolator.js';
import {
  scoreTerrainComposition,
  scoreTrailInFrame,
  estimateTrailCompositionFromLookAt,
} from './terrainComposer.js';
import {
  extractTerrainFeatures,
  featuresNearDistance,
  featureAffinityScore,
  createEmptyFeatureGraph,
} from './terrainFeatures.js';
import {
  SHOT_DWELL_SEC,
  selectShotType,
  shotGrammarScore,
} from './shotTypes.js';
import { queryTerrainElevationAt } from '../../camera.js';
import { readCameraControlRig } from '../rig.js';

const SCORE_WEIGHTS = {
  composition: 0.42,
  los: 0.2,
  trail: 0.12,
  grammar: 0.1,
  stability: 0.1,
  feature: 0.06,
};

const STICKY_MARGIN = 0.12;
const HUNT_EVERY_FRAMES = 14;

function estimateAbsoluteElevation(groundHint, shot) {
  const pitch = Math.max(0, shot.pitch ?? 56);
  const zoom = shot.zoom ?? 14.2;
  return groundHint + 24 + (shot.altitudeM ?? 140) + (pitch / 80) * 14 + Math.max(0, (zoom - 13) * 2);
}

function ema(prev, next, alpha) {
  if (!Number.isFinite(prev)) return next;
  return prev + (next - prev) * alpha;
}

function bearingDelta(a, b) {
  return ((b - a + 540) % 360) - 180;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * @param {{ map: import('maplibre-gl').Map, getRig?: () => object|null, getIntensity?: () => number }} deps
 */
export function createCameraDirector(deps) {
  const { map, getRig = () => null } = deps;
  const visibility = createVisibilitySolver();
  const collision = createTerrainCollisionSolver({ minClearanceM: 52 });
  const optimizer = createCameraPathOptimizer();
  const interpolator = createCameraInterpolator({ alpha: 0.05 });

  let lastContext = null;
  let smoothedContext = null;
  let orbitSide = 1;
  let stickyOrbitDeg = 48;
  let preferredShot = null;
  let preferredScore = 0;
  let blockedStreak = 0;
  let smoothTrailBearing = null;
  let framesSinceHunt = 999;
  let lastLosClear = true;
  let lastCompositionScore = 0.4;
  let featureGraph = createEmptyFeatureGraph();
  let activeShotType = null;
  let shotCommitAnimSec = null;
  let filmAnimTime = 0;

  function controls() {
    return readCameraControlRig(getRig() || {});
  }

  function setTerrainFeatures(graph) {
    featureGraph = graph?.ready ? graph : createEmptyFeatureGraph();
  }

  function ensureTerrainFeatures(route) {
    if (featureGraph.ready || !route || !map) return featureGraph;
    try {
      featureGraph = extractTerrainFeatures(map, route, { stepM: 90, lateralM: 130 });
    } catch {
      featureGraph = createEmptyFeatureGraph();
    }
    return featureGraph;
  }

  function losScore01(los) {
    if (!los) return 0.5;
    if (los.clear) return 1;
    return clamp(1 - (los.blockedFraction ?? 0) * 1.15 - (los.maxIntrusionM ?? 0) / 80, 0, 0.55);
  }

  function stabilityScore01(shot) {
    if (!preferredShot) return 1;
    const bearingPenalty = Math.min(1, Math.abs(bearingDelta(preferredShot.bearingDeg, shot.bearingDeg)) / 90);
    const altA = preferredShot.altitudeM ?? 300;
    const altB = shot.altitudeM ?? 300;
    const altPenalty = Math.min(1, Math.abs(altA - altB) / Math.max(220, altA));
    const zoomPenalty = Math.min(1, Math.abs((preferredShot.zoom ?? 13) - (shot.zoom ?? 13)) / 2.5);
    return clamp(1 - bearingPenalty * 0.55 - altPenalty * 0.25 - zoomPenalty * 0.2, 0, 1);
  }

  function lookAtFromShot(shot, sample) {
    if (Number.isFinite(shot.lookAtLng) && Number.isFinite(shot.lookAtLat)) {
      return {
        lng: shot.lookAtLng,
        lat: shot.lookAtLat,
        ele: shot.lookAtEle,
        source: shot.lookAtSource,
      };
    }
    return {
      lng: sample.point.lng,
      lat: sample.point.lat,
      ele: sample.point.ele,
      source: 'actor',
    };
  }

  function totalScore({ los, compositionScore, trailScore, shot, shotType }) {
    const parts = {
      composition: clamp(compositionScore ?? 0, 0, 1),
      los: losScore01(los),
      trail: clamp(trailScore ?? 0.4, 0, 1),
      grammar: shotGrammarScore(shotType || activeShotType, shot.shotType),
      stability: stabilityScore01(shot),
      feature: featureAffinityScore(shot.lookAtSource, null, shot.shotType),
    };
    let total =
      SCORE_WEIGHTS.composition * parts.composition +
      SCORE_WEIGHTS.los * parts.los +
      SCORE_WEIGHTS.trail * parts.trail +
      SCORE_WEIGHTS.grammar * parts.grammar +
      SCORE_WEIGHTS.stability * parts.stability +
      SCORE_WEIGHTS.feature * parts.feature;

    if (los && !los.clear && (los.blockedFraction ?? 0) > 0.45) total *= 0.55;
    return { total, parts };
  }

  function evaluateShot(shot, sample, { skipHeavy = false, shotType = null } = {}) {
    const bearing = shot.bearingDeg ?? sample.bearing;
    const lookAt = lookAtFromShot(shot, sample);
    const subjectEle = Number.isFinite(sample.point.ele) ? sample.point.ele : 0;
    const lookTerrain = queryTerrainElevationAt(map, lookAt.lng, lookAt.lat, subjectEle);
    const groundHint = lookTerrain ?? lookAt.ele ?? subjectEle;

    let absoluteElev = estimateAbsoluteElevation(groundHint, shot);
    absoluteElev = collision.resolveSafeElevation(map, lookAt, absoluteElev, subjectEle);

    const eye = visibility.estimateCameraEye(
      lookAt,
      bearing,
      shot.pitch ?? 50,
      absoluteElev,
      groundHint,
    );
    const safeEye = collision.enforceClearance(map, eye, subjectEle);
    if (safeEye.lifted) {
      absoluteElev = Math.max(absoluteElev, safeEye.ele);
      shot = {
        ...shot,
        altitudeM: Math.max(shot.altitudeM ?? 300, absoluteElev - groundHint - 28),
      };
    }

    const target = {
      lng: sample.point.lng,
      lat: sample.point.lat,
      ele: (Number.isFinite(sample.point.ele) ? sample.point.ele : groundHint) + 8,
    };

    const los = skipHeavy
      ? { clear: lastLosClear, blockedFraction: lastLosClear ? 0 : 0.2, maxIntrusionM: 0 }
      : visibility.testLineOfSight(
          map,
          { ...safeEye, ele: absoluteElev },
          target,
          { samples: 5 },
        );

    let compositionScore = lastCompositionScore;
    if (!skipHeavy) {
      const composition = scoreTerrainComposition(
        map,
        { ...safeEye, ele: absoluteElev },
        bearing,
        subjectEle,
        shot,
      );
      compositionScore = composition.compositionScore;
      lastCompositionScore = compositionScore;
    }

    // Prefer analytic trail composition under candidate look-at (not stale project).
    const trailScore = skipHeavy
      ? lastLosClear
        ? 0.5
        : 0.22
      : Math.max(
          estimateTrailCompositionFromLookAt(sample.point, lookAt, bearing),
          scoreTrailInFrame(map, sample.point) * 0.35,
        );

    const normalizedShot = {
      ...shot,
      bearingDeg: bearing,
      relativeBearing: 0,
      lookAtLng: lookAt.lng,
      lookAtLat: lookAt.lat,
      lookAtEle: lookAt.ele ?? groundHint,
      lookAtSource: lookAt.source || shot.lookAtSource,
      mode: 'cinematic',
    };

    const scored = totalScore({
      los,
      compositionScore,
      trailScore,
      shot: normalizedShot,
      shotType: shotType || activeShotType,
    });

    return {
      shot: normalizedShot,
      los,
      compositionScore,
      trailScore,
      score: scored.total,
      scoreParts: scored.parts,
    };
  }

  function smoothContext(raw) {
    if (!smoothedContext) {
      smoothedContext = { ...raw };
      return smoothedContext;
    }
    smoothedContext = {
      ...raw,
      curvature: ema(smoothedContext.curvature, raw.curvature, 0.1),
      slope: ema(smoothedContext.slope, raw.slope, 0.1),
      reliefM: ema(smoothedContext.reliefM, raw.reliefM, 0.12),
      subjectEle: ema(smoothedContext.subjectEle, raw.subjectEle, 0.18),
      avgEle: ema(smoothedContext.avgEle, raw.avgEle, 0.12),
      lookaheadBearing: (() => {
        const prev = smoothedContext.lookaheadBearing ?? raw.lookaheadBearing;
        return prev + bearingDelta(prev, raw.lookaheadBearing) * 0.14;
      })(),
      isLocalSummit: raw.isLocalSummit,
      isNarrowRelief: raw.isNarrowRelief,
    };
    return smoothedContext;
  }

  function dwellExpired() {
    if (shotCommitAnimSec == null || !activeShotType) return true;
    const need = SHOT_DWELL_SEC[activeShotType] ?? 2.5;
    return filmAnimTime - shotCommitAnimSec >= need;
  }

  function commitPreferred(evaluated, shotType) {
    preferredShot = {
      ...evaluated.shot,
      shotType: shotType || evaluated.shot.shotType,
      orbitSide: evaluated.shot.orbitSide ?? orbitSide,
      orbitDeg: evaluated.shot.orbitDeg ?? stickyOrbitDeg,
    };
    preferredScore = evaluated.score;
    orbitSide = preferredShot.orbitSide ?? orbitSide;
    stickyOrbitDeg = preferredShot.orbitDeg ?? stickyOrbitDeg;
    activeShotType = preferredShot.shotType || shotType || activeShotType;
    shotCommitAnimSec = filmAnimTime;
  }

  function resolveShot({ sample, route, animDistance, continuous = true, animTime = null }) {
    if (!sample?.point || !route) {
      return { shot: interpolator.getCurrent(), context: lastContext };
    }

    if (Number.isFinite(animTime)) filmAnimTime = animTime;

    const rigControls = controls();
    ensureTerrainFeatures(route);
    const rawContext = analyzeTrailContext(route, animDistance);
    const context = smoothContext(rawContext);
    lastContext = context;

    const near = featuresNearDistance(featureGraph, animDistance, 480);
    const desiredShotType = selectShotType(context, near);

    const rawBearing = context.lookaheadBearing ?? sample.bearing ?? 0;
    smoothTrailBearing = Number.isFinite(smoothTrailBearing)
      ? smoothTrailBearing + bearingDelta(smoothTrailBearing, rawBearing) * 0.1
      : rawBearing;
    const sampleForCam = { ...sample, bearing: smoothTrailBearing };

    const ideal = optimizer.proposeIdealFraming(context, sampleForCam, {
      rig: getRig(),
      orbitSide,
      stickyOrbitDeg,
      nearFeatures: near,
      featureGraph,
      animDistance,
      shotType: activeShotType && !dwellExpired() ? activeShotType : desiredShotType,
    });
    stickyOrbitDeg = ideal.orbitDeg ?? stickyOrbitDeg;

    framesSinceHunt += 1;
    const scoreCollapsed = lastCompositionScore < 0.28 || !lastLosClear;
    const shouldHunt =
      !continuous ||
      framesSinceHunt >= HUNT_EVERY_FRAMES ||
      scoreCollapsed ||
      blockedStreak >= 4 ||
      dwellExpired();

    let best;
    const holdType = activeShotType || ideal.shotType;

    if (preferredShot && continuous && !shouldHunt) {
      best = evaluateShot(
        {
          ...preferredShot,
          bearingDeg:
            preferredShot.bearingDeg +
            bearingDelta(preferredShot.bearingDeg, ideal.bearingDeg) * 0.035,
          lookAtLng: preferredShot.lookAtLng ?? ideal.lookAtLng,
          lookAtLat: preferredShot.lookAtLat ?? ideal.lookAtLat,
          altitudeM: Math.max(preferredShot.altitudeM ?? ideal.altitudeM, ideal.altitudeM * 0.88),
        },
        sampleForCam,
        { skipHeavy: true, shotType: holdType },
      );
      best.score = preferredScore * 0.96 + best.score * 0.04;
    } else {
      framesSinceHunt = 0;
      best = evaluateShot(ideal, sampleForCam, { shotType: ideal.shotType });

      if (preferredShot && continuous && !dwellExpired()) {
        const held = evaluateShot(
          {
            ...preferredShot,
            bearingDeg:
              preferredShot.bearingDeg +
              bearingDelta(preferredShot.bearingDeg, ideal.bearingDeg) * 0.035,
          },
          sampleForCam,
          { shotType: holdType },
        );
        if (held.score + preferredScore * STICKY_MARGIN >= best.score) {
          best = held;
        }
      }

      if (dwellExpired() || !preferredShot || scoreCollapsed) {
        const candidates = optimizer.buildCompositionCandidates(
          { ...ideal, orbitSide, orbitDeg: stickyOrbitDeg },
          sampleForCam,
          context,
          { nearFeatures: near },
        );
        for (const candidate of candidates) {
          const evaluated = evaluateShot(candidate, sampleForCam, {
            shotType: candidate.shotType || desiredShotType,
          });
          if (evaluated.score > best.score) best = evaluated;
        }
      }
    }

    lastLosClear = best.los.clear;
    if (!best.los.clear) blockedStreak += 1;
    else blockedStreak = Math.max(0, blockedStreak - 2);

    if (!preferredShot) {
      commitPreferred(best, best.shot.shotType || desiredShotType);
    } else {
      const bearingFlip = Math.abs(bearingDelta(preferredShot.bearingDeg, best.shot.bearingDeg));
      const isMajor = bearingFlip > 30 || Math.abs((preferredShot.altitudeM ?? 0) - (best.shot.altitudeM ?? 0)) > 100;
      const better = best.score >= preferredScore * (1 + STICKY_MARGIN);
      if ((!isMajor && best.score >= preferredScore * 0.98) || (better && dwellExpired()) || scoreCollapsed) {
        commitPreferred(best, best.shot.shotType || desiredShotType);
      }
    }

    if (!best.los.clear && blockedStreak >= 12) {
      const emergency = evaluateShot({
        ...ideal,
        shotType: 'establish',
        pitch: 54,
        zoom: 13.2,
        altitudeM: Math.max((ideal.altitudeM ?? 160) * 1.6, 240),
        bearingDeg: sampleForCam.bearing + 80 * orbitSide,
        lookAtLng: ideal.lookAtLng,
        lookAtLat: ideal.lookAtLat,
        orbitDeg: 80,
        orbitSide,
      }, sampleForCam, { shotType: 'establish' });
      if (emergency.score > best.score) {
        best = emergency;
        commitPreferred(best, 'establish');
        blockedStreak = 0;
      }
    }

    const compositionBoost = best.compositionScore ?? lastCompositionScore;
    const smoothed = interpolator.step(best.shot, {
      continuous,
      boost: best.los.clear ? (compositionBoost > 0.55 ? 0.7 : 1) : 1.25,
      smoothness: Math.min(1, (rigControls.cameraSmoothness ?? 0.7) + 0.12),
      dwell: compositionBoost > 0.55 && !dwellExpired(),
    });

    return {
      shot: smoothed,
      context,
      debug: {
        losClear: best.los.clear,
        score: best.score,
        scoreParts: best.scoreParts,
        compositionScore: best.compositionScore ?? lastCompositionScore,
        shotType: activeShotType,
        lookAtSource: best.shot.lookAtSource,
        featuresReady: featureGraph.ready,
        blockedStreak,
      },
    };
  }

  function reset() {
    interpolator.reset();
    lastContext = null;
    smoothedContext = null;
    preferredShot = null;
    preferredScore = 0;
    blockedStreak = 0;
    smoothTrailBearing = null;
    orbitSide = 1;
    stickyOrbitDeg = 48;
    framesSinceHunt = 999;
    lastLosClear = true;
    lastCompositionScore = 0.4;
    featureGraph = createEmptyFeatureGraph();
    activeShotType = null;
    shotCommitAnimSec = null;
    filmAnimTime = 0;
  }

  return {
    resolveShot,
    reset,
    setTerrainFeatures,
    ensureTerrainFeatures,
    getTerrainFeatures: () => featureGraph,
    getLastContext: () => lastContext,
  };
}
