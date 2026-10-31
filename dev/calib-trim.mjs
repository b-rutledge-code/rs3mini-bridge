#!/usr/bin/env node
/** Visual trim: npm run calib:trim -- down 2.5 */

import { parseTrimArgs } from '../lib/visual-trim.js';

const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const { pan, tilt, sec, label } = parseTrimArgs(process.argv);

async function api(method, path, body) {
  const res = await fetch(`${BRIDGE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.status);
  return json;
}

async function state() {
  return (await fetch(`${BRIDGE}/state`)).json();
}

const before = await state();
const bt = before.telemetry ?? {};
console.log(`→ ${label} ${sec}s`);
const end = Date.now() + sec * 1000;
await api('POST', '/move/hold', { pan, tilt });
while (Date.now() < end) {
  await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
  if (Date.now() >= end) break;
  await api('POST', '/move/hold', { pan, tilt });
}
await api('POST', '/move/stop');
await new Promise((r) => setTimeout(r, 600));
const after = await state();
const at = after.telemetry ?? {};
console.log(`wire: tilt ${bt.tiltRaw}→${at.tiltRaw}  pan ${bt.panRaw}→${at.panRaw}`);
console.log('Eyes on tape — better / worse / on?');
