/**
 * Module sidebar rail + property panel bindings.
 */
import { createCameraRigPanel } from './cameraRigPanel.js';

export function initModulePanels(kernel, deps) {
  const {
    shell,
    renderProjectState,
    getRouteDocument,
  } = deps;

  const rail = document.getElementById('module-rail');
  const moduleSections = document.querySelectorAll('[data-module-panel]');
  const propPanels = document.querySelectorAll('[data-module-props]');

  function syncModuleUI() {
    const activeId = kernel.registry.getActiveId();
    rail?.querySelectorAll('[data-module]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.module === activeId);
    });
    moduleSections.forEach((section) => {
      section.classList.toggle('active', section.dataset.modulePanel === activeId);
    });
    propPanels.forEach((panel) => {
      panel.classList.toggle('active', panel.dataset.moduleProps === activeId);
    });
    const routeReady = !!getRouteDocument();
    document.getElementById('btn-export-video')?.toggleAttribute('disabled', !routeReady);
    document.querySelector('[data-action="save-project"]')?.toggleAttribute('disabled', !routeReady);
    document.querySelector('[data-action="export-project"]')?.toggleAttribute('disabled', !routeReady);
    document.querySelector('.toolbar [title="Export Video"]')?.toggleAttribute('disabled', !routeReady);
    document.querySelector('.toolbar [title="Save"]')?.toggleAttribute('disabled', !routeReady);
  }

  rail?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-module]');
    if (!btn) return;
    kernel.setActiveModule(btn.dataset.module);
    shell.focusProperties?.();
    syncModuleUI();
  });

  const cameraRigPanel = createCameraRigPanel(document.getElementById('avo-camera-rig'), {
    onRigChange(rig) {
      kernel.emit('set-rig', {
        rig: {
          altitudeM: rig.altitudeM,
          tiltDeg: rig.tiltDeg,
          pitchDeg: rig.tiltDeg,
          focusForwardM: rig.focusForwardM,
          focusRightM: rig.focusRightM,
        },
        module: 'camera',
      });
    },
  });

  const advancedRigFields = [
    ['rig-bearing', 'bearingDeg', 0, 360, 1],
    ['rig-zoom', 'zoom', 10, 18, 0.1],
    ['rig-smooth-bearing', 'smoothing.bearing', 0, 1, 0.05],
  ];

  advancedRigFields.forEach(([id, key, min, max, step]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const value = parseFloat(el.value);
      const rig = key.includes('.')
        ? { smoothing: { [key.split('.')[1]]: value } }
        : { [key]: value };
      kernel.emit('set-rig', { rig, module: 'camera' });
      const label = document.getElementById(`${id}-val`);
      if (label) label.textContent = String(value);
    });
  });

  document.getElementById('rig-bearing-mode')?.addEventListener('change', (e) => {
    kernel.emit('set-rig', { rig: { bearingMode: e.target.value }, module: 'camera' });
    renderProjectState();
  });

  // Track style
  document.getElementById('track-color')?.addEventListener('input', (e) => {
    kernel.emit('set-style', { color: e.target.value, module: 'track' });
  });
  document.getElementById('track-width')?.addEventListener('input', (e) => {
    const width = parseFloat(e.target.value);
    document.getElementById('track-width-val').textContent = String(width);
    kernel.emit('set-style', { width, module: 'track' });
  });

  // Terrain
  document.getElementById('terrain-enabled')?.addEventListener('change', (e) => {
    kernel.emit('set-enabled', { enabled: e.target.checked, module: 'terrain' });
  });
  document.getElementById('terrain-exaggeration')?.addEventListener('input', (e) => {
    const exaggeration = parseFloat(e.target.value);
    document.getElementById('terrain-exaggeration-val').textContent = exaggeration.toFixed(1);
    kernel.emit('set-exaggeration', { exaggeration, module: 'terrain' });
  });

  // Layers
  document.getElementById('layer-list')?.addEventListener('change', (e) => {
    const layerId = e.target.dataset.layer;
    if (!layerId) return;
    kernel.emit('set-visibility', { layerId, visible: e.target.checked, module: 'layers' });
  });

  // Export
  document.getElementById('export-quality')?.addEventListener('change', (e) => {
    kernel.emit('set-config', { config: { quality: e.target.value }, module: 'export' });
  });
  document.getElementById('export-format')?.addEventListener('change', (e) => {
    kernel.emit('set-config', { config: { format: e.target.value }, module: 'export' });
  });
  document.getElementById('btn-export-video')?.addEventListener('click', () => {
    kernel.emit('export-video', { module: 'export' });
  });

  // Keyframes
  document.getElementById('btn-add-keyframe')?.addEventListener('click', () => {
    kernel.emit('add-keyframe', { module: 'camera' });
    renderKeyframeMarkers(deps);
  });

  document.getElementById('btn-clear-keyframes')?.addEventListener('click', () => {
    const state = deps.getState();
    const kfs = state.document.project.timeline.keyframes || [];
    kfs.forEach((kf) => kernel.emit('remove-keyframe', { id: kf.id, module: 'camera' }));
    renderKeyframeMarkers(deps);
  });

  // Project I/O
  document.getElementById('project-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        kernel.emit('load-project', { json: ev.target.result, module: 'route' });
        renderProjectState();
        renderKeyframeMarkers(deps);
      } catch (err) {
        shell.setStatus(`Project load failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  });

  return { syncModuleUI, renderKeyframeMarkers: () => renderKeyframeMarkers(deps), cameraRigPanel };
}

export function renderKeyframeMarkers(deps) {
  const row = document.getElementById('keyframe-row');
  if (!row) return;
  const { getState, getDuration, animator } = deps;
  const keyframes = getState().document.project.timeline.keyframes || [];
  const duration = getDuration();
  row.innerHTML = '';
  keyframes.forEach((kf) => {
    const pct = duration > 0 ? (kf.time / duration) * 100 : 0;
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'keyframe-marker';
    marker.style.left = `${pct}%`;
    marker.title = kf.label;
    marker.addEventListener('click', () => {
      animator.pause();
      const tl = (kf.time / duration) * 1000;
      animator.scrubCommit(tl);
    });
    row.appendChild(marker);
  });
}

export function syncRigControls(camera, cameraRigPanel) {
  const rig = camera.rig || {};
  cameraRigPanel?.setRig(rig);
  const set = (id, val) => {
    const el = document.getElementById(id);
    const label = document.getElementById(`${id}-val`);
    if (el && val != null) el.value = String(val);
    if (label && val != null) label.textContent = String(val);
  };
  set('rig-bearing', rig.bearingDeg);
  set('rig-zoom', rig.zoom);
  set('rig-smooth-bearing', rig.smoothing?.bearing ?? 0.6);
  const bearingMode = document.getElementById('rig-bearing-mode');
  if (bearingMode) bearingMode.value = rig.bearingMode || 'north-true';
}

export function syncTrackControls(track) {
  const color = document.getElementById('track-color');
  if (color && track.color) color.value = track.color;
  const width = document.getElementById('track-width');
  if (width) {
    width.value = String(track.width ?? 5);
    document.getElementById('track-width-val').textContent = String(track.width ?? 5);
  }
}

export function syncTerrainControls(mapConfig) {
  const enabled = document.getElementById('terrain-enabled');
  if (enabled) enabled.checked = mapConfig.terrainEnabled !== false;
  const ex = document.getElementById('terrain-exaggeration');
  const exVal = mapConfig.terrain?.exaggeration ?? 1.2;
  if (ex) {
    ex.value = String(exVal);
    document.getElementById('terrain-exaggeration-val').textContent = exVal.toFixed(1);
  }
}

export function syncLayerControls(layers) {
  document.querySelectorAll('#layer-list [data-layer]').forEach((input) => {
    const id = input.dataset.layer;
    if (layers[id] !== undefined) input.checked = layers[id];
    input.disabled = false;
  });
}

export function syncExportControls(exportConfig) {
  const quality = document.getElementById('export-quality');
  const format = document.getElementById('export-format');
  if (quality) quality.value = exportConfig.quality || 'standard';
  if (format) format.value = exportConfig.format || 'webm';
}

export function syncOverlayControls(overlays) {
  const stats = document.getElementById('overlay-stats');
  const title = document.getElementById('overlay-title');
  if (stats) stats.checked = overlays?.stats === true;
  if (title && overlays?.title != null) title.value = overlays.title;
}

export function renderKeyframeList(keyframes, onRemove) {
  const list = document.getElementById('keyframe-list');
  if (!list) return;
  list.replaceChildren();
  if (!keyframes.length) {
    const li = document.createElement('li');
    li.className = 'empty-cell';
    li.textContent = 'No keyframes';
    list.appendChild(li);
    return;
  }
  keyframes.forEach((kf) => {
    const li = document.createElement('li');
    li.className = 'keyframe-item';
    const label = document.createElement('span');
    label.textContent = kf.label || 'Camera keyframe';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-icon';
    btn.title = 'Remove';
    btn.textContent = '×';
    btn.dataset.kfId = kf.id;
    btn.addEventListener('click', () => onRemove(kf.id));
    li.append(label, btn);
    list.appendChild(li);
  });
}
