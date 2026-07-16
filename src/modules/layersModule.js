const LAYER_MAP = {
  route: [
    'route-glow', 'route-full', 'route-done', 'route-done-glow',
    'marker-start-glow', 'marker-start-core',
    'marker-end-glow', 'marker-end-core',
    'actor-glow', 'actor-core',
  ],
  waypoints: [
    'marker-start-glow', 'marker-start-core',
    'marker-end-glow', 'marker-end-core',
  ],
  terrain: ['terrain-background'],
};

export function createLayersModule(ctx) {
  return {
    id: 'layers',
    label: 'Layers',
    icon: '▦',
    onActivate() {},
    handleIntent(intent, payload) {
      if (intent !== 'set-visibility') return;
      const { layerId, visible } = payload;
      ctx.dispatch({
        type: 'project/set-layer-visibility',
        payload: { layerId, visible },
      });

      const mapLayerIds = LAYER_MAP[layerId] || [];
      const visibility = visible ? 'visible' : 'none';
      mapLayerIds.forEach((id) => {
        if (ctx.map.getLayer(id)) {
          ctx.map.setLayoutProperty(id, 'visibility', visibility);
        }
      });

      if (layerId === 'terrain') {
        ctx.animator?.setTerrainEnabled?.(visible);
        return;
      }

      if (layerId === 'elevation') {
        const panel = document.getElementById('panel-bottom');
        const chartPanel = document.querySelector('[data-bpanel="elevation"]');
        if (panel) panel.style.display = visible ? '' : 'none';
        if (chartPanel) chartPanel.style.display = visible ? '' : 'none';
        const elevTab = document.querySelector('.btab[data-btab="elevation"]');
        if (elevTab && !visible) {
          document.querySelector('.btab[data-btab="stats"]')?.click();
        }
        return;
      }

      if (layerId === 'speed') {
        const speedTab = document.querySelector('.btab[data-btab="speed"]');
        if (speedTab) {
          speedTab.toggleAttribute('disabled', !visible);
          if (!visible && speedTab.classList.contains('active')) {
            document.querySelector('.btab[data-btab="elevation"]')?.click();
          }
        }
        return;
      }

      if (layerId === 'photos') {
        document.getElementById('photos-section')?.classList.toggle('hidden', !visible);
        return;
      }

      if (layerId === 'labels') {
        // Reserved for future map labels layer.
      }
    },
  };
}
