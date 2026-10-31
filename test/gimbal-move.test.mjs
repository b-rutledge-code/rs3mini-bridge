import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJoystickFrame,
  buildNeutralFrame,
  pickMovePlan,
} from '../lib/gimbal-move.js';
import { parseMessage, resetSequence } from '../lib/duml.js';

const STICK_CENTER = 1024;
const TILT_HIGH = 1420;
const TILT_LOW = 628;
const PAN_HIGH = 1420;
const PAN_LOW = 630;

function withScale(value, fn) {
  const prev = process.env.MOVE_STICK_SCALE;
  if (value == null) delete process.env.MOVE_STICK_SCALE;
  else process.env.MOVE_STICK_SCALE = String(value);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MOVE_STICK_SCALE;
    else process.env.MOVE_STICK_SCALE = prev;
  }
}

/** Decode the A/B/C stick channels from a 0x04/0x01 joystick frame. */
function stickChannels(frame) {
  const msg = parseMessage(frame);
  assert.equal(msg.cmdSet, 0x04);
  assert.equal(msg.cmdId, 0x01, 'joystick frames are 0x04/0x01');
  return {
    a: msg.payload.readUInt16LE(0),
    b: msg.payload.readUInt16LE(2),
    c: msg.payload.readUInt16LE(4),
  };
}

test('no movement returns centered stick phase', () => {
  const plan = pickMovePlan(0, 0);
  assert.equal(plan.axis, 'none');
  assert.equal(plan.phases.length, 1);
  assert.deepEqual(plan.phases[0].stick, { a: STICK_CENTER, b: STICK_CENTER, c: STICK_CENTER });
});

test('default scale: tilt+ is between mid and full high', () => {
  withScale(null, () => {
    const plan = pickMovePlan(0, 1);
    const a = plan.phases[0].stick.a;
    assert.ok(a > STICK_CENTER && a < TILT_HIGH, `expected ${STICK_CENTER} < a < ${TILT_HIGH}, got ${a}`);
  });
});

test('MOVE_STICK_SCALE=1: extremes match presets', () => {
  withScale(1, () => {
    const tiltUp = pickMovePlan(0, 1).phases[0].stick;
    assert.equal(tiltUp.a, TILT_HIGH);
    assert.equal(tiltUp.b, STICK_CENTER);
    assert.equal(tiltUp.c, STICK_CENTER);

    const tiltDown = pickMovePlan(0, -1).phases[0].stick;
    assert.equal(tiltDown.a, TILT_LOW);

    const panLeft = pickMovePlan(-1, 0).phases[0].stick;
    assert.equal(panLeft.c, PAN_LOW);

    const panRight = pickMovePlan(1, 0).phases[0].stick;
    assert.equal(panRight.c, PAN_HIGH);
  });
});

test('MOVE_STICK_SCALE default ints for tilt+ and pan-', () => {
  withScale(null, () => {
    const tiltUp = pickMovePlan(0, 1).phases[0].stick;
    assert.equal(tiltUp.a, Math.round(STICK_CENTER + 0.05 * (TILT_HIGH - STICK_CENTER)));
    assert.equal(tiltUp.b, STICK_CENTER);
    assert.equal(tiltUp.c, STICK_CENTER);

    const panLeft = pickMovePlan(-1, 0).phases[0].stick;
    assert.equal(panLeft.a, STICK_CENTER);
    assert.equal(panLeft.c, Math.round(STICK_CENTER + 0.05 * (PAN_LOW - STICK_CENTER)));
  });
});

test('MOVE_STICK_SCALE=0.35: exact ints for tilt+ and pan-', () => {
  withScale(0.35, () => {
    const tiltUp = pickMovePlan(0, 1).phases[0].stick;
    assert.equal(tiltUp.a, Math.round(STICK_CENTER + 0.35 * (TILT_HIGH - STICK_CENTER)));
    assert.equal(tiltUp.b, STICK_CENTER);
    assert.equal(tiltUp.c, STICK_CENTER);

    const panLeft = pickMovePlan(-1, 0).phases[0].stick;
    assert.equal(panLeft.a, STICK_CENTER);
    assert.equal(panLeft.c, Math.round(STICK_CENTER + 0.35 * (PAN_LOW - STICK_CENTER)));
  });
});

test('combined pan+tilt runs two stick phases (pan then tilt)', () => {
  const plan = pickMovePlan(1, 1);
  assert.equal(plan.axis, 'tilt++pan+');
  assert.equal(plan.phases.length, 2);
  assert.equal(plan.phases[0].axis, 'pan+');
  assert.equal(plan.phases[1].axis, 'tilt+');
});

test('buildJoystickFrame advances DUML sequence each call', () => {
  resetSequence(0x1000);
  const f1 = buildJoystickFrame(1420, STICK_CENTER, STICK_CENTER);
  const f2 = buildJoystickFrame(1420, STICK_CENTER, STICK_CENTER);
  assert.notEqual(f1.toString('hex'), f2.toString('hex'));
  const ch = stickChannels(f1);
  assert.equal(ch.a, 1420);
});

test('buildNeutralFrame centers all axes', () => {
  resetSequence(0x2000);
  const ch = stickChannels(buildNeutralFrame());
  assert.equal(ch.a, STICK_CENTER);
  assert.equal(ch.b, STICK_CENTER);
  assert.equal(ch.c, STICK_CENTER);
});
