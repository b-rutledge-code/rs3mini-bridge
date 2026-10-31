/**
 * RS 3 Mini 0x66 @2/@8 wire quantizes to k·256 + 1 (bench 2026-06-17).
 */

import fs from 'node:fs';

export const WIRE_QUANTUM = 256;
export const WIRE_OFFSET = 1;

export function rungIndex(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round((value - WIRE_OFFSET) / WIRE_QUANTUM);
}

export function wireRung(value) {
  const k = rungIndex(value);
  if (k == null) return null;
  return k * WIRE_QUANTUM + WIRE_OFFSET;
}

export function onSameRung(a, b) {
  const ia = rungIndex(a);
  const ib = rungIndex(b);
  return ia != null && ia === ib;
}

export function withinTolerance(current, target, tolerance) {
  if (current == null || target == null) return false;
  if (onSameRung(current, target)) return true;
  return Math.abs(current - target) <= tolerance;
}

/**
 * Bench-learned d-pad signs: tilt+ lowers @2; pan+ raises @8.
 * Nudge one rung at a time on the wire ladder.
 */
export function nudgeForAxis(current, target, axis) {
  if (current == null || target == null) return null;
  const cur = rungIndex(current);
  const tgt = rungIndex(target);
  if (cur == null || tgt == null || cur === tgt) return null;

  if (axis === 'tilt') {
    if (cur < tgt) return { pan: 0, tilt: -1 };
    return { pan: 0, tilt: 1 };
  }
  if (axis === 'pan') {
    if (cur < tgt) return { pan: 1, tilt: 0 };
    return { pan: -1, tilt: 0 };
  }
  return null;
}

/** Larger wire rung error first; optional tilt-before-pan sequencing. */
export function pickNudge(tilt, pan, targetTilt, targetPan, tolerance, { tiltFirst = false } = {}) {
  const tiltOk = withinTolerance(tilt, targetTilt, tolerance);
  const panOk = withinTolerance(pan, targetPan, tolerance);
  if (tiltOk && panOk) return null;

  if (tiltFirst && !tiltOk) {
    return nudgeForAxis(tilt, targetTilt, 'tilt');
  }
  if (tiltFirst && tiltOk && !panOk) {
    return nudgeForAxis(pan, targetPan, 'pan');
  }

  const tiltErr =
    tilt != null && targetTilt != null ? Math.abs(rungIndex(tilt) - rungIndex(targetTilt)) : 0;
  const panErr =
    pan != null && targetPan != null ? Math.abs(rungIndex(pan) - rungIndex(targetPan)) : 0;

  if (panErr > tiltErr) return nudgeForAxis(pan, targetPan, 'pan');
  if (tiltErr > 0) return nudgeForAxis(tilt, targetTilt, 'tilt');
  return nudgeForAxis(pan, targetPan, 'pan');
}

export function is066State(state) {
  const t = state?.telemetry;
  return state?.ok && !t?.stale && t?.source === '0x04/0x66' && t?.tiltRaw != null;
}

export function loadTargetFromJsonl(file, step = 'p01') {
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.step !== step) continue;
    if (row.bridge?.source !== '0x04/0x66') continue;
    return {
      step: row.step,
      visual: row.visual,
      tiltRaw: row.bridge.tiltRaw,
      panRaw: row.bridge.panRaw,
      rawHex: row.decode066?.rawHex ?? null,
    };
  }
  return null;
}
