export function createKeyframeId() {
  return `kf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function createCameraKeyframe(time, rig, label = '') {
  return {
    id: createKeyframeId(),
    track: 'camera',
    time: Math.max(0, time),
    label: label || `Camera @ ${formatKeyframeTime(time)}`,
    rig: { ...rig },
  };
}

export function formatKeyframeTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function addKeyframe(keyframes, keyframe) {
  const next = [...(keyframes || []), keyframe].sort((a, b) => a.time - b.time);
  return dedupeKeyframeTimes(next);
}

export function removeKeyframe(keyframes, id) {
  return (keyframes || []).filter((kf) => kf.id !== id);
}

export function updateKeyframe(keyframes, id, patch) {
  return (keyframes || []).map((kf) => (kf.id === id ? { ...kf, ...patch } : kf));
}

function dedupeKeyframeTimes(keyframes) {
  const seen = new Set();
  return keyframes.filter((kf) => {
    const key = `${kf.track}:${kf.time.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function keyframesAtTrack(keyframes, track = 'camera') {
  return (keyframes || []).filter((kf) => kf.track === track).sort((a, b) => a.time - b.time);
}
