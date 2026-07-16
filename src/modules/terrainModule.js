export function createTerrainModule(ctx) {
  return {
    id: 'terrain',
    label: 'Terrain',
    icon: '⛰',
    onActivate() {},
    handleIntent(intent, payload) {
      if (intent === 'set-enabled') {
        ctx.dispatch({ type: 'project/set-terrain-config', payload: { terrainEnabled: payload.enabled } });
        ctx.animator?.setTerrainEnabled?.(payload.enabled !== false);
        ctx.animator?.reprepare?.('terrain');
        ctx.renderProjectState?.();
      }
      if (intent === 'set-quality') {
        ctx.dispatch({ type: 'project/set-terrain-config', payload: { quality: payload.quality } });
        ctx.animator?.reprepare?.('terrain');
      }
      if (intent === 'set-exaggeration') {
        ctx.dispatch({ type: 'project/set-terrain-config', payload: { exaggeration: payload.exaggeration } });
        ctx.animator?.setTerrainExaggeration?.(payload.exaggeration);
      }
    },
  };
}
