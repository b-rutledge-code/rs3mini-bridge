#!/usr/bin/env node
/**
 * 0x14 round-trip to markA / markB wire (bench).
 *   BRIDGE_URL=http://10.0.0.183:8787 npm run calib:014-roundtrip
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';

const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'calibration-poses.jsonl');
const CENTER_MS = 4000;
const NUDGE_MS = 2500;
const SETTLE_MS = Number(process.env.RECALL_SETTLE_MS ?? 5000);

const MARKS = {
  A: { pitch: 2305, yaw: -511, rawHex: '010601090701fd0801fe0a01000b01000c0100' },
  B: { pitch: 257, yaw: 257, rawHex: '010601010701fc0801010a01000b01000c0100' },
};

async function api(method, p, body) {
  const res = await fetch(`${BRIDGE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${json.error ?? text}`);
  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function state() {
  return (await fetch(`${BRIDGE}/state`)).json();
}

function wire(s) {
  const t = s.telemetry ?? {};
  return { tilt: t.tiltRaw, pan: t.panRaw, raw: t.rawPayload, source: t.source };
}

function log(step, visual, st, notes) {
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(calibRowFromState(st, { step, visual, action: '014-roundtrip', notes }))}\n`);
}

async function center() {
  await api('POST', '/move/stop').catch(() => {});
  await api('POST', '/center');
  await sleep(CENTER_MS);
}

async function nudge(pan, tilt) {
  const end = Date.now() + NUDGE_MS;
  await api('POST', '/move/hold', { pan, tilt });
  while (Date.now() < end) {
    await sleep(Math.min(200, end - Date.now()));
    if (Date.now() >= end) break;
    await api('POST', '/move/hold', { pan, tilt });
  }
  await api('POST', '/move/stop');
  await sleep(800);
}

async function recall(pitch, yaw, duration = 80) {
  await api('POST', '/angle/recall', { pitch, yaw, roll: 0, flags: 0x07, duration, settleMs: SETTLE_MS });
}

async function tryMark(name, mark) {
  console.log(`\n=== mark${name} round-trip ===`);
  await center();
  let st = await state();
  console.log(`CTR: ${JSON.stringify(wire(st))}`);

  console.log('→ nudge away (pan+ tilt+)');
  await nudge(1, 1);
  st = await state();
  const away = wire(st);
  console.log(`away: ${JSON.stringify(away)}`);

  for (const duration of [80, 160, 255]) {
    console.log(`→ 0x14 pitch=${mark.pitch} yaw=${mark.yaw} duration=${duration}`);
    await recall(mark.pitch, mark.yaw, duration);
    st = await state();
    const back = wire(st);
    const tiltOk = back.tilt === mark.pitch;
    const panOk = back.pan === mark.yaw;
    const hexOk = back.raw === mark.rawHex;
    console.log(`  wire: tilt=${back.tilt} pan=${back.pan} src=${back.source}`);
    console.log(`  match: tilt=${tiltOk} pan=${panOk} rawHex=${hexOk}`);
    log(`014-mark${name}-d${duration}`, `tilt=${tiltOk} pan=${panOk} hex=${hexOk}`, st, JSON.stringify({ away, target: mark }));
    if (tiltOk && panOk) {
      console.log(`  ** FULL WIRE MATCH duration=${duration} **`);
      return true;
    }
    if (!tiltOk || !panOk) {
      await nudge(1, 0);
      await sleep(500);
    }
  }
  return false;
}

async function main() {
  console.log(`0x14 round-trip @ ${BRIDGE}`);
  const a = await tryMark('A', MARKS.A);
  const b = await tryMark('B', MARKS.B);
  console.log(`\nmarkA: ${a ? 'PASS' : 'FAIL'}  markB: ${b ? 'PASS' : 'FAIL'}`);
  if (!a || !b) process.exit(2);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
