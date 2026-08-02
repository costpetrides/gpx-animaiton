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

function computeElevationGainM(rawPoints) {
  let gain = 0;
  let prev = null;
  for (const point of rawPoints || []) {
    if (!Number.isFinite(point?.ele)) continue;
    if (prev != null && point.ele > prev) gain += point.ele - prev;
    prev = point.ele;
  }
  return gain;
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
    elevationGain: computeElevationGainM(routePath.raw),
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
        preset: 'cinematic',
        mode: 'cinematic',
        rig: createDefaultCameraRig('cinematic'),
        shot: null,
        segments: [],
      },
      track: {
        // Rayshaderanimate hero path cyan — trail must dominate the film.
        color: '#0f9ad1',
        width: 6,
        glowWidth: 16,
        opacity: 1,
        showFullRoute: true,
      },
      map: {
        styleKey: 'outdoor',
        terrainEnabled: true,
        terrain: {
          quality: 'balanced',
          exaggeration: 1.6,
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
        // Balanced prefetch: load corridor terrain before Play (cinematic quality).
        prepareQuality: 'balanced',
      },
      export: {
        format: 'mp4',
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

