/**
 * Full QA audit: Trails/*.gpx + all major GPX Animator features.
 * Usage: node scripts/trails-qa-audit.mjs
 */
import { chromium } from 'playwright';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TRAILS_ROOT = path.resolve(ROOT, '../Trails/Trails');
const BASE = 'http://127.0.0.1:5173/?gpxDebug=1';
const REPORT_PATH = path.join(ROOT, 'qa-trails-report.json');

const issues = [];
const trailResults = [];
const featureResults = {};

function issue(severity, category, msg, extra = {}) {
  issues.push({
    severity,
    category,
    msg,
    at: new Date().toISOString(),
    ...extra,
  });
}

async function waitArmed(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      const a = window.__gpxStudio?.animator;
      return {
        armed: a?.isPlaybackArmed?.(),
        preparing: a?.isPreparingPlayback?.(),
        err: a?.getPrepareLastError?.() || a?.getPrepareError?.(),
        degraded: a?.isPlaybackDegraded?.(),
      };
    });
    if (s.armed) return { ok: true, ms: Date.now() - start, degraded: s.degraded };
    if (s.err && !s.preparing) return { ok: false, err: s.err, ms: Date.now() - start };
    await page.waitForTimeout(300);
  }
  return { ok: false, err: 'timeout', ms: timeoutMs };
}

async function loadGpxText(page, text, filename) {
  await page.evaluate(
    ({ text, filename }) => window.__gpxStudio.loadGpxText(text, filename),
    { text, filename },
  );
  return waitArmed(page);
}

async function listTrailSamples() {
  const dirs = await readdir(TRAILS_ROOT, { withFileTypes: true });
  const rows = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const gpx = path.join(TRAILS_ROOT, d.name, 'trail.gpx');
    try {
      const buf = await readFile(gpx);
      rows.push({ name: d.name, path: gpx, size: buf.length });
    } catch {
      // no trail.gpx
    }
  }
  rows.sort((a, b) => a.size - b.size);
  const picks = [];
  const push = (i) => {
    if (i < 0 || i >= rows.length) return;
    picks.push(rows[i]);
  };
  // small / mid / large spectrum + always include extremes
  push(0);
  push(1);
  push(2);
  for (let i = 3; i < rows.length - 3; i += Math.max(1, Math.floor((rows.length - 6) / 12))) {
    push(i);
  }
  push(rows.length - 3);
  push(rows.length - 2);
  push(rows.length - 1);

  const seen = new Set();
  return picks.filter((r) => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  });
}

async function exerciseFeatures(page) {
  const feat = {};

  // Modules rail
  feat.modules = {};
  for (const mod of ['route', 'camera', 'track', 'terrain', 'layers', 'overlays', 'export', 'data']) {
    const btn = page.locator(`[data-module="${mod}"]`);
    if (!(await btn.count())) {
      feat.modules[mod] = { ok: false, reason: 'button missing' };
      if (mod !== 'data') issue('medium', 'modules', `Module button missing: ${mod}`);
      continue;
    }
    await btn.click();
    await page.waitForTimeout(100);
    const d = await page.evaluate((m) => ({
      props: document.querySelector('.module-props.active')?.dataset?.moduleProps,
      panel: document.querySelector('.module-panel.active')?.dataset?.modulePanel,
      rail: document.querySelector('.module-btn.active')?.dataset?.module,
    }), mod);
    const ok = d.props === mod || d.panel === mod || d.rail === mod;
    feat.modules[mod] = { ok, ...d };
    if (!ok) issue('high', 'modules', `Module UI mismatch for ${mod}`, d);
  }

  // Playback
  await page.click('#btn-play');
  await page.waitForTimeout(2000);
  const playState = await page.evaluate(() => {
    const a = window.__gpxStudio.animator;
    const s = a.getPlaybackState();
    return { playing: a.isPlaying(), dist: s.animDistance, time: s.animTime };
  });
  feat.play = playState;
  if (!playState.playing) issue('high', 'playback', 'Play did not start');
  if (playState.dist < 1) issue('high', 'playback', 'Actor distance not advancing', playState);

  await page.click('#btn-play');
  await page.waitForTimeout(250);
  const paused = await page.evaluate(() => window.__gpxStudio.animator.isPlaying());
  feat.pause = { playing: paused };
  if (paused) issue('high', 'playback', 'Still playing after pause');

  // Speed
  if (await page.locator('#speed-slider').count()) {
    await page.locator('#speed-slider').fill('2');
    await page.locator('#speed-slider').dispatchEvent('input');
    await page.waitForTimeout(150);
    feat.speed = await page.evaluate(() => ({
      label: document.getElementById('speed-label')?.textContent,
      store: window.__gpxStudio.getState().document.project.playback?.speed,
    }));
  }

  // Camera presets + Avo rig
  await page.click('[data-module="camera"]');
  for (const cam of ['follow', 'chase', 'drone', 'cinematic']) {
    const chip = page.locator(`#camera-picker [data-camera="${cam}"]`);
    if (await chip.count()) {
      await chip.click();
      await page.waitForTimeout(200);
    }
  }
  feat.cameraPreset = await page.evaluate(() => window.__gpxStudio.getState().document.project.camera.preset);

  if (await page.locator('#avo-camera-slider').count()) {
    await page.click('[data-avo-mode="tilt"]').catch(() => {});
    await page.locator('#avo-camera-slider').fill('62');
    await page.locator('#avo-camera-slider').dispatchEvent('input');
    await page.waitForTimeout(300);
    feat.cameraTilt = await page.evaluate(() => ({
      rigTilt: window.__gpxStudio.getState().document.project.camera.rig?.tiltDeg,
      mapPitch: window.__gpxStudio.map.getPitch(),
    }));
    if (
      feat.cameraTilt.rigTilt != null &&
      Math.abs(feat.cameraTilt.mapPitch - feat.cameraTilt.rigTilt) > 12
    ) {
      issue('high', 'camera', 'Tilt slider not reflected on map pitch', feat.cameraTilt);
    }
  } else {
    issue('medium', 'camera-ui', 'AvoMaps camera slider not found');
  }

  // Keyframes
  if (await page.locator('#btn-add-keyframe').count()) {
    await page.click('#btn-add-keyframe');
    await page.waitForTimeout(200);
    feat.keyframes = await page.evaluate(
      () => window.__gpxStudio.getState().document.project.timeline?.keyframes?.length ?? 0,
    );
    if (feat.keyframes < 1) issue('high', 'keyframes', 'Keyframe not added');
  }

  // Scrub
  await page.locator('#timeline').fill('350');
  await page.locator('#timeline').dispatchEvent('input');
  await page.locator('#timeline').fill('700');
  await page.locator('#timeline').dispatchEvent('change');
  const scrubArm = await waitArmed(page, 90000);
  feat.scrub = scrubArm;
  if (!scrubArm.ok) issue('high', 'scrub', `Scrub re-arm failed: ${scrubArm.err}`);

  const playBtn = await page.evaluate(() => ({
    disabled: document.getElementById('btn-play')?.disabled,
    armed: window.__gpxStudio.animator.isPlaybackArmed(),
    preparing: window.__gpxStudio.animator.isPreparingPlayback(),
  }));
  feat.playButtonAfterScrub = playBtn;
  if (playBtn.disabled && playBtn.armed && !playBtn.preparing) {
    issue('high', 'playback', 'Play disabled while armed after scrub', playBtn);
  }

  // Track color
  await page.click('[data-module="track"]').catch(() => page.click('[data-module="route"]'));
  if (await page.locator('#route-color').count()) {
    await page.locator('#route-color').fill('#e11d48');
    await page.locator('#route-color').dispatchEvent('input');
    await page.waitForTimeout(200);
    feat.trackColor = await page.evaluate(
      () => window.__gpxStudio.getState().document.project.track.color,
    );
    if (feat.trackColor !== '#e11d48') {
      issue('medium', 'track', 'route-color does not update track.color', feat);
    }
  }

  // Layers
  await page.click('[data-module="layers"]');
  await page.waitForTimeout(100);
  feat.layers = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('#layer-list input[type=checkbox], [data-layer]')];
    return {
      count: boxes.length,
      ids: boxes.map((el) => el.dataset?.layer || el.id).filter(Boolean),
    };
  });
  if (feat.layers.count === 0) issue('medium', 'layers', 'No layer toggles found');

  // Terrain panel
  await page.click('[data-module="terrain"]');
  if (await page.locator('#terrain-enabled').count()) {
    const before = await page.evaluate(() => !!window.__gpxStudio.map.getTerrain());
    await page.locator('#terrain-enabled').uncheck();
    await page.waitForTimeout(600);
    const off = await page.evaluate(() => !!window.__gpxStudio.map.getTerrain());
    feat.terrainToggle = { before, off };
    if (before && off) issue('high', 'terrain', 'Terrain checkbox did not disable map terrain');
    await page.locator('#terrain-enabled').check();
    await waitArmed(page, 90000);
  }

  if (await page.locator('#terrain-exaggeration').count()) {
    await page.locator('#terrain-exaggeration').fill('2.2');
    await page.locator('#terrain-exaggeration').dispatchEvent('input');
    await page.waitForTimeout(300);
    feat.exaggeration = await page.evaluate(() => window.__gpxStudio.map.getTerrain()?.exaggeration);
  }

  // Overlays
  await page.click('[data-module="overlays"]');
  if (await page.locator('#overlay-stats').count()) {
    await page.locator('#overlay-stats').check();
    await page.waitForTimeout(200);
    feat.overlayStats = await page.evaluate(() => ({
      store: window.__gpxStudio.getState().document.project.overlays?.stats,
      visible: !document.getElementById('stats-overlay')?.classList.contains('hidden'),
    }));
  }

  // Map styles (Peak Explorer set)
  feat.styles = {};
  for (const style of ['outdoor', 'positron', 'dark']) {
    const chip = page.locator(`#style-picker [data-style="${style}"]`);
    if (!(await chip.count())) {
      feat.styles[style] = { ok: false, reason: 'chip missing' };
      issue('high', 'style', `Style chip missing: ${style}`);
      continue;
    }
    const t0 = Date.now();
    await chip.click();
    const arm = await waitArmed(page, 120000);
    const ms = Date.now() - t0;
    const layer = await page.evaluate(() => !!window.__gpxStudio.map.getLayer('route-full'));
    feat.styles[style] = { ok: arm.ok && layer, ms, armed: arm.ok, layer, err: arm.err };
    if (!arm.ok) issue('critical', 'style', `Style ${style} failed to arm`, arm);
    if (!layer) issue('critical', 'style', `route-full missing after ${style}`);
    if (ms > 20000) issue('medium', 'performance', `Style ${style} took ${ms}ms`, { ms });
  }

  // Legacy chips should be gone
  for (const legacy of ['satellite', 'topo', 'liberty']) {
    if (await page.locator(`#style-picker [data-style="${legacy}"]`).count()) {
      issue('medium', 'style', `Legacy style chip still present: ${legacy}`);
    }
  }

  // 2D / 3D
  await page.locator('#map-mode-2d').click();
  const arm2d = await waitArmed(page, 90000);
  feat.mode2d = {
    ...arm2d,
    terrain: await page.evaluate(() => !!window.__gpxStudio.map.getTerrain()),
    pitch: await page.evaluate(() => window.__gpxStudio.map.getPitch()),
    hillshade: await page.evaluate(() => !!window.__gpxStudio.map.getLayer('pe-hillshade')),
    buildings: await page.evaluate(() => !!window.__gpxStudio.map.getLayer('pe-buildings-3d')),
  };
  if (!arm2d.ok) issue('high', 'view', `2D mode arm failed: ${arm2d.err}`);
  if (feat.mode2d.terrain) issue('high', 'view', 'Terrain still on in Map 2D');
  if (feat.mode2d.pitch > 1) issue('medium', 'view', 'Pitch not near 0 in Map 2D', feat.mode2d);
  if (feat.mode2d.hillshade) issue('medium', 'view', 'Hillshade still present in 2D');

  await page.locator('#map-mode-3d').click();
  const arm3d = await waitArmed(page, 120000);
  feat.mode3d = {
    ...arm3d,
    terrain: await page.evaluate(() => !!window.__gpxStudio.map.getTerrain()),
    terrainSource: await page.evaluate(() => window.__gpxStudio.map.getTerrain()?.source),
    hillshade: await page.evaluate(() => !!window.__gpxStudio.map.getLayer('pe-hillshade')),
    pitch: await page.evaluate(() => window.__gpxStudio.map.getPitch()),
  };
  if (!arm3d.ok) issue('high', 'view', `3D mode arm failed: ${arm3d.err}`);
  if (!feat.mode3d.terrain) issue('high', 'view', 'Terrain not enabled in Map 3D');
  if (feat.mode3d.terrainSource && feat.mode3d.terrainSource !== 'pe-terrain') {
    issue('high', 'terrain', '3D terrain source is not Peak Explorer pe-terrain', feat.mode3d);
  }

  // Prepare quality
  if (await page.locator('#prepare-quality-select').count()) {
    await page.selectOption('#prepare-quality-select', 'fast');
    await page.evaluate(() => window.__gpxStudio.animator.reprepare?.('quality'));
    feat.prepareFast = await waitArmed(page, 120000);
    if (!feat.prepareFast.ok) issue('high', 'prepare', `Fast prepare failed: ${feat.prepareFast.err}`);

    await page.selectOption('#prepare-quality-select', 'maximum');
    const t0 = Date.now();
    await page.evaluate(() => window.__gpxStudio.animator.reprepare?.('quality'));
    feat.prepareMax = await waitArmed(page, 180000);
    feat.prepareMax.ms = Date.now() - t0;
    if (!feat.prepareMax.ok) {
      issue('high', 'prepare', `Maximum prepare failed: ${feat.prepareMax.err}`, feat.prepareMax);
    } else if (feat.prepareMax.ms > 60000) {
      issue('medium', 'ux', `Maximum prepare took ${feat.prepareMax.ms}ms`, feat.prepareMax);
    }
  }

  // Export panel
  await page.click('[data-module="export"]');
  feat.export = await page.evaluate(() => ({
    videoDisabled: document.getElementById('btn-export-video')?.disabled ?? null,
    toolbarVideo: document.getElementById('toolbar-export-video')?.disabled ?? null,
  }));

  // Loop checkbox
  if (await page.locator('#loop-check').count()) {
    await page.locator('#loop-check').check();
    feat.loop = true;
  }

  // Step / skip controls
  for (const id of ['btn-step-back', 'btn-step-fwd', 'btn-skip-start', 'btn-skip-end']) {
    if (await page.locator(`#${id}`).count()) {
      await page.click(`#${id}`);
      await page.waitForTimeout(200);
    }
  }
  feat.transport = await waitArmed(page, 60000);

  // Screenshot tool if present
  if (await page.locator('[data-action="screenshot"]').count()) {
    await page.click('[data-action="screenshot"]');
    await page.waitForTimeout(300);
    feat.screenshotClicked = true;
  }

  return feat;
}

async function main() {
  const samples = await listTrailSamples();
  console.log(`Sampling ${samples.length} / Trails GPX files from ${TRAILS_ROOT}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.__gpxStudio?.animator, { timeout: 45000 });

  // Boot checks
  const boot = await page.evaluate(() => ({
    kernel: !!window.__gpxStudio?.kernel,
    styles: [...document.querySelectorAll('#style-picker .chip')].map((c) => c.dataset.style),
    mode3d: document.getElementById('map-mode-3d')?.classList.contains('active'),
    mode2d: document.getElementById('map-mode-2d')?.classList.contains('active'),
  }));
  featureResults.boot = boot;
  if (!boot.kernel) issue('medium', 'debug', '__gpxStudio.kernel undefined');
  if (!boot.styles.includes('outdoor') || !boot.styles.includes('positron') || !boot.styles.includes('dark')) {
    issue('high', 'style', 'Peak Explorer style chips incomplete', boot);
  }

  // Load each sampled Trails GPX (arm only — keep runtime bounded)
  for (const sample of samples) {
    const text = await readFile(sample.path, 'utf8');
    const t0 = Date.now();
    let result = {
      name: sample.name,
      size: sample.size,
      ok: false,
    };
    try {
      // Skip full prepare on huge E4 in feature phase; still try arm with long timeout
      const timeout = sample.size > 500_000 ? 180000 : 120000;
      const arm = await loadGpxText(page, text, `${sample.name}.gpx`);
      result = {
        ...result,
        ok: arm.ok,
        ms: Date.now() - t0,
        degraded: arm.degraded,
        err: arm.err || null,
        route: await page.evaluate(() => {
          const r = window.__gpxStudio.animator.getRoute?.();
          return r
            ? {
                points: r.raw?.length ?? r.points?.length ?? null,
                totalDistance: r.totalDistance ?? null,
              }
            : null;
        }),
      };
      if (!arm.ok) {
        issue('critical', 'trails-load', `Failed to arm: ${sample.name}`, {
          err: arm.err,
          size: sample.size,
        });
      } else if (arm.degraded) {
        issue('medium', 'trails-load', `Armed degraded: ${sample.name}`, { size: sample.size });
      }
      // quick play smoke for non-huge files
      if (arm.ok && sample.size < 300_000) {
        await page.click('#btn-play');
        await page.waitForTimeout(1200);
        const playing = await page.evaluate(() => ({
          playing: window.__gpxStudio.animator.isPlaying(),
          dist: window.__gpxStudio.animator.getPlaybackState().animDistance,
        }));
        result.playSmoke = playing;
        if (!playing.playing) {
          issue('high', 'playback', `Play failed for ${sample.name}`, playing);
        }
        await page.click('#btn-play');
        await page.waitForTimeout(200);
      }
    } catch (err) {
      result.ok = false;
      result.err = String(err?.message || err);
      issue('critical', 'trails-load', `Exception loading ${sample.name}`, { err: result.err });
    }
    trailResults.push(result);
    console.log(
      `${result.ok ? 'OK' : 'FAIL'}  ${String(result.ms || 0).padStart(6)}ms  ${sample.name} (${sample.size}b)`,
    );
  }

  // Full feature pass on a mid-size reliable trail
  const featureTrail =
    samples.find((s) => s.name.includes('Venetian')) ||
    samples.find((s) => s.size > 15000 && s.size < 80000) ||
    samples[Math.floor(samples.length / 2)];
  console.log(`\nFull feature pass on: ${featureTrail.name}`);
  const featureText = await readFile(featureTrail.path, 'utf8');
  const featureArm = await loadGpxText(page, featureText, `${featureTrail.name}.gpx`);
  if (!featureArm.ok) {
    issue('critical', 'features', `Feature-pass trail failed to arm: ${featureTrail.name}`, featureArm);
  } else {
    Object.assign(featureResults, await exerciseFeatures(page));
  }
  featureResults.featureTrail = featureTrail.name;

  // Malformed GPX
  await page.evaluate(() => window.__gpxStudio.loadGpxText('<gpx><trk></trk></gpx>', 'bad.gpx'));
  await page.waitForTimeout(1000);
  const badRoute = await page.evaluate(() => !!window.__gpxStudio.animator.getRoute?.());
  featureResults.malformedGpxAccepted = badRoute;
  if (badRoute) issue('medium', 'input', 'Empty/malformed GPX loaded without rejection');

  // Runtime errors
  for (const err of pageErrors) issue('critical', 'runtime', `Uncaught: ${err}`);
  for (const err of consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e))) {
    // MapLibre tile 404s are noisy — keep but tag
    const sev = /Failed to fetch|404|net::/i.test(err) ? 'low' : 'medium';
    issue(sev, 'console', err.slice(0, 400));
  }

  await browser.close();

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;

  const report = {
    generatedAt: new Date().toISOString(),
    app: BASE,
    trailsRoot: TRAILS_ROOT,
    sampled: samples.length,
    trailPass: trailResults.filter((r) => r.ok).length,
    trailFail: trailResults.filter((r) => !r.ok).length,
    summary: bySeverity,
    totalIssues: issues.length,
    trailResults,
    featureResults,
    issues,
  };

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ ...bySeverity, total: issues.length, trailPass: report.trailPass, trailFail: report.trailFail }, null, 2));
  console.log(`Wrote ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
