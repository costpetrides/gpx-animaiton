import { serializeProjectDocument, deserializeProjectDocument } from '../project/serialization.js';

export function createRouteModule(ctx) {
  return {
    id: 'route',
    label: 'Route',
    icon: '〰',
    onActivate() {},
    handleIntent(intent, payload) {
      if (intent === 'set-description') {
        ctx.dispatch({ type: 'project/set-route-meta', payload: { description: payload.description } });
      }
      if (intent === 'set-color') {
        ctx.dispatch({ type: 'project/set-track-style', payload: { color: payload.color } });
        ctx.animator?.applyTrackStyle?.(payload);
        ctx.renderProjectState?.();
      }
      if (intent === 'save-project') {
        const json = serializeProjectDocument(ctx.getState().document);
        downloadText(json, `${ctx.getState().document.project.name || 'project'}.gpxstudio.json`);
      }
      if (intent === 'load-project' && payload.json) {
        const doc = deserializeProjectDocument(payload.json);
        ctx.dispatch({ type: 'project/import-document', payload: { document: doc } });
        const route = doc.project.route;
        if (route) {
          ctx.animator.load({ name: route.name, points: route.points });
        }
      }
    },
  };
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
