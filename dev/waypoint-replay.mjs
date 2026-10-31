#!/usr/bin/env node
/**
 * Bench: replay Ronin Track 0x62 path + 0x6b poll (Stage 0f/0g).
 *
 *   npm run waypoint:replay [saved|stage0g|capture]
 *
 * `capture` — save current pose → center → 0x62 replay (one BLE session).
 */

process.env.CONNECT_GUARD_MS = process.env.CONNECT_GUARD_MS ?? '0';
process.env.STARTUP_GUARD_MS = process.env.STARTUP_GUARD_MS ?? '0';

import { buildGimbalTarget, gimbalTargetLabel, hasGimbalTarget } from '../lib/gimbal-target.js';
import { loadPoseRecord, poseFromGimbalState, savePoseRecord, presetPath } from '../lib/gimbal-preset.js';
import { build062Path, STAGE0G_062_PAYLOAD } from '../lib/gimbal-waypoint.js';
import { sleep } from '../lib/ble-session.js';

const gimbal = await import('../lib/gimbal-session.js');

const POLL_MS = Number(process.env.TRACK_POLL_MS ?? 4000);
const PRE_POLLS = Number(process.env.TRACK_PRE_POLLS ?? 3);
const FOLLOW_MS = Number(process.env.TRACK_FOLLOW_MS ?? 20000);

const target = buildGimbalTarget();

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function fmtPose(state) {
  const t = state.telemetry;
  return `tilt=${t.tiltDeg?.toFixed(1) ?? '?'}° (${t.tiltRaw})  pan=${t.panDeg?.toFixed(1) ?? '?'}° (${t.panRaw})`;
}

function pathForMode(mode) {
  if (mode === 'stage0g') {
    return { label: 'stage0g capture (up→down)', payload: STAGE0G_062_PAYLOAD };
  }
  const saved = loadPoseRecord();
  const pt = { pitch: saved.pitch, yaw: saved.yaw ?? 0 };
  const payload = build062Path([pt, pt]);
  return {
    label: `saved pose ×2 (${saved.savedAt}) pitch=${pt.pitch} yaw=${pt.yaw}`,
    payload,
  };
}

async function waitForPose(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = gimbal.getGimbalState();
    if (state.ok && !state.telemetry.stale && state.telemetry.tiltRaw != null) {
      return state;
    }
    await sleep(400);
  }
  die('connect/telemetry timeout');
}

const SETTLE_MS = Number(process.env.PRESET_SETTLE_MS ?? 2500);

async function runReplay(payload, label) {
  console.log(`${label}`);
  console.log(`0x62 payload (${payload.length} B): ${payload.toString('hex')}`);
  console.log('Watch for slow sweep after 0x62 upload…\n');

  const logTimer = setInterval(() => {
    console.log(`  ${new Date().toLocaleTimeString()}  ${fmtPose(gimbal.getGimbalState())}`);
  }, POLL_MS);

  try {
    await gimbal.replayTrackPath(target, {
      payload,
      pollMs: POLL_MS,
      prePolls: PRE_POLLS,
      followMs: FOLLOW_MS,
    });
  } finally {
    clearInterval(logTimer);
  }
}

async function main() {
  const mode = process.argv[2] ?? 'saved';
  if (!hasGimbalTarget(target)) {
    die('Set GIMBAL_NAME_RE (e.g. export GIMBAL_NAME_RE=YOURSUFFIX)');
  }

  console.log(`Target: ${gimbalTargetLabel(target)}`);

  if (mode === 'capture') {
    await gimbal.connectGimbal(target);
    const framed = await waitForPose();
    console.log(`1/3 Save — ${fmtPose(framed)}`);
    const saved = poseFromGimbalState(framed);
    savePoseRecord(saved);
    console.log(`     → ${presetPath()}\n`);

    console.log('2/3 Center…');
    await gimbal.centerGimbal(target);
    await sleep(SETTLE_MS);
    console.log(`     ${fmtPose(await waitForPose())}\n`);

    const pt = { pitch: saved.pitch, yaw: saved.yaw ?? 0 };
    const payload = build062Path([pt, pt]);
    console.log('3/3 Track replay…');
    await runReplay(payload, `saved ×2 pitch=${pt.pitch} yaw=${pt.yaw}`);
    console.log(`\nEnd: ${fmtPose(gimbal.getGimbalState())}`);
    return;
  }

  const { label, payload } = pathForMode(mode);
  console.log(`Mode: ${mode} — ${label}\n`);

  await gimbal.connectGimbal(target);
  const state = await waitForPose();
  console.log(`Start: ${fmtPose(state)}`);
  await runReplay(payload, label);
  console.log(`\nEnd: ${fmtPose(gimbal.getGimbalState())}`);
}

try {
  await main();
} finally {
  gimbal.stopReconnectLoop();
  await gimbal.shutdownSession();
}
