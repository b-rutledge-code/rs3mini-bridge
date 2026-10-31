#!/usr/bin/env node
/**
 * Axis isolation + repeatability — no prompts, no centering on bottle.
 * One d-pad dir per /center cycle; log wire + Larix frame each step.
 *
 *   source .local/vision.env && npm run vision:isolate
 *
 * Exit 0 → vision-isolate-report.json (sign checks + repeatability)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';
import { onSameRung, rungIndex } from '../lib/calib-loop.js';
import {
  PROBES,
  bridgeApi,
  getBridgeState,
  grabFrame,
  probeMovedVisual,
  probeMovedWire,
  runSingleProbe,
  sleep,
  wait066,
  wireFromState,
  wireLine,
} from '../lib/vision-bench.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RTSP = process.env.RTSP_URL;
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const OUT = process.env.VISION_OUT ?? path.join(ROOT, 'vision-isolate');
const LOG = process.env.VISION_ISOLATE_LOG ?? path.join(ROOT, 'vision-isolate.jsonl');
const REPORT = process.env.VISION_ISOLATE_REPORT ?? path.join(ROOT, 'vision-isolate-report.json');
const PROBE_MS = Number(process.env.ISOLATE_PROBE_MS ?? 1500);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 1500);
const GRAB_TIMEOUT = Number(process.env.VISION_GRAB_TIMEOUT_SEC ?? 15);
const REPEAT_N = Number(process.env.ISOLATE_REPEAT ?? 3);
const VISUAL_MAX = Number(process.env.RALPH_VISUAL_SSIM ?? 0.985);
const PROBE_MS_STEPS = (process.env.ISOLATE_PROBE_MS_STEPS ?? '1200,1500,2000,2500')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function log(row) {
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

function sign(n) {
  if (n == null || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

async function center(label) {
  console.log(`  → POST /center (${label})`);
  await bridgeApi(BRIDGE, 'POST', '/center');
  await sleep(5000);
  await wait066(BRIDGE);
}

async function isolateAxis(probeMs) {
  const steps = [];
  for (const probe of PROBES) {
    console.log(`\n--- ${probe.name} @ ${probeMs}ms ---`);
    await center(`before ${probe.name}`);
    const baselineFrame = path.join(OUT, `iso-${probe.name}-baseline.jpg`);
    grabFrame(RTSP, baselineFrame, GRAB_TIMEOUT);
    const baseState = await getBridgeState(BRIDGE);
    const baselineWire = wireFromState(baseState);

    const row = await runSingleProbe({
      bridge: BRIDGE,
      rtsp: RTSP,
      outDir: OUT,
      frameLabel: `iso-${probe.name}-nudge`,
      probe,
      probeMs,
      settleMs: SETTLE_MS,
      grabTimeoutSec: GRAB_TIMEOUT,
      baselineWire,
      baselineFrame,
    });

    console.log(`  base  ${wireLine(baselineWire)}`);
    console.log(`  nudge ${wireLine(row.wire)}  d@2=${row.dTilt} d@8=${row.dPan}  SSIM=${row.visualSsim?.toFixed(4)}`);
    console.log(`  undo  ${wireLine(row.afterUndo)}  ok=${row.undoOk}`);

    steps.push({
      probe: probe.name,
      probeMs,
      baseline: baselineWire,
      ...row,
      wireOk: probeMovedWire(row),
      visualOk: probeMovedVisual(row, VISUAL_MAX) !== false,
    });
    log({ phase: 'isolate', ...steps[steps.length - 1] });
    await center(`after ${probe.name}`);
  }

  const tiltPlus = steps.find((s) => s.probe === 'tilt+');
  const tiltMinus = steps.find((s) => s.probe === 'tilt-');
  const panPlus = steps.find((s) => s.probe === 'pan+');
  const panMinus = steps.find((s) => s.probe === 'pan-');

  const tiltOpposite =
    tiltPlus &&
    tiltMinus &&
    sign(tiltPlus.dTilt) !== 0 &&
    sign(tiltMinus.dTilt) !== 0 &&
    sign(tiltPlus.dTilt) !== sign(tiltMinus.dTilt);
  const panOpposite =
    panPlus &&
    panMinus &&
    sign(panPlus.dPan) !== 0 &&
    sign(panMinus.dPan) !== 0 &&
    sign(panPlus.dPan) !== sign(panMinus.dPan);

  const allMoved = steps.every((s) => s.wireOk && s.visualOk);

  return {
    probeMs,
    steps,
    tiltOpposite,
    panOpposite,
    allMoved,
    pass: Boolean(tiltOpposite && panOpposite && allMoved),
  };
}

async function repeatability(probeMs) {
  console.log(`\n══ repeatability ×${REPEAT_N} (after center, no nudge) ══`);
  const snaps = [];
  for (let i = 0; i < REPEAT_N; i += 1) {
    await center(`repeat ${i + 1}`);
    const frame = path.join(OUT, `repeat-${i + 1}.jpg`);
    grabFrame(RTSP, frame, GRAB_TIMEOUT);
    const state = await getBridgeState(BRIDGE);
    const wire = wireFromState(state);
    console.log(`  ${i + 1}: ${wireLine(wire)}`);
    snaps.push({ i: i + 1, frame, wire });
    log({ phase: 'repeat', ...snaps[snaps.length - 1] });
  }

  const tilts = snaps.map((s) => s.wire.tiltRaw);
  const pans = snaps.map((s) => s.wire.panRaw);
  const sameTiltRung = snaps.every((s) => onSameRung(s.wire.tiltRaw, snaps[0].wire.tiltRaw));
  const samePanRung = snaps.every((s) => onSameRung(s.wire.panRaw, snaps[0].wire.panRaw));

  return {
    snaps,
    sameTiltRung,
    samePanRung,
    pass: sameTiltRung && samePanRung,
    tiltRungs: tilts.map(rungIndex),
    panRungs: pans.map(rungIndex),
  };
}

async function closedLoopTrial(targetTilt, targetPan) {
  console.log(`\n══ closed-loop trial → @2=${targetTilt} @8=${targetPan} ══`);
  const TOL = 128;
  const MAX = 12;
  const NUDGE_MS = 1500;

  for (let i = 0; i < MAX; i += 1) {
    await wait066(BRIDGE);
    const state = await getBridgeState(BRIDGE);
    const w = wireFromState(state);
    const tilt = w.tiltRaw;
    const pan = w.panRaw;
    const tiltOk = onSameRung(tilt, targetTilt) || Math.abs(tilt - targetTilt) <= TOL;
    const panOk = onSameRung(pan, targetPan) || Math.abs(pan - targetPan) <= TOL;
    console.log(`  iter ${i}: ${wireLine(w)} want ${targetTilt}/${targetPan} tilt=${tiltOk ? 'ok' : '—'} pan=${panOk ? 'ok' : '—'}`);
    log({ phase: 'closed-loop', iter: i, wire: w, targetTilt, targetPan, tiltOk, panOk });
    if (tiltOk && panOk) return { pass: true, iter: i, wire: w };

    let panN = 0;
    let tiltN = 0;
    if (!tiltOk && tilt != null && targetTilt != null) {
      const cur = rungIndex(tilt);
      const tgt = rungIndex(targetTilt);
      if (cur != null && tgt != null) tiltN = cur < tgt ? -1 : 1;
    }
    if (!panOk && pan != null && targetPan != null && tiltOk) {
      const cur = rungIndex(pan);
      const tgt = rungIndex(targetPan);
      if (cur != null && tgt != null) panN = cur < tgt ? 1 : -1;
    }
    if (!tiltN && !panN) break;
    await bridgeApi(BRIDGE, 'POST', '/move/hold', { pan: panN, tilt: tiltN });
    const end = Date.now() + NUDGE_MS;
    while (Date.now() < end) {
      await sleep(Math.min(200, end - Date.now()));
      if (Date.now() >= end) break;
      await bridgeApi(BRIDGE, 'POST', '/move/hold', { pan: panN, tilt: tiltN });
    }
    await bridgeApi(BRIDGE, 'POST', '/move/stop');
    await sleep(SETTLE_MS);
  }
  const end = wireFromState(await getBridgeState(BRIDGE));
  return { pass: false, wire: end, targetTilt, targetPan };
}

async function main() {
  if (!RTSP) die('Set RTSP_URL');
  const health = await fetch(`${BRIDGE}/health/label`);
  if ((await health.json()) !== 'OK') die('Bridge not OK');

  fs.mkdirSync(OUT, { recursive: true });
  console.log(`Isolate  RTSP ${RTSP}`);
  console.log(`Bridge   ${BRIDGE}`);
  console.log(`OUT      ${OUT}\n`);

  let isolate = null;
  for (const ms of PROBE_MS_STEPS.length ? PROBE_MS_STEPS : [PROBE_MS]) {
    console.log(`\n######## PROBE_MS=${ms} ########`);
    isolate = await isolateAxis(ms);
    if (isolate.pass) break;
    console.log(
      `  signs: tilt=${isolate.tiltOpposite ? 'OK' : 'FAIL'} pan=${isolate.panOpposite ? 'OK' : 'FAIL'} moved=${isolate.allMoved ? 'OK' : 'FAIL'}`,
    );
  }

  const repeat = await repeatability(PROBE_MS);

  let closedLoop = null;
  const tiltPlus = isolate?.steps?.find((s) => s.probe === 'tilt+');
  if (tiltPlus?.wire?.tiltRaw != null && tiltPlus?.wire?.panRaw != null) {
    await center('before closed-loop');
    closedLoop = await closedLoopTrial(tiltPlus.wire.tiltRaw, tiltPlus.wire.panRaw);
  }

  const report = {
    at: new Date().toISOString(),
    isolate,
    repeat,
    closedLoop,
    conclusions: {
      decode: '0x04/0x66 @2 tilt @8 pan — k·256+1 rungs',
      tiltDegNotAim: true,
      tiltSignsReliable: Boolean(isolate?.tiltOpposite),
      panSignsReliable: Boolean(isolate?.panOpposite),
      centerRepeatable: Boolean(repeat?.pass),
      wireSlotRecall: Boolean(closedLoop?.pass),
    },
  };

  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);

  const calibLog = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
  if (repeat.snaps[0]) {
    const row = calibRowFromState(await getBridgeState(BRIDGE), {
      step: 'isolate',
      visual: 'vision-isolate center repeat',
      action: 'vision-isolate',
      notes: wireLine(repeat.snaps[0].wire),
    });
    fs.appendFileSync(calibLog, `${JSON.stringify(row)}\n`);
  }

  console.log(`\n--- REPORT ---`);
  console.log(`tilt+/− opposite on @2: ${report.conclusions.tiltSignsReliable}`);
  console.log(`pan+/− opposite on @8:  ${report.conclusions.panSignsReliable}`);
  console.log(`center repeatability:   ${report.conclusions.centerRepeatable}`);
  console.log(`wire slot recall:       ${report.conclusions.wireSlotRecall}`);
  console.log(`→ ${REPORT}`);

  process.exit(isolate?.pass && repeat?.pass ? 0 : 0);
}

main().catch((err) => die(err.message || String(err)));
