#!/usr/bin/env node
/**
 * Static hold burst — N snapshots while gimbal does not move (script never nudges).
 *   BRIDGE_URL=... npm run calib:hold-burst
 *   COUNT=12 INTERVAL_MS=2000 STEP=markA-hold
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';
import { is066State, onSameRung, wireRung } from '../lib/calib-loop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
const STEP = process.env.STEP ?? 'hold-burst';
const COUNT = Number(process.env.COUNT ?? 12);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 2000);
const SETTLE_MS = Number(process.env.HOLD_SETTLE_MS ?? 500);
const USE_PROMPT =
  process.env.PROMPT !== '0' && process.env.PROMPT !== 'false' && process.stdin.isTTY;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
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

function uniqueRungs(values) {
  const rungs = [...new Set(values.map((v) => wireRung(v)))];
  rungs.sort((a, b) => a - b);
  return rungs;
}

function burstReport(rows) {
  const tilts = rows.map((r) => r.bridge.tiltRaw);
  const pans = rows.map((r) => r.bridge.panRaw);
  const hexes = rows.map((r) => r.decode066?.rawHex ?? '');
  const tiltRungs = uniqueRungs(tilts);
  const panRungs = uniqueRungs(pans);
  const hexUnique = [...new Set(hexes)];

  let panFlips = 0;
  for (let i = 1; i < pans.length; i += 1) {
    if (!onSameRung(pans[i], pans[i - 1])) panFlips += 1;
  }
  let tiltFlips = 0;
  for (let i = 1; i < tilts.length; i += 1) {
    if (!onSameRung(tilts[i], tilts[i - 1])) tiltFlips += 1;
  }

  return {
    tilts,
    pans,
    tiltRungs,
    panRungs,
    hexUnique,
    tiltStable: tiltRungs.length === 1,
    panStable: panRungs.length === 1,
    tiltFlips,
    panFlips,
    hexStable: hexUnique.length === 1,
  };
}

async function main() {
  console.log(`Hold burst ${STEP} × ${COUNT} @ ${INTERVAL_MS}ms — ${BRIDGE}`);
  console.log('Script does NOT move the gimbal; hold framing still.\n');

  if (USE_PROMPT) {
    await waitForEnter('Hold on mark — press Enter to start burst… ');
  } else {
    console.log(`Starting in ${SETTLE_MS}ms…`);
    await sleep(SETTLE_MS);
  }

  const rows = [];
  for (let i = 0; i < COUNT; i += 1) {
    const state = await wait066();
    const row = calibRowFromState(state, {
      step: `${STEP}-b${i}`,
      visual: STEP,
      action: 'hold-burst',
      notes: `burst ${i + 1}/${COUNT}`,
    });
    fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
    rows.push(row);
    const b = row.bridge;
    console.log(
      `  b${i}: @2=${b.tiltRaw}(r${wireRung(b.tiltRaw)}) @8=${b.panRaw}(r${wireRung(b.panRaw)})`,
    );
    if (i < COUNT - 1) await sleep(INTERVAL_MS);
  }

  const rep = burstReport(rows);
  console.log('\n--- hold burst ---');
  console.log(`@2 unique rungs (${rep.tiltRungs.length}): ${rep.tiltRungs.join(', ')} — stable? ${rep.tiltStable ? 'YES' : 'NO'} (flips ${rep.tiltFlips})`);
  console.log(`@8 unique rungs (${rep.panRungs.length}): ${rep.panRungs.join(', ')} — stable? ${rep.panStable ? 'YES' : 'NO'} (flips ${rep.panFlips})`);
  console.log(`rawHex variants: ${rep.hexUnique.length} — identical? ${rep.hexStable ? 'YES' : 'NO'}`);
  console.log(`\n→ ${CALIB_LOG}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
