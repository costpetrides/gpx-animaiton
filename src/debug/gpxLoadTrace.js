const STEPS = [
  'open-click',
  'input-change',
  'file-selected',
  'read-start',
  'read-done',
  'parse-start',
  'parse-done',
  'store-dispatch',
  'animator-load-start',
  'animator-load-done',
  'auto-fetch-start',
  'auto-fetch-done',
  'drop-received',
  'error',
];

export function createGpxLoadTrace({ enabled = false } = {}) {
  if (!enabled) {
    return {
      step() {},
      getSteps() {
        return [];
      },
      flush() {},
    };
  }

  const steps = [];

  function step(name, detail = {}) {
    if (!STEPS.includes(name)) return;
    const entry = { name, detail, ts: performance.now() };
    steps.push(entry);
    console.log(`[gpx-load] ${name}`, detail);
    const status = document.getElementById('status-message');
    if (status) status.textContent = `GPX: ${name}`;
  }

  function flush(label = 'complete') {
    console.log(`[gpx-load] flush:${label}`, steps);
  }

  return { step, getSteps: () => [...steps], flush };
}

export async function fetchAutoGpx(filename) {
  const name = filename.split('/').pop() || 'route.gpx';
  const candidates = filename.startsWith('/')
    ? [filename]
    : [`/test/${filename}`, `/public/${filename}`, `/${filename}`];

  let lastError = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastError = new Error(`Failed to fetch GPX (${res.status}): ${url}`);
        continue;
      }
      const text = await res.text();
      if (!text.includes('<gpx') && !text.includes('<trkpt')) {
        lastError = new Error(`Response is not GPX XML: ${url}`);
        continue;
      }
      return { text, name, url };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error(`Failed to fetch GPX: ${filename}`);
}
