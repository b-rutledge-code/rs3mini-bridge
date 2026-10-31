#!/usr/bin/env node
/**
 * Snapshot calibration row from live rs3mini-bridge GET /state (no second BLE session).
 * Use while the service is running and 0x04/0x66 telemetry is flowing.
 *
 *   CALIB_STEP=p02b CALIB_LABEL="straight up" npm run calib:from-bridge
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibRowFromState } from '../lib/calib-decode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CALIB_LOG = process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');
const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787/state';
const REQUIRE_066 = process.env.CALIB_REQUIRE_066 !== '0';

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

const res = await fetch(BRIDGE_URL);
if (!res.ok) die(`GET ${BRIDGE_URL} → ${res.status}`);
const state = await res.json();

if (!state.ok) die('bridge not connected to gimbal');
if (state.telemetry?.stale) die('telemetry stale — wait for fresh notify');
if (REQUIRE_066 && state.telemetry?.source !== '0x04/0x66') {
  die(`need 0x04/0x66 (got ${state.telemetry?.source ?? 'none'}) — try POST /center then reframe`);
}

const row = calibRowFromState(state, {
  step: process.env.CALIB_STEP,
  visual: process.env.CALIB_LABEL,
  action: 'bridge-state',
  notes: process.env.CALIB_NOTES,
});

console.log(JSON.stringify(row, null, 2));
if (process.env.CALIB_LABEL) {
  fs.appendFileSync(CALIB_LOG, `${JSON.stringify(row)}\n`, 'utf8');
  console.log(`→ appended ${CALIB_LOG}`);
}
