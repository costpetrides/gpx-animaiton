/**
 * Full QA against Trails/ GPX packages + feature workout.
 * Usage: node scripts/trails-qa.mjs
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
const featureResults = [];

function issue(severity, category, msg, extra = {}) {
  issues.push({ severity, category, msg, ...extra, at: new Date().toISOString() });
}

async function listTrailGpx() {
  const dirs = await readdir(TRAILS_ROOT, { withFileTypes: true });
  const rows = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const gpx = path.join(TRAILS_ROOT, d.name, 'trail.gpx');
    try {
      const text = await readFile(gpx, 'utf8');
      rows.push({ name: d.name, path: gpx, size: Buffer.byteLength(text), text });
    } catch {
      issue('medium', 'trails-library', `Missing trail.gpx in ${d.name}`);
    }
  }
  return rows.sort((a, b) => a.size - b.size);
}

function pickDiverse(rows, count = 24) {
  if (rows.length <= count) return rows;
  const picks = [];
  const seen = new Set();
  const add = (row) => {
    if (!row || seen.has(row.path)) return;
    seen.add(row.path);
    picks.push(row);
  };
  // edge cases: tiny / huge
  add(rows[0]);
  add(rows[1]);
  add(rows[2]);
  add(rows[rows.length - 1]);
  add(rows[rows.length - 2]);
  add(rows[rows.length - 3]);
  const step = Math.max(1, Math.floor((rows.length - 6) / (count - 6)));
  for (let i = 3; picks.length < count && i < rows.length - 3; i += step) add(rows[i]);
  return picks;
}

async function waitArmed(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      const a = window.__gpxStudio?.animator;
      if (!a) return { ready: false };
      return {
        ready: true,
        armed: a.isPlaybackArmed?.(),
        preparing: a.isPreparingPlayback?.(),
        err: a.getPrepareLastError?.() || a.getPrepareError?.(),
        degraded: a.isPlaybackDegraded?.(),
      };
    });
    if (!s.ready) {
      await page.waitForTimeout(200);
      continue;
    }
    if (s.armed) return { ok: true, ms: Date.now() - start, degraded: s.degraded };
    if (s.err && !s.preparing) return { ok: false, err: s.err, ms: Date.now() - start };
    await page.waitForTimeout(250);
  }
  return { ok: false, err: 'arm-timeout', ms: timeoutMs };
}

async function loadTrail(page, trail) {
  await page.evaluate(({ text, filename }) => {
    window.__gpxStudio.animator?.pause?.();
    window.__gpxStudio.loadGpxText(text, filename);
  }, { text: trail.text, filename: `${trail.name}.gpx` });
  return waitArmed(page, trail.size > 200_000 ? 180000 : 120000);
}

async function main() {
  const allTrails = await listTrailGpx();
  const sample = pickDiverse(allTrails, 24);
  console.log(`Trails library: ${allTrails.length} GPX; testing ${sample.length}`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.__gpxStudio?.animator, { timeout: 45000 });

  // ── Boot / chrome ──
  const boot = await page.evaluate(() => ({
    kernel: !!window.__gpxStudio?.kernel,
    map: !!window.__gpxStudio?.map,
    styleUrl: window.__gpxStudio?.map?.getStyle?.()?.sprite || null,
    hasMode3d: !!document.getElementById('map-mode-3d'),
    hasMode2d: !!document.getElementById('map-mode-2d'),
    styleChips: [...document.querySelectorAll('#style-picker .chip')].map((c) => c.dataset.style),
  }));
  featureResults.push({ feature: 'boot', ...boot });
  if (!boot.kernel) issue('high', 'boot', '__gpxStudio.kernel missing with gpxDebug');
  if (!boot.hasMode3d || !boot.hasMode2d) issue('critical', 'view', '2D/3D mode tabs missing');
  if (!boot.styleChips.includes('outdoor') || !boot.styleChips.includes('positron') || !boot.styleChips.includes('dark')) {
    issue('high', 'styles', 'Peak Explorer style chips incomplete', { chips: boot.styleChips });
  }
  if (boot.styleChips.includes('satellite') || boot.styleChips.includes('topo')) {
    issue('medium', 'styles', 'Legacy raster styles still present', { chips: boot.styleChips });
  }

  // ── Module rail ──
  for (const mod of ['route', 'camera', 'track', 'terrain', 'layers', 'overlays', 'export', 'data']) {
    const btn = page.locator(`[data-module="${mod}"]`);
    if (!(await btn.count())) {
      issue('medium', 'modules', `Module button missing: ${mod}`);
      continue;
    }
    await btn.click();
    await page.waitForTimeout(60);
    const d = await page.evaluate((m) => ({
      props: document.querySelector('.module-props.active')?.dataset?.moduleProps,
      panel: document.querySelector('.module-panel.active')?.dataset?.modulePanel,
      rail: document.querySelector('.module-btn.active')?.dataset?.module,
      tool: window.__gpxStudio?.getState?.().editor?.activeTool,
      m,
    }), mod);
    featureResults.push({ feature: `module:${mod}`, ok: d.props === mod || d.panel === mod || d.rail === mod, detail: d });
    if (d.props && d.props !== mod) issue('high', 'modules', `Properties panel mismatch for ${mod}`, d);
  }

  // ── Load + exercise each sampled trail ──
  for (const trail of sample) {
    const row = {
      name: trail.name,
      sizeBytes: trail.size,
      steps: {},
      issues: [],
    };
    console.log(`→ ${trail.name} (${trail.size} bytes)`);
    try {
      const arm = await loadTrail(page, trail);
      row.steps.load = arm;
      if (!arm.ok) {
        row.issues.push({ severity: 'critical', step: 'arm', msg: String(arm.err) });
        issue('critical', 'prepare', `Prepare failed: ${trail.name}`, arm);
        trailResults.push(row);
        continue;
      }
      if (arm.degraded) {
        row.issues.push({ severity: 'medium', step: 'arm', msg: 'armed degraded' });
        issue('medium', 'terrain', `Degraded prepare: ${trail.name}`, arm);
      }

      const meta = await page.evaluate(() => {
        const a = window.__gpxStudio.animator;
        const route = a.getRoute?.();
        const st = a.getPlaybackState?.();
        return {
          points: route?.raw?.length ?? route?.points?.length ?? 0,
          totalDistance: route?.totalDistance ?? 0,
          hasLayers: !!window.__gpxStudio.map.getLayer('route-full'),
          terrain: !!window.__gpxStudio.map.getTerrain(),
          pitch: window.__gpxStudio.map.getPitch(),
          styleKey: window.__gpxStudio.getState().document.project.map.styleKey,
          armed: a.isPlaybackArmed(),
          dist: st?.animDistance ?? 0,
        };
      });
      row.steps.meta = meta;
      if (!meta.hasLayers) {
        row.issues.push({ severity: 'critical', step: 'layers', msg: 'route-full missing' });
        issue('critical', 'layers', `route-full missing after load: ${trail.name}`);
      }
      if (meta.points < 2) {
        row.issues.push({ severity: 'high', step: 'parse', msg: `too few points: ${meta.points}` });
        issue('high', 'gpx', `Parse produced <2 points: ${trail.name}`, meta);
      }

      // play / pause
      await page.click('#btn-play');
      await page.waitForTimeout(1600);
      const play = await page.evaluate(() => {
        const a = window.__gpxStudio.animator;
        const s = a.getPlaybackState();
        return { playing: a.isPlaying(), dist: s.animDistance, time: s.animTime };
      });
      row.steps.play = play;
      if (!play.playing) {
        row.issues.push({ severity: 'high', step: 'play', msg: 'not playing' });
        issue('high', 'playback', `Play failed: ${trail.name}`, play);
      }
      if (play.dist <= 0) {
        row.issues.push({ severity: 'medium', step: 'play', msg: 'distance not advancing' });
        issue('medium', 'playback', `Distance stuck: ${trail.name}`, play);
      }

      await page.click('#btn-play'); // pause
      await page.waitForTimeout(200);
      const paused = await page.evaluate(() => window.__gpxStudio.animator.isPlaying());
      row.steps.pause = { playing: paused };
      if (paused) {
        row.issues.push({ severity: 'high', step: 'pause', msg: 'still playing' });
        issue('high', 'playback', `Pause failed: ${trail.name}`);
      }

      // scrub
      await page.locator('#timeline').fill('350');
      await page.locator('#timeline').dispatchEvent('input');
      await page.locator('#timeline').fill('700');
      await page.locator('#timeline').dispatchEvent('change');
      const scrub = await waitArmed(page, 90000);
      row.steps.scrub = scrub;
      if (!scrub.ok) {
        row.issues.push({ severity: 'high', step: 'scrub', msg: String(scrub.err) });
        issue('high', 'scrub', `Scrub re-arm failed: ${trail.name}`, scrub);
      }

      // 2D / 3D
      await page.locator('#map-mode-2d').click();
      const arm2d = await waitArmed(page, 90000);
      const view2d = await page.evaluate(() => ({
        terrain: !!window.__gpxStudio.map.getTerrain(),
        pitch: window.__gpxStudio.map.getPitch(),
        active2d: document.getElementById('map-mode-2d')?.classList.contains('active'),
      }));
      row.steps.view2d = { ...arm2d, ...view2d };
      if (!arm2d.ok) issue('high', 'view', `2D mode arm failed: ${trail.name}`, arm2d);
      if (view2d.terrain) issue('medium', 'view', `Terrain still on in 2D: ${trail.name}`);
      if (view2d.pitch > 1) issue('medium', 'view', `Pitch not flat in 2D: ${trail.name}`, view2d);

      await page.locator('#map-mode-3d').click();
      const arm3d = await waitArmed(page, 120000);
      const view3d = await page.evaluate(() => ({
        terrain: !!window.__gpxStudio.map.getTerrain(),
        terrainSource: window.__gpxStudio.map.getTerrain()?.source || null,
        hillshade: !!window.__gpxStudio.map.getLayer('pe-hillshade'),
        buildings: !!window.__gpxStudio.map.getLayer('pe-buildings-3d'),
        active3d: document.getElementById('map-mode-3d')?.classList.contains('active'),
      }));
      row.steps.view3d = { ...arm3d, ...view3d };
      if (!arm3d.ok) issue('high', 'view', `3D mode arm failed: ${trail.name}`, arm3d);
      if (!view3d.terrain) issue('medium', 'view', `No terrain in 3D: ${trail.name}`);
      if (view3d.terrainSource && view3d.terrainSource !== 'pe-terrain') {
        issue('high', 'terrain', `Unexpected DEM source: ${view3d.terrainSource}`, { trail: trail.name });
      }

      // style cycle (Peak Explorer styles)
      for (const style of ['positron', 'dark', 'outdoor']) {
        const chip = page.locator(`#style-picker .chip[data-style="${style}"]`);
        if (!(await chip.count())) {
          issue('high', 'styles', `Missing style chip ${style}`);
          continue;
        }
        const t0 = Date.now();
        await chip.click();
        const armStyle = await waitArmed(page, 120000);
        const ms = Date.now() - t0;
        const after = await page.evaluate(() => ({
          styleKey: window.__gpxStudio.getState().document.project.map.styleKey,
          routeLayer: !!window.__gpxStudio.map.getLayer('route-full'),
          terrain: !!window.__gpxStudio.map.getTerrain(),
        }));
        row.steps[`style:${style}`] = { ...armStyle, ms, ...after };
        if (!armStyle.ok) issue('high', 'styles', `Style ${style} arm failed: ${trail.name}`, armStyle);
        if (!after.routeLayer) issue('critical', 'styles', `route-full lost after ${style}: ${trail.name}`);
        if (ms > 20000) issue('medium', 'performance', `Style ${style} slow (${ms}ms): ${trail.name}`);
      }

      // camera presets
      await page.click('[data-module="camera"]');
      for (const cam of ['follow', 'cinematic', 'overview']) {
        const chip = page.locator(`#camera-picker .chip[data-camera="${cam}"]`);
        if (await chip.count()) {
          await chip.click();
          await page.waitForTimeout(250);
        }
      }
      const camArmed = await page.evaluate(() => window.__gpxStudio.animator.isPlaybackArmed());
      row.steps.camera = { armed: camArmed };
      if (!camArmed) issue('high', 'camera', `Disarmed after camera presets: ${trail.name}`);

      // track color
      await page.click('[data-module="track"]');
      const colorInput = page.locator('#route-color, #track-color').first();
      if (await colorInput.count()) {
        await colorInput.fill('#e11d48');
        await colorInput.dispatchEvent('input');
        await page.waitForTimeout(150);
        const color = await page.evaluate(() => window.__gpxStudio.getState().document.project.track.color);
        row.steps.trackColor = color;
        if (color?.toLowerCase() !== '#e11d48') {
          issue('medium', 'track', `Track color not applied: ${trail.name}`, { color });
        }
      }

      // terrain exaggeration
      await page.click('[data-module="terrain"]');
      const ex = page.locator('#terrain-exaggeration');
      if (await ex.count()) {
        await ex.fill('2.0');
        await ex.dispatchEvent('input');
        await page.waitForTimeout(300);
        const exVal = await page.evaluate(() => window.__gpxStudio.map.getTerrain()?.exaggeration);
        row.steps.exaggeration = exVal;
      }

      // speed / loop
      const speed = page.locator('#speed-slider');
      if (await speed.count()) {
        await speed.fill('2');
        await speed.dispatchEvent('input');
      }
      const loop = page.locator('#loop-check');
      if (await loop.count()) {
        const checked = await loop.isChecked();
        if (!checked) await loop.check();
      }

      // reset
      const resetBtn = page.locator('#btn-skip-start');
      if (await resetBtn.count()) {
        await resetBtn.click();
        await page.waitForTimeout(400);
        const reset = await page.evaluate(() => window.__gpxStudio.animator.getPlaybackState().animDistance);
        row.steps.resetDist = reset;
        if (reset > 50) issue('medium', 'playback', `Reset not near start: ${trail.name}`, { reset });
      }

      // overlays
      await page.click('[data-module="overlays"]');
      const stats = page.locator('#overlay-stats');
      if (await stats.count()) {
        await stats.check();
        await page.waitForTimeout(100);
        await stats.uncheck();
      }

      // export panel presence
      await page.click('[data-module="export"]');
      const exportBtn = page.locator('#btn-export-video, [data-action="export-video"]').first();
      row.steps.exportVisible = await exportBtn.count() > 0;

    } catch (err) {
      row.issues.push({ severity: 'critical', step: 'exception', msg: String(err?.message || err) });
      issue('critical', 'runtime', `Exception on ${trail.name}: ${err?.message || err}`);
    }
    trailResults.push(row);
  }

  // ── Malformed GPX ──
  await page.evaluate(() => window.__gpxStudio.loadGpxText('<gpx><trk></trk></gpx>', 'bad.gpx'));
  await page.waitForTimeout(800);
  const bad = await page.evaluate(() => ({
    route: !!window.__gpxStudio.animator.getRoute?.(),
    status: document.querySelector('#status-text')?.textContent || '',
  }));
  featureResults.push({ feature: 'malformed-gpx', ...bad });
  if (bad.route) issue('medium', 'input', 'Empty/malformed GPX accepted as route');

  // ── Disabled menu items ──
  const disabledMenus = await page.evaluate(() =>
    [...document.querySelectorAll('.menu-dropdown button[disabled]')].map((b) => b.textContent.trim()),
  );
  featureResults.push({ feature: 'disabled-menus', items: disabledMenus });
  for (const label of disabledMenus) {
    issue('low', 'ux', `Menu item disabled / unfinished: ${label}`);
  }

  // ── Console / page errors ──
  for (const err of pageErrors) issue('critical', 'runtime', `Uncaught: ${err}`);
  for (const err of consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e))) {
    issue('medium', 'console', err.slice(0, 300));
  }

  await browser.close();

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;

  const report = {
    generatedAt: new Date().toISOString(),
    librarySize: allTrails.length,
    testedCount: sample.length,
    testedTrails: sample.map((t) => ({ name: t.name, sizeBytes: t.size })),
    summary: bySeverity,
    totalIssues: issues.length,
    trailPassCount: trailResults.filter((r) => r.issues.length === 0).length,
    trailFailCount: trailResults.filter((r) => r.issues.length > 0).length,
    issues,
    trailResults,
    featureResults,
  };

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ summary: bySeverity, total: issues.length, report: REPORT_PATH }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
