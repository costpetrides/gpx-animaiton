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
import { getCropRegion } from './crop.js';

export const EXPORT_QUALITY_OPTIONS = {
  low: { label: '720p', longEdge: 1280, bitrate: 2_000_000 },
  medium: { label: '1080p', longEdge: 1920, bitrate: 5_000_000 },
  high: { label: '1440p', longEdge: 2560, bitrate: 10_000_000 },
  ultra: { label: '4K', longEdge: 3840, bitrate: 20_000_000 },
};

export const EXPORT_ASPECT_RATIOS = ['16:9', '1:1', '9:16'];
export const EXPORT_FRAME_RATES = [24, 30, 60];

export function normalizeExportQuality(value) {
  if (value === 'low' || value === 'high' || value === 'ultra') return value;
  // Backward compatibility with the previous renderer presets.
  if (value === 'draft') return 'low';
  if (value === 'standard') return 'medium';
  return 'medium';
}

export function normalizeExportAspectRatio(value) {
  return EXPORT_ASPECT_RATIOS.includes(value) ? value : '16:9';
}

export function normalizeExportFps(value) {
  const fps = Number(value);
  return EXPORT_FRAME_RATES.includes(fps) ? fps : 30;
}

export function getExportResolution(qualityValue, aspectRatioValue) {
  const quality = EXPORT_QUALITY_OPTIONS[normalizeExportQuality(qualityValue)] || EXPORT_QUALITY_OPTIONS.medium;
  const aspectRatio = normalizeExportAspectRatio(aspectRatioValue);
  const longEdge = quality.longEdge;

  if (aspectRatio === '1:1') {
    const size = Math.round((longEdge * 9) / 16);
    return { width: size, height: size };
  }
  if (aspectRatio === '9:16') {
    return { width: Math.round((longEdge * 9) / 16), height: longEdge };
  }
  return { width: longEdge, height: Math.round((longEdge * 9) / 16) };
}

function resolveExportPreset(options = {}) {
  const qualityKey = normalizeExportQuality(options.quality);
  const aspectRatio = normalizeExportAspectRatio(options.aspectRatio);
  const fps = normalizeExportFps(options.fps);
  const quality = EXPORT_QUALITY_OPTIONS[qualityKey] || EXPORT_QUALITY_OPTIONS.medium;
  const resolution = getExportResolution(qualityKey, aspectRatio);
  return {
    qualityKey,
    aspectRatio,
    fps,
    width: resolution.width,
    height: resolution.height,
    bitrate: quality.bitrate,
    label: quality.label,
  };
}

export function createVideoExporter(deps) {
  const { map, animator, getDuration, getPhotos, getVisibleStats, onProgress, onStatus } = deps;
  let abortController = null;

  function abort() {
    abortController?.abort();
    abortController = null;
  }

  async function exportVideo(options = {}) {
    const quality = resolveExportPreset(options);
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

        const crop = drawExportMapFrame(
          compositeCtx,
          mapCanvas,
          width,
          height,
        );
        drawFilmStats(
          compositeCtx,
          width,
          height,
          crop,
          getVisibleStats?.() || ['altitude', 'distance', 'speed'],
        );
        drawElevationProfile(compositeCtx, width, height, crop);
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

    const routeProgress = routeFrames <= 1 ? 0 : frame / (routeFrames - 1);
    const t = routeProgress * routeDurationSec;
    const pct = routeProgress * 1000;

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

    while (nextPhotoIndex < photos.length && photos[nextPhotoIndex].progress <= routeProgress + 1e-9) {
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
  const enterMs = 600;
  const exitMs = 350;
  const elapsed = Math.max(0, elapsedMs);
  if (elapsed < enterMs) {
    const t = Math.min(1, elapsed / enterMs);
    const eased = 1 - (1 - t) ** 3;
    return {
      opacity: eased,
      scale: 0.96 + 0.04 * eased,
      portraitScale: 1.03 - 0.03 * eased,
    };
  }
  const exitStart = Math.max(enterMs, durationMs - exitMs);
  if (elapsed > exitStart) {
    const t = Math.min(1, (elapsed - exitStart) / Math.max(1, durationMs - exitStart));
    const eased = t ** 3;
    return {
      opacity: 1 - eased,
      scale: 1 - 0.15 * eased,
      portraitScale: 1,
    };
  }
  return { opacity: 1, scale: 1, portraitScale: 1 };
}

function drawPhotoMoment(ctx, width, height, photo, image, elapsedMs, durationMs) {
  const style = photoMomentStyle(elapsedMs, durationMs);
  if (style.opacity <= 0 || !image?.naturalWidth || !image?.naturalHeight) return;

  const portraitOutput = height > width;
  const imageAspect = image.naturalWidth / image.naturalHeight;

  let x;
  let y;
  let drawW;
  let drawH;

  if (portraitOutput) {
    // Portrait exports treat a photo as the moment itself: full-frame,
    // centered, aspect-preserving, no floating card. Use cover semantics so
    // there are no map slivers or black side bars in a 9:16 reel.
    const frameAspect = width / height;
    if (imageAspect > frameAspect) {
      drawH = height;
      drawW = height * imageAspect;
    } else {
      drawW = width;
      drawH = width / imageAspect;
    }
    const portraitScale = style.portraitScale ?? 1;
    drawW *= portraitScale;
    drawH *= portraitScale;
    x = (width - drawW) / 2;
    y = (height - drawH) / 2;
  } else {
    const maxW = width * 0.72;
    const maxH = height * 0.72;
    const boxAspect = maxW / maxH;
    drawW = maxW;
    drawH = maxH;
    if (imageAspect > boxAspect) drawH = maxW / imageAspect;
    else drawW = maxH * imageAspect;
    drawW *= style.scale;
    drawH *= style.scale;
    x = (width - drawW) / 2;
    y = (height - drawH) / 2;
  }

  ctx.save();
  ctx.globalAlpha = style.opacity;

  if (portraitOutput) {
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
  } else {
    roundRect(ctx, x, y, drawW, drawH, Math.max(12, width * 0.009));
    ctx.clip();
  }

  ctx.drawImage(image, x, y, drawW, drawH);

  const progress = Math.max(0, Math.min(1, elapsedMs / Math.max(1, durationMs)));
  const progressY = portraitOutput ? 0 : y;
  const progressX = portraitOutput ? 0 : x;
  const progressW = portraitOutput ? width : drawW;
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(progressX, progressY, progressW, Math.max(3, height * 0.003));
  ctx.fillStyle = '#0f9ad1';
  ctx.fillRect(progressX, progressY, progressW * progress, Math.max(3, height * 0.003));
  ctx.restore();
}

function drawExportMapFrame(ctx, sourceCanvas, targetWidth, targetHeight) {
  const sourceWidth = sourceCanvas.width;
  const sourceHeight = sourceCanvas.height;
  if (!sourceWidth || !sourceHeight) {
    return {
      cropX: 0,
      cropY: 0,
      cropW: targetWidth,
      cropH: targetHeight,
      cssWidth: targetWidth,
      cssHeight: targetHeight,
      scaleToRecording: 1,
    };
  }

  // Match TrailReplay: preview and encoder derive their crop from the exact
  // same capture container, never from a different child element.
  const captureContainer = document.getElementById('viewport-canvas');
  const cssWidth = Math.max(1, captureContainer?.clientWidth || sourceWidth);
  const cssHeight = Math.max(1, captureContainer?.clientHeight || sourceHeight);
  const crop = getCropRegion(cssWidth, cssHeight, targetWidth, targetHeight);
  const pixelScaleX = sourceWidth / cssWidth;
  const pixelScaleY = sourceHeight / cssHeight;

  ctx.drawImage(
    sourceCanvas,
    crop.cropX * pixelScaleX,
    crop.cropY * pixelScaleY,
    crop.cropW * pixelScaleX,
    crop.cropH * pixelScaleY,
    0,
    0,
    targetWidth,
    targetHeight,
  );

  return {
    ...crop,
    cssWidth,
    cssHeight,
    scaleToRecording: targetWidth / Math.max(1, crop.cropW),
  };
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

function splitExportStat(value) {
  const text = String(value ?? '—').trim();
  if (!text || text === '—') return { value: '—', unit: '' };
  const match = text.match(/^(.+?)\s+(km\/h|km|m|\/km)$/i);
  if (!match) return { value: text, unit: '' };
  return { value: match[1], unit: match[2] };
}

function drawFilmStats(ctx, width, height, crop = null, visibleStats = []) {
  const valueById = {
    distance: ['DISTANCE', document.getElementById('live-distance')?.textContent || '—', document.getElementById('live-distance-unit')?.textContent || ''],
    gain: ['GAIN', document.getElementById('live-gain')?.textContent || '—', document.getElementById('live-gain-unit')?.textContent || ''],
    altitude: ['ELEVATION', document.getElementById('live-elevation')?.textContent || '—', document.getElementById('live-elevation-unit')?.textContent || ''],
    time: ['TIME', document.getElementById('live-time')?.textContent || '00:00', document.getElementById('live-time-unit')?.textContent || ''],
    speed: ['SPEED', document.getElementById('live-speed')?.textContent || '—', document.getElementById('live-speed-unit')?.textContent || ''],
    pace: ['PACE', document.getElementById('live-pace')?.textContent || '—', document.getElementById('live-pace-unit')?.textContent || ''],
  };

  const values = visibleStats
    .map((id) => valueById[id])
    .filter(Boolean)
    .slice(0, 3);
  if (values.length === 0) return;

  const scale = crop?.scaleToRecording || 1;
  const columns = 3;
  const marginX = Math.max(18 * scale, width * 0.055);
  const top = Math.max(28 * scale, height * 0.07);
  const usableWidth = Math.max(1, width - marginX * 2);
  const colW = usableWidth / columns;

  const brandPx = Math.max(16, 21 * scale);
  const labelPx = Math.max(10, 12 * scale);
  const valuePx = Math.max(20, 27 * scale);
  const unitPx = Math.max(10, 12 * scale);
  const brandGap = Math.max(14 * scale, 18 * scale);
  const statsTop = top + brandPx + brandGap;
  const centerLift = Math.max(8 * scale, 10 * scale);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = Math.max(2, 4 * scale);
  ctx.shadowOffsetY = Math.max(1, 1.5 * scale);

  ctx.fillStyle = '#fff';
  ctx.font = `800 ${brandPx}px sans-serif`;
  ctx.fillText('Ryodo', width / 2, top + brandPx);

  values.forEach(([label, rawValue, rawUnit], index) => {
    const cx = marginX + colW * index + colW / 2;
    const lift = index === 1 ? centerLift : 0;
    const y = statsTop - lift;
    const parsed = rawUnit
      ? { value: rawValue, unit: rawUnit }
      : splitExportStat(rawValue);

    const valueY = y + valuePx;
    const labelY = valueY + labelPx + 8 * scale;
    const unitY = labelY + unitPx + 6 * scale;

    ctx.fillStyle = '#fff';
    ctx.font = `700 ${valuePx}px sans-serif`;
    ctx.fillText(String(parsed.value), cx, valueY);

    ctx.fillStyle = 'rgba(255,255,255,0.90)';
    ctx.font = `700 ${labelPx}px sans-serif`;
    ctx.fillText(label, cx, labelY);

    if (parsed.unit) {
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.font = `700 ${unitPx}px sans-serif`;
      ctx.fillText(String(parsed.unit), cx, unitY);
    }
  });

  ctx.restore();
}

function drawElevationProfile(ctx, width, height, crop = null) {
  const source = document.getElementById('elevation-profile');
  if (
    !(source instanceof HTMLCanvasElement) ||
    source.width <= 0 ||
    source.height <= 0
  ) {
    return;
  }

  const targetWidth = width * 0.85;
  const scale = crop?.scaleToRecording || 1;
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
