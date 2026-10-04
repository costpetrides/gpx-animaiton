/**
 * gpx-cinematic-renderer — public package surface.
 *
 * Hosts (standalone studio, Ryodo) should import from this entry or the
 * subpath exports in package.json. Rendering has no AWS/Firebase/S3 knowledge.
 * exportVideo() is Blob-first; download is a host/UI action.
 */

export {
  mountTrailRenderer,
  createDefaultAnimationConfig,
  normalizeAnimationConfig,
} from './mountTrailRenderer.js';

export {
  createCameraDocumentFromConfig,
  ANIMATION_CONFIG_SCHEMA_VERSION,
  ANIMATION_TRACK_COLOR_PRESETS,
} from './host/animationConfig.js';

export { parseGPX, formatDistance, formatDuration, formatElevation } from './gpx.js';
export { RoutePath } from './route.js';

export { createAnimator } from './animator.js';
export { createCameraDirector } from './camera/cinematic/index.js';
export { createDefaultCameraRig } from './camera/rig.js';

export {
  createVideoExporter,
  downloadBlob,
  getExportResolution,
  normalizeExportAspectRatio,
  normalizeExportFps,
  normalizeExportQuality,
  EXPORT_QUALITY_PRESETS,
} from './export/videoExporter.js';

export {
  getBaseAnimationDuration,
  getPlaybackDuration,
  samplePlaybackFrame,
  seekPlaybackProgress,
} from './playback/engine.js';

export {
  CINEMATIC_GROUND_MPS,
  MIN_ANIMATION_DURATION_SEC,
  MAX_ANIMATION_DURATION_SEC,
} from './playback/constants.js';
