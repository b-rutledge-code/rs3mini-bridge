import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, TARGET_APP_TO_GIMBAL } from '../lib/duml.js';
import {
  parseAttitude,
  isPoseTelemetry,
  decode0466Fields,
} from '../lib/telemetry.js';

const int16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeInt16LE(v);
  return b;
};
const tlv = (tag, buf) => Buffer.concat([Buffer.from([tag, buf.length]), buf]);

/** 0x66/0x10 TLV payload: header byte 0 then tag/len/value records (tilt/roll/pan). */
function tlvPayload({ tilt, roll = 0, pan }) {
  const parts = [Buffer.from([0x00])];
  parts.push(tlv(0x22, int16(tilt)));
  parts.push(tlv(0x23, int16(roll)));
  if (pan != null) parts.push(tlv(0x24, int16(pan)));
  return Buffer.concat(parts);
}

const frame = (cmdId, payload) => buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x04, cmdId, payload);

test('decode0466Fields walks tag/len/value records', () => {
  const fields = decode0466Fields(tlvPayload({ tilt: 123, roll: -45, pan: 678 }));
  assert.equal(fields[0x22], 123);
  assert.equal(fields[0x23], -45);
  assert.equal(fields[0x24], 678);
});

test('parseAttitude decodes 0x04/0x66 TLV pose', () => {
  const att = parseAttitude(frame(0x66, tlvPayload({ tilt: 100, roll: 0, pan: 200 })));
  assert.equal(att.source, '0x04/0x66');
  assert.equal(att.layout, 'rs3mini-0x66-tlv');
  assert.equal(att.tiltDeg, 10);
  assert.equal(att.panDeg, 20);
  assert.equal(isPoseTelemetry(att), true);
});

test('parseAttitude decodes 0x04/0x10 TLV pose (pan optional)', () => {
  const att = parseAttitude(frame(0x10, tlvPayload({ tilt: 50 })));
  assert.equal(att.source, '0x04/0x10');
  assert.equal(att.layout, 'rs3mini-0x10-tlv');
  assert.equal(att.tiltDeg, 5);
  assert.equal(att.panDeg, null);
  assert.equal(isPoseTelemetry(att), true);
});

test('parseAttitude rejects implausible angles', () => {
  assert.equal(parseAttitude(frame(0x66, tlvPayload({ tilt: 5000, pan: 0 }))), null);
});

test('parseAttitude decodes 0x0d/0x02 battery (last byte percent)', () => {
  const payload = Buffer.alloc(21);
  payload[payload.length - 1] = 88;
  const att = parseAttitude(buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x0d, 0x02, payload));
  assert.equal(att.source, '0x0d/0x02');
  assert.equal(att.batteryPercent, 88);
  assert.equal(isPoseTelemetry(att), false, 'battery is not pose telemetry');
});

test('parseAttitude decodes 0x04/0x05 standard angle record', () => {
  const payload = Buffer.alloc(6);
  payload.writeInt16LE(100, 0);
  payload.writeInt16LE(0, 2);
  payload.writeInt16LE(50, 4);
  const att = parseAttitude(buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x04, 0x05, payload));
  assert.equal(att.source, '0x04/0x05');
  assert.equal(att.layout, 'standard');
  assert.equal(att.pitchDeg, 10);
  assert.equal(att.yawDeg, 5);
});

test('parseAttitude returns null for non-telemetry frames', () => {
  assert.equal(parseAttitude(Buffer.from([0x00, 0x01])), null);
  assert.equal(parseAttitude(frame(0x01, Buffer.from([0x00]))), null, 'joystick cmd is not telemetry');
});
