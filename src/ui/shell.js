/**
 * Minimal renderer shell — status, empty/preparing overlays, trail meta, times.
 */
export function initShell(actions = {}) {
  const loading = document.getElementById('loading-screen');

  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const action = el.dataset.action;
      if (action === 'export-video') actions.exportVideo?.();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      actions.togglePlay?.();
    }
    if (e.key === 'r' || e.key === 'R') actions.reset?.();
    if (e.key === 'o' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      actions.openGpx?.();
    }
  });

  return {
    hideLoading() {
      loading?.classList.add('hidden');
    },
    setStatus(msg) {
      const el = document.getElementById('status-message');
      if (el) el.textContent = msg;
    },
    setGpxStatus(msg) {
      this.setStatus(msg);
    },
    hideEmptyState() {
      document.getElementById('viewport-empty')?.classList.add('hidden');
    },
    showEmptyState() {
      document.getElementById('viewport-empty')?.classList.remove('hidden');
      this.hidePreparing();
    },
    showPreparing(title = 'Preparing 3D preview', detail = 'Loading terrain…') {
      const overlay = document.getElementById('viewport-preparing');
      const titleEl = document.getElementById('viewport-preparing-title');
      const detailEl = document.getElementById('viewport-preparing-detail');
      if (titleEl) titleEl.textContent = title;
      if (detailEl) detailEl.textContent = detail;
      overlay?.classList.remove('hidden');
      overlay?.setAttribute('aria-busy', 'true');
    },
    updatePreparing(detail, title) {
      const detailEl = document.getElementById('viewport-preparing-detail');
      const titleEl = document.getElementById('viewport-preparing-title');
      if (detailEl && detail) detailEl.textContent = detail;
      if (titleEl && title) titleEl.textContent = title;
      document.getElementById('viewport-preparing')?.classList.remove('hidden');
    },
    hidePreparing() {
      const overlay = document.getElementById('viewport-preparing');
      overlay?.classList.add('hidden');
      overlay?.setAttribute('aria-busy', 'false');
    },
    updateProject(meta) {
      const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val ?? '—';
      };
      set('meta-name', meta.name);
      set('meta-length', meta.length);
      set('meta-gain', meta.gain);
      set('meta-duration', meta.duration);
    },
    updateWaypoints() {},
    formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },
    setTimes(current, total) {
      const c = document.getElementById('time-current');
      const t = document.getElementById('time-total');
      if (c) c.textContent = this.formatTime(current);
      if (t) t.textContent = this.formatTime(total);
    },
    setZoom() {},
    setCoords() {},
    setFps() {},
    setCompass() {},
    focusProperties() {},
  };
}
