#!/usr/bin/env node
/**
 * Phase E — axis isolation: single-axis holds, log @2/@8 ladder + coupling.
 *   BRIDGE_URL=... npm run calib:isolate
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';
import { is066State, rungIndex, wireRung } from '../lib/calib-loop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
const PULSES = Number(process.env.ISOLATE_PULSES ?? 8);
const NUDGE_MS = Number(process.env.ISOLATE_MS ?? 1200);
const SETTLE_MS = Number(process.env.ISOLATE_SETTLE_MS ?? 700);
const CENTER_MS = Number(process.env.ISOLATE_CENTER_MS ?? 4000);

const AXES = [
  { step: 'iso-pan+', pan: 1, tilt: 0, label: 'pan+ only' },
  { step: 'iso-pan-', pan: -1, tilt: 0, label: 'pan- only' },
  { step: 'iso-tilt+', pan: 0, tilt: 1, label: 'tilt+ (nose up)' },
  { step: 'iso-tilt-', pan: 0, tilt: -1, label: 'tilt- (nose down)' },
];

async function api(method, p, body) {
  const res = await fetch(`${BRIDGE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${json.error ?? res.status}`);
  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function wait066(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const res = await fetch(`${BRIDGE}/state`);
    const state = await res.json();
    if (is066State(state)) return state;
    await sleep(400);
  }
  throw new Error('timeout waiting for 0x66');
}

function logRow(step, visual, state, notes) {
  const row = calibRowFromState(state, { step, visual, action: 'isolate', notes });
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function summarizeBlock(rows) {
  const tilts = rows.map((r) => r.bridge.tiltRaw).filter((n) => typeof n === 'number');
  const pans = rows.map((r) => r.bridge.panRaw).filter((n) => typeof n === 'number');
  const tiltRungs = [...new Set(tilts.map((t) => wireRung(t)))];
  const panRungs = [...new Set(pans.map((p) => wireRung(p)))];
  const tiltSpan = tilts.length ? Math.max(...tilts) - Math.min(...tilts) : 0;
  const panSpan = pans.length ? Math.max(...pans) - Math.min(...pans) : 0;
  return { tiltRungs, panRungs, tiltSpan, panSpan, n: rows.length };
}

async function center() {
  console.log('→ CTR');
  await api('POST', '/center');
  await sleep(CENTER_MS);
  return wait066();
}

async function runAxis({ step, pan, tilt, label }) {
  console.log(`\n=== ${label} (${PULSES}× ${NUDGE_MS}ms) ===`);
  await center();
  const block = [];
  for (let i = 0; i < PULSES; i += 1) {
    const end = Date.now() + NUDGE_MS;
    await api('POST', '/move/hold', { pan, tilt });
    while (Date.now() < end) {
      await sleep(Math.min(200, end - Date.now()));
      if (Date.now() >= end) break;
      await api('POST', '/move/hold', { pan, tilt });
    }
    await api('POST', '/move/stop');
    await sleep(SETTLE_MS);
    const state = await wait066(15000);
    const t = state.telemetry;
    const row = logRow(`${step}-${i}`, label, state, `pulse ${i}`);
    block.push(row);
    console.log(
      `  ${i}: @2=${t.tiltRaw}(r${rungIndex(t.tiltRaw)}) @8=${t.panRaw}(r${rungIndex(t.panRaw)})`,
    );
  }
  const sum = summarizeBlock(block);
  console.log(
    `  summary: @2 rungs [${sum.tiltRungs.join(', ')}] span=${sum.tiltSpan} | @8 [${sum.panRungs.join(', ')}] span=${sum.panSpan}`,
  );
  return { step, sum, block };
}

async function main() {
  console.log(`Axis isolation @ ${BRIDGE}\n`);
  const health = await fetch(`${BRIDGE}/health/label`).then((r) => r.json());
  if (String(health).includes('NO GIMB')) throw new Error('gimbal not connected');

  const results = [];
  for (const axis of AXES) {
    results.push(await runAxis(axis));
  }

  console.log('\n--- coupling check (other axis moved?) ---');
  for (const { step, sum } of results) {
    const primary = step.includes('pan') ? '@8' : '@2';
    const other = step.includes('pan') ? '@2' : '@8';
    const otherSpan = step.includes('pan') ? sum.tiltSpan : sum.panSpan;
    console.log(
      `${step}: primary ${primary} rungs=${step.includes('pan') ? sum.panRungs.length : sum.tiltRungs.length} | ${other} span=${otherSpan}`,
    );
  }
  console.log(`\n→ ${CALIB_LOG}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
