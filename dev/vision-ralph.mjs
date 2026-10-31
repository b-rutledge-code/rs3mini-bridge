#!/usr/bin/env node
/**
 * Ralph loop — run until wire + vision correlation passes, or MAX_ROUNDS exhausted.
 * No centering. No operator prompts. Retries with longer nudges / telemetry refresh.
 *
 *   source .local/vision.env && npm run vision:ralph
 *
 * Exit 0 → vision-understanding.json written (ready to stop).
 * Exit 1 → failed gates after all rounds (log has evidence).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';
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
const OUT_DIR = process.env.VISION_OUT ?? path.join(ROOT, 'vision-ralph');
const LOG = process.env.VISION_RALPH_LOG ?? path.join(ROOT, 'vision-ralph.jsonl');
const REPORT = process.env.VISION_REPORT ?? path.join(ROOT, 'vision-understanding.json');

const MAX_ROUNDS = Number(process.env.RALPH_MAX_ROUNDS ?? 24);
const CONSECUTIVE_PASS = Number(process.env.RALPH_PASS_STREAK ?? 1);
const CENTER_BETWEEN_CYCLES = process.env.RALPH_NO_CENTER !== '1';
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 1200);
const GRAB_TIMEOUT = Number(process.env.VISION_GRAB_TIMEOUT_SEC ?? 15);
const VISUAL_SSIM_MAX = Number(process.env.RALPH_VISUAL_SSIM ?? 0.985);
const PROBE_MS_STEPS = (process.env.RALPH_PROBE_MS ?? '600,800,1200,1600,2000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => n > 0);

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function logRow(row) {
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

function sign(n) {
  if (n == null || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

function evaluateProbe(row) {
  const failures = [];
  const passes = [];

  if (!probeMovedWire(row)) failures.push(`${row.probe}: wire did not move`);
  else passes.push(`${row.probe}: wire d@2=${row.dTilt} d@8=${row.dPan}`);

  const visualOk = probeMovedVisual(row, VISUAL_SSIM_MAX);
  if (visualOk === false) failures.push(`${row.probe}: vision unchanged (SSIM=${row.visualSsim?.toFixed(4)})`);
  else if (visualOk === true) passes.push(`${row.probe}: vision SSIM=${row.visualSsim?.toFixed(4)}`);

  if (!row.undoOk) {
    passes.push(`${row.probe}: undo approx (tries=${row.undoTries}) → ${wireLine(row.afterUndo)}`);
  } else {
    passes.push(`${row.probe}: undo ok (${row.undoTries} tries)`);
  }

  return { ok: failures.length === 0, failures, passes, row };
}

function evaluateCycle(cycleRows) {
  const failures = [];
  const passes = [];
  for (const row of cycleRows) {
    const r = evaluateProbe(row);
    passes.push(...r.passes);
    failures.push(...r.failures);
  }
  return { ok: failures.length === 0, failures, passes, rows: cycleRows };
}

function learnedModel(rows) {
  const model = {};
  for (const row of rows) {
    model[row.probe] = {
      dTilt: row.dTilt,
      dPan: row.dPan,
      visualSsim: row.visualSsim,
      wire: row.wire,
    };
  }
  return model;
}

function signsMatch(a, b) {
  for (const name of ['tilt+', 'tilt-', 'pan+', 'pan-']) {
    const ra = a[name];
    const rb = b[name];
    if (!ra || !rb) return false;
    if (sign(ra.dTilt) !== sign(rb.dTilt)) return false;
    if (sign(ra.dPan) !== sign(rb.dPan)) return false;
  }
  return true;
}

async function main() {
  if (!RTSP) die('Set RTSP_URL');
  if (!PROBE_MS_STEPS.length) die('RALPH_PROBE_MS empty');

  const health = await fetch(`${BRIDGE}/health/label`);
  const ble = await health.json();
  if (ble !== 'OK') die(`Bridge not OK: ${ble}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (CENTER_BETWEEN_CYCLES) {
    try {
      console.log('POST /center before first cycle…');
      await bridgeApi(BRIDGE, 'POST', '/center');
      await sleep(5000);
    } catch (err) {
      console.log(`center failed: ${err.message}`);
    }
  }

  console.log('Ralph loop — run until wire+vision gates pass');
  console.log(`RTSP ${RTSP}`);
  console.log(`Bridge ${BRIDGE}`);
  console.log(`max rounds ${MAX_ROUNDS}, need ${CONSECUTIVE_PASS} consecutive pass\n`);

  let passStreak = 0;
  let probeMsIdx = 0;
  let lastModel = null;
  let lastBaseline = null;
  let cycleRows = [];
  let cycleNum = 0;
  let cycleBaseline = null;

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const probeMs = PROBE_MS_STEPS[Math.min(probeMsIdx, PROBE_MS_STEPS.length - 1)];
    const probe = PROBES[(round - 1) % PROBES.length];
    const isCycleStart = (round - 1) % PROBES.length === 0;

    if (isCycleStart) {
      cycleNum += 1;
      cycleRows = [];
      console.log(`\n══ cycle ${cycleNum}  PROBE_MS=${probeMs} ══`);
    } else {
      console.log(`── ${probe.name}  PROBE_MS=${probeMs} ──`);
    }

    try {
      await wait066(BRIDGE);
    } catch (err) {
      console.log(`  wait 0x66: ${err.message} — refresh telemetry`);
      try {
        await bridgeApi(BRIDGE, 'POST', '/telemetry/refresh');
        await sleep(2000);
        await wait066(BRIDGE);
      } catch (err2) {
        logRow({ round, phase: 'fail', error: err2.message });
        console.log(`  ${err2.message}`);
        passStreak = 0;
        cycleRows = [];
        cycleBaseline = null;
        continue;
      }
    }

    if (isCycleStart) {
      const baselineFrame = path.join(OUT_DIR, `c${cycleNum}-baseline.jpg`);
      grabFrame(RTSP, baselineFrame, GRAB_TIMEOUT);
      const baseState = await getBridgeState(BRIDGE);
      const baselineWire = wireFromState(baseState);
      cycleBaseline = { frame: baselineFrame, wire: baselineWire, state: baseState };
      console.log(`  baseline ${wireLine(baselineWire)}`);
    }

    const { frame: baselineFrame, wire: baselineWire, state: baseState } = cycleBaseline;
    const row = await runSingleProbe({
      bridge: BRIDGE,
      rtsp: RTSP,
      outDir: OUT_DIR,
      frameLabel: `c${cycleNum}-${probe.name}`,
      probe,
      probeMs,
      settleMs: SETTLE_MS,
      grabTimeoutSec: GRAB_TIMEOUT,
      baselineWire,
      baselineFrame,
    });
    cycleRows.push(row);

    const probeResult = evaluateProbe(row);
    for (const p of probeResult.passes) console.log(`  ✓ ${p}`);
    for (const f of probeResult.failures) console.log(`  ✗ ${f}`);

    const isCycleEnd = round % PROBES.length === 0;
    if (!isCycleEnd) continue;

    const result = evaluateCycle(cycleRows);
    logRow({
      round,
      cycle: cycleNum,
      probeMs,
      phase: result.ok ? 'pass' : 'fail',
      baseline: baselineWire,
      rows: cycleRows,
      failures: result.failures,
    });

    if (result.ok) {
      const model = learnedModel(cycleRows);
      if (lastModel && !signsMatch(lastModel, model)) {
        console.log('  ✗ sign flip vs previous cycle');
        passStreak = 0;
      } else {
        passStreak += 1;
        console.log(`  cycle pass ${passStreak}/${CONSECUTIVE_PASS}`);
      }
      lastModel = model;
      lastBaseline = { wire: baselineWire, frame: baselineFrame, state: baseState };

      if (passStreak >= CONSECUTIVE_PASS) {
        const report = {
          at: new Date().toISOString(),
          cycles: cycleNum,
          probeMs,
          baseline: {
            wire: lastBaseline.wire,
            frame: lastBaseline.frame,
            raw: lastBaseline.wire.rawPayload,
          },
          model: lastModel,
          notes: [
            'tiltDeg/panDeg are wire/10 — not calibrated aim',
            'pan d-pad may move @2 (axis coupling)',
            'wire quantizes k·256+1',
          ],
        };
        fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
        const calibRow = calibRowFromState(lastBaseline.state, {
          step: 'ralph',
          visual: 'vision-ralph baseline (bottle in frame)',
          action: 'vision-ralph pass',
          notes: wireLine(lastBaseline.wire),
        });
        fs.appendFileSync(
          process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl'),
          `${JSON.stringify(calibRow)}\n`,
        );
        console.log(`\nDONE — understanding written to ${REPORT}`);
        console.log(`log → ${LOG}`);
        process.exit(0);
      }
    } else {
      passStreak = 0;
      console.log('  cycle FAIL');
      for (const f of result.failures) {
        if (!cycleRows.some((r) => f.startsWith(r.probe))) console.log(`  ✗ ${f}`);
      }
      if (probeMsIdx < PROBE_MS_STEPS.length - 1) probeMsIdx += 1;
      else {
        try {
          await bridgeApi(BRIDGE, 'POST', '/telemetry/refresh');
          await sleep(1500);
        } catch {
          /* retry */
        }
      }
    }

    if (CENTER_BETWEEN_CYCLES) {
      try {
        console.log('  → POST /center (recover range for next cycle)');
        await bridgeApi(BRIDGE, 'POST', '/center');
        await sleep(4000);
      } catch (err) {
        console.log(`  center failed: ${err.message}`);
      }
    }

    await sleep(500);
  }

  die(`RALPH_MAX_ROUNDS (${MAX_ROUNDS}) — gates never passed ${CONSECUTIVE_PASS} cycles. See ${LOG}`);
}

main().catch((err) => die(err.message || String(err)));
