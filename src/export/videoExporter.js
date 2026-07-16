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
      : (MediaRecorder.isTypeSupported('video/mp4') ? 'video/mp4' : 'video/webm;codecs=vp9');

    if (!animator.getRoute()) throw new Error('No route loaded');
    abortController = new AbortController();
    const { signal } = abortController;

    animator.pause();
    onStatus?.('Preparing export…');
    animator.reprepare?.('export');
    await waitUntil(() => animator.isPlaybackArmed(), { timeoutMs: 120000, signal });

    const duration = getDuration();
    if (duration <= 0) throw new Error('Invalid animation duration');

    const canvas = map.getCanvas();
    const stream = canvas.captureStream(quality.fps);
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

    onStatus?.('Recording…');
    recorder.start(100);

    const frameInterval = 1000 / quality.fps;
    const totalFrames = Math.ceil(duration * quality.fps);
    animator.reset();
    await waitForMapRender(map, signal);
    await waitMs(200, signal);

    for (let frame = 0; frame < totalFrames; frame++) {
      if (signal.aborted) throw new Error('export_aborted');
      const t = frame / quality.fps;
      const pct = duration > 0 ? (t / duration) * 1000 : 0;
      animator.scrubPreview(pct);
      map.triggerRepaint?.();
      await waitForMapRender(map, signal);
      await waitMs(Math.max(0, frameInterval - 8), signal);
      if (frame % 8 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      onProgress?.({ frame, totalFrames, time: t, duration });
    }

    recorder.stop();
    onStatus?.('Finalizing…');
    const blob = await finished;
    abortController = null;
    return { blob, mimeType: mimeType.split(';')[0], filename: `gpx-animation.${format === 'mp4' && mimeType.includes('mp4') ? 'mp4' : 'webm'}` };
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
