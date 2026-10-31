#!/usr/bin/env node
/**
 * Vision Ralph loop — Larix RTSP frame vs reference, hill-climb nudges via bridge HTTP.
 *
 * Setup:
 *   1. Larix streaming; RTSP_URL from app
 *   2. Aim tape mark → RTSP_URL=... OUT=vision-reference.jpg npm run vision:grab
 *   3. RTSP_URL=... REF=vision-reference.jpg BRIDGE_URL=http://10.0.0.183:8787 npm run vision:loop
 *
 * Env: MAX_ITERS, NUDGE_MS, SETTLE_MS, SSIM_OK (default 0.92), PROBE_MS (short test nudge)
 *       WIRE_PROBE=1 (default) — after visual check, nudge each axis once and log @2/@8 deltas
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';
import { rungIndex } from '../lib/calib-loop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RTSP = process.env.RTSP_URL;
const REF = process.env.REF ?? path.join(ROOT, 'vision-reference.jpg');
const CUR = process.env.CUR ?? path.join(ROOT, 'vision-current.jpg');
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const LOG = process.env.VISION_LOG ?? path.join(ROOT, 'vision-loop.jsonl');

const MAX_ITERS = Number(process.env.MAX_ITERS ?? 24);
const NUDGE_MS = Number(process.env.NUDGE_MS ?? 1200);
const PROBE_MS = Number(process.env.PROBE_MS ?? 600);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 1500);
const SSIM_OK = Number(process.env.SSIM_OK ?? 0.92);
const GRAB_TIMEOUT = Number(process.env.VISION_GRAB_TIMEOUT_SEC ?? 15);
const WIRE_PROBE = process.env.WIRE_PROBE !== '0';
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');

const PROBES = [
  { name: 'tilt+', pan: 0, tilt: 1 },
  { name: 'tilt-', pan: 0, tilt: -1 },
  { name: 'pan+', pan: 1, tilt: 0 },
  { name: 'pan-', pan: -1, tilt: 0 },
];

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function grabFrame(out = CUR) {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-timeout',
      String(GRAB_TIMEOUT * 1_000_000),
      '-i',
      RTSP,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-y',
      out,
    ],
    { stdio: 'pipe', timeout: (GRAB_TIMEOUT + 5) * 1000 },
  );
}

/** Parse SSIM All: from ffmpeg stderr (written even on exit 0). */
function ssimVsRef(currentPath) {
  const { stderr, status } = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-i', REF, '-i', currentPath, '-lavfi', 'ssim', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  if (status !== 0 && status !== null) {
    throw new Error(`ffmpeg ssim failed: ${stderr?.slice(-200) ?? status}`);
  }
  const m = (stderr ?? '').match(/All:([\d.]+)/);
  if (!m) throw new Error('SSIM parse failed — check reference/current frames');
  return Number(m[1]);
}

function logRow(row) {
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

async function getState() {
  const res = await fetch(`${BRIDGE}/state`);
  if (!res.ok) throw new Error(`GET /state → ${res.status}`);
  return res.json();
}

function wireFromState(state) {
  const t = state?.telemetry ?? {};
  return {
    source: t.source ?? null,
    stale: Boolean(t.stale),
    tiltRaw: t.tiltRaw ?? null,
    panRaw: t.panRaw ?? null,
    tiltRung: rungIndex(t.tiltRaw),
    panRung: rungIndex(t.panRaw),
  };
}

function wireLine(w) {
  if (w.tiltRaw == null) return '@2=? @8=? (no 0x66)';
  return `@2=${w.tiltRaw}(r${w.tiltRung}) @8=${w.panRaw}(r${w.panRung}) src=${w.source}${w.stale ? ' STALE' : ''}`;
}

function appendCalibMark(state, { visual, notes }) {
  const row = calibRowFromState(state, {
    step: 'markA',
    visual,
    action: 'vision-mark',
    notes,
  });
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`);
  return row;
}

async function measureWire(phase, extra = {}) {
  const state = await getState();
  const wire = wireFromState(state);
  logRow({ phase, wire, ...extra });
  return { state, wire };
}

function printMarkSummary(state, ssim) {
  const w = wireFromState(state);
  console.log('\n--- MARK A (vision + wire) ---');
  console.log(`SSIM=${ssim?.toFixed?.(4) ?? '?'}`);
  console.log(wireLine(w));
  console.log(`raw: ${state.telemetry?.rawPayload ?? '(none)'}`);
  console.log('(tiltDeg/panDeg are wire/10 — not calibrated aim)');
}

async function nudge({ pan, tilt }, ms) {
  const end = Date.now() + ms;
  await api('POST', '/move/hold', { pan, tilt });
  while (Date.now() < end) {
    await sleep(Math.min(200, end - Date.now()));
    if (Date.now() >= end) break;
    await api('POST', '/move/hold', { pan, tilt });
  }
  await api('POST', '/move/stop');
  await sleep(SETTLE_MS);
}

async function probeDirection(probe, baselineWire) {
  await nudge(probe, PROBE_MS);
  grabFrame(CUR);
  const ssim = ssimVsRef(CUR);
  const { wire } = await measureWire('probe', { probe: probe.name, ssim });
  const undo = { pan: -probe.pan, tilt: -probe.tilt };
  await nudge(undo, PROBE_MS);
  return {
    ssim,
    wire,
    dTilt: wire.tiltRaw != null && baselineWire.tiltRaw != null ? wire.tiltRaw - baselineWire.tiltRaw : null,
    dPan: wire.panRaw != null && baselineWire.panRaw != null ? wire.panRaw - baselineWire.panRaw : null,
  };
}

/** One nudge per d-pad dir — log SSIM + @2/@8 delta vs mark (validates axis signs). */
async function wireProbeBattery(baselineWire) {
  console.log('\nWire probe (each dir nudged briefly, then undone):');
  console.log(`  baseline ${wireLine(baselineWire)}\n`);
  for (const probe of PROBES) {
    await nudge(probe, PROBE_MS);
    grabFrame(CUR);
    const ssim = ssimVsRef(CUR);
    const { wire } = await measureWire('wire-probe', { probe: probe.name, ssim });
    const dTilt = wire.tiltRaw != null && baselineWire.tiltRaw != null ? wire.tiltRaw - baselineWire.tiltRaw : null;
    const dPan = wire.panRaw != null && baselineWire.panRaw != null ? wire.panRaw - baselineWire.panRaw : null;
    console.log(
      `  ${probe.name.padEnd(6)} SSIM=${ssim.toFixed(4)}  d@2=${dTilt ?? '?'}  d@8=${dPan ?? '?'}  → ${wireLine(wire)}`,
    );
    const undo = { pan: -probe.pan, tilt: -probe.tilt };
    await nudge(undo, PROBE_MS);
  }
}

async function main() {
  if (!RTSP) die('Set RTSP_URL (from Larix when streaming).');
  if (!fs.existsSync(REF)) die(`Missing reference: ${REF} — run vision:grab with OUT=vision-reference.jpg at tape mark.`);

  const health = await fetch(`${BRIDGE}/health/label`);
  const label = await health.json();
  if (label !== 'OK') die(`Bridge not OK: ${label}`);

  console.log(`Vision loop  ref=${REF}`);
  console.log(`RTSP ${RTSP}`);
  console.log(`Bridge ${BRIDGE}  SSIM≥${SSIM_OK}\n`);

  for (let i = 0; i < MAX_ITERS; i += 1) {
    grabFrame(CUR);
    const ssim = ssimVsRef(CUR);
    const { state, wire } = await measureWire('measure', { iter: i, ssim });
    console.log(`iter ${i}: SSIM=${ssim.toFixed(4)}  ${wireLine(wire)}`);
    logRow({ iter: i, ssim, phase: 'measure', wire });

    if (ssim >= SSIM_OK) {
      printMarkSummary(state, ssim);
      appendCalibMark(state, {
        visual: 'bottle centered (vision mark A)',
        notes: `SSIM=${ssim.toFixed(4)} from vision-loop`,
      });
      console.log(`→ appended markA to ${CALIB_LOG}`);
      if (WIRE_PROBE) await wireProbeBattery(wire);
      console.log('\nCONVERGED (SSIM threshold)');
      logRow({ iter: i, ssim, phase: 'done', wire });
      return;
    }

    const scores = [];
    for (const probe of PROBES) {
      const result = await probeDirection(probe, wire);
      console.log(
        `  probe ${probe.name}: SSIM=${result.ssim.toFixed(4)}  d@2=${result.dTilt ?? '?'}  d@8=${result.dPan ?? '?'}`,
      );
      scores.push({ probe, ...result });
      logRow({
        iter: i,
        probe: probe.name,
        ssim: result.ssim,
        dTilt: result.dTilt,
        dPan: result.dPan,
        wire: result.wire,
        phase: 'probe',
      });
    }

    scores.sort((a, b) => b.ssim - a.ssim);
    const best = scores[0];

    if (best.ssim <= ssim + 0.002) {
      console.log('\nSTUCK — no probe improved SSIM (lighting moved? ghost BLE?)');
      logRow({ iter: i, ssim, phase: 'stuck', wire });
      process.exit(2);
    }

    console.log(`  → commit ${best.probe.name} ${NUDGE_MS}ms`);
    await nudge(best.probe, NUDGE_MS);
    const { wire: afterWire } = await measureWire('commit', { iter: i, commit: best.probe.name });
    logRow({ iter: i, commit: best.probe.name, ssim: best.ssim, wire: afterWire, phase: 'commit' });
  }

  die('MAX_ITERS reached without convergence');
}

main().catch((err) => die(err.message || String(err)));
