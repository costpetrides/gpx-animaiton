/**
 * Local trail context for cinematic framing decisions.
 * Pure geometry over the RoutePath — no MapLibre dependency.
 */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function bearingDeltaDeg(a, b) {
  let d = ((b - a + 540) % 360) - 180;
  return d;
}

/**
 * @param {import('../../route.js').RoutePath} route
 * @param {number} animDistance
 * @param {{ windowM?: number }} [options]
 */
export function analyzeTrailContext(route, animDistance, options = {}) {
  const windowM = options.windowM ?? 320;
  if (!route?.totalDistance) {
    return {
      curvature: 0,
      slope: 0,
      reliefM: 0,
      isLocalSummit: false,
      isNarrowRelief: false,
      subjectEle: 0,
      avgEle: 0,
      lookaheadBearing: 0,
    };
  }

  const dist = clamp(animDistance, 0, route.totalDistance);
  const from = Math.max(0, dist - windowM * 0.35);
  const to = Math.min(route.totalDistance, dist + windowM * 0.65);

  const samples = [];
  const step = Math.max(8, (to - from) / 16);
  for (let d = from; d <= to; d += step) {
    const s = route.atDistance(d);
    if (s?.point) samples.push({ ...s, distance: d });
  }

  if (samples.length < 3) {
    const s = route.atDistance(dist);
    return {
      curvature: 0,
      slope: 0,
      reliefM: 0,
      isLocalSummit: false,
      isNarrowRelief: false,
      subjectEle: s?.point?.ele ?? 0,
      avgEle: s?.point?.ele ?? 0,
      lookaheadBearing: s?.bearing ?? 0,
    };
  }

  let turnAccum = 0;
  let pathLen = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const seg = Math.max(1, b.distance - a.distance);
    pathLen += seg;
    turnAccum += Math.abs(bearingDeltaDeg(a.bearing, b.bearing));
  }
  const curvature = pathLen > 0 ? turnAccum / pathLen : 0; // deg per meter

  const eles = samples
    .map((s) => s.point.ele)
    .filter((e) => Number.isFinite(e));
  const subject = route.atDistance(dist);
  const subjectEle = Number.isFinite(subject?.point?.ele) ? subject.point.ele : (eles[0] ?? 0);
  const minEle = eles.length ? Math.min(...eles) : subjectEle;
  const maxEle = eles.length ? Math.max(...eles) : subjectEle;
  const reliefM = maxEle - minEle;
  const avgEle = eles.length ? eles.reduce((a, b) => a + b, 0) / eles.length : subjectEle;

  const first = samples[0];
  const last = samples[samples.length - 1];
  const eleSpan = (Number.isFinite(last.point.ele) && Number.isFinite(first.point.ele))
    ? last.point.ele - first.point.ele
    : 0;
  const slope = pathLen > 0 ? eleSpan / pathLen : 0;

  const nearEnd = dist > route.totalDistance * 0.92;
  const isLocalSummit =
    subjectEle >= maxEle - Math.max(8, reliefM * 0.12) &&
    (Math.abs(slope) < 0.08 || nearEnd);

  // High walls around a lower trail → canyon-like framing
  const isNarrowRelief = reliefM > 120 && subjectEle < avgEle - reliefM * 0.15;

  const lookahead = route.atDistance(Math.min(route.totalDistance, dist + 140));

  return {
    curvature,
    slope,
    reliefM,
    isLocalSummit,
    isNarrowRelief,
    subjectEle,
    avgEle,
    lookaheadBearing: lookahead?.bearing ?? subject?.bearing ?? 0,
  };
}
