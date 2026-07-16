import { chromium } from 'playwright';
import { readFile } from 'fs/promises';
import path from 'path';

const issues = [];
const push = (s, a, m, e) => issues.push({ severity: s, area: a, msg: m, ...e });

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/?gpxDebug=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gpxStudio?.animator);

  const load = async (f) => {
    const text = await readFile(path.join('./test', f), 'utf8');
    await page.evaluate(({ text, f }) => window.__gpxStudio.loadGpxText(text, f), { text, f });
    for (let i = 0; i < 200; i++) {
      if (await page.evaluate(() => window.__gpxStudio.animator.isPlaybackArmed())) return true;
      await page.waitForTimeout(300);
    }
    return false;
  };

  await load('route.gpx');

  // Keyframes don't affect playback
  await page.click('[data-module="camera"]');
  await page.locator('#rig-pitch').fill('70');
  await page.locator('#rig-pitch').dispatchEvent('input');
  await page.click('#btn-add-keyframe');
  await page.locator('#timeline').fill('800');
  await page.locator('#timeline').dispatchEvent('change');
  for (let i = 0; i < 200; i++) {
    if (await page.evaluate(() => window.__gpxStudio.animator.isPlaybackArmed())) break;
    await page.waitForTimeout(300);
  }
  await page.locator('#rig-pitch').fill('10');
  await page.locator('#rig-pitch').dispatchEvent('input');
  await page.click('#btn-add-keyframe');
  const kfInTimeline = await page.evaluate(() => window.__gpxStudio.getState().document.project.timeline.keyframes.length);
  const kfInCamera = await page.evaluate(() => window.__gpxStudio.getState().document.project.camera.keyframes?.length ?? 0);
  if (kfInTimeline >= 2 && kfInCamera === 0) {
    push('critical', 'keyframes', 'Keyframes stored in timeline but camera resolver reads camera.keyframes — interpolation never runs');
  }

  // Interpolation test at midpoint
  await page.locator('#timeline').fill('500');
  await page.locator('#timeline').dispatchEvent('input');
  const midPitch = await page.evaluate(() => {
    const { resolveCameraShotFromDocument } = window;
    return null;
  });
  const pitchAtMid = await page.evaluate(() => {
    const doc = window.__gpxStudio.getState().document.project;
    const animTime = window.__gpxStudio.animator.getPlaybackState().animTime;
    const duration = doc.route.stats.hasTime ? doc.route.stats.duration : doc.route.stats.totalDistance / 15;
    // replicate bug: uses camera.keyframes (empty)
    const kf = doc.camera.keyframes || [];
    const kfTimeline = doc.timeline.keyframes || [];
    return { animTime, kfCamera: kf.length, kfTimeline: kfTimeline.length };
  });
  if (pitchAtMid.kfTimeline >= 2 && pitchAtMid.kfCamera === 0) {
    push('critical', 'keyframes', 'Keyframe interpolation broken at playback time', pitchAtMid);
  }

  // Terrain checkbox doesn't disable map terrain
  await page.click('[data-module="terrain"]');
  await page.uncheck('#terrain-enabled');
  await page.waitForTimeout(1000);
  const terrainOnMap = await page.evaluate(() => {
    try { return !!window.__gpxStudio.map.getTerrain(); } catch { return null; }
  });
  if (terrainOnMap) push('high', 'terrain', 'Unchecking terrain does not disable map terrain');

  // Layer toggles for elevation/speed do nothing on map
  await page.click('[data-module="layers"]');
  await page.locator('[data-layer="elevation"]').uncheck();
  const eleLayerExists = await page.evaluate(() => !!window.__gpxStudio.map.getLayer('elevation'));
  if (!eleLayerExists) {
    push('low', 'layers', 'Elevation layer toggle has no map layer (expected stub)');
  }

  // New project doesn't reset UI modules
  await page.locator('[data-action="new-project"]').click();
  await page.waitForTimeout(500);
  const routeAfterNew = await page.evaluate(() => window.__gpxStudio.getState().document.project.route);
  const emptyVisible = await page.evaluate(() => !document.getElementById('viewport-empty')?.classList.contains('hidden'));
  if (routeAfterNew) push('high', 'project', 'New project did not clear route');
  if (!emptyVisible) push('medium', 'project', 'Empty state not shown after new project');

  // Reload and test export doesn't throw immediately
  await load('route.gpx');
  await page.click('[data-module="export"]');
  let exportError = null;
  page.once('pageerror', (e) => { exportError = e.message; });
  await page.click('#btn-export-video');
  await page.waitForTimeout(3000);
  const status = await page.textContent('#status-message');
  if (exportError) push('high', 'export', `Export threw: ${exportError}`);
  if (status?.includes('failed')) push('medium', 'export', `Export status: ${status}`);

  // HUD data panel unreachable
  const dataPanel = await page.$('[data-module-props="data"]');
  if (dataPanel && !(await dataPanel.evaluate((el) => el.classList.contains('active')))) {
    const dataModuleBtn = await page.$('[data-module="data"]');
    if (!dataModuleBtn) push('medium', 'ui', 'Live HUD stats panel exists but no module rail button to access it');
  }

  // route-color vs track-color desync
  await page.click('[data-module="route"]');
  await page.locator('#route-color').fill('#123456');
  await page.locator('#route-color').dispatchEvent('input');
  await page.click('[data-module="track"]');
  const trackColorUi = await page.locator('#track-color').inputValue();
  if (trackColorUi !== '#123456') push('medium', 'track', 'route-color and track-color UIs not synced', { trackColorUi });

  await browser.close();
  console.log(JSON.stringify({ total: issues.length, issues }, null, 2));
}

main();
