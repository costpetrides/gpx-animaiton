import exifr from 'exifr';
import { haversine } from '../gpx.js';

export const DEFAULT_PHOTO_DISPLAY_MS = 3000;
export const GPS_ROUTE_MATCH_THRESHOLD_M = 250;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function finite(value) {
  return Number.isFinite(value) ? value : undefined;
}

function normalizeDate(value) {
  if (!value) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export async function readPhotoMetadata(file) {
  try {
    const meta = await exifr.parse(file, {
      gps: true,
      tiff: true,
      exif: true,
      ifd0: true,
      translateValues: true,
    });

    const latitude = finite(meta?.latitude);
    const longitude = finite(meta?.longitude);
    const timestamp =
      normalizeDate(meta?.DateTimeOriginal) ??
      normalizeDate(meta?.CreateDate) ??
      normalizeDate(meta?.MediaCreateDate) ??
      normalizeDate(meta?.DateTimeDigitized) ??
      normalizeDate(meta?.ModifyDate) ??
      (Number.isFinite(file?.lastModified) && file.lastModified > 0
        ? new Date(file.lastModified)
        : undefined);

    return { latitude, longitude, timestamp };
  } catch {
    const fallback = Number.isFinite(file?.lastModified) && file.lastModified > 0
      ? new Date(file.lastModified)
      : undefined;
    return { timestamp: fallback };
  }
}

function metersPerDegreeLng(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}

function projectToSegment(point, a, b) {
  const lat0 = (a.lat + b.lat + point.lat) / 3;
  const mx = metersPerDegreeLng(lat0);
  const my = 111320;

  const ax = a.lng * mx;
  const ay = a.lat * my;
  const bx = b.lng * mx;
  const by = b.lat * my;
  const px = point.lng * mx;
  const py = point.lat * my;

  const dx = bx - ax;
  const dy = by - ay;
  const denom = dx * dx + dy * dy;
  const t = denom > 0
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denom))
    : 0;

  return {
    t,
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
  };
}

export function projectCoordinateToRoute(route, lat, lng) {
  if (!route?.points?.length || route.points.length < 2) return null;

  const target = { lat, lng };
  let best = null;

  for (let i = 0; i < route.points.length - 1; i += 1) {
    const a = route.points[i];
    const b = route.points[i + 1];
    const projected = projectToSegment(target, a, b);
    const distanceMeters = haversine(target, projected);
    if (!best || distanceMeters < best.distanceMeters) {
      const segmentLength = route.segLengths[i] ?? haversine(a, b);
      const routeDistanceM = (route.cumDist[i] ?? 0) + segmentLength * projected.t;
      best = {
        lat: projected.lat,
        lng: projected.lng,
        distanceMeters,
        routeDistanceM,
        progress: route.totalDistance > 0 ? clamp01(routeDistanceM / route.totalDistance) : 0,
      };
    }
  }

  return best;
}

function placementFromPointIndex(route, pointIndex) {
  if (!Number.isFinite(pointIndex) || !route?.raw?.length) return null;
  const index = Math.max(0, Math.min(route.raw.length - 1, Math.round(pointIndex)));
  const point = route.raw[index];
  if (!point) return null;
  return projectCoordinateToRoute(route, point.lat, point.lng);
}

function placementFromRouteDistance(route, routeDistanceM) {
  if (!Number.isFinite(routeDistanceM) || !route) return null;
  const distance = Math.max(0, Math.min(route.totalDistance, routeDistanceM));
  const sample = route.atDistance(distance)?.point;
  if (!sample) return null;
  return {
    lat: sample.lat,
    lng: sample.lng,
    routeDistanceM: distance,
    progress: route.totalDistance > 0 ? clamp01(distance / route.totalDistance) : 0,
    distanceMeters: 0,
  };
}

function placementFromTimestamp(route, timestamp) {
  const targetMs = timestamp?.getTime?.();
  const points = route?.raw || [];
  if (!Number.isFinite(targetMs) || points.length < 2) return null;

  const timed = points
    .map((point, index) => ({ point, index, time: point.time }))
    .filter((entry) => Number.isFinite(entry.time));
  if (timed.length < 2) return null;

  if (targetMs < timed[0].time || targetMs > timed[timed.length - 1].time) {
    return null;
  }

  for (let i = 1; i < timed.length; i += 1) {
    const lower = timed[i - 1];
    const upper = timed[i];
    if (targetMs < lower.time || targetMs > upper.time) continue;
    const span = upper.time - lower.time;
    const t = span > 0 ? (targetMs - lower.time) / span : 0;
    const lat = lower.point.lat + (upper.point.lat - lower.point.lat) * t;
    const lng = lower.point.lng + (upper.point.lng - lower.point.lng) * t;
    return projectCoordinateToRoute(route, lat, lng);
  }

  return null;
}

export function resolvePhotoPlacement(route, {
  pointIndex,
  routeDistanceM,
  latitude,
  longitude,
  timestamp,
} = {}) {
  const byIndex = placementFromPointIndex(route, pointIndex);
  if (byIndex) return { ...byIndex, placementSource: 'pointIndex' };

  const byDistance = placementFromRouteDistance(route, routeDistanceM);
  if (byDistance) return { ...byDistance, placementSource: 'routeDistance' };

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const byGps = projectCoordinateToRoute(route, latitude, longitude);
    if (byGps && byGps.distanceMeters <= GPS_ROUTE_MATCH_THRESHOLD_M) {
      return { ...byGps, placementSource: 'gps' };
    }
  }

  const byTime = placementFromTimestamp(route, timestamp);
  if (byTime) return { ...byTime, placementSource: 'timestamp' };

  return null;
}

export function createPhotoRecord({
  id,
  file,
  url,
  metadata = {},
  placement = null,
  displayDurationMs = DEFAULT_PHOTO_DISPLAY_MS,
}) {
  return {
    id,
    originalFileName: file?.name || '',
    mimeType: file?.type || '',
    url,
    capturedAt: metadata.timestamp?.toISOString?.() || null,
    originalLat: Number.isFinite(metadata.latitude) ? metadata.latitude : null,
    originalLng: Number.isFinite(metadata.longitude) ? metadata.longitude : null,
    lat: placement?.lat ?? null,
    lng: placement?.lng ?? null,
    routeDistanceM: placement?.routeDistanceM ?? null,
    progress: placement?.progress ?? null,
    placementSource: placement?.placementSource ?? 'manual-pending',
    displayDurationMs,
    title: '',
    description: '',
  };
}
