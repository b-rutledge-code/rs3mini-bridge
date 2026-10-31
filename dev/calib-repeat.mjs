#!/usr/bin/env node
/**
 * Phase D — repeatability: N snapshots with operator re-aim between each.
 *   STEP=markA-live COUNT=3 npm run calib:repeat
 * Interactive (TTY): press Enter when framed. Non-TTY or PROMPT=0: WAIT_SEC timer.
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
const STEP = process.env.STEP ?? process.argv[2] ?? 'markA-live';
const COUNT = Number(process.env.COUNT ?? process.argv[3] ?? 3);
const WAIT_SEC = Number(process.env.WAIT_SEC ?? 20);
const SETTLE_MS = Number(process.env.REPEAT_SETTLE_MS ?? 500);
const LABEL = process.env.CALIB_LABEL ?? `repeat ${STEP}`;
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

async function waitForOperator({ reAim }) {
  if (USE_PROMPT) {
    const verb = reAim ? 'Re-aim' : 'Aim';
    console.log('');
    console.log(`${verb} at ${STEP} on tape — hold still; script does NOT move the gimbal.`);
    await waitForEnter('Press Enter when framed and holding still… ');
    if (SETTLE_MS > 0) await sleep(SETTLE_MS);
    return;
  }

  const sec = reAim ? WAIT_SEC : 3;
  const verb = reAim ? 'Re-aim' : 'Aim';
  console.log(`${verb} at ${STEP} — auto snap in ${sec}s…`);
  await sleep(sec * 1000);
}

async function wait066(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const res = await fetch(`${BRIDGE}/state`);
    const state = await res.json();
    if (is066State(state)) return state;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('timeout waiting for 0x66');
}

function logRow(i, state) {
  const row = calibRowFromState(state, {
    step: `${STEP}-r${i}`,
    visual: LABEL,
    action: 'repeat',
    notes: `repeat ${i + 1}/${COUNT}`,
  });
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

function clusterReport(rows) {
  const tilts = rows.map((r) => r.bridge.tiltRaw);
  const pans = rows.map((r) => r.bridge.panRaw);
  const hexes = rows.map((r) => r.decode066?.rawHex ?? r.bridge?.rawPayload);
  const tiltSame = tilts.every((t) => onSameRung(t, tilts[0]));
  const panSame = pans.every((p) => onSameRung(p, pans[0]));
  const hexSame = hexes.every((h) => h === hexes[0]);
  return { tilts, pans, hexes, tiltSame, panSame, hexSame };
}

async function main() {
  console.log(`Repeatability ${STEP} × ${COUNT} @ ${BRIDGE}`);
  if (USE_PROMPT) {
    console.log('Interactive: press Enter each time you are framed on the mark.\n');
  } else {
    console.log(`Timer mode (PROMPT=0 or non-TTY): ${WAIT_SEC}s between re-aims.\n`);
  }
  const rows = [];

  for (let i = 0; i < COUNT; i += 1) {
    await waitForOperator({ reAim: i > 0 });
    const state = await wait066();
    const row = logRow(i, state);
    rows.push(row);
    const b = row.bridge;
    console.log(
      `  r${i}: @2=${b.tiltRaw} @8=${b.panRaw} rung ${wireRung(b.tiltRaw)}/${wireRung(b.panRaw)}`,
    );
    console.log(`  raw: ${row.decode066?.rawHex ?? ''}`);
  }

  const rep = clusterReport(rows);
  console.log('\n--- repeatability ---');
  console.log(`@2 rungs: ${rep.tilts.join(', ')} — same rung? ${rep.tiltSame ? 'YES' : 'NO'}`);
  console.log(`@8 rungs: ${rep.pans.join(', ')} — same rung? ${rep.panSame ? 'YES' : 'NO'}`);
  console.log(`rawHex identical? ${rep.hexSame ? 'YES' : 'NO'}`);
  console.log(`\n→ ${CALIB_LOG}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
