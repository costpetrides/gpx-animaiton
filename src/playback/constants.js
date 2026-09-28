/**
 * Fixed route-film duration at 1×.
 *
 * The GPX activity's recorded duration, sport, and distance do not change the
 * cinematic playback length. 1× is always 30 seconds of route animation.
 */
export const ROUTE_PLAYBACK_DURATION_SEC = 30;

/**
 * @deprecated The playback engine is progress/duration based now. Kept only
 * for older imports that may still reference the symbol.
 */
export const CINEMATIC_GROUND_MPS = 1;

/** Fixed duration at 1×. */
export const MIN_ANIMATION_DURATION_SEC = ROUTE_PLAYBACK_DURATION_SEC;
export const MAX_ANIMATION_DURATION_SEC = ROUTE_PLAYBACK_DURATION_SEC;

/** @deprecated Legacy timed-route compatibility export. */
export const PLAYBACK_TIME_COMPRESSION = 60;

/** @deprecated Legacy compatibility alias. */
export const REFERENCE_SPEED_MPS = CINEMATIC_GROUND_MPS;

/** @deprecated Route playback no longer uses a fixed ground speed. */
export const DEFAULT_SPEED_MPS = CINEMATIC_GROUND_MPS;
