/**
 * Rendering engine facade — desktop UI and future Peak Explorer API share this surface.
 *
 * Pipeline:
 *   GPX Input → Route Analysis → Terrain → 3D Scene → Camera Director
 *   → Animation Timeline → Frame Rendering → MP4 Export
 *
 * The desktop app is only a test harness. Do not put UI concerns here.
 */

export { parseGPX } from '../gpx.js';
export { RoutePath } from '../route.js';

export {
  getBaseAnimationDuration,
  getPlaybackDuration,
  samplePlaybackFrame,
  seekPlaybackProgress,
} from '../playback/engine.js';
export {
  CINEMATIC_GROUND_MPS,
  MIN_ANIMATION_DURATION_SEC,
  MAX_ANIMATION_DURATION_SEC,
} from '../playback/constants.js';

export { createAnimator } from '../animator.js';
export { createCameraDirector } from '../camera/cinematic/index.js';
export { createDefaultCameraRig } from '../camera/rig.js';

export { createVideoExporter, EXPORT_QUALITY_PRESETS } from '../export/videoExporter.js';
