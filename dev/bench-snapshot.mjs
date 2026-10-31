#!/usr/bin/env node
/** Quick snapshot: optional CTR, then append calibration row. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';

const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const LOG = process.env.CALIB_LOG ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'calibration-poses.jsonl');
const STEP = process.argv[2] ?? process.env.CALIB_STEP ?? 'snap';
const LABEL = process.argv[3] ?? process.env.CALIB_LABEL ?? '';
const DO_CTR = process.env.BENCH_CTR === '1' || process.argv.includes('--ctr');

async function api(method, p, body) {
  const res = await fetch(`${BRIDGE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.status);
  return json;
}

async function wait066(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await (await fetch(`${BRIDGE}/state`)).json();
    if (s.telemetry?.source === '0x04/0x66' && !s.telemetry?.stale) return s;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('no 0x66 — CTR again or power-cycle gimbal');
}

if (DO_CTR) {
  await api('POST', '/center');
  await new Promise((r) => setTimeout(r, 4000));
}
let state = await wait066();
if (DO_CTR) state = await wait066();

const row = calibRowFromState(state, {
  step: STEP,
  visual: LABEL || STEP,
  action: 'bench-snapshot',
  notes: process.env.CALIB_NOTES,
});
fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
const t = state.telemetry;
console.log(`${STEP}: tilt=${t.tiltRaw} pan=${t.panRaw}`);
console.log(`rawHex: ${t.rawPayload}`);
console.log(`→ ${LOG}`);
