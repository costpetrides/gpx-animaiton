import { createVideoExporter, downloadBlob, normalizeExportQuality } from '../export/videoExporter.js';

export function createExportModule(ctx) {
  let exporter = null;
  let exporting = false;

  function getExporter() {
    if (!exporter) {
      exporter = createVideoExporter({
        map: ctx.map,
        animator: ctx.animator,
        getDuration: ctx.getDuration,
        getPhotos: () => ctx.getState().document.project.media?.photos || [],
        getVisibleStats: () => {
          const project = ctx.getState().document.project;
          const configured = Array.isArray(project.overlays?.visibleStats)
            ? project.overlays.visibleStats
            : ['altitude', 'distance', 'speed'];
          const hasTime = Boolean(project.route?.stats?.hasTime);
          return configured
            .filter((id) => !['time', 'speed', 'pace'].includes(id) || hasTime)
            .slice(0, 3);
        },
        onProgress: (p) => {
          const pct = Math.round((p.frame / p.totalFrames) * 100);
          ctx.shell?.setStatus(`Exporting ${pct}%`);
        },
        onStatus: (msg) => ctx.shell?.setStatus(msg),
      });
    }
    return exporter;
  }

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
        getExporter()
          .exportVideo({
            quality: normalizeExportQuality(config?.quality),
            aspectRatio: config?.aspectRatio || '16:9',
            fps: config?.fps || 30,
            format: config?.format || 'mp4',
            filenameBase,
          })
          .then(({ blob, filename }) => {
            downloadBlob(blob, filename);
            ctx.shell?.setStatus('MP4 export complete');
          })
          .catch((err) => {
            if (err.message !== 'export_aborted') {
              ctx.shell?.setStatus(`Export failed: ${err.message}`);
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
        getExporter().abort();
        exporting = false;
        window.dispatchEvent(new CustomEvent('gpx-export-state', {
          detail: { exporting: false },
        }));
      }
    },
  };
}
