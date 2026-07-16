/**
 * GPX parser validation suite — runs parseGPX() on every file in test/.
 * Does not modify parser or playback logic.
 *
 * Usage: node scripts/validate-gpx-suite.mjs
 */

import { readFile, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { DOMParser } from 'linkedom';

// Browser API shim — parser unchanged; only this test harness needs it in Node.
globalThis.DOMParser = DOMParser;

const { parseGPX, buildSegments, formatDistance } = await import('../src/gpx.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = join(ROOT, 'test');

function analyzePoints(points) {
  const withTime = points.filter((p) => p.time != null).length;
  const withEle = points.filter((p) => p.ele != null && Number.isFinite(p.ele)).length;
  const hasTime =
    withTime > 0 &&
    points[0]?.time != null &&
    points[points.length - 1]?.time != null &&
    points[points.length - 1].time > points[0].time;
  const hasElevation = withEle > 0;
  const { totalDistance } = buildSegments(points);

  return {
    pointCount: points.length,
    withTime,
    withEle,
    hasTime,
    hasElevation,
    totalDistanceM: totalDistance,
    totalDistance: formatDistance(totalDistance),
  };
}

async function validateFile(filePath) {
  const file = basename(filePath);
  try {
    const text = await readFile(filePath, 'utf8');
    if (!text.trim()) {
      return { file, status: 'FAIL', error: 'Empty file' };
    }

    const parsed = parseGPX(text);
    const stats = analyzePoints(parsed.points);

    return {
      file,
      status: 'PASS',
      name: parsed.name,
      ...stats,
    };
  } catch (err) {
    return {
      file,
      status: 'FAIL',
      error: err?.message || String(err),
    };
  }
}

function pad(str, len) {
  const s = String(str ?? '—');
  return s.length >= len ? s.slice(0, len - 1) + '…' : s.padEnd(len);
}

function printRow(cols, widths) {
  console.log(cols.map((c, i) => pad(c, widths[i])).join('  '));
}

async function main() {
  const entries = await readdir(TEST_DIR);
  const gpxFiles = entries.filter((f) => f.toLowerCase().endsWith('.gpx')).sort();

  if (!gpxFiles.length) {
    console.error(`No GPX files found in ${TEST_DIR}`);
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  GPX Parser Validation Suite');
  console.log(`  Directory: ${TEST_DIR}`);
  console.log(`  Files: ${gpxFiles.length}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  const widths = [28, 6, 8, 36, 12, 8, 8, 8];
  const headers = ['File', 'Status', 'Points', 'Route name', 'Distance', 'Time?', 'Ele?', 'Time pts'];
  printRow(headers, widths);
  printRow(headers.map(() => '—'.repeat(20)), widths);

  const results = [];
  for (const file of gpxFiles) {
    const result = await validateFile(join(TEST_DIR, file));
    results.push(result);

    if (result.status === 'PASS') {
      printRow([
        result.file,
        result.status,
        result.pointCount,
        result.name,
        result.totalDistance,
        result.hasTime ? 'yes' : 'no',
        result.hasElevation ? 'yes' : 'no',
        result.withTime,
      ], widths);
    } else {
      printRow([
        result.file,
        result.status,
        '—',
        result.error,
        '—',
        '—',
        '—',
        '—',
      ], widths);
    }
  }

  const passed = results.filter((r) => r.status === 'PASS');
  const failed = results.filter((r) => r.status === 'FAIL');
  const withTime = passed.filter((r) => r.hasTime);
  const withoutTime = passed.filter((r) => !r.hasTime);
  const withEle = passed.filter((r) => r.hasElevation);
  const withoutEle = passed.filter((r) => !r.hasElevation);

  const points = passed.map((r) => r.pointCount);
  const minPts = points.length ? Math.min(...points) : 0;
  const maxPts = points.length ? Math.max(...points) : 0;
  const avgPts = points.length
    ? Math.round(points.reduce((a, b) => a + b, 0) / points.length)
    : 0;

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Total files:     ${results.length}`);
  console.log(`  PASS:            ${passed.length}`);
  console.log(`  FAIL:            ${failed.length}`);
  console.log(`  With timestamps: ${withTime.length}`);
  console.log(`  Without time:    ${withoutTime.length}`);
  console.log(`  With elevation:  ${withEle.length}`);
  console.log(`  Without ele:     ${withoutEle.length}`);
  if (passed.length) {
    console.log(`  Points (min/avg/max): ${minPts} / ${avgPts} / ${maxPts}`);
  }

  if (failed.length) {
    console.log('\n  Failures:');
    failed.forEach((r) => console.log(`    • ${r.file}: ${r.error}`));
  }

  console.log('\n═══════════════════════════════════════════════════════════════\n');

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
