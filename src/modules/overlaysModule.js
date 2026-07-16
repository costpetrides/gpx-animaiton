export function createOverlaysModule(ctx) {
  function updateStatsOverlay(overlays, routeDoc, hud = {}) {
    const el = document.getElementById('stats-overlay');
    if (!el) return;
    const show = overlays?.stats && routeDoc;
    el.classList.toggle('hidden', !show);
    if (!show) {
      el.replaceChildren();
      return;
    }
    const title = overlays?.title || routeDoc.name || 'Route';
    el.replaceChildren();
    const titleEl = document.createElement('div');
    titleEl.className = 'stats-overlay-title';
    titleEl.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'stats-overlay-grid';
    const rows = [
      ['Distance', hud.distance || '—'],
      ['Speed', hud.speed || '—'],
      ['Elevation', hud.elevation || '—'],
      ['Progress', hud.progress != null ? `${hud.progress}%` : '—'],
    ];
    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'stats-overlay-row';
      const l = document.createElement('span');
      l.className = 'stats-overlay-label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'stats-overlay-value';
      v.textContent = value;
      row.append(l, v);
      grid.appendChild(row);
    });
    el.append(titleEl, grid);
  }

  return {
    id: 'overlays',
    label: 'Overlays',
    icon: '◎',
    onActivate() {},
    updateStatsOverlay,
    handleIntent(intent, payload) {
      if (intent === 'set-overlay') {
        ctx.dispatch({
          type: 'project/set-overlay-config',
          payload: payload.config,
        });
        const state = ctx.getState();
        const routeDoc = state.document?.project?.route;
        const overlays = { ...state.document.project.overlays, ...payload.config };
        updateStatsOverlay(overlays, routeDoc);
        ctx.renderProjectState?.();
      }
    },
  };
}
