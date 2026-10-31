#!/usr/bin/env node
/**
 * Closed-loop wire targeting via live bridge HTTP (no second BLE session).
 *
 *   TARGET_STEP=p01 npm run calib:closed-loop
 *   TARGET_TILT=2049 TARGET_PAN=1 npm run calib:closed-loop
 *
 * Env: BRIDGE_URL, CALIB_LOG, CLOOP_TOL, CLOOP_MAX, CLOOP_NUDGE_MS, CLOOP_CENTER
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';
import {
  is066State,
  loadTargetFromJsonl,
  pickNudge,
  withinTolerance,
} from '../lib/calib-loop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
const TOL = Number(process.env.CLOOP_TOL ?? 128);
const MAX_ITERS = Number(process.env.CLOOP_MAX ?? 32);
const NUDGE_MS = Number(process.env.CLOOP_NUDGE_MS ?? 1500);
const PAN_NEG_MS = Number(process.env.CLOOP_PAN_NEG_MS ?? 2500);
const WAIT_066_MS = Number(process.env.CLOOP_066_MS ?? 30000);
const CENTER_FIRST = process.env.CLOOP_CENTER === '1';
const TILT_FIRST = process.env.CLOOP_TILT_FIRST !== '0';
const CTR_NEG_PAN = process.env.CLOOP_CTR_NEG_PAN === '1';

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function api(method, path, body) {
  const res = await fetch(`${BRIDGE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) die(`${method} ${path} → ${res.status}: ${json.error ?? text}`);
  return json;
}

async function getState() {
  const res = await fetch(`${BRIDGE}/state`);
  if (!res.ok) die(`GET /state → ${res.status}`);
  return res.json();
}

async function waitFor066(timeoutMs = WAIT_066_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState();
    if (is066State(state)) return state;
    await sleep(400);
  }
  die(`timeout — no 0x04/0x66 within ${timeoutMs}ms (try POST /telemetry/refresh)`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveTarget() {
  if (process.env.TARGET_TILT != null && process.env.TARGET_PAN != null) {
    return {
      step: 'env',
      visual: 'TARGET_TILT/TARGET_PAN',
      tiltRaw: Number(process.env.TARGET_TILT),
      panRaw: Number(process.env.TARGET_PAN),
    };
  }
  const step = process.env.TARGET_STEP ?? 'p01';
  const t = loadTargetFromJsonl(CALIB_LOG, step);
  if (!t) die(`no 0x66 row for step ${step} in ${CALIB_LOG}`);
  return t;
}

async function main() {
  const target = resolveTarget();
  console.log(`Target ${target.step}: tilt=${target.tiltRaw} pan=${target.panRaw} (${target.visual})`);
  console.log(`Bridge ${BRIDGE} tol=±${TOL}\n`);

  console.log('→ POST /telemetry/refresh');
  await api('POST', '/telemetry/refresh');
  await waitFor066();

  if (CENTER_FIRST) {
    console.log('→ POST /center');
    await api('POST', '/center');
    await sleep(2500);
    await waitFor066();
  }

  let ctrNegPanDone = false;

  const trail = [];
  for (let i = 0; i < MAX_ITERS; i += 1) {
    const state = await waitFor066(WAIT_066_MS);
    const { tiltRaw: tilt, panRaw: pan } = state.telemetry;
    const tiltOk = withinTolerance(tilt, target.tiltRaw, TOL);
    const panOk = withinTolerance(pan, target.panRaw, TOL);

    console.log(
      `iter ${i}: tilt=${tilt}(${tiltOk ? 'ok' : '—'}) pan=${pan}(${panOk ? 'ok' : '—'}) want ${target.tiltRaw}/${target.panRaw}`,
    );
    trail.push({ iter: i, tilt, pan, tiltOk, panOk });

    if (tiltOk && panOk) {
      const row = calibRowFromState(state, {
        step: 'closed-loop-ok',
        visual: `wire match ${target.step}`,
        action: 'closed-loop',
        notes: `target tilt=${target.tiltRaw} pan=${target.panRaw} tol=${TOL}`,
      });
      row.target = target;
      row.trail = trail;
      console.log('\nMATCH');
      console.log(JSON.stringify(row, null, 2));
      fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
      console.log(`\n→ appended ${CALIB_LOG}`);
      console.log('\nHuman gate: does the camera framing look right? (yes/no)');
      return;
    }

    const nudge = pickNudge(tilt, pan, target.tiltRaw, target.panRaw, TOL, {
      tiltFirst: TILT_FIRST,
    });
    if (!nudge) break;

    if (
      CTR_NEG_PAN &&
      !ctrNegPanDone &&
      tiltOk &&
      !panOk &&
      target.panRaw < 0 &&
      pan != null &&
      pan > target.panRaw
    ) {
      console.log('  → skip CTR (tilt OK) — pan− rungs only');
      ctrNegPanDone = true;
    }

    const ms = nudge.pan < 0 && target.panRaw < 0 ? PAN_NEG_MS : NUDGE_MS;
    console.log(`  nudge pan=${nudge.pan} tilt=${nudge.tilt} ${ms}ms`);
    const end = Date.now() + ms;
    await api('POST', '/move/hold', nudge);
    while (Date.now() < end) {
      await sleep(Math.min(200, end - Date.now()));
      if (Date.now() >= end) break;
      await api('POST', '/move/hold', nudge);
    }
    await api('POST', '/move/stop');
    await sleep(800);
  }

  const final = await getState();
  const row = calibRowFromState(final, {
    step: 'closed-loop-fail',
    visual: `wire miss ${target.step}`,
    action: 'closed-loop',
    notes: `target tilt=${target.tiltRaw} pan=${target.panRaw} tol=${TOL}`,
  });
  row.target = target;
  row.trail = trail;
  console.log('\nMISS');
  console.log(JSON.stringify(row, null, 2));
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
  die('closed loop did not converge — check trail', 2);
}

main().catch((err) => die(err.message || String(err)));
