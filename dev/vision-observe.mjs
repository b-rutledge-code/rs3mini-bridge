#!/usr/bin/env node
/**
 * Larix frame + bridge @2/@8 — no centering, no SSIM target.
 * Grab what the gimbal sees; nudge each axis; log wire deltas + save frames.
 *
 *   source .local/vision.env && npm run vision:observe
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';
import { rungIndex } from '../lib/calib-loop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RTSP = process.env.RTSP_URL;
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const LOG = process.env.VISION_LOG ?? path.join(ROOT, 'vision-observe.jsonl');
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
const OUT_DIR = process.env.VISION_OUT ?? path.join(ROOT, 'vision-observe');
const PROBE_MS = Number(process.env.PROBE_MS ?? 800);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 1200);
const GRAB_TIMEOUT = Number(process.env.VISION_GRAB_TIMEOUT_SEC ?? 15);
const PROBE = process.env.VISION_PROBE !== '0';

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
    rawPayload: t.rawPayload ?? null,
  };
}

function wireLine(w) {
  if (w.tiltRaw == null) return '@2=? @8=? (no 0x66)';
  return `@2=${w.tiltRaw}(r${w.tiltRung}) @8=${w.panRaw}(r${w.panRung})`;
}

function logRow(row) {
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

function grabFrame(out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
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

async function snapshot(label) {
  const frame = path.join(OUT_DIR, `${label}.jpg`);
  grabFrame(frame);
  const state = await getState();
  const wire = wireFromState(state);
  const row = { label, frame, wire };
  logRow({ phase: 'snapshot', ...row });
  return { frame, state, wire };
}

async function main() {
  if (!RTSP) die('Set RTSP_URL (Larix stream).');

  const health = await fetch(`${BRIDGE}/health/label`);
  const label = await health.json();
  if (label !== 'OK') die(`Bridge not OK: ${label}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Observe  RTSP ${RTSP}`);
  console.log(`Bridge   ${BRIDGE}`);
  console.log(`Frames   ${OUT_DIR}/\n`);

  const base = await snapshot('00-baseline');
  console.log(`baseline  ${wireLine(base.wire)}`);
  console.log(`          ${base.frame}`);
  console.log(`raw       ${base.wire.rawPayload ?? '(none)'}\n`);

  const calibRow = calibRowFromState(base.state, {
    step: 'observe',
    visual: 'bottle on table (whatever is in frame)',
    action: 'vision-observe baseline',
    notes: wireLine(base.wire),
  });
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(calibRow)}\n`);

  if (!PROBE) {
    console.log('VISION_PROBE=0 — baseline only.');
    return;
  }

  console.log('Axis probes (nudge → frame + wire → undo):\n');
  for (const probe of PROBES) {
    await nudge(probe, PROBE_MS);
    const shot = await snapshot(`probe-${probe.name}`);
    const dTilt =
      shot.wire.tiltRaw != null && base.wire.tiltRaw != null
        ? shot.wire.tiltRaw - base.wire.tiltRaw
        : null;
    const dPan =
      shot.wire.panRaw != null && base.wire.panRaw != null
        ? shot.wire.panRaw - base.wire.panRaw
        : null;
    console.log(
      `${probe.name.padEnd(6)} d@2=${dTilt ?? '?'} d@8=${dPan ?? '?'}  ${wireLine(shot.wire)}`,
    );
    console.log(`         ${shot.frame}\n`);
    logRow({ phase: 'probe', probe: probe.name, dTilt, dPan, wire: shot.wire, frame: shot.frame });
    const undo = { pan: -probe.pan, tilt: -probe.tilt };
    await nudge(undo, PROBE_MS);
  }

  const end = await snapshot('99-after-undo');
  console.log(`after undo  ${wireLine(end.wire)}`);
  console.log(`log → ${LOG}`);
}

main().catch((err) => die(err.message || String(err)));
