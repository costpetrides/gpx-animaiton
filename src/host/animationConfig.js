/**
 * Host-facing animation config (no GPS points).
 * Used by mountTrailRenderer and Ryodo draft persistence adapters.
 */

import { createDefaultCameraRig } from '../camera/rig.js';

export const ANIMATION_CONFIG_SCHEMA_VERSION = 1;

const TRACK_COLORS = Object.freeze([
  '#0f9ad1',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#ffffff',
]);

export const ANIMATION_TRACK_COLOR_PRESETS = TRACK_COLORS;

export function createDefaultAnimationConfig() {
  return {
    camera: {
      mode: 'cinematic',
      stability: 0.5,
      followBehindZoomLevel: 33,
    },
    track: {
      color: '#0f9ad1',
      width: 6,
      glowWidth: 16,
      opacity: 1,
      showFullRoute: true,
    },
    map: {
      styleKey: 'outdoor',
      terrainEnabled: true,
      terrain: {
        exaggeration: 1.5,
      },
    },
    playback: {
      speed: 1,
      prepareQuality: 'fast',
    },
  };
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Normalize a saved/partial config into a complete engine-safe config.
 * Strips any accidental route/points payloads.
 */
export function normalizeAnimationConfig(input) {
  const defaults = createDefaultAnimationConfig();
  const raw = input && typeof input === 'object' ? input : {};

  const {
    points: _points,
    route: _route,
    ...safe
  } = raw;

  const camera = safe.camera && typeof safe.camera === 'object' ? safe.camera : {};
  const track = safe.track && typeof safe.track === 'object' ? safe.track : {};
  const map = safe.map && typeof safe.map === 'object' ? safe.map : {};
  const terrain =
    map.terrain && typeof map.terrain === 'object' ? map.terrain : {};
  const playback =
    safe.playback && typeof safe.playback === 'object' ? safe.playback : {};

  const mode = String(camera.mode || defaults.camera.mode);
  const styleKey = String(map.styleKey || defaults.map.styleKey);
  const color = String(track.color || defaults.track.color);
  const prepareQuality = String(
    playback.prepareQuality || defaults.playback.prepareQuality,
  );

  return {
    camera: {
      mode: ['overview', 'follow', 'follow-behind', 'cinematic'].includes(mode)
        ? mode
        : defaults.camera.mode,
      stability: clamp(finiteOr(camera.stability, defaults.camera.stability), 0, 1),
      followBehindZoomLevel: clamp(
        finiteOr(
          camera.followBehindZoomLevel,
          defaults.camera.followBehindZoomLevel,
        ),
        0,
        100,
      ),
    },
    track: {
      color: TRACK_COLORS.includes(color) ? color : defaults.track.color,
      width: clamp(finiteOr(track.width, defaults.track.width), 1, 24),
      glowWidth: clamp(finiteOr(track.glowWidth, defaults.track.glowWidth), 0, 48),
      opacity: clamp(finiteOr(track.opacity, defaults.track.opacity), 0, 1),
      showFullRoute:
        track.showFullRoute === undefined
          ? defaults.track.showFullRoute
          : Boolean(track.showFullRoute),
    },
    map: {
      styleKey: ['outdoor', 'positron', 'dark'].includes(styleKey)
        ? styleKey
        : defaults.map.styleKey,
      terrainEnabled:
        map.terrainEnabled === undefined
          ? defaults.map.terrainEnabled
          : Boolean(map.terrainEnabled),
      terrain: {
        exaggeration: clamp(
          finiteOr(terrain.exaggeration, defaults.map.terrain.exaggeration),
          0.2,
          4,
        ),
      },
    },
    playback: {
      speed: clamp(finiteOr(playback.speed, defaults.playback.speed), 0.25, 16),
      prepareQuality: ['fast', 'balanced', 'maximum'].includes(prepareQuality)
        ? prepareQuality
        : defaults.playback.prepareQuality,
    },
  };
}

export function createCameraDocumentFromConfig(config) {
  const normalized = normalizeAnimationConfig(config);
  const preset = 'cinematic';
  return {
    preset,
    mode: normalized.camera.mode,
    rig: createDefaultCameraRig(preset),
    shot: null,
  };
}
