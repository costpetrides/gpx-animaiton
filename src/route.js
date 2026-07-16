import { haversine, bearingBetween } from './gpx.js';
import { DEFAULT_SPEED_MPS } from './playback/constants.js';

/** Resample + smooth a GPS track for fluid cinematic motion */
export class RoutePath {
  constructor(rawPoints) {
    this.raw = rawPoints;
    this.points = densify(rawPoints, densifySpacing(rawPoints.length));
    this.segLengths = [];
    this.cumDist = [0];
    this.totalDistance = 0;

    for (let i = 1; i < this.points.length; i++) {
      const d = haversine(this.points[i - 1], this.points[i]);
      this.segLengths.push(d);
      this.totalDistance += d;
      this.cumDist.push(this.totalDistance);
    }

    this.hasTime =
      rawPoints.some((p) => p.time) &&
      rawPoints[0].time &&
      rawPoints[rawPoints.length - 1].time &&
      rawPoints[rawPoints.length - 1].time > rawPoints[0].time;

    this.duration = this.hasTime
      ? (rawPoints[rawPoints.length - 1].time - rawPoints[0].time) / 1000
      : this.totalDistance / DEFAULT_SPEED_MPS;
  }

  /** Get position at distance (meters) along route */
  atDistance(dist) {
    dist = Math.max(0, Math.min(dist, this.totalDistance));
    if (dist <= 0) return sampleAt(this.points, 0, 0);

    for (let i = 0; i < this.segLengths.length; i++) {
      if (this.cumDist[i + 1] >= dist) {
        const segStart = this.cumDist[i];
        const t = this.segLengths[i] > 0 ? (dist - segStart) / this.segLengths[i] : 0;
        return sampleAt(this.points, i, t);
      }
    }
    return sampleAt(this.points, this.points.length - 2, 1);
  }

  /** Get position at animation time (seconds from start) */
  atTime(sec) {
    if (!this.hasTime) return this.atDistance(sec * DEFAULT_SPEED_MPS);
    const t0 = this.raw[0].time;
    const target = t0 + sec * 1000;
    return interpolateByTime(this.raw, target);
  }

  distanceAtTime(sec) {
    const { point } = this.atTime(sec);
    return closestDistance(this, point);
  }

  coords() {
    return this.points.map((p) => [p.lng, p.lat]);
  }

  traveledCoords(dist) {
    dist = Math.max(0, Math.min(dist, this.totalDistance));

    if (
      this._traveledCache &&
      dist === this._traveledCache.dist &&
      this._traveledCache.coords
    ) {
      return this._traveledCache.coords;
    }

    // Incremental extend when playing forward (common playback path).
    if (
      this._traveledCache?.coords &&
      dist > this._traveledCache.dist &&
      this._traveledCache.segIndex != null
    ) {
      const coords = this._traveledCache.coords.slice();
      let i = this._traveledCache.segIndex;
      for (; i < this.segLengths.length; i++) {
        if (this.cumDist[i + 1] <= dist) {
          coords.push([this.points[i + 1].lng, this.points[i + 1].lat]);
        } else {
          const { point } = this.atDistance(dist);
          coords.push([point.lng, point.lat]);
          this._traveledCache = { dist, coords, segIndex: i };
          return coords;
        }
      }
      if (coords.length < 2) coords.push([...coords[0]]);
      this._traveledCache = { dist, coords, segIndex: i };
      return coords;
    }

    const coords = [[this.points[0].lng, this.points[0].lat]];
    let segIndex = 0;
    for (let i = 0; i < this.segLengths.length; i++) {
      if (this.cumDist[i + 1] <= dist) {
        coords.push([this.points[i + 1].lng, this.points[i + 1].lat]);
        segIndex = i + 1;
      } else {
        const { point } = this.atDistance(dist);
        coords.push([point.lng, point.lat]);
        segIndex = i;
        break;
      }
    }
    if (coords.length < 2) coords.push([...coords[0]]);
    this._traveledCache = { dist, coords, segIndex };
    return coords;
  }

  resetTraveledCache() {
    this._traveledCache = null;
  }
}

function densify(pts, spacingM) {
  if (pts.length < 2) return [...pts];
  const out = [pts[0]];

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const d = haversine(a, b);
    const steps = Math.max(1, Math.floor(d / spacingM));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
        ele: lerpEle(a.ele, b.ele, t),
        time: lerpTime(a.time, b.time, t),
      });
    }
  }
  return out;
}

function densifySpacing(pointCount) {
  if (pointCount > 20000) return 30;
  if (pointCount > 5000) return 15;
  return 8;
}

function lerpEle(a, b, t) {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return a + (b - a) * t;
}

function lerpTime(a, b, t) {
  if (!a || !b) return a || b || null;
  return a + (b - a) * t;
}

function sampleAt(pts, segIdx, t) {
  const a = pts[segIdx];
  const b = pts[Math.min(segIdx + 1, pts.length - 1)];
  const point = {
    lat: a.lat + (b.lat - a.lat) * t,
    lng: a.lng + (b.lng - a.lng) * t,
    ele: lerpEle(a.ele, b.ele, t),
  };

  const lookAhead = Math.min(segIdx + 3, pts.length - 1);
  const lookPt = pts[lookAhead];
  const bearing = bearingBetween(point, lookPt);

  return { point, bearing, segIdx: segIdx + t };
}

function interpolateByTime(pts, targetMs) {
  if (targetMs <= pts[0].time) return { point: pts[0], bearing: bearingBetween(pts[0], pts[1]), segIdx: 0 };
  const last = pts.length - 1;
  if (targetMs >= pts[last].time) {
    return { point: pts[last], bearing: bearingBetween(pts[last - 1], pts[last]), segIdx: last };
  }

  for (let i = 0; i < last; i++) {
    if (pts[i + 1].time >= targetMs) {
      const dt = pts[i + 1].time - pts[i].time;
      const t = dt > 0 ? (targetMs - pts[i].time) / dt : 0;
      const point = {
        lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * t,
        lng: pts[i].lng + (pts[i + 1].lng - pts[i].lng) * t,
        ele: lerpEle(pts[i].ele, pts[i + 1].ele, t),
      };
      const ahead = Math.min(i + 4, last);
      return { point, bearing: bearingBetween(point, pts[ahead]), segIdx: i + t };
    }
  }
  return { point: pts[last], bearing: 0, segIdx: last };
}

function closestDistance(route, point) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < route.points.length; i++) {
    const d = haversine(route.points[i], point);
    if (d < bestD) {
      bestD = d;
      best = route.cumDist[i];
    }
  }
  return best;
}

export function estimateSpeed(route, dist, prevDist, dt) {
  if (dt > 0 && prevDist != null) return (dist - prevDist) / dt;
  return 0;
}
