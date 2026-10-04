/**
 * Rendering engine facade — desktop UI and Peak Explorer / Ryodo share this surface.
 *
 * Prefer the package root (`gpx-cinematic-renderer`) or `mountTrailRenderer`
 * for hosts. This subpath re-exports lower-level engine primitives.
 *
 * The desktop app is only a test harness. Do not put UI or cloud concerns here.
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

export {
  createVideoExporter,
  downloadBlob,
  getExportResolution,
  normalizeExportAspectRatio,
  normalizeExportFps,
  normalizeExportQuality,
  EXPORT_QUALITY_PRESETS,
} from '../export/videoExporter.js';

export {
  mountTrailRenderer,
  createDefaultAnimationConfig,
  normalizeAnimationConfig,
} from '../mountTrailRenderer.js';
