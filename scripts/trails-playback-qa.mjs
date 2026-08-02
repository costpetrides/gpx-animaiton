/**
 * Full Trails library playback QA.
 * Usage: node scripts/trails-playback-qa.mjs
 */
import { chromium } from 'playwright';
import { readFile, writeFile, readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TRAILS_ROOT = path.resolve(ROOT, '../Trails/Trails');
const BASE = 'http://127.0.0.1:5173/?gpxDebug=1';
const REPORT_PATH = path.join(ROOT, 'qa-trails-playback-report.json');
const ARM_TIMEOUT_MS = 28000;
const PLAY_MS = 1600;

async function listTrails() {
  const dirs = await readdir(TRAILS_ROOT, { withFileTypes: true });
  const rows = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const gpxPath = path.join(TRAILS_ROOT, d.name, 'trail.gpx');
    try {
      const text = await readFile(gpxPath, 'utf8');
      rows.push({ name: d.name, path: gpxPath, bytes: Buffer.byteLength(text), text });
    } catch {
      rows.push({ name: d.name, path: gpxPath, missing: true });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function waitArmed(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await page.evaluate(() => {
      const a = window.__gpxStudio?.animator;
      if (!a) return { ready: false };
      return {
        ready: true,
        armed: Boolean(a.isPlaybackArmed?.()),
        preparing: Boolean(a.isPreparingPlayback?.()),
        err: a.getPrepareError?.() || null,
        degraded: Boolean(a.isPlaybackDegraded?.()),
      };
    });
    if (s.ready && s.armed && !s.preparing) {
      return { ok: true, ms: Date.now() - start, degraded: s.degraded };
    }
    if (s.ready && s.err && !s.preparing && !s.armed) {
      return { ok: false, err: String(s.err), ms: Date.now() - start };
    }
    await page.waitForTimeout(250);
  }
  const last = await page.evaluate(() => {
    const a = window.__gpxStudio.animator;
    return {
      armed: Boolean(a.isPlaybackArmed?.()),
      preparing: Boolean(a.isPreparingPlayback?.()),
      err: a.getPrepareError?.() || null,
      degraded: Boolean(a.isPlaybackDegraded?.()),
    };
  });
  return {
    ok: Boolean(last.armed),
    timeout: !last.armed,
    ms: Date.now() - start,
    preparing: last.preparing,
    err: last.err,
    degraded: last.degraded,
  };
}

function classifyIssues(row, result) {
  const issues = [];
  const push = (severity, code, detail) => issues.push({ severity, code, detail });

  if (row.missing) {
    push('high', 'missing_gpx', 'trail.gpx not found');
    return issues;
  }
  if (result.pageError) {
    push('critical', 'page_error', result.pageError);
  }
  if (result.loadError) {
    push('critical', 'load_error', result.loadError);
  }
  if (result.arm?.timeout) {
    push('critical', 'prepare_timeout', `Not armed after ${result.arm.ms}ms`);
  } else if (result.arm && !result.arm.ok) {
    push('critical', 'prepare_failed', result.arm.err || 'arm failed');
  }
  if (result.arm?.degraded) {
    push('medium', 'prepare_degraded', 'Preview armed with simplified/recovered terrain');
  }
  if (result.duration != null) {
    if (result.duration < 40) {
      push('high', 'film_too_short', `${result.duration.toFixed(1)}s film length`);
    } else if (result.duration > 300) {
      push('low', 'film_very_long', `${result.duration.toFixed(1)}s film length`);
    }
  }
  if (result.distanceM != null && result.distanceM < 50) {
    push('medium', 'tiny_route', `${result.distanceM.toFixed(0)}m route`);
  }
  if (result.scrub) {
    const expected = (result.distanceM || 0) * 0.5;
    if (expected > 20 && Math.abs(result.scrub.dist - expected) > expected * 0.12) {
      push(
        'critical',
        'scrub_inaccurate',
        `mid scrub → ${result.scrub.dist?.toFixed?.(0)}m (expected ~${expected.toFixed(0)}m)`,
      );
    }
    if (result.scrub.preparing) {
      push('high', 'scrub_reprepare', 'Scrub triggered prepare pipeline');
    }
    if (result.scrub.armed === false) {
      push('critical', 'scrub_disarmed', 'Playback disarmed after scrub');
    }
  }
  if (result.play) {
    if (!result.play.playing && result.arm?.ok) {
      push('critical', 'play_failed', 'Play did not start');
    }
    if (result.play.playing && result.play.animTime < 0.35) {
      push(
        'high',
        'play_stalled',
        `Only ${result.play.animTime?.toFixed?.(3)}s advanced in ${PLAY_MS}ms wall time`,
      );
    }
    if (result.play.armed === false) {
      push('critical', 'play_disarmed', 'Disarmed during play');
    }
    if (Number.isFinite(result.play.pitch) && result.play.pitch < 20) {
      push('medium', 'flat_camera', `Pitch ${result.play.pitch.toFixed(1)}° during play`);
    }
  }
  if (result.reset) {
    if (result.reset.dist > 5) {
      push('high', 'reset_not_start', `Restart left at ${result.reset.dist.toFixed(0)}m`);
    }
    if (result.reset.preparing) {
      push('critical', 'reset_reprepare', 'Restart triggered prepare');
    }
    if (result.reset.armed === false) {
      push('critical', 'reset_disarmed', 'Disarmed after restart');
    }
  }
  return issues;
}

async function testOne(page, row) {
  const result = {
    name: row.name,
    bytes: row.bytes,
    issues: [],
  };
  if (row.missing) {
    result.issues = classifyIssues(row, result);
    return result;
  }

  const pageErrors = [];
  const onErr = (e) => pageErrors.push(String(e));
  page.on('pageerror', onErr);

  try {
    await page.evaluate(() => {
      window.__gpxStudio.dispatch({
        type: 'project/set-prepare-quality',
        payload: { prepareQuality: 'fast' },
      });
    });

    const load = await page.evaluate(async ({ text, name }) => {
      try {
        window.__gpxStudio.loadGpxText(text, `${name}.gpx`);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    }, { text: row.text, name: row.name });

    if (!load.ok) {
      result.loadError = load.error;
      result.pageError = pageErrors[0] || null;
      result.issues = classifyIssues(row, result);
      return result;
    }

    result.arm = await waitArmed(page, ARM_TIMEOUT_MS);
    const meta = await page.evaluate(() => {
      const a = window.__gpxStudio.animator;
      const route = a.getRoute?.();
      return {
        duration: a.getDuration?.(),
        distanceM: route?.totalDistance ?? null,
        pointCount: route?.raw?.length ?? null,
        hasTime: Boolean(route?.hasTime),
        status: document.getElementById('status-message')?.textContent || '',
        playDisabled: Boolean(document.getElementById('btn-play')?.disabled),
      };
    });
    Object.assign(result, meta);

    if (result.arm.ok) {
      // Scrub to midpoint
      await page.evaluate(() => {
        const tl = document.getElementById('timeline');
        tl.value = '500';
        tl.dispatchEvent(new Event('input', { bubbles: true }));
        tl.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(200);
      result.scrub = await page.evaluate(() => {
        const a = window.__gpxStudio.animator;
        const ps = a.getPlaybackState();
        return {
          dist: ps.animDistance,
          animTime: ps.animTime,
          uiTime: document.getElementById('time-current')?.textContent,
          armed: a.isPlaybackArmed?.(),
          preparing: a.isPreparingPlayback?.(),
        };
      });

      // Reset + play
      await page.evaluate(() => window.__gpxStudio.animator.reset());
      await page.waitForTimeout(150);
      result.reset = await page.evaluate(() => {
        const a = window.__gpxStudio.animator;
        const ps = a.getPlaybackState();
        return {
          dist: ps.animDistance,
          armed: a.isPlaybackArmed?.(),
          preparing: a.isPreparingPlayback?.(),
        };
      });

      await page.evaluate(() => window.__gpxStudio.animator.play());
      await page.waitForTimeout(PLAY_MS);
      result.play = await page.evaluate(() => {
        const a = window.__gpxStudio.animator;
        const map = window.__gpxStudio.map;
        const ps = a.getPlaybackState();
        return {
          playing: a.isPlaying(),
          animTime: ps.animTime,
          dist: ps.animDistance,
          armed: a.isPlaybackArmed?.(),
          preparing: a.isPreparingPlayback?.(),
          pitch: map.getPitch?.(),
          bearing: map.getBearing?.(),
          zoom: map.getZoom?.(),
        };
      });
      await page.evaluate(() => {
        try { window.__gpxStudio.animator.pause(); } catch {}
      });
    }
  } catch (e) {
    result.loadError = String(e?.message || e);
  } finally {
    page.off('pageerror', onErr);
  }

  if (pageErrors.length) result.pageError = pageErrors[0];
  result.issues = classifyIssues(row, result);
  return result;
}

async function main() {
  const trails = await listTrails();
  console.log(`Trails library: ${trails.length} packages`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__gpxStudio?.animator && window.__gpxStudio?.dispatch, {
    timeout: 60000,
  });

  const results = [];
  let i = 0;
  for (const row of trails) {
    i += 1;
    process.stdout.write(`→ [${i}/${trails.length}] ${row.name}\n`);
    const r = await testOne(page, row);
    results.push(r);
    const crit = r.issues.filter((x) => x.severity === 'critical').length;
    const high = r.issues.filter((x) => x.severity === 'high').length;
    if (r.issues.length) {
      process.stdout.write(
        `  ✗ ${r.issues.length} issue(s) (critical=${crit}, high=${high}): ${r.issues.map((x) => x.code).join(', ')}\n`,
      );
    } else {
      process.stdout.write(`  ✓ ok (arm ${r.arm?.ms ?? '?'}ms, film ${r.duration?.toFixed?.(0) ?? '?'}s)\n`);
    }
  }

  await browser.close();

  const allIssues = [];
  for (const r of results) {
    for (const issue of r.issues) {
      allIssues.push({ trail: r.name, ...issue });
    }
  }

  const byCode = {};
  for (const issue of allIssues) {
    byCode[issue.code] = byCode[issue.code] || { count: 0, severity: issue.severity, examples: [] };
    byCode[issue.code].count += 1;
    if (byCode[issue.code].examples.length < 8) {
      byCode[issue.code].examples.push(issue.trail);
    }
  }

  const summary = {
    testedAt: new Date().toISOString(),
    trailsRoot: TRAILS_ROOT,
    totalTrails: trails.length,
    tested: results.length,
    passed: results.filter((r) => r.issues.length === 0).length,
    failed: results.filter((r) => r.issues.length > 0).length,
    issueCount: allIssues.length,
    bySeverity: {
      critical: allIssues.filter((i) => i.severity === 'critical').length,
      high: allIssues.filter((i) => i.severity === 'high').length,
      medium: allIssues.filter((i) => i.severity === 'medium').length,
      low: allIssues.filter((i) => i.severity === 'low').length,
    },
    byCode,
    results,
  };

  await writeFile(REPORT_PATH, JSON.stringify(summary, null, 2));
  console.log(`\nReport: ${REPORT_PATH}`);
  console.log(
    `Passed ${summary.passed}/${summary.tested}; issues=${summary.issueCount} (critical=${summary.bySeverity.critical}, high=${summary.bySeverity.high})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
