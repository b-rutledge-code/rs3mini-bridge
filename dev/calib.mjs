#!/usr/bin/env node
/**
 * Pan/tilt calibration bench — human labels + agentic loop.
 *
 *   npm run calib:snapshot -- --step p00 --label "mechanical center"
 *   npm run calib:center
 *   npm run calib:nudge -- --tilt 1
 *   npm run calib:grid
 *
 * Stop rs3mini-bridge on Pi. Append rows to calibration-poses.jsonl (CALIB_LOG).
 */

process.env.CONNECT_GUARD_MS = process.env.CONNECT_GUARD_MS ?? '0';
process.env.STARTUP_GUARD_MS = process.env.STARTUP_GUARD_MS ?? '0';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGimbalTarget, gimbalTargetLabel, hasGimbalTarget } from '../lib/gimbal-target.js';
import { calibRowFromState } from '../lib/calib-decode.js';
import { runAndExit, sleep } from '../lib/ble-session.js';

const gimbal = await import('../lib/gimbal-session.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
const CONNECT_TIMEOUT_MS = Number(process.env.CALIB_CONNECT_MS ?? 90000);
const SETTLE_MS = Number(process.env.CALIB_SETTLE_MS ?? 2500);
const NUDGE_MS = Number(process.env.CALIB_NUDGE_MS ?? 2000);

const target = buildGimbalTarget();

const GRID = [
  { step: 'p00', action: 'center', visual: 'mechanical center (CTR equivalent)' },
  { step: 'p01', action: 'manual', visual: 'YOUR CF game framing — aim now, then snapshot' },
  { step: 'p02', action: 'manual', visual: 'straight up / your saved-shot aim' },
  { step: 'p03', action: 'nudge', tilt: 1, pan: 0, visual: 'center + tilt+ one hold' },
  { step: 'p04', action: 'nudge', tilt: -1, pan: 0, visual: 'center + tilt− one hold' },
  { step: 'p05', action: 'nudge', tilt: 0, pan: 1, visual: 'center + pan+ one hold' },
  { step: 'p06', action: 'nudge', tilt: 0, pan: -1, visual: 'center + pan− one hold' },
];

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--step') out.step = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--tilt') out.tilt = Number(argv[++i]);
    else if (a === '--pan') out.pan = Number(argv[++i]);
    else if (a === '--ms') out.ms = Number(argv[++i]);
    else if (a === '--no-append') out.noAppend = true;
    else if (a.startsWith('-')) die(`unknown flag: ${a}`);
    else out._.push(a);
  }
  return out;
}

function appendRow(row) {
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
  console.log(`→ appended ${CALIB_LOG}`);
}

function printRow(row) {
  console.log(JSON.stringify(row, null, 2));
}

function is066Pose(state) {
  const t = state?.telemetry;
  return (
    state?.ok &&
    !t?.stale &&
    t?.tiltRaw != null &&
    t?.source === '0x04/0x66'
  );
}

async function waitForAnyPose(timeoutMs = CONNECT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = gimbal.getGimbalState();
    if (state.ok && !state.telemetry.stale && state.telemetry.tiltRaw != null) {
      return state;
    }
    await sleep(400);
  }
  die('connect/telemetry timeout — no fresh pose notify');
}

async function holdFor(pan, tilt, ms) {
  const end = Date.now() + ms;
  await gimbal.holdMove(target, { pan, tilt });
  while (Date.now() < end) {
    await sleep(Math.min(200, end - Date.now()));
    if (Date.now() >= end) break;
    await gimbal.holdMove(target, { pan, tilt });
  }
  await gimbal.stopMove();
}

async function kickFor066() {
  const ms = Number(process.env.CALIB_KICK_MS ?? 0);
  if (!ms) return;
  console.log(`Kick nudge tilt+ ${ms}ms to wake 0x04/0x66…`);
  await holdFor(0, 1, ms);
  await sleep(500);
}

async function waitForPose(timeoutMs = CONNECT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = gimbal.getGimbalState();
    if (is066Pose(state)) return state;
    await sleep(400);
  }
  die('connect/telemetry timeout — no fresh 0x04/0x66');
}

async function ensureConnected() {
  if (!hasGimbalTarget(target)) {
    die('Set GIMBAL_NAME_RE (e.g. export GIMBAL_NAME_RE=YOURSUFFIX)');
  }
  await gimbal.connectGimbal(target);
  return waitForAnyPose();
}

async function snapshotRow({ step, visual, action, notes }) {
  const state = gimbal.getGimbalState();
  return calibRowFromState(state, { step, visual, action, notes });
}

async function cmdSnapshot(args) {
  await ensureConnected();
  await sleep(SETTLE_MS);
  await kickFor066();
  const poseWaitMs = Number(process.env.CALIB_066_MS ?? 60000);
  console.log(`Waiting for 0x04/0x66 (up to ${poseWaitMs}ms)…`);
  await waitForPose(poseWaitMs);
  const row = await snapshotRow({
    step: args.step ?? process.env.CALIB_STEP,
    visual: args.label ?? process.env.CALIB_LABEL,
    action: args._.join(' ') || 'snapshot',
    notes: args.notes,
  });
  printRow(row);
  if (!args.noAppend && (args.label || process.env.CALIB_LABEL)) {
    appendRow(row);
  }
}

async function cmdCenter(args) {
  await ensureConnected();
  console.log('Recentering…');
  await gimbal.centerGimbal(target);
  await sleep(SETTLE_MS);
  const row = await snapshotRow({
    step: args.step ?? 'p00',
    visual: args.label ?? 'mechanical center',
    action: 'center',
    notes: args.notes,
  });
  printRow(row);
  if (!args.noAppend) appendRow(row);
}

async function cmdNudge(args) {
  const tilt = args.tilt ?? 0;
  const pan = args.pan ?? 0;
  const ms = args.ms ?? NUDGE_MS;
  if (!tilt && !pan) die('nudge needs --tilt ±1 and/or --pan ±1');

  await ensureConnected();
  console.log(`Nudge pan=${pan} tilt=${tilt} ${ms}ms…`);
  await holdFor(pan, tilt, ms);
  await sleep(SETTLE_MS);

  const row = await snapshotRow({
    step: args.step,
    visual: args.label,
    action: `nudge pan=${pan} tilt=${tilt} ${ms}ms`,
    notes: args.notes,
  });
  printRow(row);
  if (!args.noAppend && args.label) appendRow(row);
}

async function cmdGrid() {
  await ensureConnected();
  console.log(`Calibration grid → ${CALIB_LOG}\n`);

  for (const item of GRID) {
    console.log(`\n=== ${item.step}: ${item.visual} ===`);
    if (item.action === 'center') {
      await gimbal.centerGimbal(target);
      await sleep(SETTLE_MS);
    } else if (item.action === 'nudge') {
      await holdFor(item.pan, item.tilt, NUDGE_MS);
      await sleep(SETTLE_MS);
    } else {
      console.log('(manual) Frame the gimbal, then re-run:');
      console.log(
        `  CALIB_STEP=${item.step} CALIB_LABEL="your description" npm run calib:snapshot`,
      );
      continue;
    }

    const row = await snapshotRow({
      step: item.step,
      visual: item.visual,
      action: item.action,
    });
    printRow(row);
    appendRow(row);
  }

  console.log('\nGrid automated steps done. Run calib:snapshot for p01/p02 manual poses.');
}

function usage() {
  console.log(`Usage: node dev/calib.mjs <command> [options]

Commands:
  snapshot   Log current 0x66 decode (connect if needed)
  center     Recenter + snapshot + append
  nudge      D-pad hold + snapshot (--tilt ±1 --pan ±1)
  grid       Run p00 + nudge grid; skips manual p01/p02

Options:
  --step ID       Pose id (e.g. p01)
  --label TEXT    Visual label (required to append)
  --notes TEXT    Freeform
  --no-append     Print only

Env: GIMBAL_NAME_RE, CALIB_LOG, CALIB_LABEL, CALIB_STEP
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  const handlers = {
    snapshot: cmdSnapshot,
    center: cmdCenter,
    nudge: cmdNudge,
    grid: cmdGrid,
  };

  if (!handlers[cmd]) {
    usage();
    die(`Unknown command: ${cmd}`);
  }

  try {
    await handlers[cmd](args);
  } finally {
    gimbal.stopReconnectLoop();
    await gimbal.shutdownSession();
  }
}

runAndExit(main);
