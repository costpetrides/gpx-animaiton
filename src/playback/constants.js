/**
 * Cinematic along-trail ground speed at 1× (meters / second).
 * Tuned so preview 3× feels brisk (~previous 12×): ~88 m/s ≈ 320 km/h flyover.
 * A 4.5 km trail ≈ 51 s at 1×, ~17 s at 3×.
 */
export const CINEMATIC_GROUND_MPS = 88;

/** Soft floor / ceiling so tiny trails aren't instant and long ones don't drag. */
export const MIN_ANIMATION_DURATION_SEC = 22;
export const MAX_ANIMATION_DURATION_SEC = 120;

/**
 * @deprecated Kept for any remaining timed-route math; cinematic pacing is distance-based.
 * Legacy 60× compression made short GPS clocks play like a rocket.
 */
export const PLAYBACK_TIME_COMPRESSION = 60;

/**
 * @deprecated Prefer CINEMATIC_GROUND_MPS. Alias so older imports keep working.
 */
export const REFERENCE_SPEED_MPS = CINEMATIC_GROUND_MPS;

/**
 * Along-trail meters per second at 1× (distance-paced cinematic preview).
 */
export const DEFAULT_SPEED_MPS = CINEMATIC_GROUND_MPS;
