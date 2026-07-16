const DEFAULTS = { left: 260, right: 300, bottom: 180 };

export function initShell(actions = {}) {
  const root = document.documentElement;
  const shell = document.getElementById('app-shell');
  const loading = document.getElementById('loading-screen');

  // ── Loading screen ─────────────────────────────────────────
  function hideLoading() {
    loading?.classList.add('hidden');
  }

  // ── Panel resize ───────────────────────────────────────────
  let drag = null;

  function startResize(e, type) {
    e.preventDefault();
    drag = {
      type,
      startX: e.clientX,
      startY: e.clientY,
      left: parseInt(getComputedStyle(root).getPropertyValue('--panel-left')) || DEFAULTS.left,
      right: parseInt(getComputedStyle(root).getPropertyValue('--panel-right')) || DEFAULTS.right,
      bottom: parseInt(getComputedStyle(root).getPropertyValue('--panel-bottom')) || DEFAULTS.bottom,
    };
    document.body.classList.add('resizing');
  }

  document.querySelectorAll('.resize-handle').forEach((el) => {
    el.addEventListener('mousedown', (e) => startResize(e, el.dataset.resize));
  });

  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    if (drag.type === 'left') {
      const w = Math.max(180, Math.min(420, drag.left + (e.clientX - drag.startX)));
      root.style.setProperty('--panel-left', w + 'px');
    }
    if (drag.type === 'right') {
      const w = Math.max(220, Math.min(480, drag.right - (e.clientX - drag.startX)));
      root.style.setProperty('--panel-right', w + 'px');
    }
    if (drag.type === 'bottom') {
      const h = Math.max(100, Math.min(400, drag.bottom - (e.clientY - drag.startY)));
      root.style.setProperty('--panel-bottom', h + 'px');
    }
  });

  document.addEventListener('mouseup', () => {
    drag = null;
    document.body.classList.remove('resizing');
    actions.onResize?.();
  });

  // ── Tabs ───────────────────────────────────────────────────
  document.getElementById('prop-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.ptab');
    if (!btn) return;
    document.querySelectorAll('.ptab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.ptab-panel').forEach((p) =>
      p.classList.toggle('active', p.dataset.panel === btn.dataset.tab),
    );
  });

  document.getElementById('bottom-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btab:not([disabled])');
    if (!btn) return;
    document.querySelectorAll('.btab').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.btab-panel').forEach((p) =>
      p.classList.toggle('active', p.dataset.bpanel === btn.dataset.btab),
    );
    actions.onResize?.();
  });

  // ── Menus ──────────────────────────────────────────────────
  document.querySelectorAll('.menu-trigger').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const item = btn.closest('.menu-item');
      const open = item.classList.contains('open');
      document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('open'));
      if (!open) item.classList.add('open');
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('open'));
  });

  const actionMap = {
    'open-gpx': () => actions.openGpx?.(),
    'new-project': () => actions.newProject?.(),
    fullscreen: () => actions.fullscreen?.(),
    'toggle-left': () => {
      const p = document.getElementById('panel-left');
      const collapsed = p?.classList.toggle('collapsed');
      root.style.setProperty('--panel-left', collapsed ? '0px' : DEFAULTS.left + 'px');
      actions.onResize?.();
    },
    'toggle-right': () => {
      const p = document.getElementById('panel-right');
      const collapsed = p?.classList.toggle('collapsed');
      root.style.setProperty('--panel-right', collapsed ? '0px' : DEFAULTS.right + 'px');
      actions.onResize?.();
    },
    'toggle-bottom': () => {
      document.getElementById('panel-bottom')?.classList.toggle('collapsed');
      actions.onResize?.();
    },
    'reset-layout': () => {
      root.style.setProperty('--panel-left', DEFAULTS.left + 'px');
      root.style.setProperty('--panel-right', DEFAULTS.right + 'px');
      root.style.setProperty('--panel-bottom', DEFAULTS.bottom + 'px');
      actions.onResize?.();
    },
    play: () => actions.togglePlay?.(),
    reset: () => actions.reset?.(),
    'capture-shot': () => actions.captureShot?.(),
    'reset-shot': () => actions.resetShot?.(),
    'save-project': () => actions.saveProject?.(),
    'export-project': () => actions.exportProject?.(),
    'export-video': () => actions.exportVideo?.(),
    'export-image': () => actions.exportImage?.(),
    screenshot: () => actions.exportImage?.(),
    'focus-camera': () => {
      actions.focusModule?.('camera');
    },
    'focus-speed': () => {
      actions.focusModule?.('route');
      document.getElementById('speed-slider')?.focus();
    },
    'focus-data': () => {
      actions.focusModule?.('data');
    },
    about: () => {
      actions.onAbout?.();
    },
  };

  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', () => {
      const fn = actionMap[el.dataset.action];
      if (fn) fn();
      document.querySelectorAll('.menu-item').forEach((m) => m.classList.remove('open'));
    });
  });

  // ── Keyboard shortcuts ─────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') { e.preventDefault(); actions.togglePlay?.(); }
    if (e.key === 'r' || e.key === 'R') actions.reset?.();
    if (e.key === 'o' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); actions.openGpx?.(); }
  });

  return {
    hideLoading,
    setStatus(msg) {
      const el = document.getElementById('status-message');
      if (el) el.textContent = msg;
    },
    setGpxStatus(msg) {
      const el = document.getElementById('status-gpx');
      if (el) el.textContent = msg;
    },
    setZoom(z) {
      const el = document.getElementById('status-zoom');
      if (el) el.textContent = 'Zoom ' + (z?.toFixed?.(1) ?? '—');
    },
    setCoords(lng, lat) {
      const el = document.getElementById('status-coords');
      if (el) el.textContent = `${lat?.toFixed(5) ?? '—'}, ${lng?.toFixed(5) ?? '—'}`;
    },
    setFps(fps) {
      const el = document.getElementById('status-fps');
      if (el) el.textContent = fps + ' FPS';
    },
    setCompass(bearing) {
      const el = document.getElementById('compass-needle');
      if (el) el.style.transform = `rotate(${-bearing}deg)`;
    },
    hideEmptyState() {
      document.getElementById('viewport-empty')?.classList.add('hidden');
    },
    showEmptyState() {
      document.getElementById('viewport-empty')?.classList.remove('hidden');
      this.hidePreparing();
    },
    showPreparing(title = 'Preparing route for playback', detail = 'Loading map tiles…') {
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
        if (!el) return;
        const text = val ?? '—';
        if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          el.value = text;
        } else {
          el.textContent = text;
        }
      };
      set('meta-name', meta.name);
      set('meta-file', meta.file);
      set('meta-length', meta.length);
      set('meta-duration', meta.duration);
      set('meta-points', meta.points);
      set('route-name', meta.name);
      set('stat-distance', meta.length);
      set('stat-points', meta.points);
    },
    updateWaypoints(rows) {
      const tbody = document.querySelector('#waypoints-table tbody');
      if (!tbody) return;
      tbody.replaceChildren();
      if (!rows.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 3;
        td.className = 'empty-cell';
        td.textContent = 'No waypoints';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        tr.dataset.pct = String(r.pct ?? 0);
        const name = document.createElement('td');
        name.textContent = r.name ?? '—';
        const dist = document.createElement('td');
        dist.textContent = r.dist ?? '—';
        const ele = document.createElement('td');
        ele.textContent = r.ele ?? '—';
        tr.append(name, dist, ele);
        tr.addEventListener('dblclick', () => actions.scrubTo?.(parseFloat(tr.dataset.pct)));
        tbody.appendChild(tr);
      });
    },
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
    focusProperties() {
      document.getElementById('panel-right')?.classList.remove('collapsed');
    },
  };
}
