export { analyzeTrailContext } from './context.js';
export { createVisibilitySolver, estimateCameraEye, testLineOfSight } from './visibilitySolver.js';
export { createTerrainCollisionSolver } from './terrainCollision.js';
export {
  createCameraPathOptimizer,
  proposeIdealFraming,
  buildCompositionCandidates,
} from './pathOptimizer.js';
export {
  createTerrainComposer,
  scoreTerrainComposition,
  scoreTrailInFrame,
  estimateTrailCompositionFromLookAt,
  TCS_WEIGHTS,
} from './terrainComposer.js';
export {
  extractTerrainFeatures,
  featuresNearDistance,
  resolveLandscapeLookAt,
  createEmptyFeatureGraph,
} from './terrainFeatures.js';
export {
  SHOT_TYPE,
  SHOT_DWELL_SEC,
  SHOT_PRIORS,
  selectShotType,
  shotGrammarScore,
} from './shotTypes.js';
export { createCameraInterpolator } from './interpolator.js';
export { createCameraDirector } from './director.js';
