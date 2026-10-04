import { downloadBlob, normalizeExportQuality } from '../export/videoExporter.js';

/**
 * Studio export module.
 *
 * Rendering yields a Blob via ctx.exportVideo (shared mount) — never uploads.
 * Download is an explicit host/UI step after the Blob is ready.
 */
export function createExportModule(ctx) {
  let exporting = false;

  return {
    id: 'export',
    label: 'Export',
    icon: '⬇',
    onActivate() {},
    isExporting: () => exporting,
    handleIntent(intent, payload) {
      if (intent === 'set-config') {
        ctx.dispatch({ type: 'project/set-export-config', payload: payload.config });
        ctx.renderProjectState?.();
        return;
      }
      if (intent === 'export-video') {
        if (exporting) return;
        if (typeof ctx.exportVideo !== 'function') {
          ctx.shell?.setStatus('Export is not available');
          return;
        }

        const state = ctx.getState();
        const config = state.document.project.export;
        const routeName = state.document.project.route?.name || 'trail-animation';
        const filenameBase = String(routeName)
          .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '')
          .replace(/\s+/g, '-')
          .slice(0, 80) || 'trail-animation';

        exporting = true;
        window.dispatchEvent(new CustomEvent('gpx-export-state', {
          detail: { exporting: true },
        }));

        Promise.resolve(
          ctx.exportVideo({
            quality: normalizeExportQuality(config?.quality),
            aspectRatio: config?.aspectRatio || '16:9',
            fps: config?.fps || 30,
            format: config?.format || 'mp4',
            filenameBase,
          }),
        )
          .then((result) => {
            const blob = result?.blob;
            const filename = result?.filename || `${filenameBase}.mp4`;
            if (!blob) throw new Error('Export produced no video blob');
            // Host/UI download action — separate from rendering.
            downloadBlob(blob, filename);
            ctx.shell?.setStatus('MP4 export complete');
            return result;
          })
          .catch((err) => {
            if (err?.message !== 'export_aborted') {
              ctx.shell?.setStatus(`Export failed: ${err?.message || err}`);
            }
          })
          .finally(() => {
            exporting = false;
            window.dispatchEvent(new CustomEvent('gpx-export-state', {
              detail: { exporting: false },
            }));
            ctx.renderProjectState?.();
          });
      }
      if (intent === 'abort-export') {
        ctx.abortExport?.();
        exporting = false;
        window.dispatchEvent(new CustomEvent('gpx-export-state', {
          detail: { exporting: false },
        }));
      }
    },
  };
}
