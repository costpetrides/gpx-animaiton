/**
 * Full QA audit — bugs, malfunctions, security surface.
 */
import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import path from 'path';

const BASE = 'http://localhost:5173/?gpxDebug=1&autoGpx=DoxaoTheos.gpx';
const issues = [];

function issue(severity, category, msg, extra = {}) {
  issues.push({ severity, category, msg, ...extra });
}

async function waitArmed(page, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => ({
      armed: window.__gpxStudio?.animator?.isPlaybackArmed?.(),
      preparing: window.__gpxStudio?.animator?.isPreparingPlayback?.(),
      err: window.__gpxStudio?.animator?.getPrepareLastError?.(),
    }));
    if (s.armed) return { ok: true, ms: Date.now() - start };
    if (s.err && !s.preparing) return { ok: false, err: s.err };
    await page.waitForTimeout(300);
  }
  return { ok: false, err: 'timeout' };
}

async function loadGpx(page, filename) {
  const text = await readFile(path.join('./test', filename), 'utf8');
  await page.evaluate(({ text, filename }) => window.__gpxStudio.loadGpxText(text, filename), { text, filename });
  return waitArmed(page);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__gpxStudio?.animator, { timeout: 30000 });

  // ── Boot / debug ──
  const hasKernel = await page.evaluate(() => !!window.__gpxStudio?.kernel);
  if (!hasKernel) issue('medium', 'debug', '__gpxStudio.kernel undefined at debug init');

  const avoPanel = await page.locator('#avo-camera-rig').isVisible();
  if (!avoPanel) issue('high', 'camera-ui', 'AvoMaps camera rig panel not visible');

  // ── Module rail ──
  for (const mod of ['route', 'camera', 'track', 'terrain', 'layers', 'overlays', 'export']) {
    await page.click(`[data-module="${mod}"]`);
    await page.waitForTimeout(80);
    const d = await page.evaluate(() => ({
      props: document.querySelector('.module-props.active')?.dataset?.moduleProps,
      panel: document.querySelector('.module-panel.active')?.dataset?.modulePanel,
      rail: document.querySelector('.module-btn.active')?.dataset?.module,
      tool: window.__gpxStudio?.getState?.().editor?.activeTool,
    }));
    if (d.props !== mod) issue('high', 'modules', `Properties panel mismatch for ${mod}`, d);
    if (d.panel !== mod) issue('high', 'modules', `Left panel mismatch for ${mod}`, d);
    if (d.rail !== mod) issue('medium', 'modules', `Rail highlight mismatch for ${mod}`, d);
  }

  // ── Wait armed (auto GPX) ──
  const arm = await waitArmed(page);
  if (!arm.ok) issue('critical', 'prepare', `Initial prepare failed: ${arm.err}`);

  // ── Playback ──
  await page.click('#btn-play');
  await page.waitForTimeout(2000);
  const playState = await page.evaluate(() => {
    const a = window.__gpxStudio.animator;
    const s = a.getPlaybackState();
    return { playing: a.isPlaying(), dist: s.animDistance, time: s.animTime };
  });
  if (!playState.playing) issue('high', 'playback', 'Play did not start');
  if (playState.dist < 1) issue('high', 'playback', 'Actor distance not advancing', playState);

  await page.click('#btn-play'); // pause
  await page.waitForTimeout(200);

  // ── AvoMaps camera controls ──
  await page.click('[data-module="camera"]');
  const pitchBefore = await page.evaluate(() => window.__gpxStudio.map.getPitch());

  await page.click('[data-avo-mode="tilt"]');
  await page.locator('#avo-camera-slider').fill('65');
  await page.locator('#avo-camera-slider').dispatchEvent('input');
  await page.waitForTimeout(300);
  const tiltCheck = await page.evaluate(() => ({
    rigTilt: window.__gpxStudio.getState().document.project.camera.rig.tiltDeg,
    mapPitch: window.__gpxStudio.map.getPitch(),
  }));
  if (Math.abs(tiltCheck.mapPitch - tiltCheck.rigTilt) > 8) {
    issue('high', 'camera', 'Tilt slider not reflected on map pitch', tiltCheck);
  }

  await page.click('[data-avo-mode="altitude"]');
  await page.locator('#avo-camera-slider').fill('400');
  await page.locator('#avo-camera-slider').dispatchEvent('input');
  await page.waitForTimeout(200);
  const altCheck = await page.evaluate(() => window.__gpxStudio.getState().document.project.camera.rig.altitudeM);
  if (altCheck !== 400) issue('medium', 'camera', 'Altitude not stored in rig', { altCheck });

  await page.click('[data-avo-mode="focus"]');
  await page.locator('#avo-camera-slider').fill('60');
  await page.locator('#avo-camera-slider').dispatchEvent('input');
  const focusCheck = await page.evaluate(() => window.__gpxStudio.getState().document.project.camera.rig.focusForwardM);
  if (focusCheck !== 60) issue('medium', 'camera', 'Focus forward not stored', { focusCheck });

  const armedAfterCamera = await page.evaluate(() => window.__gpxStudio.animator.isPlaybackArmed());
  if (!armedAfterCamera) issue('high', 'camera', 'Playback disarmed after camera rig changes');

  // ── Keyframes ──
  await page.click('#btn-play');
  await page.waitForTimeout(500);
  await page.click('#btn-play');
  await page.click('#btn-add-keyframe');
  await page.waitForTimeout(200);
  const kfCount = await page.evaluate(() => window.__gpxStudio.getState().document.project.timeline.keyframes.length);
  if (kfCount < 1) issue('high', 'keyframes', 'Keyframe not added to timeline');

  // Keyframe interpolation during play
  await page.click('#btn-play');
  await page.waitForTimeout(1500);
  const kfPlay = await page.evaluate(() => window.__gpxStudio.animator.isPlaying());
  if (!kfPlay) issue('medium', 'keyframes', 'Playback stopped unexpectedly with keyframes');

  await page.click('#btn-play');

  // ── Scrub / prepare ──
  await page.locator('#timeline').fill('400');
  await page.locator('#timeline').dispatchEvent('input');
  await page.locator('#timeline').fill('800');
  await page.locator('#timeline').dispatchEvent('change');
  const scrubArm = await waitArmed(page, 60000);
  if (!scrubArm.ok) issue('high', 'scrub', `Scrub re-arm failed: ${scrubArm.err}`);
  const playDisabledWhenArmed = await page.evaluate(() => ({
    disabled: document.getElementById('btn-play').disabled,
    armed: window.__gpxStudio.animator.isPlaybackArmed(),
    preparing: window.__gpxStudio.animator.isPreparingPlayback(),
  }));
  if (playDisabledWhenArmed.disabled && playDisabledWhenArmed.armed && !playDisabledWhenArmed.preparing) {
    issue('high', 'playback', 'Play button disabled while armed after scrub', playDisabledWhenArmed);
  }

  // ── Layer toggles ──
  await page.click('[data-module="layers"]');
  const layerCheckbox = page.locator('#layer-list [data-layer="elevation"]');
  if (await layerCheckbox.count()) {
    const before = await layerCheckbox.isChecked();
    await layerCheckbox.click();
    await page.waitForTimeout(200);
    const layerState = await page.evaluate(() => window.__gpxStudio.getState().document.project.layers.elevation);
    if (layerState === before) issue('medium', 'layers', 'Elevation layer toggle has no effect on store');
  }

  // ── Terrain toggle ──
  await page.click('[data-module="terrain"]');
  const terrainOn = await page.evaluate(() => !!window.__gpxStudio.map.getTerrain());
  await page.locator('#terrain-enabled').uncheck();
  await page.waitForTimeout(500);
  const terrainOff = await page.evaluate(() => !!window.__gpxStudio.map.getTerrain());
  if (terrainOn && terrainOff) issue('medium', 'terrain', 'Terrain checkbox did not disable map terrain');
  await page.locator('#terrain-enabled').check();
  await waitArmed(page, 60000);

  // ── route-color vs track-color ──
  await page.click('[data-module="route"]');
  await page.locator('#route-color').fill('#ff00ff');
  await page.locator('#route-color').dispatchEvent('input');
  await page.waitForTimeout(200);
  const trackColor = await page.evaluate(() => window.__gpxStudio.getState().document.project.track.color);
  if (trackColor !== '#ff00ff') issue('medium', 'route', 'route-color does not update track.color', { trackColor });

  // ── Style switch freeze ──
  const styleStart = Date.now();
  await page.locator('[data-style="topo"]').click();
  await waitArmed(page, 120000);
  const styleMs = Date.now() - styleStart;
  if (styleMs > 15000) issue('medium', 'performance', `Style switch took ${styleMs}ms (>15s freeze)`, { styleMs });
  const hasRouteLayer = await page.evaluate(() => !!window.__gpxStudio.map.getLayer('route-full'));
  if (!hasRouteLayer) issue('critical', 'style', 'route-full layer missing after style switch');

  // ── 2D/3D ──
  await page.locator('#map-mode-2d').click();
  await waitArmed(page, 60000);
  const terrain2d = await page.evaluate(() => !!window.__gpxStudio.map.getTerrain());
  if (terrain2d) issue('medium', 'view', 'Terrain still enabled in 2D mode');
  await page.locator('#map-mode-3d').click();
  await waitArmed(page, 60000);

  // ── Maximum prepare quality timeout risk ──
  await page.selectOption('#prepare-quality-select', 'maximum');
  await page.evaluate(() => window.__gpxStudio.animator.reprepare('quality'));
  const maxPrep = await waitArmed(page, 180000);
  if (!maxPrep.ok) issue('high', 'prepare', `Maximum quality prepare failed/timeout: ${maxPrep.err}`, { ms: maxPrep.ms });
  if (maxPrep.ms > 60000) issue('medium', 'ux', `Maximum prepare took ${maxPrep.ms}ms — long Play disable`, { ms: maxPrep.ms });

  // ── Malformed GPX ──
  await page.evaluate(() => window.__gpxStudio.loadGpxText('<gpx><trk></trk></gpx>', 'bad.gpx'));
  await page.waitForTimeout(1000);
  const badRoute = await page.evaluate(() => !!window.__gpxStudio.animator.getRoute());
  if (badRoute) issue('medium', 'input', 'Empty/malformed GPX loaded without rejection');

  // ── XSS probe in route name ──
  const xssPayload = '<img src=x onerror=window.__xssProbe=1>';
  await page.evaluate(({ payload }) => {
    try {
      const parsed = { name: payload, points: [{ lat: 35, lng: 33, ele: 100, time: null }], stats: {} };
      // can't call parseGPX easily; test project name in DOM via store
      window.__gpxStudio.getState();
    } catch {}
  }, { payload: xssPayload });

  // ── Export button state ──
  await loadGpx(page, 'route.gpx');
  await page.click('[data-module="export"]');
  const exportDisabled = await page.locator('#btn-export-video').isDisabled();
  if (exportDisabled) issue('low', 'export', 'Export video button disabled with route loaded');

  // ── Console / page errors ──
  for (const err of pageErrors) issue('critical', 'runtime', `Uncaught exception: ${err}`);
  for (const err of consoleErrors.filter((e) => !e.includes('favicon'))) {
    issue('medium', 'console', err);
  }

  await browser.close();

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  issues.forEach((i) => { bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1; });

  console.log(JSON.stringify({ summary: bySeverity, total: issues.length, issues }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
