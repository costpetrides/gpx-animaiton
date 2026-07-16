import { createModuleRegistry } from './moduleRegistry.js';
import { createRouteModule } from '../modules/routeModule.js';
import { createCameraModule } from '../modules/cameraModule.js';
import { createTrackModule } from '../modules/trackModule.js';
import { createTerrainModule } from '../modules/terrainModule.js';
import { createLayersModule } from '../modules/layersModule.js';
import { createOverlaysModule } from '../modules/overlaysModule.js';
import { createDataModule } from '../modules/dataModule.js';
import { createExportModule } from '../modules/exportModule.js';

/**
 * Studio kernel — central orchestrator for modules, intents, and playback.
 */
export function createStudioKernel(deps) {
  const {
    store,
    animator,
    map,
    shell,
    terrainStream,
    getDuration,
    renderProjectState,
  } = deps;

  const registry = createModuleRegistry();
  const moduleCtx = {
    store,
    animator,
    map,
    shell,
    terrainStream,
    getDuration,
    renderProjectState,
    dispatch: (action) => store.dispatch(action),
    getState: () => store.getState(),
  };

  [
    createRouteModule(moduleCtx),
    createCameraModule(moduleCtx),
    createTrackModule(moduleCtx),
    createTerrainModule(moduleCtx),
    createLayersModule(moduleCtx),
    createOverlaysModule(moduleCtx),
    createDataModule(moduleCtx),
    createExportModule(moduleCtx),
  ].forEach((m) => registry.register(m));

  function setActiveModule(id) {
    if (!registry.setActive(id)) return;
    store.dispatch({ type: 'editor/set-active-tool', payload: { tool: id } });
    renderProjectState?.();
  }

  function emit(intent, payload = {}) {
    const mod = registry.get(payload.module || registry.getActiveId());
    mod?.handleIntent?.(intent, payload);
  }

  return {
    registry,
    setActiveModule,
    emit,
    getActiveModule: () => registry.getActive(),
  };
}
