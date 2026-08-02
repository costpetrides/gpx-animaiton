/**
 * Shot grammar for the Terrain-Aware Cinematic Director.
 * Fixed automatic priors — no user controls.
 */

export const SHOT_TYPE = {
  ESTABLISH: 'establish',
  TRAVEL: 'travel',
  ORBIT: 'orbit',
  REVEAL: 'reveal',
  SUMMIT: 'summit',
  VALLEY: 'valley',
};

/** Preferred film-time dwell (seconds) per shot type — short so faster pace still switches. */
export const SHOT_DWELL_SEC = {
  [SHOT_TYPE.ESTABLISH]: 1.6,
  [SHOT_TYPE.TRAVEL]: 1.2,
  [SHOT_TYPE.ORBIT]: 1.4,
  [SHOT_TYPE.REVEAL]: 1.5,
  [SHOT_TYPE.SUMMIT]: 1.8,
  [SHOT_TYPE.VALLEY]: 1.3,
};

/**
 * Framing priors — closer to the trail so the path fills more of the frame.
 */
export const SHOT_PRIORS = {
  [SHOT_TYPE.ESTABLISH]: {
    pitch: 52,
    zoom: 13.6,
    altitudeM: 200,
    orbitDeg: 28,
    lookAtForwardM: 55,
    lookAtRightM: 22,
  },
  [SHOT_TYPE.TRAVEL]: {
    pitch: 58,
    zoom: 14.4,
    altitudeM: 130,
    orbitDeg: 32,
    lookAtForwardM: 40,
    lookAtRightM: 28,
  },
  [SHOT_TYPE.ORBIT]: {
    pitch: 56,
    zoom: 14.2,
    altitudeM: 150,
    orbitDeg: 55,
    lookAtForwardM: 35,
    lookAtRightM: 40,
  },
  [SHOT_TYPE.REVEAL]: {
    pitch: 54,
    zoom: 13.9,
    altitudeM: 175,
    orbitDeg: 40,
    lookAtForwardM: 50,
    lookAtRightM: 18,
  },
  [SHOT_TYPE.SUMMIT]: {
    pitch: 48,
    zoom: 13.4,
    altitudeM: 220,
    orbitDeg: 22,
    lookAtForwardM: 65,
    lookAtRightM: 14,
  },
  [SHOT_TYPE.VALLEY]: {
    pitch: 60,
    zoom: 14.1,
    altitudeM: 145,
    orbitDeg: 70,
    lookAtForwardM: 45,
    lookAtRightM: 48,
  },
};

/**
 * Pick a shot type from trail + terrain context (fully automatic).
 */
export function selectShotType(context = {}, featuresNear = null) {
  if (context.isLocalSummit) return SHOT_TYPE.SUMMIT;
  if (context.isNarrowRelief || (context.reliefM ?? 0) > 180) return SHOT_TYPE.VALLEY;
  if ((context.curvature ?? 0) > 0.28) return SHOT_TYPE.ORBIT;
  if (featuresNear?.hasPeak && (context.slope ?? 0) > 0.08) return SHOT_TYPE.REVEAL;
  if ((context.reliefM ?? 0) > 90) return SHOT_TYPE.REVEAL;
  if ((context.reliefM ?? 0) < 40) return SHOT_TYPE.ESTABLISH;
  return SHOT_TYPE.TRAVEL;
}

export function shotGrammarScore(shotType, candidateType) {
  if (!shotType || !candidateType) return 0.7;
  if (shotType === candidateType) return 1;
  const compat = {
    [SHOT_TYPE.ESTABLISH]: [SHOT_TYPE.REVEAL, SHOT_TYPE.TRAVEL],
    [SHOT_TYPE.TRAVEL]: [SHOT_TYPE.ORBIT, SHOT_TYPE.REVEAL],
    [SHOT_TYPE.ORBIT]: [SHOT_TYPE.TRAVEL, SHOT_TYPE.VALLEY],
    [SHOT_TYPE.REVEAL]: [SHOT_TYPE.ESTABLISH, SHOT_TYPE.SUMMIT],
    [SHOT_TYPE.SUMMIT]: [SHOT_TYPE.REVEAL, SHOT_TYPE.ESTABLISH],
    [SHOT_TYPE.VALLEY]: [SHOT_TYPE.ORBIT, SHOT_TYPE.TRAVEL],
  };
  if (compat[shotType]?.includes(candidateType)) return 0.75;
  return 0.45;
}
