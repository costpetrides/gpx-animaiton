/**
 * Coordinates terrain + imagery tile streaming during playback.
 *
 * MapLibre builds a 3D terrain mesh from loaded DEM tiles. When the camera
 * outruns tile loading, unloaded neighbours are meshed at zero elevation,
 * producing vertical walls and black voids (maplibre-gl-js #6920).
 */
import { queryTerrainElevationAt } from '../camera.js';

export function createTerrainStreamCoordinator(map) {
  let stallCount = 0;
  let lastReadyAt = 0;
  let corridorPinned = false;

  function isTerrainEnabled() {
    try {
      return Boolean(map.getTerrain());
    } catch {
      return false;
    }
  }

  function isTerrainDemReady(elevationHint = null) {
    if (!isTerrainEnabled()) return true;
    try {
      const center = map.getCenter();
      return queryTerrainElevationAt(map, center.lng, center.lat, elevationHint) != null;
    } catch {
      return false;
    }
  }

  function isViewReady(elevationHint = null) {
    if (!isTerrainEnabled()) return true;
    try {
      return map.areTilesLoaded() && isTerrainDemReady(elevationHint);
    } catch {
      return false;
    }
  }

  function markStall() {
    stallCount += 1;
  }

  function markReady() {
    lastReadyAt = performance.now();
  }

  function getStats() {
    return {
      stallCount,
      lastReadyAt,
      corridorPinned,
      ready: isViewReady(),
    };
  }

  function pinRouteCorridor(bounds, paddingFactor = 0.18) {
    if (!bounds) return;
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const latPad = Math.max((ne.lat - sw.lat) * paddingFactor, 0.003);
    const lngPad = Math.max((ne.lng - sw.lng) * paddingFactor, 0.003);
    map.setMaxBounds([
      [sw.lng - lngPad, sw.lat - latPad],
      [ne.lng + lngPad, ne.lat + latPad],
    ]);
    corridorPinned = true;
  }

  function clearRouteCorridor() {
    if (!corridorPinned) return;
    map.setMaxBounds(null);
    corridorPinned = false;
  }

  function waitForViewReady(timeoutMs = 5000, { elevationHint = null } = {}) {
    if (!isTerrainEnabled()) {
      markReady();
      return Promise.resolve(true);
    }

    const deadline = performance.now() + timeoutMs;

    return new Promise((resolve) => {
      let sawNotReady = !isViewReady(elevationHint);

      function cleanup(on) {
        if (on) map.off('idle', on);
      }

      function check() {
        const ready = isViewReady(elevationHint);
        const canResolve = ready && sawNotReady;

        if (canResolve) {
          cleanup(onIdle);
          markReady();
          resolve(true);
          return;
        }

        if (!ready) sawNotReady = true;

        if (performance.now() >= deadline) {
          cleanup(onIdle);
          resolve(isViewReady(elevationHint));
          return;
        }

        requestAnimationFrame(check);
      }

      function onIdle() {
        check();
      }

      map.on('idle', onIdle);
      check();
    });
  }

  return {
    isTerrainEnabled,
    isTerrainDemReady,
    isViewReady,
    markStall,
    markReady,
    getStats,
    pinRouteCorridor,
    clearRouteCorridor,
    waitForViewReady,
  };
}
