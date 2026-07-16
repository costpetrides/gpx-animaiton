export function createElevationChart(canvas, { onScrub = null, onScrubEnd = null } = {}) {
  const ctx = canvas.getContext('2d');
  let elevations = [];
  let progress = 0;
  let isDragging = false;
  let cachedPoints = null;
  let cachedMin = 0;
  let cachedMax = 0;
  let cachedSize = { w: 0, h: 0 };

  function setProgressFromClientX(clientX) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const p = rect.width > 0 ? x / rect.width : 0;
    progress = Math.max(0, Math.min(1, p));
    draw();
    onScrub?.(progress);
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!onScrub) return;
    isDragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    setProgressFromClientX(e.clientX);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!onScrub || !isDragging) return;
    setProgressFromClientX(e.clientX);
    e.preventDefault();
  });

  function endDrag(e) {
    if (!isDragging) return;
    isDragging = false;
    if (onScrubEnd) onScrubEnd(progress);
    if (e?.pointerId != null) canvas.releasePointerCapture?.(e.pointerId);
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function setData(eles) {
    elevations = eles.filter((e) => e != null && !isNaN(e));
    draw();
  }

  function setProgress(p) {
    progress = Math.max(0, Math.min(1, p));
    drawPlayhead();
  }

  function buildPointCache(w, h) {
    if (!elevations.length) {
      cachedPoints = null;
      return;
    }

    cachedMin = Math.min(...elevations);
    cachedMax = Math.max(...elevations);
    const range = cachedMax - cachedMin || 1;
    const pad = 8;

    cachedPoints = elevations.map((e, i) => ({
      x: pad + (i / (elevations.length - 1)) * (w - pad * 2),
      y: pad + (1 - (e - cachedMin) / range) * (h - pad * 2),
    }));
    cachedSize = { w, h };
  }

  function drawStaticChart(w, h) {
    if (!cachedPoints || cachedPoints.length < 2) return;

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(59,130,246,0.35)');
    grad.addColorStop(1, 'rgba(59,130,246,0.02)');

    ctx.beginPath();
    ctx.moveTo(cachedPoints[0].x, h);
    cachedPoints.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(cachedPoints[cachedPoints.length - 1].x, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    cachedPoints.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawPlayhead() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return;

    if (elevations.length < 2) {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(139,149,168,0.5)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('No elevation data', 12, h / 2);
      return;
    }

    if (!cachedPoints || cachedSize.w !== w || cachedSize.h !== h) {
      buildPointCache(w, h);
    }
    if (!cachedPoints || cachedPoints.length < 2) return;

    ctx.clearRect(0, 0, w, h);
    drawStaticChart(w, h);

    const idx = Math.floor(progress * (elevations.length - 1));
    const cx = cachedPoints[idx].x;
    const elevationValue = elevations[idx];

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cachedPoints[idx].y, 4, 0, Math.PI * 2);
    ctx.fill();

    if (Number.isFinite(elevationValue)) {
      const label = `${Math.round(elevationValue)} m`;
      const padX = 6;
      const padY = 4;
      ctx.font = '11px system-ui, sans-serif';
      const textW = ctx.measureText(label).width;
      const boxW = textW + padX * 2;
      const boxH = 18;
      const x = Math.max(6, Math.min(w - boxW - 6, cx - boxW / 2));
      const y = Math.max(6, cachedPoints[idx].y - boxH - 8);

      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, y, boxW, boxH);

      ctx.fillStyle = '#fff';
      ctx.fillText(label, x + padX, y + 13);
    }
  }

  function draw() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    if (elevations.length < 2) {
      cachedPoints = null;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(139,149,168,0.5)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('No elevation data', 12, h / 2);
      return;
    }

    buildPointCache(w, h);
    drawPlayhead();
  }

  window.addEventListener('resize', resize);
  resize();

  return { setData, setProgress, resize };
}
