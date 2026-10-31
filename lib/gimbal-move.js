import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMessage, TARGET_APP_TO_GIMBAL } from './duml.js';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_PATH = path.join(__dirname, '..', 'move-presets.json');
const SAMPLES_PATH = path.join(__dirname, '..', 'capture-samples.json');

/** RS 3 Mini 0x04/0x01 payload tail (stage0d capture). */
const STICK_TAIL = Buffer.from([0x00, 0x00, 0x02]);
const JOYSTICK_FLAGS = 0x40;
const DEFAULT_STICK_SCALE = 0.05;

let presetsCache;
let loggedScale = false;

/** Fraction of Stage 0d stick throw. Clamp to (0, 1]; invalid/missing → 0.1. */
export function stickScale() {
  const raw = Number(process.env.MOVE_STICK_SCALE ?? DEFAULT_STICK_SCALE);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_STICK_SCALE;
  return Math.min(1, raw);
}

function scaledStick(mid, extreme, scale) {
  return Math.round(mid + scale * (extreme - mid));
}

export function loadPresets() {
  if (!presetsCache) {
    presetsCache = JSON.parse(fs.readFileSync(PRESETS_PATH, 'utf8'));
  }
  return presetsCache;
}

export function loadPairingHex() {
  const samples = JSON.parse(fs.readFileSync(SAMPLES_PATH, 'utf8'));
  return samples.pairing || '0100';
}

function axisLabel(pan, tilt) {
  const parts = [];
  if (tilt > 0) parts.push('tilt+');
  else if (tilt < 0) parts.push('tilt-');
  if (pan > 0) parts.push('pan+');
  else if (pan < 0) parts.push('pan-');
  return parts.join('+') || 'none';
}

/** Build one live 0x04/0x01 joystick frame (new DUML seq + CRC each call). */
export function buildJoystickFrame(a, b, c) {
  const payload = Buffer.alloc(9);
  payload.writeUInt16LE(a, 0);
  payload.writeUInt16LE(b, 2);
  payload.writeUInt16LE(c, 4);
  STICK_TAIL.copy(payload, 6);
  return buildMessage(TARGET_APP_TO_GIMBAL, JOYSTICK_FLAGS, 0x04, 0x01, payload);
}

export function buildNeutralFrame() {
  const mid = loadPresets().mid_a ?? 1024;
  return buildJoystickFrame(mid, mid, mid);
}

function stickForAxis(presets, pan, tilt) {
  const midA = presets.mid_a ?? 1024;
  const midC = presets.mid_c ?? 1024;
  const scale = stickScale();
  let a = midA;
  let c = midC;
  if (tilt > 0) a = scaledStick(midA, presets.axis_a_range[1], scale);
  else if (tilt < 0) a = scaledStick(midA, presets.axis_a_range[0], scale);
  if (pan > 0) c = scaledStick(midC, presets.axis_c_range[1], scale);
  else if (pan < 0) c = scaledStick(midC, presets.axis_c_range[0], scale);
  return { a, b: midA, c };
}

function singleAxisPhase(presets, pan, tilt) {
  const stick = stickForAxis(presets, pan, tilt);
  return { axis: axisLabel(pan, tilt), stick };
}

/**
 * RS 3 Mini joystick plan — live 0x04/0x01 frames built each tick in gimbal-session.
 * When both pan and tilt are requested, run two stick phases (pan then tilt).
 */
export function pickMovePlan(pan, tilt) {
  if (!loggedScale) {
    loggedScale = true;
    log.info('move', `MOVE_STICK_SCALE=${stickScale()}`);
  }
  const presets = loadPresets();

  if (pan === 0 && tilt === 0) {
    const mid = presets.mid_a ?? 1024;
    return {
      axis: 'none',
      phases: [{ axis: 'none', stick: { a: mid, b: mid, c: mid } }],
    };
  }

  if (pan !== 0 && tilt !== 0) {
    const phases = [];
    if (pan !== 0) phases.push(singleAxisPhase(presets, pan, 0));
    if (tilt !== 0) phases.push(singleAxisPhase(presets, 0, tilt));
    return { axis: axisLabel(pan, tilt), phases };
  }

  const single = singleAxisPhase(presets, pan, tilt);
  return { axis: single.axis, phases: [single] };
}

/** @deprecated use pickMovePlan */
export function pickMoveFrames(pan, tilt) {
  const { axis, phases } = pickMovePlan(pan, tilt);
  const frames = phases.map((p) => buildJoystickFrame(p.stick.a, p.stick.b, p.stick.c));
  return { axis, frames };
}
