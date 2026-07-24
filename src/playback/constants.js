/**
 * Compress recorded activity time into animation length.
 * Example: a 2 hour ride plays in ~2 minutes at 1× (60× compression).
 */
export const PLAYBACK_TIME_COMPRESSION = 60;

/**
 * Assumed travel speed for GPX files without timestamps (before compression).
 * ~4 m/s ≈ 14.4 km/h — light cycling / brisk trail pace.
 */
export const REFERENCE_SPEED_MPS = 4;

/**
 * Virtual travel speed for untimed routes at 1× playback
 * (= REFERENCE_SPEED_MPS × PLAYBACK_TIME_COMPRESSION).
 */
export const DEFAULT_SPEED_MPS = REFERENCE_SPEED_MPS * PLAYBACK_TIME_COMPRESSION;
