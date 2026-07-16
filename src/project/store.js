import {
  createEmptyEditorState,
  createEmptyRuntimeState,
  createEmptyProjectDocument,
  createInitialStudioState,
  createRouteDocument,
  migrateProjectDocument,
} from './model.js';

function stampProject(project) {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
  };
}

function reduce(state, action) {
  switch (action.type) {
    case 'project/reset': {
      return createInitialStudioState();
    }

    case 'project/load-gpx': {
      const route = createRouteDocument(action.payload.route, {
        sourceFile: action.payload.sourceFile,
      });
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            name: route.name,
            sourceFile: action.payload.sourceFile || '',
            route,
          }),
        },
        editor: {
          ...state.editor,
          dirty: true,
          lastAction: 'project/load-gpx',
        },
        runtime: createEmptyRuntimeState(),
      };
    }

    case 'project/set-map-style': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            map: {
              ...state.document.project.map,
              styleKey: action.payload.styleKey,
            },
          }),
        },
        editor: {
          ...state.editor,
          dirty: true,
          lastAction: 'project/set-map-style',
        },
      };
    }

    case 'project/set-camera-preset': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            camera: {
              ...state.document.project.camera,
              preset: action.payload.preset,
            },
          }),
        },
        editor: {
          ...state.editor,
          dirty: true,
          lastAction: 'project/set-camera-preset',
        },
      };
    }

    case 'project/set-playback-shot': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            camera: {
              ...state.document.project.camera,
              shot: action.payload.shot,
            },
          }),
        },
        editor: {
          ...state.editor,
          dirty: true,
          lastAction: 'project/set-playback-shot',
        },
      };
    }

    case 'project/reset-playback-shot': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            camera: {
              ...state.document.project.camera,
              shot: null,
            },
          }),
        },
        editor: {
          ...state.editor,
          dirty: true,
          lastAction: 'project/reset-playback-shot',
        },
      };
    }

    case 'project/set-playback-speed': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            playback: {
              ...state.document.project.playback,
              speed: action.payload.speed,
            },
          }),
        },
        editor: {
          ...state.editor,
          dirty: true,
          lastAction: 'project/set-playback-speed',
        },
      };
    }

    case 'project/set-prepare-quality': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            playback: {
              ...state.document.project.playback,
              prepareQuality: action.payload.prepareQuality,
            },
          }),
        },
        editor: {
          ...state.editor,
          dirty: true,
          lastAction: 'project/set-prepare-quality',
        },
      };
    }

    case 'project/set-camera-config': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            camera: {
              ...state.document.project.camera,
              preset: action.payload.preset,
              mode: action.payload.preset,
              rig: action.payload.rig,
              shot: action.payload.shot !== undefined ? action.payload.shot : state.document.project.camera.shot,
            },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'project/set-camera-config' },
      };
    }

    case 'project/set-camera-rig': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            camera: {
              ...state.document.project.camera,
              rig: { ...state.document.project.camera.rig, ...action.payload.rig },
            },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'project/set-camera-rig' },
      };
    }

    case 'project/set-track-style': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            track: { ...state.document.project.track, ...action.payload },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'project/set-track-style' },
      };
    }

    case 'project/set-terrain-config': {
      const terrainPatch = action.payload;
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            map: {
              ...state.document.project.map,
              terrainEnabled: terrainPatch.terrainEnabled ?? state.document.project.map.terrainEnabled,
              terrain: { ...state.document.project.map.terrain, ...terrainPatch },
            },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'project/set-terrain-config' },
      };
    }

    case 'project/set-layer-visibility': {
      const { layerId, visible } = action.payload;
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            layers: { ...state.document.project.layers, [layerId]: visible },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'project/set-layer-visibility' },
      };
    }

    case 'project/set-overlay-config': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            overlays: { ...state.document.project.overlays, ...action.payload },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'project/set-overlay-config' },
      };
    }

    case 'project/set-export-config': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            export: { ...state.document.project.export, ...action.payload.config },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'project/set-export-config' },
      };
    }

    case 'project/set-route-meta': {
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            description: action.payload.description ?? state.document.project.description,
            route: state.document.project.route
              ? { ...state.document.project.route, ...action.payload.route }
              : state.document.project.route,
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'project/set-route-meta' },
      };
    }

    case 'project/import-document': {
      return {
        ...state,
        document: migrateProjectDocument(action.payload.document),
        editor: { ...state.editor, dirty: false, lastAction: 'project/import-document' },
        runtime: createEmptyRuntimeState(),
      };
    }

    case 'timeline/add-keyframe': {
      const keyframes = [...(state.document.project.timeline.keyframes || []), action.payload.keyframe];
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            timeline: { ...state.document.project.timeline, keyframes },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'timeline/add-keyframe' },
      };
    }

    case 'timeline/remove-keyframe': {
      const keyframes = (state.document.project.timeline.keyframes || []).filter(
        (kf) => kf.id !== action.payload.id,
      );
      return {
        ...state,
        document: {
          ...state.document,
          project: stampProject({
            ...state.document.project,
            timeline: { ...state.document.project.timeline, keyframes },
          }),
        },
        editor: { ...state.editor, dirty: true, lastAction: 'timeline/remove-keyframe' },
      };
    }

    case 'runtime/set-playback': {
      return {
        ...state,
        runtime: {
          ...state.runtime,
          playback: {
            ...state.runtime.playback,
            ...action.payload,
          },
        },
      };
    }

    case 'editor/set-active-tool': {
      return {
        ...state,
        editor: {
          ...state.editor,
          activeTool: action.payload.tool,
          lastAction: 'editor/set-active-tool',
        },
      };
    }

    default:
      return state;
  }
}

export function createStudioStore(initialState = createInitialStudioState()) {
  let state = initialState;
  const listeners = new Set();

  function notify(action) {
    listeners.forEach((listener) => listener(state, action));
  }

  return {
    getState() {
      return state;
    },
    dispatch(action) {
      state = reduce(state, action);
      notify(action);
      return action;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      state = {
        document: createEmptyProjectDocument(),
        editor: createEmptyEditorState(),
        runtime: createEmptyRuntimeState(),
      };
      notify({ type: 'store/reset' });
    },
  };
}

