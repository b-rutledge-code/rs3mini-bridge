#!/usr/bin/env node
/**
 * Bench battery: 0x14 Track angles vs 0x62 replay vs 0x66 wire-as-track (all via HTTP).
 *
 *   BRIDGE_URL=http://10.0.0.183:8787 npm run calib:track-bench
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';
import { TRACK_REF, decode062Path, STAGE0G_062_PAYLOAD } from '../lib/gimbal-waypoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
const CENTER_MS = Number(process.env.TRACK_CENTER_MS ?? 4000);
const SETTLE_MS = Number(process.env.TRACK_SETTLE_MS ?? 3000);
const TIMEOUT_MS = Number(process.env.TRACK_BENCH_TIMEOUT_MS ?? 90000);

const TESTS = [
  {
    id: '014-stage0g-up',
    kind: '014',
    pitch: TRACK_REF.stage0gUp.pitch,
    yaw: TRACK_REF.stage0gUp.yaw,
    label: TRACK_REF.stage0gUp.label,
  },
  {
    id: '014-stage0g-down',
    kind: '014',
    pitch: TRACK_REF.stage0gDown.pitch,
    yaw: TRACK_REF.stage0gDown.yaw,
    label: TRACK_REF.stage0gDown.label,
  },
  {
    id: '014-markA-wire',
    kind: '014',
    pitch: 2305,
    yaw: -511,
    label: 'markA 0x66 wire as track pitch/yaw (expect fail)',
  },
  {
    id: '014-markB-wire',
    kind: '014',
    pitch: 257,
    yaw: 257,
    label: 'markB 0x66 wire as track pitch/yaw',
  },
  {
    id: '062-stage0g',
    kind: '062',
    mode: 'stage0g',
    label: 'stage0g captured path',
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${json.error ?? text}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function state() {
  const res = await fetch(`${BRIDGE}/state`);
  if (!res.ok) throw new Error(`GET /state → ${res.status}`);
  return res.json();
}

function fmt(s) {
  const t = s.telemetry ?? {};
  return `tilt=${t.tiltRaw} pan=${t.panRaw} src=${t.source}`;
}

function logRow(step, visual, st, notes) {
  const row = calibRowFromState(st, { step, visual, action: 'track-bench', notes });
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
}

async function center() {
  console.log('  → CTR');
  await api('POST', '/center');
  await sleep(CENTER_MS);
}

async function runTest(test) {
  console.log(`\n=== ${test.id}: ${test.label} ===`);
  await center();
  const before = await state();
  console.log(`  before: ${fmt(before)}`);

  if (test.kind === '014') {
    console.log(`  → POST /angle/recall pitch=${test.pitch} yaw=${test.yaw}`);
    await api('POST', '/angle/recall', { pitch: test.pitch, yaw: test.yaw, settleMs: SETTLE_MS });
  } else {
    const body =
      test.mode === 'stage0g'
        ? { mode: 'stage0g', followMs: Number(process.env.TRACK_FOLLOW_MS ?? 22000) }
        : { payloadHex: test.payloadHex };
    console.log(`  → POST /track/replay ${JSON.stringify(body)}`);
    await api('POST', '/track/replay', body);
    await sleep(1500);
    try {
      await api('POST', '/telemetry/refresh');
    } catch {
      /* optional */
    }
  }

  await sleep(800);
  const after = await state();
  console.log(`  after:  ${fmt(after)}`);
  logRow(test.id, test.label, after, `before ${fmt(before)}`);
  return { test: test.id, before, after };
}

async function main() {
  console.log(`Track bench @ ${BRIDGE}`);
  console.log(`stage0g decode: ${JSON.stringify(decode062Path(STAGE0G_062_PAYLOAD))}\n`);

  const health = await api('GET', '/health/label');
  if (String(health).includes('NO GIMB')) throw new Error('gimbal not connected');

  const results = [];
  for (const test of TESTS) {
    try {
      results.push(await runTest(test));
    } catch (err) {
      console.error(`  FAIL: ${err.message}`);
      results.push({ test: test.id, error: err.message });
    }
    await sleep(2000);
  }

  console.log('\n--- done — watch framing for stage0g up/down; wire-as-track expected wrong ---');
  for (const r of results) {
    if (r.error) console.log(`${r.test}: ERROR ${r.error}`);
    else console.log(`${r.test}: ${fmt(r.before)} → ${fmt(r.after)}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
