/**
 * TerrainCollisionSolver — keep camera above DEM with clearance.
 */

import { queryTerrainElevationAt } from '../../camera.js';

export function createTerrainCollisionSolver(options = {}) {
  const minClearanceM = options.minClearanceM ?? 45;

  /**
   * @param {import('maplibre-gl').Map} map
   * @param {{ lng: number, lat: number, ele: number }} eye
   * @param {number} [hintM]
   */
  function enforceClearance(map, eye, hintM = null) {
    if (!eye) return eye;
    const terrain = queryTerrainElevationAt(map, eye.lng, eye.lat, hintM ?? eye.ele);
    if (terrain == null) {
      return { ...eye, clearanceM: minClearanceM, lifted: false };
    }
    const floor = terrain + minClearanceM;
    if (eye.ele >= floor) {
      return { ...eye, clearanceM: eye.ele - terrain, lifted: false, terrainEle: terrain };
    }
    return {
      ...eye,
      ele: floor,
      clearanceM: minClearanceM,
      lifted: true,
      terrainEle: terrain,
    };
  }

  /**
   * Ensure jumpTo elevation clears DEM under the focal area and eye.
   */
  function resolveSafeElevation(map, center, proposedElevation, hintM = null) {
    const centerTerrain = queryTerrainElevationAt(map, center.lng, center.lat, hintM);
    let elev = proposedElevation;
    if (Number.isFinite(centerTerrain)) {
      elev = Math.max(elev, centerTerrain + minClearanceM);
    }
    return elev;
  }

  return {
    minClearanceM,
    enforceClearance,
    resolveSafeElevation,
  };
}
