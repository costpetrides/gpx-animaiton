/**
 * Frame-by-frame video export using the map canvas and MediaRecorder.
 */

export const EXPORT_QUALITY_PRESETS = {
  draft: { label: 'Draft', width: 1280, height: 720, fps: 24, bitrate: 4_000_000 },
  standard: { label: 'Standard', width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  high: { label: 'High', width: 1920, height: 1080, fps: 60, bitrate: 16_000_000 },
};

export function normalizeExportQuality(value) {
  if (value === 'draft' || value === 'high') return value;
  return 'standard';
}

export function createVideoExporter(deps) {
  const { map, animator, getDuration, onProgress, onStatus } = deps;
  let abortController = null;

  function abort() {
    abortController?.abort();
    abortController = null;
  }

  async function exportVideo(options = {}) {
    const quality = EXPORT_QUALITY_PRESETS[normalizeExportQuality(options.quality)] || EXPORT_QUALITY_PRESETS.standard;
    const format = options.format === 'webm' ? 'webm' : 'mp4';
    const mimeType = format === 'webm'
      ? 'video/webm;codecs=vp9'
      : (MediaRecorder.isTypeSupported('video/mp4')
        ? 'video/mp4'
        : (MediaRecorder.isTypeSupported('video/webm;codecs=h264')
          ? 'video/webm;codecs=h264'
          : 'video/webm;codecs=vp9'));

    if (!animator.getRoute()) throw new Error('No route loaded');
    abortController = new AbortController();
    const { signal } = abortController;

    animator.pause();
    onStatus?.('Preparing MP4 export…');
    animator.reprepare?.('export');
    await waitUntil(() => animator.isPlaybackArmed(), { timeoutMs: 120000, signal });

    const duration = getDuration();
    if (duration <= 0) throw new Error('Invalid animation duration');

    const mapCanvas = map.getCanvas();
    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = mapCanvas.width;
    compositeCanvas.height = mapCanvas.height;
    const compositeCtx = compositeCanvas.getContext('2d', { alpha: false });
    if (!compositeCtx) throw new Error('Could not create export composition canvas');

    const drawCompositeFrame = () => {
      if (
        compositeCanvas.width !== mapCanvas.width ||
        compositeCanvas.height !== mapCanvas.height
      ) {
        compositeCanvas.width = mapCanvas.width;
        compositeCanvas.height = mapCanvas.height;
      }

      const width = compositeCanvas.width;
      const height = compositeCanvas.height;
      compositeCtx.clearRect(0, 0, width, height);
      compositeCtx.drawImage(mapCanvas, 0, 0, width, height);
      drawFilmStats(compositeCtx, width, height);
      drawElevationProfile(compositeCtx, width, height);
    };

    drawCompositeFrame();
    const stream = compositeCanvas.captureStream(quality.fps);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: quality.bitrate,
    });

    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };

    const finished = new Promise((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
      recorder.onerror = () => reject(new Error('MediaRecorder failed'));
      signal.addEventListener('abort', () => reject(new Error('export_aborted')));
    });

    onStatus?.('Rendering frames…');

    const frameInterval = 1000 / quality.fps;
    const totalFrames = Math.ceil(duration * quality.fps);
    const introMs = animator.getIntroDurationMs?.() ?? 1500;
    const outroMs = animator.getOutroDurationMs?.() ?? 3000;
    const totalFilmDuration = duration + introMs / 1000 + outroMs / 1000;

    // Export the same sequence the user previews:
    // panoramic overview -> focus fly-in -> route replay -> panoramic outro.
    animator.reset();
    animator.showOverview?.();
    await waitForMapRender(map, signal);
    drawCompositeFrame();
    await waitMs(120, signal);

    // Start capture only after the panoramic opening frame is fully settled.
    recorder.start(100);

    onStatus?.('Rendering cinematic intro…');
    await captureCameraMotion({
      action: () => animator.focusStart?.(introMs),
      durationMs: introMs,
      fps: quality.fps,
      drawCompositeFrame,
      signal,
    });
    if (signal.aborted) throw new Error('export_aborted');

    onStatus?.('Rendering route…');
    for (let frame = 0; frame < totalFrames; frame++) {
      if (signal.aborted) throw new Error('export_aborted');
      const t = frame / quality.fps;
      const pct = duration > 0 ? (t / duration) * 1000 : 0;
      if (animator.renderExportProgress) animator.renderExportProgress(pct);
      else animator.scrubPreview(pct);
      map.triggerRepaint?.();
      await waitForMapRender(map, signal);
      drawCompositeFrame();
      await waitMs(Math.max(0, frameInterval - 8), signal);
      if (frame % 8 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      onProgress?.({
        frame,
        totalFrames,
        time: t + introMs / 1000,
        duration: totalFilmDuration,
      });
    }

    onStatus?.('Rendering cinematic outro…');
    await captureCameraMotion({
      action: () => animator.playOutro?.(outroMs),
      durationMs: outroMs,
      fps: quality.fps,
      drawCompositeFrame,
      signal,
    });
    if (signal.aborted) throw new Error('export_aborted');

    recorder.stop();
    onStatus?.('Finalizing video…');
    const blob = await finished;
    abortController = null;
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const base = options.filenameBase || 'trail-animation';
    return { blob, mimeType: mimeType.split(';')[0], filename: `${base}.${ext}` };
  }

  return { exportVideo, abort };
}

function waitForMapRender(map, signal, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('export_aborted'));
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    const timer = setTimeout(finish, timeoutMs);
    const onRender = () => {
      clearTimeout(timer);
      finish();
    };
    map.once?.('render', onRender);
    requestAnimationFrame(() => map.triggerRepaint?.());
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('export_aborted'));
    }, { once: true });
  });
}

function waitMs(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      reject(new Error('export_aborted'));
    });
  });
}

function waitUntil(predicate, { timeoutMs = 30000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (signal?.aborted) {
        reject(new Error('export_aborted'));
        return;
      }
      if (predicate()) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error('export_timeout'));
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


async function captureCameraMotion({
  action,
  durationMs,
  fps,
  drawCompositeFrame,
  signal,
}) {
  const actionPromise = Promise.resolve(action?.());
  const interval = 1000 / Math.max(1, fps);
  const startedAt = performance.now();

  while (performance.now() - startedAt < durationMs) {
    if (signal?.aborted) throw new Error('export_aborted');
    drawCompositeFrame();
    await waitMs(Math.max(1, interval - 2), signal);
  }

  await actionPromise;
  drawCompositeFrame();
}

function drawFilmStats(ctx, width, height) {
  const values = [
    ['DISTANCE', document.getElementById('live-distance')?.textContent || '—'],
    ['GAIN', document.getElementById('live-gain')?.textContent || '—'],
    ['ALTITUDE', document.getElementById('live-elevation')?.textContent || '—'],
    ['GPX TIME', document.getElementById('live-time')?.textContent || '00:00'],
  ];

  const scale = width / Math.max(1, document.getElementById('map')?.clientWidth || width);
  const x = 18 * scale;
  const y = 18 * scale;
  const boxW = 220 * scale;
  const boxH = 92 * scale;

  ctx.save();
  ctx.fillStyle = 'rgba(8,10,12,0.62)';
  roundRect(ctx, x, y, boxW, boxH, 12 * scale);
  ctx.fill();

  const colW = boxW / 2;
  const rowH = boxH / 2;
  values.forEach(([label, value], index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const tx = x + 12 * scale + col * colW;
    const ty = y + 21 * scale + row * rowH;

    ctx.fillStyle = 'rgba(255,255,255,0.66)';
    ctx.font = `${Math.max(8, 9 * scale)}px sans-serif`;
    ctx.fillText(label, tx, ty);

    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.max(10, 13 * scale)}px monospace`;
    ctx.fillText(String(value), tx, ty + 18 * scale);
  });
  ctx.restore();
}

function drawElevationProfile(ctx, width, height) {
  const source = document.getElementById('elevation-profile');
  if (!(source instanceof HTMLCanvasElement) || source.width <= 0 || source.height <= 0) return;

  const targetWidth = width * 0.85;
  const cssMapHeight = Math.max(1, document.getElementById('map')?.clientHeight || height);
  const scale = height / cssMapHeight;
  const targetHeight = Math.max(44 * scale, 76 * scale);
  const x = (width - targetWidth) / 2;
  const y = height - targetHeight - 12 * scale;

  ctx.save();
  ctx.globalAlpha = 0.98;
  ctx.drawImage(source, x, y, targetWidth, targetHeight);
  ctx.restore();
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
