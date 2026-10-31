#!/usr/bin/env node
/**
 * Phase A — axis direction proof via bridge HTTP (no second BLE).
 * CTR before each nudge. Prints wire after each step.
 *
 *   BRIDGE_URL=http://10.0.0.183:8787 npm run calib:phase-a
 */

const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const NUDGE_MS = Number(process.env.PHASE_A_MS ?? 1500);
const CENTER_MS = Number(process.env.PHASE_A_CENTER_MS ?? 3000);
const TIMEOUT_MS = Number(process.env.PHASE_A_TIMEOUT_MS ?? 45000);

const STEPS = [
  { label: 'tilt+', pan: 0, tilt: 1 },
  { label: 'tilt−', pan: 0, tilt: -1 },
  { label: 'pan+', pan: 1, tilt: 0 },
  { label: 'pan−', pan: -1, tilt: 0 },
];

async function api(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BRIDGE}${path}`, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error ?? text}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function wire() {
  const state = await api('GET', '/state');
  const t = state.telemetry ?? {};
  return {
    source: t.source,
    tilt: t.tiltRaw,
    pan: t.panRaw,
  };
}

async function nudgeStep(i, { label, pan, tilt }) {
  console.log(`\n=== ${i + 1}/4 ${label} — watch the camera ===`);
  try {
    await api('POST', '/move/stop');
  } catch {
    /* idle */
  }
  await sleep(400);
  console.log('→ center');
  await api('POST', '/center');
  await sleep(CENTER_MS);
  const before = await wire();
  console.log(`  wire before: ${before.source} tilt=${before.tilt} pan=${before.pan}`);
  console.log(`→ nudge pan=${pan} tilt=${tilt} for ${NUDGE_MS}ms`);
  const start = await api('POST', '/move/hold', { pan, tilt });
  console.log(`  axis: ${start.axis}`);
  const end = Date.now() + NUDGE_MS;
  while (Date.now() < end) {
    await sleep(Math.min(200, end - Date.now()));
    if (Date.now() >= end) break;
    await api('POST', '/move/hold', { pan, tilt });
  }
  await api('POST', '/move/stop');
  await sleep(800);
  const after = await wire();
  console.log(`  wire after:  ${after.source} tilt=${after.tilt} pan=${after.pan}`);
  return { label, before, after };
}

async function main() {
  console.log(`Phase A @ ${BRIDGE}\n`);
  const results = [];
  for (let i = 0; i < STEPS.length; i += 1) {
    results.push(await nudgeStep(i, STEPS[i]));
  }
  console.log('\n--- summary ---');
  for (const r of results) {
    console.log(
      `${r.label}: tilt ${r.before.tilt} → ${r.after.tilt}  pan ${r.before.pan} → ${r.after.pan}`,
    );
  }
  console.log('\nAnswer yes/no for each: did the camera move the right way?');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
