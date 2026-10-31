import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryState } from '../lib/telemetry-state.js';
import { parseAttitude, isPoseTelemetry } from '../lib/telemetry.js';
import { buildMessage, TARGET_APP_TO_GIMBAL } from '../lib/duml.js';

const int16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16LE(v);
  return b;
};
const tlv = (tag, buf) => Buffer.concat([Buffer.from([tag, buf.length]), buf]);
function poseFrame(cmdId, tilt, pan) {
  const parts = [Buffer.from([0x00]), tlv(0x22, int16(tilt)), tlv(0x23, int16(0))];
  if (pan != null) parts.push(tlv(0x24, int16(pan)));
  return buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x04, cmdId, Buffer.concat(parts));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const make = (over = {}) =>
  new TelemetryState({
    staleMs: 80,
    parseMotor: () => null,
    parseAttitude,
    isPose: isPoseTelemetry,
    ...over,
  });

test('ingest decodes a 0x66 pose into the telemetry record', () => {
  const ts = make();
  ts.ingest(poseFrame(0x66, 100, 200));
  assert.equal(ts.telemetry.source, '0x04/0x66');
  assert.equal(ts.telemetry.tiltDeg, 10);
  assert.equal(ts.telemetry.panDeg, 20);
});

test('fresh 0x66 outranks 0x10; stale 0x66 yields to 0x10', async () => {
  const ts = make({ staleMs: 60 });
  ts.ingest(poseFrame(0x66, 100, 200));
  ts.ingest(poseFrame(0x10, 300, null));
  assert.equal(ts.telemetry.source, '0x04/0x66', '0x10 ignored while 0x66 fresh');
  assert.equal(ts.telemetry.tiltDeg, 10);

  await sleep(90);
  ts.ingest(poseFrame(0x10, 300, null));
  assert.equal(ts.telemetry.source, '0x04/0x10', '0x10 wins once 0x66 is stale');
  assert.equal(ts.telemetry.tiltDeg, 30);
});

test('a higher-or-equal priority pose always overwrites', () => {
  const ts = make();
  ts.ingest(poseFrame(0x10, 50, null)); // priority 1
  assert.equal(ts.telemetry.source, '0x04/0x10');
  ts.ingest(poseFrame(0x66, 100, 200)); // priority 2 > 1 → accepted
  assert.equal(ts.telemetry.source, '0x04/0x66');
  assert.equal(ts.telemetry.tiltDeg, 10);
});

test('battery telemetry updates the battery fields only', () => {
  const ts = make();
  const payload = Buffer.alloc(21);
  payload[payload.length - 1] = 77;
  ts.ingest(buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x0d, 0x02, payload));
  assert.equal(ts.telemetry.batteryPercent, 77);
  assert.equal(ts.telemetry.source, null, 'battery is not a pose source');
});

test('ingest routes motor sleep/wake through setMotor', () => {
  const changes = [];
  const ts = make({
    parseMotor: () => 'ASLEEP',
    onMotorChange: (s, src) => changes.push([s, src]),
  });
  ts.ingest(Buffer.from([0x55]));
  assert.equal(ts.motorState, 'ASLEEP');
  assert.deepEqual(changes, [['ASLEEP', 'notify']]);
});

test('handle sleep overrides connect, and a same-state echo keeps the command origin', () => {
  const changes = [];
  const ts = make({
    parseMotor: (data) => {
      if (data[0] === 0x11) return { state: 'ASLEEP', source: 'handle' };
      if (data[0] === 0x10) return { state: 'AWAKE', source: 'handle' };
      return null;
    },
    onMotorChange: (s, src) => changes.push([s, src]),
  });
  ts.setMotor('AWAKE', 'connect');
  ts.ingest(Buffer.from([0x11]));
  assert.equal(ts.motorState, 'ASLEEP');
  assert.equal(ts.motorSource, 'handle');
  ts.setMotor('ASLEEP', 'command');
  assert.equal(ts.motorSource, 'command', 'bridge command claims a state the notify already set');
  ts.ingest(Buffer.from([0x11]));
  assert.equal(ts.motorSource, 'command', 'echo of our own sleep does not become a handle event');
  ts.ingest(Buffer.from([0x10]));
  assert.equal(ts.motorState, 'AWAKE');
  assert.equal(ts.motorSource, 'handle');
  assert.deepEqual(changes, [
    ['AWAKE', 'connect'],
    ['ASLEEP', 'handle'],
    ['AWAKE', 'handle'],
  ]);
});

test('setMotor fires onMotorChange only on an actual change', () => {
  const changes = [];
  const ts = make({ onMotorChange: (s) => changes.push(s) });
  ts.setMotor('AWAKE', 'connect');
  ts.setMotor('AWAKE', 'connect'); // no change
  ts.setMotor('ASLEEP', 'command');
  ts.setMotor('BOGUS', 'x'); // ignored
  assert.deepEqual(changes, ['AWAKE', 'ASLEEP']);
  assert.equal(ts.motorState, 'ASLEEP');
});

test('clearTelemetry / clearMotor reset state', () => {
  const ts = make();
  ts.ingest(poseFrame(0x66, 100, 200));
  ts.setMotor('AWAKE', 'connect');
  ts.clearTelemetry();
  ts.clearMotor();
  assert.equal(ts.telemetry.source, null);
  assert.equal(ts.telemetry.tiltDeg, null);
  assert.equal(ts.motorState, null);
});

test('ingest is bound and usable as a detached callback', () => {
  const ts = make();
  const handler = ts.ingest; // e.g. chars.fff4.on('data', telem.ingest)
  handler(poseFrame(0x66, 70, 80));
  assert.equal(ts.telemetry.tiltDeg, 7);
});
