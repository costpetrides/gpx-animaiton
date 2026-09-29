/**
 * Deterministic video export.
 *
 * MP4 uses WebCodecs H.264 + mp4-muxer, matching TrailReplay's production
 * approach. Frames are encoded with explicit presentation timestamps, so
 * export duration is independent of how long MapLibre/terrain takes to render.
 *
 * WebM remains available through MediaRecorder as a compatibility format.
 */
import {
  createMp4CanvasEncoder,
  isWebCodecsMp4Supported,
} from './mp4CanvasEncoder.js';

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
  const { map, animator, getDuration, getPhotos, onProgress, onStatus } = deps;
  let abortController = null;

  function abort() {
    abortController?.abort();
    abortController = null;
  }

  async function exportVideo(options = {}) {
    const quality =
      EXPORT_QUALITY_PRESETS[normalizeExportQuality(options.quality)] ||
      EXPORT_QUALITY_PRESETS.standard;
    const format = options.format === 'webm' ? 'webm' : 'mp4';

    if (!animator.getRoute()) throw new Error('No route loaded');

    abortController = new AbortController();
    const { signal } = abortController;

    try {
      animator.pause();
      onStatus?.(format === 'mp4' ? 'Preparing MP4 export…' : 'Preparing WebM export…');
      animator.reprepare?.('export');
      await waitUntil(() => animator.isPlaybackArmed(), {
        timeoutMs: 120000,
        signal,
      });

      const routeDurationSec = getDuration();
      if (routeDurationSec <= 0) throw new Error('Invalid animation duration');
      const photos = (getPhotos?.() || [])
        .filter((photo) => Number.isFinite(photo.progress) && photo.url)
        .sort((a, b) => a.progress - b.progress);
      const photoAssets = await loadPhotoAssets(photos, signal);

      const introMs = animator.getIntroDurationMs?.() ?? 1500;
      const outroMs = animator.getOutroDurationMs?.() ?? 3000;

      const mapCanvas = map.getCanvas();
      const compositeCanvas = document.createElement('canvas');
      compositeCanvas.width = quality.width;
      compositeCanvas.height = quality.height;
      const compositeCtx = compositeCanvas.getContext('2d', { alpha: false });
      if (!compositeCtx) {
        throw new Error('Could not create export composition canvas');
      }

      const drawCompositeFrame = (photoMoment = null) => {
        const width = compositeCanvas.width;
        const height = compositeCanvas.height;

        compositeCtx.fillStyle = '#000';
        compositeCtx.fillRect(0, 0, width, height);

        drawCover(
          compositeCtx,
          mapCanvas,
          width,
          height,
        );
        drawFilmStats(compositeCtx, width, height);
        drawElevationProfile(compositeCtx, width, height);
        if (photoMoment?.photo && photoMoment?.image) {
          drawPhotoMoment(
            compositeCtx,
            width,
            height,
            photoMoment.photo,
            photoMoment.image,
            photoMoment.elapsedMs,
            photoMoment.durationMs,
          );
        }
      };

      if (format === 'mp4') {
        if (!isWebCodecsMp4Supported()) {
          throw new Error(
            'This device does not support H.264 WebCodecs MP4 export.',
          );
        }

        const encoder = await createMp4CanvasEncoder({
          width: quality.width,
          height: quality.height,
          fps: quality.fps,
          bitrate: quality.bitrate,
        });
        if (!encoder) {
          throw new Error(
            'No compatible H.264 encoder is available for MP4 export.',
          );
        }

        try {
          const blob = await exportDeterministicMp4({
            map,
            animator,
            encoder,
            compositeCanvas,
            drawCompositeFrame,
            quality,
            routeDurationSec,
            introMs,
            outroMs,
            photos,
            photoAssets,
            signal,
            onProgress,
            onStatus,
          });

          const base = options.filenameBase || 'trail-animation';
          return {
            blob,
            mimeType: 'video/mp4',
            filename: `${base}.mp4`,
          };
        } catch (error) {
          encoder.close();
          throw error;
        }
      }

      return await exportWebmFallback({
        map,
        animator,
        compositeCanvas,
        drawCompositeFrame,
        quality,
        routeDurationSec,
        introMs,
        outroMs,
        photos,
        photoAssets,
        signal,
        onProgress,
        onStatus,
        filenameBase: options.filenameBase || 'trail-animation',
      });
    } finally {
      abortController = null;
    }
  }

  return { exportVideo, abort };
}

async function exportDeterministicMp4({
  map,
  animator,
  encoder,
  compositeCanvas,
  drawCompositeFrame,
  quality,
  routeDurationSec,
  introMs,
  outroMs,
  photos,
  photoAssets,
  signal,
  onProgress,
  onStatus,
}) {
  const fps = quality.fps;
  const frameDurationMs = 1000 / fps;
  const frameDurationMicros = Math.round(1_000_000 / fps);

  const introFrames = Math.max(0, Math.round((introMs / 1000) * fps));
  const routeFrames = Math.max(1, Math.round(routeDurationSec * fps));
  const outroFrames = Math.max(1, Math.round((outroMs / 1000) * fps));
  const photoFrames = photos.reduce(
    (sum, photo) => sum + Math.max(1, Math.round(((photo.displayDurationMs || 3000) / 1000) * fps)),
    0,
  );
  const totalFrames = introFrames + routeFrames + photoFrames + outroFrames;

  let encodedFrame = 0;

  const encodeCurrent = async () => {
    if (signal.aborted) throw new Error('export_aborted');
    await encoder.encodeCanvas(
      compositeCanvas,
      Math.round(encodedFrame * frameDurationMicros),
      frameDurationMicros,
    );
    encodedFrame += 1;
    onProgress?.({
      frame: encodedFrame,
      totalFrames,
      time: encodedFrame / fps,
      duration: totalFrames / fps,
    });
  };

  // Start export directly on the first playback camera pose.
  animator.reset();
  await animator.focusStart?.(0);
  map.triggerRepaint?.();
  await waitForMapSettledEnough(map, signal);
  drawCompositeFrame();

  onStatus?.('Rendering route…');
  let nextPhotoIndex = 0;
  for (let i = 0; i < routeFrames; i += 1) {
    if (signal.aborted) throw new Error('export_aborted');

    const progress =
      routeFrames <= 1 ? 0 : i / (routeFrames - 1);
    const pct = progress * 1000;

    if (animator.renderExportProgress) {
      animator.renderExportProgress(pct);
    } else {
      animator.scrubPreview(pct);
    }

    map.triggerRepaint?.();
    await waitForMapRender(map, signal);

    drawCompositeFrame();
    await encodeCurrent();

    const dueProgress = progress + 1e-9;
    while (nextPhotoIndex < photos.length && photos[nextPhotoIndex].progress <= dueProgress) {
      const photo = photos[nextPhotoIndex];
      const image = photoAssets.get(photo.id);
      nextPhotoIndex += 1;
      if (!image) continue;

      onStatus?.('Rendering photo moments…');
      const durationMs = Math.max(500, photo.displayDurationMs || 3000);
      const holdFrames = Math.max(1, Math.round((durationMs / 1000) * fps));
      for (let holdFrame = 0; holdFrame < holdFrames; holdFrame += 1) {
        if (signal.aborted) throw new Error('export_aborted');
        const elapsedMs = holdFrames <= 1
          ? durationMs
          : (holdFrame / (holdFrames - 1)) * durationMs;
        drawCompositeFrame({ photo, image, elapsedMs, durationMs });
        await encodeCurrent();
      }
      onStatus?.('Rendering route…');
    }
  }

  onStatus?.('Rendering cinematic outro…');
  animator.beginExportOutro?.();

  for (let i = 0; i < outroFrames; i += 1) {
    if (signal.aborted) throw new Error('export_aborted');

    const progress =
      outroFrames <= 1 ? 1 : i / (outroFrames - 1);
    const rendered = animator.renderExportOutroProgress?.(progress);

    if (rendered === false || rendered == null) {
      // Compatibility fallback for older animator implementations.
      if (i === 0) {
        await Promise.resolve(animator.playOutro?.(outroMs));
      }
    }

    map.triggerRepaint?.();
    await waitForMapRender(map, signal);
    drawCompositeFrame();
    await encodeCurrent();
  }
  animator.resetExportOutro?.();

  onStatus?.('Finalizing MP4…');
  return await encoder.finalize();
}

async function exportWebmFallback({
  map,
  animator,
  compositeCanvas,
  drawCompositeFrame,
  quality,
  routeDurationSec,
  introMs,
  outroMs,
  photos,
  photoAssets,
  signal,
  onProgress,
  onStatus,
  filenameBase,
}) {
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  const stream = compositeCanvas.captureStream(quality.fps);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: quality.bitrate,
  });

  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };

  const finished = new Promise((resolve, reject) => {
    recorder.onstop = () =>
      resolve(new Blob(chunks, { type: 'video/webm' }));
    recorder.onerror = () => reject(new Error('MediaRecorder failed'));
    signal.addEventListener(
      'abort',
      () => reject(new Error('export_aborted')),
      { once: true },
    );
  });

  animator.reset();
  await animator.focusStart?.(0);
  map.triggerRepaint?.();
  await waitForMapRender(map, signal);
  drawCompositeFrame();

  recorder.start(100);

  onStatus?.('Rendering WebM…');

  const routeFrames = Math.ceil(routeDurationSec * quality.fps);
  const photoFrames = photos.reduce(
    (sum, photo) => sum + Math.max(1, Math.round(((photo.displayDurationMs || 3000) / 1000) * quality.fps)),
    0,
  );
  const totalFrames = routeFrames + photoFrames;
  const frameInterval = 1000 / quality.fps;
  let outputFrame = 0;
  let nextPhotoIndex = 0;

  for (let frame = 0; frame < routeFrames; frame += 1) {
    if (signal.aborted) throw new Error('export_aborted');

    const t = frame / quality.fps;
    const pct = routeDurationSec > 0
      ? (t / routeDurationSec) * 1000
      : 0;

    if (animator.renderExportProgress) {
      animator.renderExportProgress(pct);
    } else {
      animator.scrubPreview(pct);
    }

    map.triggerRepaint?.();
    await waitForMapRender(map, signal);
    drawCompositeFrame();
    await waitMs(Math.max(0, frameInterval - 8), signal);
    outputFrame += 1;

    while (nextPhotoIndex < photos.length && photos[nextPhotoIndex].progress <= Math.min(1, t / Math.max(routeDurationSec, 0.001) + 1e-9)) {
      const photo = photos[nextPhotoIndex];
      const image = photoAssets.get(photo.id);
      nextPhotoIndex += 1;
      if (!image) continue;

      const durationMs = Math.max(500, photo.displayDurationMs || 3000);
      const holdFrames = Math.max(1, Math.round((durationMs / 1000) * quality.fps));
      for (let holdFrame = 0; holdFrame < holdFrames; holdFrame += 1) {
        const elapsedMs = holdFrames <= 1
          ? durationMs
          : (holdFrame / (holdFrames - 1)) * durationMs;
        drawCompositeFrame({ photo, image, elapsedMs, durationMs });
        await waitMs(Math.max(1, frameInterval - 2), signal);
        outputFrame += 1;
      }
    }

    onProgress?.({
      frame: outputFrame,
      totalFrames,
      time: outputFrame / quality.fps,
      duration: totalFrames / quality.fps + outroMs / 1000,
    });
  }

  await captureRealtimePhase({
    action: () => animator.playOutro?.(outroMs),
    durationMs: outroMs,
    fps: quality.fps,
    drawCompositeFrame,
    signal,
  });

  recorder.stop();
  const blob = await finished;

  return {
    blob,
    mimeType: 'video/webm',
    filename: `${filenameBase}.webm`,
  };
}

async function loadPhotoAssets(photos, signal) {
  const assets = new Map();
  await Promise.all((photos || []).map(async (photo) => {
    if (signal?.aborted) throw new Error('export_aborted');
    try {
      const image = await loadImage(photo.url, signal);
      assets.set(photo.id, image);
    } catch {
      // A missing photo should not abort an otherwise valid route export.
    }
  }));
  return assets;
}

function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('export_aborted'));
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('photo_load_failed'));
    signal?.addEventListener('abort', () => reject(new Error('export_aborted')), { once: true });
    image.src = url;
  });
}

function photoMomentStyle(elapsedMs, durationMs) {
  const enterMs = 450;
  const exitMs = 350;
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < enterMs) {
    const t = Math.min(1, elapsed / enterMs);
    const eased = 1 - (1 - t) ** 3;
    return { opacity: eased, scale: 0.15 + 0.85 * eased };
  }
  const exitStart = Math.max(enterMs, durationMs - exitMs);
  if (elapsed > exitStart) {
    const t = Math.min(1, (elapsed - exitStart) / Math.max(1, durationMs - exitStart));
    const eased = t ** 3;
    return { opacity: 1 - eased, scale: 1 - 0.15 * eased };
  }
  return { opacity: 1, scale: 1 };
}

function drawPhotoMoment(ctx, width, height, photo, image, elapsedMs, durationMs) {
  const style = photoMomentStyle(elapsedMs, durationMs);
  if (style.opacity <= 0 || !image?.naturalWidth || !image?.naturalHeight) return;

  const maxW = width * 0.72;
  const maxH = height * 0.72;
  const imageAspect = image.naturalWidth / image.naturalHeight;
  const boxAspect = maxW / maxH;
  let drawW = maxW;
  let drawH = maxH;
  if (imageAspect > boxAspect) drawH = maxW / imageAspect;
  else drawW = maxH * imageAspect;

  drawW *= style.scale;
  drawH *= style.scale;
  const x = (width - drawW) / 2;
  const y = (height - drawH) / 2;

  ctx.save();
  ctx.globalAlpha = style.opacity;
  roundRect(ctx, x, y, drawW, drawH, Math.max(12, width * 0.009));
  ctx.clip();
  ctx.drawImage(image, x, y, drawW, drawH);

  const progress = Math.max(0, Math.min(1, elapsedMs / Math.max(1, durationMs)));
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(x, y, drawW, Math.max(3, height * 0.003));
  ctx.fillStyle = '#0f9ad1';
  ctx.fillRect(x, y, drawW * progress, Math.max(3, height * 0.003));
  ctx.restore();
}

function drawCover(ctx, sourceCanvas, targetWidth, targetHeight) {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  if (!sourceWidth || !sourceHeight) return;

  const sourceAspect = sourceWidth / sourceHeight;
  const targetAspect = targetWidth / targetHeight;

  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceAspect > targetAspect) {
    sw = sourceHeight * targetAspect;
    sx = (sourceWidth - sw) / 2;
  } else if (sourceAspect < targetAspect) {
    sh = sourceWidth / targetAspect;
    sy = (sourceHeight - sh) / 2;
  }

  ctx.drawImage(
    sourceCanvas,
    sx,
    sy,
    sw,
    sh,
    0,
    0,
    targetWidth,
    targetHeight,
  );
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

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('export_aborted'));
      },
      { once: true },
    );
  });
}

async function waitForMapSettledEnough(map, signal, timeoutMs = 6000) {
  const startedAt = performance.now();

  while (performance.now() - startedAt < timeoutMs) {
    if (signal?.aborted) throw new Error('export_aborted');

    map.triggerRepaint?.();
    await waitForMapRender(map, signal, 500);

    const styleReady = map.isStyleLoaded?.() !== false;
    const tilesReady =
      typeof map.areTilesLoaded === 'function'
        ? map.areTilesLoaded()
        : true;
    const moving =
      typeof map.isMoving === 'function'
        ? map.isMoving()
        : false;

    if (styleReady && tilesReady && !moving) return true;
    await waitMs(16, signal);
  }

  return false;
}

function waitMs(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(new Error('export_aborted'));
      },
      { once: true },
    );
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
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Safari/WebKit and Electron can still be consuming the object URL when the
  // click returns. Revoke it on a later task rather than synchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function captureRealtimePhase({
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

  const mapElement = document.getElementById('map');
  const scale =
    width / Math.max(1, mapElement?.clientWidth || width);
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
  if (
    !(source instanceof HTMLCanvasElement) ||
    source.width <= 0 ||
    source.height <= 0
  ) {
    return;
  }

  const targetWidth = width * 0.85;
  const scale =
    width / Math.max(1, document.getElementById('map')?.clientWidth || width);
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
