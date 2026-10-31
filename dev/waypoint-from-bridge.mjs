#!/usr/bin/env node
/**
 * Replay Ronin Track 0x62 path via running bridge (no second BLE session).
 *
 *   BRIDGE_URL=http://10.0.0.183:8787 npm run waypoint:from-bridge -- stage0g
 *   BRIDGE_URL=... npm run waypoint:from-bridge -- capture
 *   BRIDGE_URL=... npm run waypoint:from-bridge -- hex 0a020000...
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build062Path, pose066ToTrackWire } from '../lib/gimbal-waypoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const SAVED = process.env.PRESET_PATH ?? path.join(ROOT, 'saved-pose.json');
const TIMEOUT_MS = Number(process.env.TRACK_HTTP_TIMEOUT_MS ?? 120000);
const CENTER_MS = Number(process.env.TRACK_CENTER_MS ?? 4000);

async function api(method, path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BRIDGE}${path}`, {
      method,
      signal: ctrl.signal,
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
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.error ?? text}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function state() {
  const res = await fetch(`${BRIDGE}/state`);
  if (!res.ok) throw new Error(`GET /state → ${res.status}`);
  return res.json();
}

function fmt(s) {
  const t = s.telemetry ?? {};
  return `tilt=${t.tiltRaw} pan=${t.panRaw} src=${t.source}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const mode = process.argv[2] ?? 'stage0g';
  console.log(`Track replay @ ${BRIDGE} mode=${mode}\n`);

  const before = await state();
  if (!before.ok) throw new Error('gimbal not connected');
  console.log(`before: ${fmt(before)}`);

  let body;
  if (mode === 'capture') {
    const t = before.telemetry ?? {};
    if (t.tiltRaw == null || t.panRaw == null) {
      throw new Error('need attitude tilt/pan before capture');
    }
    const pt = pose066ToTrackWire({
      tiltRaw: t.tiltRaw,
      panRaw: t.panRaw,
      rollRaw: t.rollRaw,
      layout: t.layout,
    });
    const record = {
      savedAt: new Date().toISOString(),
      source: t.source,
      layout: t.layout,
      tiltRaw: t.tiltRaw,
      panRaw: t.panRaw,
      tiltDeg: t.tiltDeg,
      panDeg: t.panDeg,
      track: pt,
      trackMap: 'REA identity TLV°×10 → Track wire (no negate)',
    };
    fs.writeFileSync(SAVED, `${JSON.stringify(record, null, 2)}\n`);
    console.log(
      `saved → ${SAVED} layout=${t.layout} pitch=${pt.pitch} yaw=${pt.yaw} (${t.tiltDeg}°/${t.panDeg}°)`,
    );

    console.log('→ POST /center');
    await api('POST', '/center');
    await sleep(CENTER_MS);
    const centered = await state();
    console.log(`centered: ${fmt(centered)}`);

    // ≥2 waypoints required; duplicate saved pose (Ronin Preview gate).
    const payload = build062Path([pt, { ...pt, moveTime: 20 }]);
    body = {
      payloadHex: payload.toString('hex'),
      followMs: Number(process.env.TRACK_FOLLOW_MS ?? 20000),
      pollMs: Number(process.env.TRACK_POLL_MS ?? 4000),
      prePolls: Number(process.env.TRACK_PRE_POLLS ?? 3),
    };
    console.log(`0x62 ×2: ${body.payloadHex}\n`);
  } else if (mode === 'hex') {
    body = {
      payloadHex: process.argv[3],
      followMs: Number(process.env.TRACK_FOLLOW_MS ?? 20000),
    };
    if (!body.payloadHex) throw new Error('usage: waypoint:from-bridge hex <payloadHex>');
  } else {
    body = {
      mode: 'stage0g',
      followMs: Number(process.env.TRACK_FOLLOW_MS ?? 20000),
      pollMs: Number(process.env.TRACK_POLL_MS ?? 4000),
      prePolls: Number(process.env.TRACK_PRE_POLLS ?? 3),
    };
  }

  console.log('→ POST /track/replay (watch gimbal…)\n');
  const result = await api('POST', '/track/replay', body);
  console.log('replay:', JSON.stringify(result));

  await sleep(1500);
  try {
    await api('POST', '/telemetry/refresh');
  } catch {
    /* optional */
  }
  const after = await state();
  console.log(`after:  ${fmt(after)}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
