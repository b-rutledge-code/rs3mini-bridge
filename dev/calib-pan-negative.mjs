#!/usr/bin/env node
/**
 * Pan @8 range probe — sample wire during pan+ then pan− holds from CTR.
 * Does not assume monotonic pan; logs min/max and sign crossings.
 *
 *   BRIDGE_URL=http://10.0.0.183:8787 npm run calib:pan-negative
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
const CENTER_MS = Number(process.env.PAN_CENTER_MS ?? 4000);
const PAN_POS_MS = Number(process.env.PAN_POS_MS ?? 4000);
const PAN_NEG_MS = Number(process.env.PAN_NEG_MS ?? 8000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 400);
const TIMEOUT_MS = Number(process.env.PAN_PROBE_TIMEOUT_MS ?? 60000);

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function api(method, p, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BRIDGE}${p}`, {
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
    if (!res.ok) die(`${method} ${p} → ${res.status}: ${json.error ?? text}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getState() {
  const res = await fetch(`${BRIDGE}/state`);
  if (!res.ok) die(`GET /state → ${res.status}`);
  return res.json();
}

async function waitFor066(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState();
    if (state.telemetry?.source === '0x04/0x66' && !state.telemetry?.stale) return state;
    await sleep(400);
  }
  die('timeout waiting for 0x04/0x66');
}

function wire(state) {
  const t = state.telemetry ?? {};
  return { tilt: t.tiltRaw, pan: t.panRaw, raw: t.rawPayload };
}

function logRow(step, visual, state, notes) {
  const row = calibRowFromState(state, { step, visual, action: 'pan-negative-probe', notes });
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
}

function stats(samples) {
  const pans = samples.map((s) => s.pan).filter((n) => typeof n === 'number');
  const tilts = samples.map((s) => s.tilt).filter((n) => typeof n === 'number');
  const uniqPan = [...new Set(pans)];
  return {
    n: pans.length,
    panMin: pans.length ? Math.min(...pans) : null,
    panMax: pans.length ? Math.max(...pans) : null,
    tiltMin: tilts.length ? Math.min(...tilts) : null,
    tiltMax: tilts.length ? Math.max(...tilts) : null,
    uniqPan,
    sawNegative: pans.some((p) => p < 0),
    sawPositive: pans.some((p) => p > 0),
    sawZero: pans.some((p) => p === 0),
  };
}

async function sampleHold(label, pan, tilt, durationMs) {
  await api('POST', '/move/hold', { pan, tilt });
  const samples = [];
  const deadline = Date.now() + durationMs;
  let lastPulse = Date.now();
  while (Date.now() < deadline) {
    if (Date.now() - lastPulse >= 200) {
      await api('POST', '/move/hold', { pan, tilt });
      lastPulse = Date.now();
    }
    const state = await getState();
    const w = wire(state);
    samples.push({ phase: label, ...w });
    console.log(`  [${label}] pan=${w.pan} tilt=${w.tilt}`);
    await sleep(SAMPLE_MS);
  }
  await api('POST', '/move/stop');
  await sleep(600);
  return samples;
}

async function main() {
  console.log(`Pan @8 range probe @ ${BRIDGE}\n`);

  const health = await api('GET', '/health/label');
  if (String(health.label ?? health).includes('NO GIMB')) die('gimbal not connected');
  console.log(`health: ${health.label ?? health}`);

  try {
    await api('POST', '/move/stop');
  } catch {
    /* idle */
  }
  await sleep(300);

  console.log('→ POST /center');
  await api('POST', '/center');
  await sleep(CENTER_MS);
  let state = await waitFor066();
  const center = wire(state);
  console.log(`CTR wire: tilt=${center.tilt} pan=${center.pan}`);
  logRow('panRange-ctr', 'center', state, 'baseline');

  console.log(`\n→ hold pan+ ${PAN_POS_MS}ms`);
  const posSamples = await sampleHold('pan+', 1, 0, PAN_POS_MS);
  state = await waitFor066(15000);
  const afterPos = wire(state);
  console.log(`  settled: tilt=${afterPos.tilt} pan=${afterPos.pan}`);
  logRow('panRange-after+', 'after pan+', state, JSON.stringify(stats(posSamples)));

  console.log(`\n→ hold pan− ${PAN_NEG_MS}ms (watch: return toward CTR pan=${center.pan}?)`);
  const negSamples = await sampleHold('pan−', -1, 0, PAN_NEG_MS);
  state = await waitFor066(15000);
  const afterNeg = wire(state);
  console.log(`  settled: tilt=${afterNeg.tilt} pan=${afterNeg.pan}`);
  logRow('panRange-after−', 'after pan−', state, JSON.stringify(stats(negSamples)));

  const pos = stats(posSamples);
  const neg = stats(negSamples);
  const all = stats([...posSamples, ...negSamples]);

  console.log('\n--- summary ---');
  console.log(`CTR pan=${center.pan}  after+ pan=${afterPos.pan}  after− pan=${afterNeg.pan}`);
  console.log(`pan+ hold: min=${pos.panMin} max=${pos.panMax} uniq=[${pos.uniqPan.join(', ')}]`);
  console.log(`pan− hold: min=${neg.panMin} max=${neg.panMax} uniq=[${neg.uniqPan.join(', ')}]`);
  console.log(`combined: negative=${all.sawNegative} positive=${all.sawPositive}`);

  const backToCtr =
    center.pan != null &&
    afterNeg.pan != null &&
    Math.abs(afterNeg.pan - center.pan) <= 128;
  console.log(`returned near CTR pan (±128): ${backToCtr ? 'YES' : 'NO'} (delta=${afterNeg.pan - center.pan})`);

  const verdict = backToCtr
    ? 'CTR pan recoverable via pan− after pan+'
    : all.sawNegative && all.sawPositive
      ? 'pan @8 spans ± but does not settle back to CTR — recall unreliable'
      : 'pan @8 range limited — investigate decode or use 0x62 Track';

  console.log(`\n${verdict}`);
  logRow('panRange-verdict', verdict, state, JSON.stringify({ center, afterPos, afterNeg, pos, neg, backToCtr }));

  if (!backToCtr) process.exit(2);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
