/**
 * GPX 1.0 / 1.1 parser.
 * Picks the longest track (or route / waypoints) — never merges unrelated tracks.
 */

const MIN_POINT_SPACING_M = 0.25;

export function parseGPX(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid GPX file');
  }

  const root = doc.documentElement;
  if (!root) throw new Error('Invalid GPX file');

  const ns = root.namespaceURI || 'http://www.topografix.com/GPX/1/1';
  const q = (el, tag) => {
    const nodes = el.getElementsByTagNameNS(ns, tag);
    return nodes.length ? nodes : el.getElementsByTagName(tag);
  };

  const childText = (el, tag) => {
    const nodes = el.getElementsByTagNameNS(ns, tag);
    const node = nodes.length ? nodes[0] : el.getElementsByTagName(tag)[0];
    return node?.textContent?.trim() || null;
  };

  const name =
    q(root, 'name')[0]?.textContent?.trim() ||
    q(root, 'metadata')[0] && childText(q(root, 'metadata')[0], 'name') ||
    'Untitled Route';

  const candidates = [];

  for (const trk of [...q(root, 'trk')]) {
    const trackName = childText(trk, 'name') || name;
    const segments = [...q(trk, 'trkseg')];
    if (segments.length) {
      const merged = [];
      for (const seg of segments) {
        const pts = collectPoints(seg, q, childText);
        if (pts.length < 2) continue;
        appendPoints(merged, pts);
      }
      if (merged.length >= 2) candidates.push({ name: trackName, points: merged });
    } else {
      const pts = collectPoints(trk, q, childText);
      if (pts.length >= 2) candidates.push({ name: trackName, points: pts });
    }
  }

  if (!candidates.length) {
    const rte = [...q(root, 'rte')];
    for (const route of rte) {
      const pts = collectPoints(route, q, childText, 'rtept');
      if (pts.length >= 2) candidates.push({ name: childText(route, 'name') || name, points: pts });
    }
  }

  if (!candidates.length) {
    const pts = collectPoints(root, q, childText, 'wpt');
    if (pts.length >= 2) candidates.push({ name, points: pts });
  }

  if (!candidates.length) {
    throw new Error('GPX must contain at least 2 valid points');
  }

  const best = pickLongestCandidate(candidates);
  const points = dedupeConsecutive(best.points);

  if (points.length < 2) {
    throw new Error('GPX must contain at least 2 distinct points');
  }

  return { name: best.name || name, points };
}

function appendPoints(target, incoming) {
  if (!incoming.length) return;
  if (!target.length) {
    target.push(...incoming);
    return;
  }
  const last = target[target.length - 1];
  const startIdx = haversine(last, incoming[0]) < MIN_POINT_SPACING_M ? 1 : 0;
  for (let i = startIdx; i < incoming.length; i++) {
    target.push(incoming[i]);
  }
}

function collectPoints(parent, q, childText, pointTag = 'trkpt') {
  const pts = [];
  for (const el of [...q(parent, pointTag)]) {
    const point = parsePoint(el, childText);
    if (point) pts.push(point);
  }
  return pts;
}

function parsePoint(el, childText) {
  const lat = parseFloat(el.getAttribute('lat'));
  const lon = parseFloat(el.getAttribute('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const eleRaw = parseFloat(childText(el, 'ele'));
  const timeRaw = childText(el, 'time');
  let time = null;
  if (timeRaw) {
    const parsed = Date.parse(timeRaw);
    time = Number.isFinite(parsed) ? parsed : null;
  }

  return {
    lat,
    lng: lon,
    ele: Number.isFinite(eleRaw) ? eleRaw : null,
    time,
  };
}

function pickLongestCandidate(candidates) {
  return candidates.reduce((best, cur) => {
    const bestDist = pathLength(best.points);
    const curDist = pathLength(cur.points);
    return curDist > bestDist ? cur : best;
  });
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1], points[i]);
  }
  return total;
}

function dedupeConsecutive(points) {
  if (points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (haversine(out[out.length - 1], points[i]) >= MIN_POINT_SPACING_M) {
      out.push(points[i]);
    }
  }
  if (out.length < 2 && points.length >= 2) {
    out.push(points[points.length - 1]);
  }
  return out;
}

export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function buildSegments(pts) {
  const lengths = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversine(pts[i - 1], pts[i]);
    lengths.push(d);
    total += d;
  }
  return { segLengths: lengths, totalDistance: total };
}

export function bearingBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function formatDistance(m) {
  if (m >= 1000) return (m / 1000).toFixed(2) + ' km';
  return Math.round(m) + ' m';
}

export function formatSpeed(ms) {
  const kmh = ms * 3.6;
  return kmh.toFixed(1) + ' km/h';
}

export function formatElevation(m) {
  if (m == null || isNaN(m)) return '—';
  return Math.round(m) + ' m';
}

export function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
