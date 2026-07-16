/**
 * User-facing prepare quality presets and intent-based prepare plans.
 * All routes use the same logic — budgets scale with quality and intent.
 */

export const PREPARE_QUALITY = {
  FAST: 'fast',
  BALANCED: 'balanced',
  MAXIMUM: 'maximum',
};

export const PREPARE_INTENT = {
  INITIAL: 'initial',
  RELOCATE: 'relocate',
  RESTYLE: 'restyle',
};

export const PREPARE_QUALITY_LABELS = {
  [PREPARE_QUALITY.FAST]: 'Fast',
  [PREPARE_QUALITY.BALANCED]: 'Balanced',
  [PREPARE_QUALITY.MAXIMUM]: 'Maximum Quality',
};

const QUALITY_BASE = {
  [PREPARE_QUALITY.FAST]: {
    initialViewDeadlineMs: 3000,
    corridor: {
      enabled: false,
      stepM: 400,
      maxDistanceM: 0,
      maxFractionOfRoute: 0,
      maxHops: 0,
      deadlineMs: 0,
    },
    fullRoute: {
      enabled: false,
      sampleStepM: 500,
      maxSamples: 0,
      deadlineMs: 0,
    },
  },
  [PREPARE_QUALITY.BALANCED]: {
    initialViewDeadlineMs: 12000,
    corridor: {
      enabled: true,
      stepM: 400,
      maxDistanceM: 2500,
      maxFractionOfRoute: 0.2,
      maxHops: 8,
      deadlineMs: 8000,
    },
    fullRoute: {
      enabled: false,
      sampleStepM: 500,
      maxSamples: 0,
      deadlineMs: 0,
    },
  },
  [PREPARE_QUALITY.MAXIMUM]: {
    initialViewDeadlineMs: 30000,
    corridor: {
      enabled: true,
      stepM: 200,
      maxDistanceM: 10000,
      maxFractionOfRoute: 0.5,
      maxHops: 50,
      deadlineMs: 30000,
    },
    fullRoute: {
      enabled: true,
      sampleStepM: 400,
      maxSamples: 80,
      deadlineMs: 60000,
    },
  },
};

const INTENT_OVERRIDES = {
  [PREPARE_INTENT.INITIAL]: {
    fitOverview: true,
    corridorScale: 0,
    deadlineScale: 1,
  },
  [PREPARE_INTENT.RELOCATE]: {
    fitOverview: false,
    corridorScale: 0.35,
    deadlineScale: 0.5,
  },
  [PREPARE_INTENT.RESTYLE]: {
    fitOverview: false,
    corridorScale: 0.5,
    deadlineScale: 0.6,
  },
};

export function normalizePrepareQuality(value) {
  if (value === PREPARE_QUALITY.FAST || value === PREPARE_QUALITY.MAXIMUM) return value;
  return PREPARE_QUALITY.BALANCED;
}

export function mapReasonToIntent(reason) {
  if (reason === 'load') return PREPARE_INTENT.INITIAL;
  if (reason === 'style') return PREPARE_INTENT.RESTYLE;
  if (reason === 'export') return PREPARE_INTENT.INITIAL;
  return PREPARE_INTENT.RELOCATE;
}

/**
 * @param {'initial'|'relocate'|'restyle'} intent
 * @param {'fast'|'balanced'|'maximum'} qualityKey
 * @param {{ totalDistance?: number } | null} route
 */
export function resolvePreparePlan(intent, qualityKey, route = null) {
  const quality = normalizePrepareQuality(qualityKey);
  const base = QUALITY_BASE[quality];
  const overrides = INTENT_OVERRIDES[intent] || INTENT_OVERRIDES[PREPARE_INTENT.RELOCATE];
  const total = route?.totalDistance ?? 0;

  const corridorScale = overrides.corridorScale ?? 1;
  const deadlineScale = overrides.deadlineScale ?? 1;

  const corridorMaxM = corridorScale <= 0
    ? 0
    : Math.min(
    base.corridor.maxDistanceM * corridorScale,
    total > 0 ? total * base.corridor.maxFractionOfRoute * corridorScale : base.corridor.maxDistanceM * corridorScale,
    base.corridor.maxHops > 0 ? base.corridor.maxHops * base.corridor.stepM * corridorScale : 0,
  );

  const corridorEnabled = base.corridor.enabled && corridorMaxM > 0 && base.corridor.stepM > 0;

  const initialViewDeadlineMs = Math.round(base.initialViewDeadlineMs * deadlineScale);

  return {
    intent,
    quality,
    fitOverview: overrides.fitOverview ?? false,
    requireInitialView: true,
    initialViewDeadlineMs,
    allowDegrade: true,
    corridor: {
      enabled: corridorEnabled,
      stepM: base.corridor.stepM,
      maxDistanceM: corridorMaxM,
      maxHops: Math.max(1, Math.round(base.corridor.maxHops * corridorScale)),
      deadlineMs: Math.round(base.corridor.deadlineMs * deadlineScale),
    },
    fullRoute: {
      enabled: intent === PREPARE_INTENT.INITIAL && base.fullRoute.enabled,
      sampleStepM: base.fullRoute.sampleStepM,
      maxSamples: base.fullRoute.maxSamples,
      deadlineMs: base.fullRoute.deadlineMs,
    },
    totalPrepareDeadlineMs: Math.max(
      initialViewDeadlineMs,
      corridorEnabled ? Math.round(base.corridor.deadlineMs * deadlineScale) : 0,
      base.fullRoute.enabled ? base.fullRoute.deadlineMs : 0,
    ),
  };
}

export function buildCorridorDistances(plan, route, { fromDistance = 0 } = {}) {
  if (!plan.corridor.enabled || !route) return [fromDistance];

  const total = route.totalDistance;
  const cap = Math.min(plan.corridor.maxDistanceM, total);
  const distances = [fromDistance];

  for (
    let d = fromDistance + plan.corridor.stepM;
    d <= fromDistance + cap && distances.length < plan.corridor.maxHops + 1;
    d += plan.corridor.stepM
  ) {
    if (d > total) break;
    distances.push(d);
  }

  if (distances.length === 1 && fromDistance === 0 && total > 0) {
    const probe = Math.min(total * 0.05, plan.corridor.maxDistanceM);
    if (probe > plan.corridor.stepM) distances.push(probe);
  }

  return distances;
}

export function buildFullRouteDistances(plan, route) {
  if (!plan.fullRoute.enabled || !route || route.totalDistance <= 0) return [];

  const total = route.totalDistance;
  const step = Math.max(plan.fullRoute.sampleStepM, total / plan.fullRoute.maxSamples);
  const distances = [];
  for (let d = 0; d <= total; d += step) {
    distances.push(Math.min(d, total));
    if (distances.length >= plan.fullRoute.maxSamples) break;
  }
  if (distances[distances.length - 1] < total) {
    distances.push(total);
  }
  return distances;
}
