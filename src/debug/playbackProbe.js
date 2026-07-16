function now() {
  return performance.now();
}

export function createPlaybackProbe({ enabled = false } = {}) {
  if (!enabled) {
    return {
      markLoop() {},
      markFrameResolved() {},
      markApplied() {},
      markSkipped() {},
      markRendererCost() {},
      markCameraCost() {},
      markTerrain() {},
      flush() {},
    };
  }

  const stats = {
    startedAt: now(),
    loops: 0,
    resolvedFrames: 0,
    appliedFrames: 0,
    skippedFrames: 0,
    rendererCostMs: 0,
    cameraCostMs: 0,
      terrainFrames: 0,
      terrainMinClearanceM: Infinity,
      terrainAvgClearanceSum: 0,
    maxDtMs: 0,
    lastFlushAt: now(),
  };

  function flush(reason = 'periodic') {
    const elapsed = Math.max(1, now() - stats.startedAt);
    const fps = (stats.loops * 1000) / elapsed;
    const summary = {
      reason,
      loops: stats.loops,
      resolvedFrames: stats.resolvedFrames,
      appliedFrames: stats.appliedFrames,
      skippedFrames: stats.skippedFrames,
      loopFps: Number(fps.toFixed(1)),
      maxDtMs: Number(stats.maxDtMs.toFixed(2)),
      avgRendererCostMs: stats.appliedFrames
        ? Number((stats.rendererCostMs / stats.appliedFrames).toFixed(2))
        : 0,
      avgCameraCostMs: stats.appliedFrames
        ? Number((stats.cameraCostMs / stats.appliedFrames).toFixed(2))
        : 0,
      terrainFrames: stats.terrainFrames,
      terrainMinClearanceM:
        stats.terrainFrames > 0
          ? Number(stats.terrainMinClearanceM.toFixed(2))
          : null,
      terrainAvgClearanceM:
        stats.terrainFrames > 0
          ? Number((stats.terrainAvgClearanceSum / stats.terrainFrames).toFixed(2))
          : null,
    };
    console.info('[PlaybackProbe]', summary);
    stats.lastFlushAt = now();
  }

  return {
    markLoop(dtSec) {
      stats.loops += 1;
      stats.maxDtMs = Math.max(stats.maxDtMs, dtSec * 1000);
      if (now() - stats.lastFlushAt > 2000) {
        flush();
      }
    },
    markFrameResolved() {
      stats.resolvedFrames += 1;
    },
    markApplied() {
      stats.appliedFrames += 1;
    },
    markSkipped() {
      stats.skippedFrames += 1;
    },
    markRendererCost(ms) {
      stats.rendererCostMs += ms;
    },
    markCameraCost(ms) {
      stats.cameraCostMs += ms;
    },
    markTerrain(terrainInfo) {
      if (!terrainInfo || !terrainInfo.terrainAware) return;
      stats.terrainFrames += 1;
      stats.terrainMinClearanceM = Math.min(
        stats.terrainMinClearanceM,
        terrainInfo.clearanceM,
      );
      stats.terrainAvgClearanceSum += terrainInfo.clearanceM;
    },
    flush,
  };
}

