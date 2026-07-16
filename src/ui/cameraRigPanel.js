import { AVO_CAMERA_LIMITS } from '../camera/rig.js';

const MODES = {
  altitude: {
    label: 'Altitude',
    unit: 'm',
    field: 'altitudeM',
    limits: AVO_CAMERA_LIMITS.altitude,
    ticks: [0, 200, 400, 600, 800, 1000, 1200, 1400, 1500],
    format: (v) => `${Math.round(v)} m`,
  },
  tilt: {
    label: 'Tilt',
    unit: '°',
    field: 'tiltDeg',
    limits: AVO_CAMERA_LIMITS.tilt,
    ticks: [0, 10, 20, 30, 40, 50, 60, 70, 80],
    format: (v) => `${Math.round(v)}°`,
  },
  focus: {
    label: 'Focus Point',
    unit: 'm',
    field: 'focusForwardM',
    limits: AVO_CAMERA_LIMITS.focusForward,
    ticks: [-120, -80, -40, 0, 40, 80, 120, 160, 200],
    format: (v) => `${Math.round(v)} m`,
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function drawGrid(ctx, w, h) {
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  const vanishX = w * 0.42;
  const vanishY = h * 0.38;
  for (let i = -4; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(vanishX, vanishY);
    ctx.lineTo(lerp(vanishX, w + 20, 0.5 + i * 0.08), h + 10);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(vanishX, vanishY);
    ctx.lineTo(lerp(vanishX, -20, 0.5 + i * 0.08), h + 10);
    ctx.stroke();
  }
  for (let i = 0; i <= 5; i++) {
    const y = lerp(h * 0.55, h + 8, i / 5);
    const spread = lerp(20, w * 0.45, i / 5);
    ctx.beginPath();
    ctx.moveTo(vanishX - spread, y);
    ctx.lineTo(vanishX + spread, y);
    ctx.stroke();
  }
}

function drawAxes(ctx, originX, originY) {
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX, originY - 34);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX + 34, originY);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('y', originX - 10, originY - 38);
  ctx.fillText('x', originX + 38, originY + 4);
}

function drawCameraIcon(ctx, x, y, angleRad) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angleRad);
  ctx.fillStyle = '#f5c542';
  ctx.strokeStyle = '#f5c542';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(-14, -9, 24, 18, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(10, -5);
  ctx.lineTo(20, -7);
  ctx.lineTo(20, 7);
  ctx.lineTo(10, 5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(2, 0, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#1a1f2e';
  ctx.fill();
  ctx.strokeStyle = '#f5c542';
  ctx.stroke();
  ctx.restore();
}

function drawLightCone(ctx, camX, camY, targetX, targetY) {
  const dx = targetX - camX;
  const dy = targetY - camY;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const spread = 18;
  ctx.fillStyle = 'rgba(245, 197, 66, 0.18)';
  ctx.beginPath();
  ctx.moveTo(camX, camY);
  ctx.lineTo(targetX + px * spread, targetY + py * spread);
  ctx.lineTo(targetX - px * spread, targetY - py * spread);
  ctx.closePath();
  ctx.fill();
}

function drawDiagram(canvas, state, mode) {
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const originX = w * 0.42;
  const originY = h * 0.72;
  const altitude = state.altitudeM ?? 80;
  const tilt = state.tiltDeg ?? 48;
  const focusForward = state.focusForwardM ?? 0;
  const focusRight = state.focusRightM ?? 0;

  drawGrid(ctx, w, h);

  if (mode === 'focus') {
    const pad = 28;
    const cx = w * 0.5;
    const cy = h * 0.55;
    const radius = Math.min(w, h) * 0.34;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();

    const fx = cx + (focusRight / 120) * radius;
    const fy = cy - (focusForward / 120) * radius;
    ctx.strokeStyle = 'rgba(245, 197, 66, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(fx, fy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#f5c542';
    ctx.beginPath();
    ctx.arc(fx, fy, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.fillText(`${Math.round(focusForward)}m`, 14, 28);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(`lateral ${Math.round(focusRight)}m`, 14, 46);
    return;
  }

  const focusX = originX + (focusRight / 120) * 26;
  const focusY = originY - (focusForward / 120) * 18;
  drawAxes(ctx, focusX, focusY);

  const altPx = (altitude / 1500) * (h * 0.55);
  const tiltRad = (tilt / 180) * Math.PI;
  const backDist = Math.max(24, altPx / Math.max(Math.tan(tiltRad), 0.12));
  const camX = focusX - Math.sin(tiltRad) * backDist;
  const camY = focusY - altPx;

  drawLightCone(ctx, camX, camY, focusX, focusY);
  ctx.strokeStyle = 'rgba(245, 197, 66, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(camX, camY);
  ctx.lineTo(focusX, focusY);
  ctx.stroke();
  ctx.setLineDash([]);

  const camAngle = Math.atan2(focusY - camY, focusX - camX);
  drawCameraIcon(ctx, camX, camY, camAngle);

  ctx.fillStyle = '#fff';
  ctx.font = '600 24px system-ui, sans-serif';
  const readout = mode === 'altitude'
    ? `${Math.round(altitude)} m`
    : `${Math.round(tilt)}°`;
  ctx.fillText(readout, camX + 12, camY - 10);
}

function valueToPercent(value, min, max) {
  if (max <= min) return 0;
  return ((value - min) / (max - min)) * 100;
}

function percentToValue(percent, min, max, step) {
  const raw = min + (percent / 100) * (max - min);
  if (!step) return raw;
  return Math.round(raw / step) * step;
}

export function createCameraRigPanel(root, { onRigChange } = {}) {
  if (!root) return null;

  let mode = 'tilt';
  let rigState = {
    altitudeM: AVO_CAMERA_LIMITS.altitude.default,
    tiltDeg: AVO_CAMERA_LIMITS.tilt.default,
    pitchDeg: AVO_CAMERA_LIMITS.tilt.default,
    focusForwardM: 0,
    focusRightM: 0,
  };
  let focusDrag = null;

  const canvas = root.querySelector('#avo-camera-diagram');
  const tabs = root.querySelectorAll('[data-avo-mode]');
  const slider = root.querySelector('#avo-camera-slider');
  const ticksEl = root.querySelector('#avo-slider-ticks');
  const nameEl = root.querySelector('#avo-control-name');
  const readoutEl = root.querySelector('#avo-control-readout');
  const focusRow = root.querySelector('#avo-focus-lateral-row');
  const lateralSlider = root.querySelector('#avo-focus-lateral');
  const minusBtn = root.querySelector('[data-avo-step="-1"]');
  const plusBtn = root.querySelector('[data-avo-step="1"]');

  function getModeConfig() {
    return MODES[mode];
  }

  function getModeValue() {
    const cfg = getModeConfig();
    return rigState[cfg.field] ?? cfg.limits.default;
  }

  function emitRig(patch) {
    const next = { ...rigState, ...patch };
    if (patch.tiltDeg != null) next.pitchDeg = patch.tiltDeg;
    rigState = next;
    onRigChange?.(rigState);
    refresh();
  }

  function buildTicks(cfg) {
    if (!ticksEl) return;
    ticksEl.innerHTML = cfg.ticks.map((tick) => {
      const pct = valueToPercent(tick, cfg.limits.min, cfg.limits.max);
      const label = cfg.unit === '°' ? `${tick}°` : `${tick}`;
      return `<span class="avo-tick" style="left:${pct}%"><i>${label}</i></span>`;
    }).join('');
  }

  function refresh() {
    const cfg = getModeConfig();
    root.dataset.mode = mode;
    if (nameEl) nameEl.textContent = cfg.label;
    if (readoutEl) readoutEl.textContent = cfg.format(getModeValue());
    if (slider) {
      slider.min = String(cfg.limits.min);
      slider.max = String(cfg.limits.max);
      slider.step = String(cfg.limits.step);
      slider.value = String(getModeValue());
    }
    if (focusRow) {
      focusRow.classList.toggle('hidden', mode !== 'focus');
    }
    if (lateralSlider && mode === 'focus') {
      lateralSlider.value = String(rigState.focusRightM ?? 0);
      const lateralVal = root.querySelector('#avo-focus-lateral-val');
      if (lateralVal) lateralVal.textContent = `${Math.round(rigState.focusRightM ?? 0)} m`;
    }
    buildTicks(cfg);
    tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.avoMode === mode));
    if (canvas) drawDiagram(canvas, rigState, mode);
  }

  function setMode(nextMode) {
    if (!MODES[nextMode]) return;
    mode = nextMode;
    refresh();
  }

  function nudge(delta) {
    const cfg = getModeConfig();
    const next = clamp(getModeValue() + delta * cfg.limits.step, cfg.limits.min, cfg.limits.max);
    emitRig({ [cfg.field]: next });
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.avoMode));
  });

  slider?.addEventListener('input', () => {
    const cfg = getModeConfig();
    const value = parseFloat(slider.value);
    emitRig({ [cfg.field]: clamp(value, cfg.limits.min, cfg.limits.max) });
  });

  lateralSlider?.addEventListener('input', () => {
    const value = parseFloat(lateralSlider.value);
    emitRig({ focusRightM: clamp(value, AVO_CAMERA_LIMITS.focusRight.min, AVO_CAMERA_LIMITS.focusRight.max) });
  });

  minusBtn?.addEventListener('click', () => nudge(-1));
  plusBtn?.addEventListener('click', () => nudge(1));

  canvas?.addEventListener('pointerdown', (e) => {
    if (mode !== 'focus') return;
    focusDrag = { pointerId: e.pointerId };
    canvas.setPointerCapture?.(e.pointerId);
    updateFocusFromPointer(e);
    e.preventDefault();
  });

  canvas?.addEventListener('pointermove', (e) => {
    if (!focusDrag || focusDrag.pointerId !== e.pointerId) return;
    updateFocusFromPointer(e);
  });

  function endFocusDrag(e) {
    if (!focusDrag) return;
    if (e?.pointerId != null && focusDrag.pointerId !== e.pointerId) return;
    focusDrag = null;
    if (e?.pointerId != null) canvas.releasePointerCapture?.(e.pointerId);
  }

  canvas?.addEventListener('pointerup', endFocusDrag);
  canvas?.addEventListener('pointercancel', endFocusDrag);

  function updateFocusFromPointer(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width * 0.5;
    const cy = rect.height * 0.55;
    const radius = Math.min(rect.width, rect.height) * 0.34;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    const scale = dist > radius ? radius / dist : 1;
    const nx = dx * scale;
    const ny = dy * scale;
    const focusRightM = clamp(Math.round((nx / radius) * 120), AVO_CAMERA_LIMITS.focusRight.min, AVO_CAMERA_LIMITS.focusRight.max);
    const focusForwardM = clamp(Math.round((-ny / radius) * 120), AVO_CAMERA_LIMITS.focusForward.min, AVO_CAMERA_LIMITS.focusForward.max);
    emitRig({ focusForwardM, focusRightM });
    if (slider) slider.value = String(focusForwardM);
  }

  window.addEventListener('resize', () => refresh());

  return {
    setRig(rig) {
      rigState = {
        altitudeM: rig.altitudeM ?? AVO_CAMERA_LIMITS.altitude.default,
        tiltDeg: rig.tiltDeg ?? rig.pitchDeg ?? AVO_CAMERA_LIMITS.tilt.default,
        pitchDeg: rig.pitchDeg ?? rig.tiltDeg ?? AVO_CAMERA_LIMITS.tilt.default,
        focusForwardM: rig.focusForwardM ?? 0,
        focusRightM: rig.focusRightM ?? 0,
      };
      refresh();
    },
    setMode,
    getMode: () => mode,
    refresh,
  };
}
