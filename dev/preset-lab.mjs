#!/usr/bin/env node
/**
 * Bench preset lab — direct BLE, no curl.
 *
 *   npm run preset:watch
 *   npm run preset:save
 *   npm run preset:go
 *   npm run preset:center
 *   npm run preset:scr     save → center → recall
 *   npm run preset:gate
 *   npm run preset:test-014 [up|down]   0x14 with Stage 0g Track wire angles
 *
 * Requires GIMBAL_NAME_RE (same as bridge). Stop rs3mini-bridge service on Pi if
 * two centrals would fight for the gimbal.
 */

process.env.CONNECT_GUARD_MS = process.env.CONNECT_GUARD_MS ?? '0';
process.env.STARTUP_GUARD_MS = process.env.STARTUP_GUARD_MS ?? '0';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGimbalTarget, gimbalTargetLabel, hasGimbalTarget } from '../lib/gimbal-target.js';
import {
  loadPoseRecord,
  poseFromGimbalState,
  poseWireDelta,
  presetPath,
  savePoseRecord,
  withinTolerance,
} from '../lib/gimbal-preset.js';
import { sleep } from '../lib/ble-session.js';

const gimbal = await import('../lib/gimbal-session.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const CONNECT_TIMEOUT_MS = Number(process.env.PRESET_CONNECT_MS ?? 90000);
const MOVE_AWAY_MS = Number(process.env.PRESET_MOVE_MS ?? 2000);
const SETTLE_MS = Number(process.env.PRESET_SETTLE_MS ?? 2500);
const RECALL_SETTLE_MS = Number(process.env.PRESET_RECALL_MS ?? 4000);
const TOLERANCE_RAW = Number(process.env.PRESET_TOLERANCE ?? 80);
const GATE_CYCLES = Number(process.env.PRESET_GATE_CYCLES ?? 3);

const target = buildGimbalTarget();

function usage() {
  console.log(`Usage: node dev/preset-lab.mjs <command>

Commands:
  watch   Live 0x66 tilt/pan until Ctrl+C
  save    Snapshot pose → ${presetPath()}
  go      0x04/0x14 recall from saved file
  center  Mechanical recenter (0x04/0x4c)
  scr     Save current pose → center → recall saved
  gate        Automated save → move away → go × ${GATE_CYCLES} (wire tolerance ±${TOLERANCE_RAW})
  test-014    Send 0x04/0x14 using Stage 0g Track wire angles (up|down)

Env: GIMBAL_NAME_RE (required), PRESET_PITCH/YAW/ROLL, PRESET_FLAGS, PRESET_DURATION,
     PRESET_CENTER_FIRST=1 (recenter before test-014)
`);
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function fmtPose(state) {
  const t = state.telemetry;
  const motor = state.motor?.state ?? '?';
  const stale = t.stale ? ' STALE' : '';
  return (
    `tilt=${t.tiltDeg?.toFixed(1) ?? '?'}° (${t.tiltRaw})  ` +
    `pan=${t.panDeg?.toFixed(1) ?? '?'}° (${t.panRaw})  ` +
    `roll=${t.rollDeg?.toFixed(1) ?? '?'}°  motor=${motor}${stale}`
  );
}

async function waitForPose(timeoutMs = CONNECT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = gimbal.getGimbalState();
    if (state.ok && !state.telemetry.stale && state.telemetry.tiltRaw != null) {
      return state;
    }
    await sleep(400);
  }
  const last = gimbal.getGimbalState();
  die(`connect/telemetry timeout — ${last.ble.lastError || 'no fresh 0x66'}`);
}

async function ensureLabConnected() {
  if (!hasGimbalTarget(target)) {
    die('Set GIMBAL_NAME_RE (e.g. export GIMBAL_NAME_RE=YOURSUFFIX)');
  }
  console.log(`Target: ${gimbalTargetLabel(target)}`);
  await gimbal.connectGimbal(target);
  const state = await waitForPose();
  console.log(`Connected — ${fmtPose(state)}`);
  return state;
}

async function cmdWatch() {
  await ensureLabConnected();
  console.log('Watching telemetry (Ctrl+C to exit)…\n');
  const timer = setInterval(() => {
    const state = gimbal.getGimbalState();
    const ts = new Date().toLocaleTimeString();
    process.stdout.write(`\r${ts}  ${fmtPose(state)}    `);
  }, 500);

  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(timer);
  console.log('\n');
}

async function cmdSave() {
  await ensureLabConnected();
  const state = gimbal.getGimbalState();
  const record = poseFromGimbalState(state);
  const file = savePoseRecord(record);
  console.log(`Saved → ${file}`);
  console.log(JSON.stringify(record, null, 2));
}

async function cmdCenter() {
  await ensureLabConnected();
  console.log('Recentering…');
  await gimbal.centerGimbal(target);
  await sleep(SETTLE_MS);
  const after = await waitForPose();
  console.log(`After center: ${fmtPose(after)}`);
}

/** Save framing → mechanical center → recall saved pose. */
async function cmdScr() {
  await ensureLabConnected();
  const state = gimbal.getGimbalState();
  const saved = poseFromGimbalState(state);
  const file = savePoseRecord(saved);
  console.log(`1/3 Saved → ${file}`);
  console.log(`     ${fmtPose(state)}\n`);

  console.log('2/3 Recenter…');
  await gimbal.centerGimbal(target);
  await sleep(SETTLE_MS);
  const centered = await waitForPose();
  console.log(`     ${fmtPose(centered)}\n`);

  console.log('3/3 Recall saved pose…');
  await gimbal.recallAbsAngle(target, {
    pitch: saved.pitch,
    roll: saved.roll ?? 0,
    yaw: saved.yaw,
    flags: Number(process.env.PRESET_FLAGS ?? 0x07),
    duration: Number(process.env.PRESET_DURATION ?? 80),
    settleMs: RECALL_SETTLE_MS,
  });

  const back = await waitForPose();
  const delta = poseWireDelta(saved, back);
  console.log(`     ${fmtPose(back)}`);
  console.log(`Delta: tilt=${delta.tilt} pan=${delta.pan} (tolerance ±${TOLERANCE_RAW})`);
  console.log(withinTolerance(delta, TOLERANCE_RAW) ? 'Recall OK (wire values)' : 'Recall OFF (wire values — eyeball framing)');
}

/** Stage 0g Ronin Track decode — wire int16 pitch/yaw from 0x62 blob. */
const TRACK_WIRE = {
  up: { pitch: 834, roll: 0, yaw: 0, label: 'stage0g wp1 (almost straight up)' },
  down: { pitch: -450, roll: 0, yaw: 14, label: 'stage0g wp2 (tilted way down)' },
};

function trackWireTarget(profile) {
  const key = profile === 'down' ? 'down' : 'up';
  const base = TRACK_WIRE[key];
  return {
    pitch: Number(process.env.PRESET_PITCH ?? base.pitch),
    roll: Number(process.env.PRESET_ROLL ?? base.roll),
    yaw: Number(process.env.PRESET_YAW ?? base.yaw),
    label: process.env.PRESET_PITCH ? 'env override' : base.label,
  };
}

/** Bench: 0x14 snap test with Track-format angles (not 0x66 save source). */
async function cmdTest014() {
  const profile = process.argv[3] ?? 'up';
  const { pitch, roll, yaw, label } = trackWireTarget(profile);
  const flags = Number(process.env.PRESET_FLAGS ?? 0x07);
  const duration = Number(process.env.PRESET_DURATION ?? 80);

  await ensureLabConnected();
  const before = gimbal.getGimbalState();
  console.log(`Before: ${fmtPose(before)}`);

  if (process.env.PRESET_CENTER_FIRST === '1') {
    console.log('Recentering first (PRESET_CENTER_FIRST=1)…');
    await gimbal.centerGimbal(target);
    await sleep(SETTLE_MS);
    console.log(`Centered: ${fmtPose(await waitForPose())}\n`);
  }

  console.log(`0x04/0x14 recall — ${label}`);
  console.log(`  pitch=${pitch} roll=${roll} yaw=${yaw} flags=0x${flags.toString(16)} duration=${duration}`);
  console.log('Watch the gimbal — snap vs slow sweep?\n');

  await gimbal.recallAbsAngle(target, {
    pitch,
    roll,
    yaw,
    flags,
    duration,
    settleMs: RECALL_SETTLE_MS,
  });

  const after = await waitForPose();
  const targetPose = { pitch, roll, yaw };
  const delta = poseWireDelta(targetPose, after);
  console.log(`After:  ${fmtPose(after)}`);
  console.log(`Target: pitch=${pitch} yaw=${yaw}`);
  console.log(`Delta:  tilt=${delta.tilt} pan=${delta.pan} (wire tolerance ±${TOLERANCE_RAW})`);
  console.log(withinTolerance(delta, TOLERANCE_RAW) ? 'Wire values WITHIN tolerance' : 'Wire values OUTSIDE tolerance — eyeball framing');
}

async function cmdGo() {
  await ensureLabConnected();
  const saved = loadPoseRecord();
  const flags = Number(process.env.PRESET_FLAGS ?? 0x07);
  const duration = Number(process.env.PRESET_DURATION ?? 80);
  console.log(`Recalling saved pose from ${saved.savedAt}…`);
  console.log(`  pitch=${saved.pitch} roll=${saved.roll} yaw=${saved.yaw} flags=${flags} duration=${duration}`);

  const before = gimbal.getGimbalState();
  console.log(`Before: ${fmtPose(before)}`);

  await gimbal.recallAbsAngle(target, {
    pitch: saved.pitch,
    roll: saved.roll ?? 0,
    yaw: saved.yaw,
    flags,
    duration,
    settleMs: RECALL_SETTLE_MS,
  });

  const after = await waitForPose(CONNECT_TIMEOUT_MS);
  const delta = poseWireDelta(saved, after);
  console.log(`After:  ${fmtPose(after)}`);
  console.log(`Delta:  tilt=${delta.tilt} pan=${delta.pan} roll=${delta.roll} (tolerance ±${TOLERANCE_RAW})`);
  console.log(withinTolerance(delta, TOLERANCE_RAW) ? 'WITHIN tolerance (wire values)' : 'OUTSIDE tolerance (wire values)');
}

async function nudge({ pan = 0, tilt = 0 }, label) {
  console.log(`  move away: ${label} ${MOVE_AWAY_MS}ms`);
  const end = Date.now() + MOVE_AWAY_MS;
  await gimbal.holdMove(target, { pan, tilt });
  while (Date.now() < end) {
    await sleep(Math.min(200, end - Date.now()));
    if (Date.now() >= end) break;
    await gimbal.holdMove(target, { pan, tilt });
  }
  await gimbal.stopMove();
  await sleep(SETTLE_MS);
}

async function cmdGate() {
  await ensureLabConnected();

  const state = gimbal.getGimbalState();
  const saved = poseFromGimbalState(state);
  savePoseRecord(saved);
  console.log(`Baseline saved — ${fmtPose(state)}\n`);

  const results = [];

  for (let i = 0; i < GATE_CYCLES; i += 1) {
    console.log(`--- cycle ${i + 1}/${GATE_CYCLES} ---`);
    await nudge({ tilt: 1 }, 'tilt+');
    await nudge({ pan: 1 }, 'pan+');
    await nudge({ pan: -1 }, 'pan-');

    const away = gimbal.getGimbalState();
    console.log(`  away:   ${fmtPose(away)}`);

    await gimbal.recallAbsAngle(target, {
      pitch: saved.pitch,
      roll: saved.roll ?? 0,
      yaw: saved.yaw,
      flags: Number(process.env.PRESET_FLAGS ?? 0x07),
      duration: Number(process.env.PRESET_DURATION ?? 80),
      settleMs: RECALL_SETTLE_MS,
    });

    const back = await waitForPose();
    const delta = poseWireDelta(saved, back);
    const pass = withinTolerance(delta, TOLERANCE_RAW);
    console.log(`  back:   ${fmtPose(back)}`);
    console.log(`  delta:  tilt=${delta.tilt} pan=${delta.pan} → ${pass ? 'PASS' : 'FAIL'}\n`);

    results.push({
      cycle: i + 1,
      delta,
      pass,
      awayTilt: away.telemetry.tiltRaw,
      awayPan: away.telemetry.panRaw,
      backTilt: back.telemetry.tiltRaw,
      backPan: back.telemetry.panRaw,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const summary = {
    at: new Date().toISOString(),
    target: gimbalTargetLabel(target),
    toleranceRaw: TOLERANCE_RAW,
    cycles: GATE_CYCLES,
    passed,
    failed: GATE_CYCLES - passed,
    saved,
    results,
  };

  const outFile = path.join(ROOT, 'bench-preset-gate.json');
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`Gate: ${passed}/${GATE_CYCLES} passed (wire tolerance ±${TOLERANCE_RAW})`);
  console.log(`Log → ${outFile}`);

  if (passed < GATE_CYCLES) {
    die('Gate FAILED — recall did not return within wire tolerance', 2);
  }
}

async function shutdown() {
  gimbal.stopReconnectLoop();
  await gimbal.shutdownSession();
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  const handlers = {
    watch: cmdWatch,
    save: cmdSave,
    go: cmdGo,
    center: cmdCenter,
    scr: cmdScr,
    gate: cmdGate,
    'test-014': cmdTest014,
  };

  if (!handlers[cmd]) {
    usage();
    die(`Unknown command: ${cmd}`);
  }

  try {
    await handlers[cmd]();
  } finally {
    await shutdown();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  shutdown().finally(() => process.exit(1));
});
