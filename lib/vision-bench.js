/**
 * Shared Larix grab + bridge wire helpers for vision bench scripts.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rungIndex, onSameRung, WIRE_QUANTUM } from './calib-loop.js';

export const PROBES = [
  { name: 'tilt+', pan: 0, tilt: 1 },
  { name: 'tilt-', pan: 0, tilt: -1 },
  { name: 'pan+', pan: 1, tilt: 0 },
  { name: 'pan-', pan: -1, tilt: 0 },
];

export function wireFromState(state) {
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

export function wireLine(w) {
  if (w.tiltRaw == null) return '@2=? @8=? (no 0x66)';
  return `@2=${w.tiltRaw}(r${w.tiltRung}) @8=${w.panRaw}(r${w.panRung})`;
}

export function wireDelta(before, after) {
  return {
    dTilt: after.tiltRaw != null && before.tiltRaw != null ? after.tiltRaw - before.tiltRaw : null,
    dPan: after.panRaw != null && before.panRaw != null ? after.panRaw - before.panRaw : null,
    tiltRungChanged: !onSameRung(before.tiltRaw, after.tiltRaw),
    panRungChanged: !onSameRung(before.panRaw, after.panRaw),
  };
}

export function grabFrame(rtsp, out, grabTimeoutSec = 15) {
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
      String(grabTimeoutSec * 1_000_000),
      '-i',
      rtsp,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-y',
      out,
    ],
    { stdio: 'pipe', timeout: (grabTimeoutSec + 5) * 1000 },
  );
}

/** Retry Larix grab when phone/mediamtx drops (404, timeout). */
export async function grabFrameRetry(
  rtsp,
  out,
  grabTimeoutSec = 15,
  { retries = 24, pauseMs = 5000 } = {},
) {
  let lastErr;
  for (let i = 0; i < retries; i += 1) {
    try {
      grabFrame(rtsp, out, grabTimeoutSec);
      return;
    } catch (err) {
      lastErr = err;
      if (i + 1 >= retries) break;
      const msg = String(err.message ?? err).split('\n')[0].slice(0, 80);
      console.log(`  RTSP wait (${msg}) — retry ${i + 2}/${retries} in ${pauseMs / 1000}s`);
      await sleep(pauseMs);
    }
  }
  throw lastErr;
}

/** SSIM between two frames — lower means more visual change. */
export function ssimBetween(aPath, bPath) {
  const { stderr, status } = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-i', aPath, '-i', bPath, '-lavfi', 'ssim', '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  if (status !== 0 && status !== null) {
    throw new Error(`ffmpeg ssim failed: ${stderr?.slice(-200) ?? status}`);
  }
  const m = (stderr ?? '').match(/All:([\d.]+)/);
  if (!m) throw new Error('SSIM parse failed');
  return Number(m[1]);
}

export async function bridgeApi(bridge, method, p, body) {
  const res = await fetch(`${bridge}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${json.error ?? res.status}`);
  return json;
}

export async function getBridgeState(bridge) {
  const res = await fetch(`${bridge}/state`);
  if (!res.ok) throw new Error(`GET /state → ${res.status}`);
  return res.json();
}

export async function wait066(bridge, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await getBridgeState(bridge);
    const w = wireFromState(state);
    if (state.ok && w.source === '0x04/0x66' && !w.stale && w.tiltRaw != null) return state;
    await sleep(400);
  }
  throw new Error(`no fresh 0x04/0x66 within ${timeoutMs}ms`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Timed slew via hold lease — pulse /move/hold while waiting, then /move/stop. */
export async function nudgeMove(bridge, { pan, tilt }, ms, settleMs) {
  const pulseMs = Math.min(200, Math.max(50, Math.floor(ms / 2) || 200));
  const end = Date.now() + ms;
  await bridgeApi(bridge, 'POST', '/move/hold', { pan, tilt });
  while (Date.now() < end) {
    await sleep(Math.min(pulseMs, end - Date.now()));
    if (Date.now() >= end) break;
    await bridgeApi(bridge, 'POST', '/move/hold', { pan, tilt });
  }
  await bridgeApi(bridge, 'POST', '/move/stop');
  await sleep(settleMs);
}

/** Single probe + undo; returns row with per-probe undo check. */
export async function runSingleProbe({
  bridge,
  rtsp,
  outDir,
  frameLabel,
  probe,
  probeMs,
  settleMs,
  grabTimeoutSec,
  baselineWire,
  baselineFrame,
}) {
  await nudgeMove(bridge, probe, probeMs, settleMs);
  const frame = path.join(outDir, `${frameLabel}.jpg`);
  grabFrame(rtsp, frame, grabTimeoutSec);
  const state = await getBridgeState(bridge);
  const wire = wireFromState(state);
  const delta = wireDelta(baselineWire, wire);
  let visualSsim = null;
  try {
    visualSsim = ssimBetween(baselineFrame, frame);
  } catch {
    /* optional */
  }
  const undo = { pan: -probe.pan, tilt: -probe.tilt };
  await nudgeMove(bridge, undo, probeMs, settleMs);
  const afterUndo = wireFromState(await getBridgeState(bridge));
  const undoOk =
    onSameRung(afterUndo.tiltRaw, baselineWire.tiltRaw) &&
    onSameRung(afterUndo.panRaw, baselineWire.panRaw);
  return {
    probe: probe.name,
    frame,
    wire,
    afterUndo,
    undoOk,
    undoTries: 1,
    ...delta,
    visualSsim,
  };
}

/** One full probe battery from current pose; returns rows, undoes each probe. */
export async function runProbeBattery({
  bridge,
  rtsp,
  outDir,
  round,
  probeMs,
  settleMs,
  grabTimeoutSec,
  baselineWire,
  baselineFrame,
}) {
  const rows = [];
  for (const probe of PROBES) {
    await nudgeMove(bridge, probe, probeMs, settleMs);
    const frame = path.join(outDir, `r${round}-${probe.name}.jpg`);
    grabFrame(rtsp, frame, grabTimeoutSec);
    const state = await getBridgeState(bridge);
    const wire = wireFromState(state);
    const delta = wireDelta(baselineWire, wire);
    let visualSsim = null;
    try {
      visualSsim = ssimBetween(baselineFrame, frame);
    } catch {
      /* optional */
    }
    rows.push({
      probe: probe.name,
      frame,
      wire,
      ...delta,
      visualSsim,
    });
    const undo = { pan: -probe.pan, tilt: -probe.tilt };
    await nudgeMove(bridge, undo, probeMs, settleMs);
  }
  return rows;
}

export function probeMovedWire(row, minDelta = WIRE_QUANTUM / 2) {
  const d2 = Math.abs(row.dTilt ?? 0);
  const d8 = Math.abs(row.dPan ?? 0);
  return row.tiltRungChanged || row.panRungChanged || d2 >= minDelta || d8 >= minDelta;
}

export function probeMovedVisual(row, threshold = 0.97) {
  if (row.visualSsim == null) return null;
  return row.visualSsim < threshold;
}
