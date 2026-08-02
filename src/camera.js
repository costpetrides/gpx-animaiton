import maplibregl from 'maplibre-gl';

export const CAMERA_PRESETS = {
  cinematic: {
    label: 'Cinematic',
    zoom: 14.5,
    pitch: 58,
    forwardOffsetM: -28,
    rightOffsetM: 0,
    relativeBearing: 0,
    bearingDeg: 0,
  },
  follow: {
    // Legacy alias — routed through cinematic director.
    label: 'Follow',
    zoom: 14.8,
    pitch: 58,
    forwardOffsetM: -28,
    rightOffsetM: 0,
    relativeBearing: 0,
    bearingDeg: 0,
  },
  bird: {
    label: 'Bird',
    zoom: 13.6,
    pitch: 48,
    forwardOffsetM: 0,
    rightOffsetM: 0,
    relativeBearing: 0,
    bearingDeg: 0,
  },
};

export function normalizeCameraPreset(preset) {
  if (preset === 'bird') return 'bird';
  if (preset === 'manual') return 'manual';
  return 'cinematic';
}

function toRad(d) {
  return (d * Math.PI) / 180;
}

function normalizeBearing(deg) {
  return ((deg % 360) + 360) % 360;
}

function metersPerDegreeLat() {
  return 111320;
}

function metersPerDegreeLng(lat) {
  return Math.cos(toRad(lat)) * 111320;
}

function projectToLocalMeters(origin, target, bearingDeg) {
  const east = (target.lng - origin.lng) * metersPerDegreeLng(origin.lat);
  const north = (target.lat - origin.lat) * metersPerDegreeLat();
  const bearingRad = toRad(bearingDeg);
  return {
    forwardOffsetM: east * Math.sin(bearingRad) + north * Math.cos(bearingRad),
    rightOffsetM: east * Math.cos(bearingRad) - north * Math.sin(bearingRad),
  };
}

function offsetPoint(point, forwardOffsetM, rightOffsetM, bearingDeg) {
  const bearingRad = toRad(bearingDeg);
  const east = forwardOffsetM * Math.sin(bearingRad) + rightOffsetM * Math.cos(bearingRad);
  const north = forwardOffsetM * Math.cos(bearingRad) - rightOffsetM * Math.sin(bearingRad);
  return {
    lat: point.lat + north / metersPerDegreeLat(),
    lng: point.lng + east / metersPerDegreeLng(point.lat),
  };
}

export const TERRAIN_ELEVATION_MIN_M = -500;
export const TERRAIN_ELEVATION_MAX_M = 9000;

export function isPlausibleTerrainElevation(elevation, hintM = null) {
  if (!Number.isFinite(elevation)) return false;
  if (elevation < TERRAIN_ELEVATION_MIN_M || elevation > TERRAIN_ELEVATION_MAX_M) return false;
  if (Number.isFinite(hintM) && Math.abs(elevation - hintM) > 4000) return false;
  return true;
}

function safeTerrainElevation(map, lng, lat, hintM = null) {
  try {
    const elevation = map.queryTerrainElevation([lng, lat]);
    return isPlausibleTerrainElevation(elevation, hintM) ? elevation : null;
  } catch {
    return null;
  }
}

function terrainRingMaxElevation(map, center, radiusM = 60, sampleCount = 8, hintM = null) {
  const elevations = [];
  const centerElevation = safeTerrainElevation(map, center.lng, center.lat, hintM);
  if (centerElevation != null) elevations.push(centerElevation);

  for (let i = 0; i < sampleCount; i++) {
    const theta = (Math.PI * 2 * i) / sampleCount;
    const east = Math.cos(theta) * radiusM;
    const north = Math.sin(theta) * radiusM;
    const lng = center.lng + east / metersPerDegreeLng(center.lat);
    const lat = center.lat + north / metersPerDegreeLat();
    const elevation = safeTerrainElevation(map, lng, lat, hintM);
    if (elevation != null) elevations.push(elevation);
  }

  if (!elevations.length) return null;
  return Math.max(...elevations);
}

function resolveTerrainAwareElevation(map, target, sample, shot, terrainGuard) {
  const gpxElevation = Number.isFinite(sample?.point?.ele) ? sample.point.ele : null;
  const elevationHint = gpxElevation;
  const centerElevation = safeTerrainElevation(map, target.lng, target.lat, elevationHint);
  if (!terrainGuard?.enabled) {
    const base = centerElevation ?? gpxElevation ?? 0;
    return {
      elevation: base,
      maxTerrainElevation: base,
      clearanceM: 0,
      terrainAware: false,
    };
  }

  const actorElevation = sample?.point
    ? safeTerrainElevation(map, sample.point.lng, sample.point.lat, elevationHint)
    : null;
  const ringMaxElevation = terrainRingMaxElevation(
    map,
    { lng: target.lng, lat: target.lat },
    terrainGuard.sampleRadiusM ?? 60,
    terrainGuard.sampleCount ?? 8,
    elevationHint,
  );
  const maxTerrainElevation = Math.max(
    centerElevation ?? -Infinity,
    actorElevation ?? -Infinity,
    ringMaxElevation ?? -Infinity,
    gpxElevation ?? -Infinity,
  );
  const fallbackTerrain = Number.isFinite(maxTerrainElevation) ? maxTerrainElevation : (gpxElevation ?? 0);

  const pitch = Math.max(0, shot?.pitch ?? 0);
  const zoom = Math.max(0, shot?.zoom ?? 14);
  const userAltitudeM = Math.max(0, shot?.altitudeM ?? 80);
  const baseClearanceM = terrainGuard?.enabled ? (terrainGuard.minClearanceM ?? 20) : 0;
  const pitchClearanceM = terrainGuard?.enabled ? (pitch / 80) * 18 : 0;
  const zoomClearanceM = terrainGuard?.enabled ? Math.max(0, (zoom - 13) * 3) : 0;
  const clearanceM = baseClearanceM + userAltitudeM + pitchClearanceM + zoomClearanceM;
  let elevation = fallbackTerrain + clearanceM;

  // Never place the camera below the actor's GPX elevation envelope.
  if (gpxElevation != null) {
    elevation = Math.max(elevation, gpxElevation + baseClearanceM + userAltitudeM);
  }

  // Smooth camera altitude — avoids jitter from per-frame DEM queries and monotonic climb.
  if (terrainGuard?.enabled) {
    const smooth = terrainGuard.elevationSmoothing ?? 0.18;
    if (!Number.isFinite(terrainGuard.smoothedElevationM)) {
      terrainGuard.smoothedElevationM = elevation;
    } else {
      terrainGuard.smoothedElevationM += (elevation - terrainGuard.smoothedElevationM) * smooth;
    }
    elevation = terrainGuard.smoothedElevationM;
    terrainGuard.lastEnvelopeM = elevation - clearanceM;
  }

  return {
    elevation,
    maxTerrainElevation: fallbackTerrain,
    clearanceM,
    terrainAware: true,
  };
}

function cameraOptions(target, elevation) {
  return {
    center: [target.lng, target.lat],
    bearing: target.bearing,
    pitch: target.pitch,
    zoom: target.zoom,
    elevation,
  };
}

export function defaultShotForMode(modeKey = 'cinematic') {
  const preset = CAMERA_PRESETS[normalizeCameraPreset(modeKey)] || CAMERA_PRESETS.cinematic;
  return {
    mode: modeKey,
    zoom: preset.zoom,
    pitch: preset.pitch,
    forwardOffsetM: preset.forwardOffsetM,
    rightOffsetM: preset.rightOffsetM,
    relativeBearing: preset.relativeBearing,
    bearingDeg: Number.isFinite(preset.bearingDeg) ? preset.bearingDeg : null,
    // AvoMap-like behavior: keep camera heading stable during a shot.
    // When bearingDeg is null we derive it once from the current viewport/route,
    // then freeze it for subsequent playback frames.
    saved: false,
  };
}

export function captureShot(map, sample, modeKey = 'follow') {
  const center = map.getCenter();
  const actorBearing = sample?.bearing ?? 0;
  const offsets = sample
    ? projectToLocalMeters(sample.point, { lat: center.lat, lng: center.lng }, actorBearing)
    : { forwardOffsetM: 0, rightOffsetM: 0 };

  return {
    mode: modeKey,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    forwardOffsetM: offsets.forwardOffsetM,
    rightOffsetM: offsets.rightOffsetM,
    // Freeze absolute camera heading from the viewport at capture time.
    // This prevents continuous rotation during playback.
    bearingDeg: normalizeBearing(map.getBearing()),
    relativeBearing: normalizeBearing(map.getBearing() - actorBearing),
    saved: true,
  };
}

/**
 * Soft keep-in-frame for terrain-showcase cinematography.
 * Only nudges when the trail pin is fully (or nearly) off-canvas.
 * Does NOT recenter to screen middle — landscape can own the composition.
 */
function keepActorOnScreen(map, actorPoint, elevation, margins = {}) {
  if (!map || !actorPoint) return;
  const canvas = map.getCanvas?.();
  const w = canvas?.clientWidth || canvas?.width || 0;
  const h = canvas?.clientHeight || canvas?.height || 0;
  if (w < 32 || h < 32) return;

  // Soft outer margin — pin may sit in corners / lower third.
  const pad = margins.pad ?? 0.02;
  const left = w * pad;
  const right = w * (1 - pad);
  const top = h * pad;
  const bottom = h * (1 - (margins.bottom ?? 0.06));

  const p = map.project([actorPoint.lng, actorPoint.lat]);
  const onCanvas =
    p.x >= left && p.x <= right && p.y >= top && p.y <= bottom;
  if (onCanvas) return;

  // Nudge just enough to bring the pin onto the canvas edge — never snap to center.
  let dx = 0;
  let dy = 0;
  if (p.x < left) dx = p.x - left;
  else if (p.x > right) dx = p.x - right;
  if (p.y < top) dy = p.y - top;
  else if (p.y > bottom) dy = p.y - bottom;

  const center = map.getCenter();
  const cpx = map.project(center);
  const next = map.unproject([cpx.x + dx, cpx.y + dy]);
  const jump = {
    center: [next.lng, next.lat],
    bearing: map.getBearing(),
    pitch: map.getPitch(),
    zoom: map.getZoom(),
  };
  if (Number.isFinite(elevation)) jump.elevation = elevation;
  map.jumpTo(jump);
}

export function applyShot(
  map,
  shot,
  sample,
  { continuous = false, durationMs = 180, terrainGuard = null } = {},
) {
  if (!shot || !sample) return;

  // Landscape look-at is primary (terrain-first). Fall back to actor+offset.
  const lookBearing = Number.isFinite(shot.bearingDeg)
    ? normalizeBearing(shot.bearingDeg)
    : normalizeBearing((sample.bearing ?? 0) + (shot.relativeBearing ?? 0));

  let centerPoint;
  if (Number.isFinite(shot.lookAtLng) && Number.isFinite(shot.lookAtLat)) {
    centerPoint = { lat: shot.lookAtLat, lng: shot.lookAtLng };
  } else {
    const rawForward = shot.focusForwardM ?? shot.forwardOffsetM ?? 0;
    const rawRight = shot.focusRightM ?? shot.rightOffsetM ?? 0;
    const focusForwardM = Math.max(0, Math.min(180, rawForward));
    const focusRightM = Math.max(-120, Math.min(120, rawRight));
    centerPoint = offsetPoint(sample.point, focusForwardM, focusRightM, lookBearing);
  }
  const target = {
    lat: centerPoint.lat,
    lng: centerPoint.lng,
    bearing: lookBearing,
    pitch: shot.pitch ?? 0,
    zoom: shot.zoom ?? 14,
  };

  // Stabilize camera heading during playback to reduce terrain/imagery tile churn.
  // MapLibre streams based on view frustum; aggressive bearing changes can lead to
  // partially loaded DEM/imagery tiles being rendered -> visible seams/voids.
  const bearingGuard = terrainGuard?.bearingGuard;
  if (bearingGuard?.enabled) {
    const desiredBearing = target.bearing;
    const last = bearingGuard.lastBearingDeg;

    if (last == null || !Number.isFinite(last)) {
      bearingGuard.lastBearingDeg = desiredBearing;
    } else {
      // Compute shortest signed delta (-180..180).
      const rawDelta = normalizeBearing(desiredBearing - last);
      const signedDelta = ((rawDelta + 540) % 360) - 180;

      const absDelta = Math.abs(signedDelta);
      if (absDelta >= bearingGuard.minDeltaDeg) {
        const clampedDelta = Math.sign(signedDelta) * Math.min(absDelta, bearingGuard.maxDeltaDegPerUpdate);
        bearingGuard.lastBearingDeg = normalizeBearing(last + clampedDelta);
      }
    }

    target.bearing = bearingGuard.lastBearingDeg;
  }

  // Freeze bearing for the rest of the playback shot.
  if (!Number.isFinite(shot.bearingDeg) && Number.isFinite(target.bearing)) {
    shot.bearingDeg = normalizeBearing(target.bearing);
  }

  // When using legacy offsets, re-resolve with guarded bearing.
  if (!(Number.isFinite(shot.lookAtLng) && Number.isFinite(shot.lookAtLat))) {
    const rawForward = shot.focusForwardM ?? shot.forwardOffsetM ?? 0;
    const rawRight = shot.focusRightM ?? shot.rightOffsetM ?? 0;
    const framedCenter = offsetPoint(
      sample.point,
      Math.max(0, Math.min(180, rawForward)),
      Math.max(-120, Math.min(120, rawRight)),
      target.bearing,
    );
    target.lat = framedCenter.lat;
    target.lng = framedCenter.lng;
  }

  const terrainInfo = resolveTerrainAwareElevation(
    map,
    target,
    sample,
    shot,
    continuous && terrainGuard?.enabled
      ? {
          ...terrainGuard,
          sampleCount: 3,
          sampleRadiusM: 40,
          elevationSmoothing: terrainGuard.elevationSmoothing ?? 0.22,
        }
      : terrainGuard,
  );
  const options = cameraOptions(target, terrainInfo.elevation);

  // During playback use jumpTo every frame — small per-frame deltas produce smooth motion.
  // easeTo stacks animations and causes wobble; jumpTo at display rate is stable.
  try {
    // Safety: never let prepare corridor clamps fight the film camera.
    if (map.getMaxBounds?.()) map.setMaxBounds(null);
  } catch {
    // ignore
  }
  map.jumpTo(options);
  keepActorOnScreen(map, sample.point, terrainInfo.elevation);
  return terrainInfo;
}

export function stopCameraAnimation(map) {
  map.stop();
}

export function fitOverview(map, bounds, { maxElevationM = null } = {}) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const latPad = Math.max((ne.lat - sw.lat) * 0.12, 0.0008);
  const lngPad = Math.max((ne.lng - sw.lng) * 0.12, 0.0008);
  const expanded = new maplibregl.LngLatBounds(
    [sw.lng - lngPad, sw.lat - latPad],
    [ne.lng + lngPad, ne.lat + latPad],
  );

  const camera = map.cameraForBounds(expanded, {
    padding: { top: 80, bottom: 160, left: 40, right: 40 },
    maxZoom: 14,
  });
  if (!camera) return;

  const center = maplibregl.LngLat.convert(camera.center);
  const jumpOptions = {
    center: [center.lng, center.lat],
    zoom: camera.zoom,
    bearing: 0,
    pitch: 0,
  };

  // With 3D terrain enabled, jumpTo must include camera elevation or the viewport
  // stays on the dark terrain background until playback sets a terrain-aware shot.
  if (map.getTerrain?.()) {
    const terrainEle = safeTerrainElevation(map, center.lng, center.lat, maxElevationM);
    const baseElevation = terrainEle ?? maxElevationM ?? 0;
    const latSpanM = Math.max((ne.lat - sw.lat) * metersPerDegreeLat(), 1);
    const lngSpanM = Math.max(
      (ne.lng - sw.lng) * metersPerDegreeLng(center.lat),
      1,
    );
    const spanM = Math.max(latSpanM, lngSpanM);
    jumpOptions.elevation = baseElevation + Math.max(spanM * 0.65, 350);
  }

  map.jumpTo(jumpOptions);
  map.triggerRepaint();
}

import {
  TERRAIN_SOURCE_ID,
  ensureTerrainSource,
  applyMap3dMode as applyPeMap3dMode,
  syncMap3dGestures,
} from './mapLibreShared.js';

export {
  TERRAIN_SOURCE_ID,
  ensureTerrainSource,
  syncMap3dGestures,
};
export { applyPeMap3dMode as applyMap3dMode };

/** Ensure Peak Explorer Mapterhorn DEM is available on the current style. */
export function addTerrainSource(map) {
  try {
    ensureTerrainSource(map);
  } catch {
    // terrain is optional
  }
}

export function disableTerrain(map) {
  try {
    map.setTerrain(null);
  } catch {
    // ignore
  }
}

/**
 * Enable DEM terrain for playback (no camera ease — animator owns the shot).
 * Uses Peak Explorer Mapterhorn source + default exaggeration.
 */
export function enableTerrain(map, exaggeration = 1.6) {
  try {
    ensureTerrainSource(map);
    const current = map.getTerrain?.();
    if (!current) {
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
      map.setCenterClampedToGround?.(false);
    } else if (current.source !== TERRAIN_SOURCE_ID) {
      map.setTerrain({
        source: TERRAIN_SOURCE_ID,
        exaggeration: current.exaggeration ?? exaggeration,
      });
      map.setCenterClampedToGround?.(false);
    }
  } catch {
    // terrain is optional
  }
}

/**
 * Full Peak Explorer 2D/3D mode (terrain + hillshade + buildings + gestures).
 * Prefer this for Map 2D / Map 3D UI toggles; use enableTerrain/disableTerrain
 * during playback stall recovery.
 */
export function setMap3dMode(map, enabled, options = {}) {
  applyPeMap3dMode(map, enabled, options);
}

export function queryTerrainElevationAt(map, lng, lat, hintM = null) {
  try {
    const elevation = map.queryTerrainElevation([lng, lat]);
    return isPlausibleTerrainElevation(elevation, hintM) ? elevation : null;
  } catch {
    return null;
  }
}
