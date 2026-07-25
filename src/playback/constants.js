/**
 * Even cinematic playback speed along route distance.
 * GPX timestamps / recorded pace are never used for animation pacing.
 *
 * Effective travel rate at 1× ≈ REFERENCE_SPEED_MPS × PLAYBACK_TIME_COMPRESSION
 * (so a long ride still finishes in a short video).
 */
export const PLAYBACK_TIME_COMPRESSION = 60;

/** Reference pace used only to size DEFAULT_SPEED_MPS (~14.4 km/h). */
export const REFERENCE_SPEED_MPS = 4;

/** Constant along-track speed (m/s) at 1× playback. */
export const DEFAULT_SPEED_MPS = REFERENCE_SPEED_MPS * PLAYBACK_TIME_COMPRESSION;
