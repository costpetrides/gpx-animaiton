import { chromium } from 'playwright';
import { readdir, readFile } from 'fs/promises';
import path from 'path';

const BASE = 'http://localhost:5173/?gpxDebug=1';
const issues = [];

function issue(severity, area, msg, extra = {}) {
  issues.push({ severity, area, msg, ...extra });
}

async function waitArmed(page, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const armed = await page.evaluate(() => window.__gpxStudio?.animator?.isPlaybackArmed?.());
    if (armed) return { ok: true, ms: Date.now() - start };
    const err = await page.evaluate(() => {
      const a = window.__gpxStudio?.animator;
      return a?.getPrepareError?.() && !a?.isPreparingPlayback?.() ? a.getPrepareError() : null;
    });
    if (err) return { ok: false, err };
    await page.waitForTimeout(300);
  }
  return { ok: false, err: 'timeout' };
}

async function domModule(page) {
  return page.evaluate(() => ({
    props: document.querySelector('.module-props.active')?.dataset?.moduleProps,
    panel: document.querySelector('.module-panel.active')?.dataset?.modulePanel,
    railActive: document.querySelector('.module-btn.active')?.dataset?.module,
    storeTool: window.__gpxStudio?.getState?.().editor?.activeTool,
  }));
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
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__gpxStudio?.animator, { timeout: 20000 });

  // kernel exposed?
  const hasKernel = await page.evaluate(() => !!window.__gpxStudio?.kernel);
  if (!hasKernel) issue('medium', 'debug', '__gpxStudio.kernel is undefined (stale reference at init)');

  for (const mod of ['route', 'camera', 'track', 'terrain', 'layers', 'overlays', 'export']) {
    await page.click(`[data-module="${mod}"]`);
    await page.waitForTimeout(100);
    const d = await domModule(page);
    if (d.props !== mod) issue('high', 'modules', `Right props panel wrong for ${mod}`, d);
    if (d.panel !== mod) issue('high', 'modules', `Left panel wrong for ${mod}`, d);
    if (d.railActive !== mod) issue('high', 'modules', `Rail highlight wrong for ${mod}`, d);
    if (d.storeTool !== mod) issue('medium', 'modules', `Store activeTool not synced for ${mod}`, d);
  }

  // Rapid module switching
  for (let i = 0; i < 20; i++) {
    await page.click(`[data-module="${['route', 'camera', 'track'][i % 3]}"]`);
  }
  const afterRapid = await domModule(page);
  if (!afterRapid.props) issue('high', 'modules', 'Module UI broken after rapid switching', afterRapid);

  const arm = await loadGpx(page, 'route.gpx');
  if (!arm.ok) issue('critical', 'load', `route.gpx arm failed: ${arm.err}`);

  // Play
  await page.click('#btn-play');
  await page.waitForTimeout(1200);
  const playing = await page.evaluate(() => window.__gpxStudio.animator.isPlaying());
  if (!playing) issue('high', 'playback', 'Play failed on route.gpx');

  // Camera slider triggers reprepare storm?
  await page.click('[data-module="camera"]');
  for (let v = 40; v <= 60; v += 5) {
    await page.locator('#rig-pitch').fill(String(v));
    await page.locator('#rig-pitch').dispatchEvent('input');
    await page.waitForTimeout(100);
  }
  const armedAfterSlider = await page.evaluate(() => window.__gpxStudio.animator.isPlaybackArmed());
  if (!armedAfterSlider) issue('high', 'camera', 'Disarmed after rig slider changes (reprepare storm)');

  // Slider value reset by renderProjectState?
  await page.locator('#rig-pitch').fill('25');
  await page.locator('#rig-pitch').dispatchEvent('input');
  await page.waitForTimeout(200);
  const pitchVal = await page.locator('#rig-pitch').inputValue();
  const pitchStore = await page.evaluate(() => window.__gpxStudio.getState().document.project.camera.rig.pitchDeg);
  if (Math.abs(parseFloat(pitchVal) - pitchStore) > 2) {
    issue('medium', 'camera', 'Slider UI out of sync with store', { pitchVal, pitchStore });
  }

  // Keyframes
  await page.click('#btn-add-keyframe');
  await page.waitForTimeout(200);
  let kfCount = await page.evaluate(() => window.__gpxStudio.getState().document.project.timeline.keyframes.length);
  if (kfCount < 1) issue('high', 'keyframes', 'Keyframe not added');
  const markers = await page.locator('.keyframe-marker').count();
  if (markers < 1) issue('medium', 'keyframes', 'Keyframe marker not rendered on timeline');

  // Scrub while preparing
  await page.locator('#timeline').fill('300');
  await page.locator('#timeline').dispatchEvent('input');
  await page.locator('#timeline').fill('700');
  await page.locator('#timeline').dispatchEvent('change');
  const scrub = await waitArmed(page, 60000);
  if (!scrub.ok) issue('high', 'scrub', `Scrub re-arm failed: ${scrub.err}`);
  const playDisabled = await page.locator('#btn-play').isDisabled();
  const armed = await page.evaluate(() => window.__gpxStudio.animator.isPlaybackArmed());
  if (playDisabled && armed) issue('high', 'playback', 'Play button disabled while armed after scrub');

  // route-color vs track-color duplicate
  await page.click('[data-module="route"]');
  await page.locator('#route-color').fill('#00ff00');
  await page.locator('#route-color').dispatchEvent('input');
  await page.waitForTimeout(200);
  const routeColor = await page.evaluate(() => window.__gpxStudio.getState().document.project.track.color);
  if (routeColor !== '#00ff00') issue('medium', 'route', 'route-color does not update track.color', { routeColor });

  // Style switch
  await page.locator('[data-style="topo"]').click();
  await page.waitForTimeout(10000);
  if (!(await page.evaluate(() => window.__gpxStudio.animator.isPlaybackArmed()))) {
    issue('high', 'style', 'Not armed after topo style switch');
  }
  if (!(await page.evaluate(() => !!window.__gpxStudio.map.getLayer('route-full')))) {
    issue('critical', 'style', 'route layer missing after style switch');
  }

  // 2D/3D
  await page.locator('#map-mode-2d').click();
  await page.waitForTimeout(5000);
  if (!(await page.evaluate(() => window.__gpxStudio.animator.isPlaybackArmed()))) {
    issue('high', 'view', 'Not armed after 2D');
  }
  await page.locator('#map-mode-3d').click();
  await page.waitForTimeout(5000);

  // Multiple GPX
  for (const f of ['EnetikaGefyria.gpx', 'Artemis.gpx', 'DoxaoTheos.gpx']) {
    const r = await loadGpx(page, f);
    if (!r.ok) issue('high', 'load', `${f} arm failed`, { err: r.err });
    await page.locator('#timeline').fill('500');
    await page.locator('#timeline').dispatchEvent('change');
    const s = await waitArmed(page, 90000);
    if (!s.ok) issue('high', 'scrub', `${f} scrub re-arm failed`);
  }

  // Toolbar save enabled?
  const saveDisabled = await page.locator('#toolbar-save').isDisabled();
  if (saveDisabled) issue('medium', 'project', 'Save toolbar still disabled with route loaded');

  // Page errors
  for (const err of pageErrors) issue('critical', 'console', err);

  await browser.close();
  console.log(JSON.stringify({ total: issues.length, issues }, null, 2));
}

main();
