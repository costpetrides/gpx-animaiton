// QA harness — run in browser console with ?gpxDebug=1
// Usage: paste or inject via CDP Runtime.evaluate
window.runGpxQaSuite = async function runGpxQaSuite(files, options = {}) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = (ms) => Date.now() + ms;
  const app = window.__gpxStudio;
  if (!app) throw new Error('__gpxStudio not available — add ?gpxDebug=1');

  const results = [];

  async function waitArmed(maxMs = 120000) {
    const end = deadline(maxMs);
    while (Date.now() < end) {
      if (app.animator.isPlaybackArmed()) {
        return { armed: true, ms: maxMs - (end - Date.now()), degraded: app.animator.isPlaybackDegraded?.() };
      }
      if (app.animator.getPrepareError() && !app.animator.isPreparingPlayback()) {
        return { armed: false, error: app.animator.getPrepareError() };
      }
      await wait(250);
    }
    return { armed: false, error: 'arm-timeout', preparing: app.animator.isPreparingPlayback() };
  }

  async function loadFile(name) {
    const url = `/test/${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch failed ${res.status}`);
    const text = await res.text();
    app.animator.pause?.();
    app.loadGpxText(text, name);
    return waitArmed(options.armTimeoutMs || 120000);
  }

  async function exerciseWorkflow(name) {
    const row = { file: name, steps: {}, issues: [] };
    const t0 = performance.now();

    try {
      row.steps.load = await loadFile(name);
      if (!row.steps.load.armed) {
        row.issues.push({ severity: 'critical', step: 'arm', msg: row.steps.load.error || 'not armed' });
        return row;
      }

      const a = app.animator;
      const status = () => document.querySelector('#status-text')?.textContent || '';
      row.steps.statusAfterArm = status();

      a.play();
      await wait(1500);
      row.steps.play = { playing: a.isPlaying(), dist: a.getPlaybackState().animDistance };
      if (!row.steps.play.playing) row.issues.push({ severity: 'high', step: 'play', msg: 'not playing after play()' });
      if (row.steps.play.dist <= 0) row.issues.push({ severity: 'medium', step: 'play', msg: 'distance did not advance' });

      a.pause();
      await wait(300);
      row.steps.pause = { playing: a.isPlaying() };
      if (row.steps.pause.playing) row.issues.push({ severity: 'high', step: 'pause', msg: 'still playing after pause' });

      a.play();
      await wait(800);
      row.steps.resume = { playing: a.isPlaying(), dist: a.getPlaybackState().animDistance };

      const tl = document.getElementById('timeline');
      for (const v of [200, 500, 800, 300]) {
        tl.value = String(v);
        tl.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(150);
      }
      tl.value = '500';
      tl.dispatchEvent(new Event('change', { bubbles: true }));
      const scrubArm = await waitArmed(options.scrubArmTimeoutMs || 60000);
      row.steps.scrub = {
        ...scrubArm,
        dist: a.getPlaybackState().animDistance,
        playDisabled: document.getElementById('btn-play')?.disabled,
      };
      if (!row.steps.scrub.armed) row.issues.push({ severity: 'high', step: 'scrub', msg: 'disarmed after scrub commit' });
      if (row.steps.scrub.playDisabled && row.steps.scrub.armed) {
        row.issues.push({ severity: 'high', step: 'scrub', msg: 'play button disabled after scrub while armed' });
      }

      a.play();
      await wait(2000);
      const afterScrubPlay = a.getPlaybackState();
      row.steps.playAfterScrub = {
        playing: a.isPlaying(),
        dist: afterScrubPlay.animDistance,
        time: afterScrubPlay.animTime,
      };
      if (row.steps.playAfterScrub.playing && row.steps.playAfterScrub.dist < 5 && row.steps.playAfterScrub.time < 0.5) {
        row.issues.push({ severity: 'critical', step: 'playback-freeze', msg: 'playback frozen after scrub' });
      }
      a.pause();

      a.reset();
      await wait(2500);
      row.steps.reset = { dist: a.getPlaybackState().animDistance, armed: a.isPlaybackArmed() };
      if (row.steps.reset.dist > 50) row.issues.push({ severity: 'medium', step: 'reset', msg: `dist not near 0: ${row.steps.reset.dist}` });

      const styles = ['outdoor', 'positron', 'dark'];
      for (const s of styles) {
        const chip = [...document.querySelectorAll('#style-picker .chip')].find((c) => c.dataset.style === s);
        chip?.click();
        await wait(6000);
        if (!a.isPlaybackArmed()) await waitArmed(60000);
      }
      row.steps.styleSwitch = {
        armed: a.isPlaybackArmed(),
        routeLayer: !!app.map.getLayer('route-full'),
        style: app.getState().document.project.map.styleKey,
      };
      if (!row.steps.styleSwitch.routeLayer) row.issues.push({ severity: 'critical', step: 'style', msg: 'route layer missing after style switches' });
      if (!row.steps.styleSwitch.armed) row.issues.push({ severity: 'high', step: 'style', msg: 'not armed after style switches' });

      for (const mode of ['2d', '3d', '2d', '3d']) {
        app.setMapViewMode(mode);
        await wait(4000);
        if (!a.isPlaybackArmed()) await waitArmed(60000);
      }
      row.steps.viewMode = { armed: a.isPlaybackArmed(), mode3d: document.getElementById('map-mode-3d')?.classList.contains('active') };

      a.play();
      await wait(3000);
      row.steps.playAfterToggles = { playing: a.isPlaying(), dist: a.getPlaybackState().animDistance };

      if (row.steps.playAfterToggles.playing && row.steps.playAfterToggles.dist < 10) {
        row.issues.push({ severity: 'high', step: 'playback-freeze', msg: 'playback did not advance after view toggles' });
      }

      a.pause();
      row.durationMs = Math.round(performance.now() - t0);
      row.route = app.getState().document.project.route;
      row.routeNameField = document.getElementById('route-name')?.value;
      row.fps = document.getElementById('status-fps')?.textContent;
    } catch (err) {
      row.issues.push({ severity: 'critical', step: 'exception', msg: err?.message || String(err) });
    }
    return row;
  }

  for (const file of files) {
    results.push(await exerciseWorkflow(file));
  }
  return results;
};
