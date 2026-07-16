export function createTrackModule(ctx) {
  return {
    id: 'track',
    label: 'Track',
    icon: '━',
    onActivate() {},
    handleIntent(intent, payload) {
      if (intent === 'set-style') {
        ctx.dispatch({ type: 'project/set-track-style', payload });
        ctx.animator?.applyTrackStyle?.(payload);
        ctx.renderProjectState?.();
      }
    },
  };
}
