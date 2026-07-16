import maplibregl from 'maplibre-gl';

export const CAMERA_PRESETS = {
  follow: {
    // AvoMap-like "North True" default: stable heading, calmer frustum.
    label: 'Follow',
    zoom: 15,
    pitch: 48,
    forwardOffsetM: -18,
    rightOffsetM: 0,
    relativeBearing: 0,
    bearingDeg: 0,
  },
  bird: {
    label: 'Bird',
    zoom: 14.2,
    pitch: 22,
    forwardOffsetM: 0,
    rightOffsetM: 0,
    relativeBearing: 0,
    bearingDeg: 0,
  },
};

export function normalizeCameraPreset(preset) {
  return preset === 'bird' ? 'bird' : 'follow';
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

export function defaultShotForMode(modeKey = 'follow') {
  const preset = CAMERA_PRESETS[normalizeCameraPreset(modeKey)] || CAMERA_PRESETS.follow;
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

export function applyShot(
  map,
  shot,
  sample,
  { continuous = false, durationMs = 180, terrainGuard = null } = {},
) {
  if (!shot || !sample) return;

  const centerPoint = offsetPoint(
    sample.point,
    shot.focusForwardM ?? shot.forwardOffsetM ?? 0,
    shot.focusRightM ?? shot.rightOffsetM ?? 0,
    sample.bearing ?? 0,
  );
  const target = {
    lat: centerPoint.lat,
    lng: centerPoint.lng,
    // If the shot captured an explicit heading, use it and keep it stable.
    // Otherwise derive once from route bearing + relative offset and freeze.
    bearing: (() => {
      if (Number.isFinite(shot.bearingDeg)) return normalizeBearing(shot.bearingDeg);
      return normalizeBearing((sample.bearing ?? 0) + (shot.relativeBearing ?? 0));
    })(),
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
  const terrainInfo = resolveTerrainAwareElevation(
    map,
    target,
    sample,
    shot,
    continuous && terrainGuard?.enabled
      ? {
          ...terrainGuard,
          sampleCount: 4,
          sampleRadiusM: 50,
          elevationSmoothing: terrainGuard.elevationSmoothing ?? 0.22,
        }
      : terrainGuard,
  );
  const options = cameraOptions(target, terrainInfo.elevation);

  // During playback use jumpTo every frame — small per-frame deltas produce smooth motion.
  // easeTo stacks animations and causes wobble; jumpTo at display rate is stable.
  map.jumpTo(options);
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

export function addTerrainSource(map) {
  try {
    if (!map.getLayer('terrain-background')) {
      const beforeId = map.getStyle().layers?.[0]?.id;
      map.addLayer(
        {
          id: 'terrain-background',
          type: 'background',
          paint: { 'background-color': '#0b1020' },
        },
        beforeId,
      );
    }

    if (!map.getSource('terrain-dem')) {
      map.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
      });
    }
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

export function enableTerrain(map) {
  try {
    addTerrainSource(map);
    if (!map.getTerrain?.()) {
      map.setTerrain({ source: 'terrain-dem', exaggeration: 1.2 });
      map.setCenterClampedToGround(false);
    }
  } catch {
    // terrain is optional
  }
}

export function queryTerrainElevationAt(map, lng, lat, hintM = null) {
  try {
    const elevation = map.queryTerrainElevation([lng, lat]);
    return isPlausibleTerrainElevation(elevation, hintM) ? elevation : null;
  } catch {
    return null;
  }
}
