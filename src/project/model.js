import { RoutePath } from '../route.js';
import { normalizeCameraPreset } from '../camera.js';
import { createDefaultCameraRig } from '../camera/rig.js';

const SCHEMA_VERSION = 1;

function createProjectId() {
  return `project-${Date.now().toString(36)}`;
}

function createRouteId() {
  return `route-${Date.now().toString(36)}`;
}

function createRouteStats(routePath) {
  const start = routePath.raw[0];
  const end = routePath.raw[routePath.raw.length - 1];
  return {
    pointCount: routePath.raw.length,
    sampledPointCount: routePath.points.length,
    totalDistance: routePath.totalDistance,
    duration: routePath.hasTime ? routePath.duration : null,
    hasTime: routePath.hasTime,
    startElevation: start?.ele ?? null,
    endElevation: end?.ele ?? null,
  };
}

function createDefaultStops(routePath) {
  const start = routePath.raw[0];
  const end = routePath.raw[routePath.raw.length - 1];
  return [
    {
      id: 'stop-start',
      kind: 'start',
      name: 'Start',
      progress: 0,
      point: start ? { lat: start.lat, lng: start.lng, ele: start.ele ?? null } : null,
    },
    {
      id: 'stop-finish',
      kind: 'finish',
      name: 'Finish',
      progress: 1,
      point: end ? { lat: end.lat, lng: end.lng, ele: end.ele ?? null } : null,
    },
  ];
}

export function createEmptyProjectDocument() {
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      id: createProjectId(),
      name: 'Untitled Project',
      description: '',
      sourceFile: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      route: null,
      camera: {
        preset: 'follow',
        mode: 'follow',
        rig: createDefaultCameraRig('follow'),
        shot: null,
        segments: [],
      },
      track: {
        color: '#3b82f6',
        width: 5,
        glowWidth: 12,
        opacity: 1,
        showFullRoute: true,
      },
      map: {
        styleKey: 'satellite',
        terrainEnabled: true,
        terrain: {
          quality: 'balanced',
          exaggeration: 1.2,
        },
      },
      layers: {
        route: true,
        elevation: true,
        speed: false,
        waypoints: true,
        photos: false,
        labels: false,
        terrain: true,
      },
      overlays: {
        stats: false,
        title: '',
        logo: null,
      },
      playback: {
        speed: 1,
        prepareQuality: 'fast',
      },
      export: {
        format: 'webm',
        quality: 'standard',
        resolution: '1920x1080',
        fps: 30,
      },
      timeline: {
        durationMode: 'route-derived',
        keyframes: [],
      },
    },
  };
}

export function createEmptyEditorState() {
  return {
    activeTool: 'route',
    selection: null,
    dirty: false,
    lastAction: 'idle',
  };
}

export function createEmptyRuntimeState() {
  return {
    playback: {
      playing: false,
      timeline: 0,
      animTime: 0,
      animDistance: 0,
      progress: 0,
      speedText: '—',
      durationText: '—',
      distanceText: '—',
      totalText: '—',
    },
  };
}

export function createInitialStudioState() {
  return {
    document: createEmptyProjectDocument(),
    editor: createEmptyEditorState(),
    runtime: createEmptyRuntimeState(),
  };
}

export function createRouteDocument(parsedRoute, options = {}) {
  const routePath = new RoutePath(parsedRoute.points);

  return {
    id: createRouteId(),
    name: parsedRoute.name,
    sourceFile: options.sourceFile || '',
    importedAt: new Date().toISOString(),
    points: parsedRoute.points,
    stats: createRouteStats(routePath),
    stops: createDefaultStops(routePath),
  };
}

export function migrateProjectDocument(document) {
  const empty = createEmptyProjectDocument();
  const project = document?.project || {};
  return {
    ...empty,
    ...document,
    project: {
      ...empty.project,
      ...project,
      camera: {
        ...empty.project.camera,
        ...project.camera,
        preset: normalizeCameraPreset(project.camera?.preset),
        rig: project.camera?.rig || createDefaultCameraRig(normalizeCameraPreset(project.camera?.preset)),
      },
      track: { ...empty.project.track, ...project.track },
      map: {
        ...empty.project.map,
        ...project.map,
        terrain: { ...empty.project.map.terrain, ...project.map?.terrain },
      },
      layers: { ...empty.project.layers, ...project.layers },
      overlays: { ...empty.project.overlays, ...project.overlays },
      playback: { ...empty.project.playback, ...project.playback },
      export: { ...empty.project.export, ...project.export },
      timeline: {
        ...empty.project.timeline,
        ...project.timeline,
        keyframes: project.timeline?.keyframes || [],
      },
    },
  };
}

