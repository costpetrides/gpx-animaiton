export function selectProject(state) {
  return state.document.project;
}

export function selectRouteDocument(state) {
  return selectProject(state).route;
}

export function selectProjectMeta(state) {
  const project = selectProject(state);
  const route = project.route;
  return {
    name: project.name,
    file: project.sourceFile || '—',
    length: route ? route.stats.totalDistance : null,
    duration: route ? route.stats.duration : null,
    pointCount: route ? route.stats.pointCount : null,
  };
}

export function selectPlaybackConfig(state) {
  return selectProject(state).playback;
}

export function selectCameraConfig(state) {
  return selectProject(state).camera;
}

export function selectTrackConfig(state) {
  return selectProject(state).track;
}

export function selectMapConfig(state) {
  return selectProject(state).map;
}

export function selectLayersConfig(state) {
  return selectProject(state).layers;
}

export function selectOverlaysConfig(state) {
  return selectProject(state).overlays;
}

export function selectExportConfig(state) {
  return selectProject(state).export;
}

export function selectTimelineConfig(state) {
  return selectProject(state).timeline;
}

export function selectEditorState(state) {
  return state.editor;
}

export function selectRuntimePlayback(state) {
  return state.runtime.playback;
}
