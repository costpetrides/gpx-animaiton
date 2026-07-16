import { disableTerrain, enableTerrain } from '../camera.js';
import { getElevationHintAtDistance } from './routePrefetch.js';

const STALL_PITCH_REDUCE_START = 2;
const STALL_TERRAIN_OFF_START = 10;
const TERRAIN_REENABLE_MS = 900;
const DT_SCALE_MIN = 0.18;
const DT_SCALE_RECOVER = 2.4;
const DT_SCALE_PENALTY = 4.5;

/**
 * Runtime terrain streaming guard during playback.
 * Slows time progression and lowers pitch when tiles lag; temporarily falls
 * back to flat map rather than showing black terrain mesh voids.
 */
export function createTerrainPlaybackGuard({
  map,
  terrainStream,
  getMapViewMode,
  isTerrainDegraded,
}) {
  let consecutiveStalls = 0;
  let dtScale = 1;
  let runtimeTerrainOff = false;
  let terrainOffSince = 0;
  let lastReadyAt = performance.now();

  function isActive() {
    return getMapViewMode() === '3d' && !isTerrainDegraded?.() && Boolean(terrainStream);
  }

  function getElevationHint(route, animDistance) {
    return getElevationHintAtDistance(route, animDistance);
  }

  function isViewReady(route, animDistance) {
    if (!isActive() || !terrainStream?.isTerrainEnabled()) return true;
    return terrainStream.isViewReady(getElevationHint(route, animDistance));
  }

  function updateFrame({ route, animDistance, dt }) {
    if (!isActive()) {
      consecutiveStalls = 0;
      dtScale = 1;
      return { dtScale: 1, pitchScale: 1, runtimeTerrainOff: false };
    }

    const ready = isViewReady(route, animDistance);

    if (ready) {
      consecutiveStalls = 0;
      lastReadyAt = performance.now();
      dtScale = Math.min(1, dtScale + dt * DT_SCALE_RECOVER);

      if (runtimeTerrainOff && performance.now() - terrainOffSince >= TERRAIN_REENABLE_MS) {
        runtimeTerrainOff = false;
        try {
          enableTerrain(map);
        } catch {
          // ignore
        }
      }
    } else {
      consecutiveStalls += 1;
      terrainStream?.markStall?.();
      dtScale = Math.max(DT_SCALE_MIN, dtScale - dt * DT_SCALE_PENALTY);

      if (consecutiveStalls >= STALL_TERRAIN_OFF_START && !runtimeTerrainOff) {
        runtimeTerrainOff = true;
        terrainOffSince = performance.now();
        try {
          disableTerrain(map);
        } catch {
          // ignore
        }
      }
    }

    const pitchScale = consecutiveStalls >= STALL_PITCH_REDUCE_START
      ? Math.max(0.5, 1 - (consecutiveStalls - STALL_PITCH_REDUCE_START) * 0.04)
      : 1;

    return {
      dtScale,
      pitchScale,
      runtimeTerrainOff,
      consecutiveStalls,
      ready,
    };
  }

  function reset() {
    consecutiveStalls = 0;
    dtScale = 1;
    runtimeTerrainOff = false;
    terrainOffSince = 0;
    lastReadyAt = performance.now();
  }

  function getStats() {
    return {
      consecutiveStalls,
      dtScale,
      runtimeTerrainOff,
      msSinceReady: performance.now() - lastReadyAt,
    };
  }

  return {
    updateFrame,
    reset,
    getStats,
    isViewReady,
    getElevationHint,
  };
}
