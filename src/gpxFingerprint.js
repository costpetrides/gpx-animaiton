/**
 * Stable content fingerprint for GPX routes.
 * Used to detect duplicate uploads without filename-specific logic.
 */
export function fingerprintRoutePoints(points) {
  if (!points?.length) return 'empty';

  let hash = 2166136261;
  const fnvMix = (value) => {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  };

  fnvMix(points.length);

  for (const point of points) {
    const lat = Math.round((point.lat ?? 0) * 1e5);
    const lng = Math.round((point.lng ?? 0) * 1e5);
    const ele = Number.isFinite(point.ele) ? Math.round(point.ele) : -999999;
    fnvMix(lat);
    fnvMix(lng);
    fnvMix(ele);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}
