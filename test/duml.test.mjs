import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessage,
  parseMessage,
  buildAbsAngle,
  buildGetPosition,
  resetSequence,
  TARGET_APP_TO_GIMBAL,
  FLAG_REQUEST,
} from '../lib/duml.js';

test('buildMessage → parseMessage round-trips header and payload', () => {
  resetSequence();
  const payload = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const frame = buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x14, payload);

  assert.equal(frame[0], 0x55, 'starts with SOF 0x55');
  assert.equal(frame.length, 13 + payload.length, 'total length = 13 + payload');

  const msg = parseMessage(frame);
  assert.ok(msg, 'parses');
  assert.equal(msg.len, frame.length, 'declared length matches buffer length');
  assert.equal(msg.flags, FLAG_REQUEST);
  assert.equal(msg.cmdSet, 0x04);
  assert.equal(msg.cmdId, 0x14);
  assert.deepEqual([...msg.payload], [...payload]);
});

test('length field packs protocol version 1 in the high bits', () => {
  resetSequence();
  const frame = buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x04, 0x02, Buffer.alloc(0));
  const declaredLen = frame[1] | ((frame[2] & 0x03) << 8);
  const version = frame[2] >> 2;
  assert.equal(declaredLen, frame.length);
  assert.equal(version, 1);
});

test('resetSequence makes identical builds byte-for-byte equal', () => {
  resetSequence(0x1700);
  const a = buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x01, Buffer.from([9]));
  resetSequence(0x1700);
  const b = buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x01, Buffer.from([9]));
  assert.ok(a.equals(b), 'same seq → same CRC → same bytes');
});

test('sequence number advances each build (different CRC trailer)', () => {
  resetSequence(0x1700);
  const a = buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x01, Buffer.from([9]));
  const b = buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x01, Buffer.from([9]));
  assert.ok(!a.equals(b), 'monotonic seq → frames differ');
});

test('parseMessage rejects non-DUML and short frames', () => {
  assert.equal(parseMessage(Buffer.alloc(0)), null, 'empty');
  assert.equal(parseMessage(Buffer.from([0x00, 0x01, 0x02])), null, 'bad SOF');
  assert.equal(parseMessage(Buffer.from([0x55, 0x05, 0x04])), null, 'too short for header');
  const partial = Buffer.from([0x55, 0xff, 0x04, 0x00, 0, 0, 0, 0, 0x40, 0x04, 0x01, 0, 0]);
  assert.equal(parseMessage(partial), null, 'declared len exceeds buffer');
});

test('buildAbsAngle encodes yaw/roll/pitch as signed int16 LE (Ronin order)', () => {
  const frame = buildAbsAngle(-100, 50, 200, { flags: 0x07, duration: 80 });
  const msg = parseMessage(frame);
  assert.equal(msg.cmdSet, 0x04);
  assert.equal(msg.cmdId, 0x14);
  assert.equal(msg.payload.length, 8);
  assert.equal(msg.payload.readInt16LE(0), 200, 'yaw @0');
  assert.equal(msg.payload.readInt16LE(2), 50, 'roll @2');
  assert.equal(msg.payload.readInt16LE(4), -100, 'pitch @4');
  assert.equal(msg.payload.readUInt8(6), 0x07);
  assert.equal(msg.payload.readUInt8(7), 80);
});

test('buildGetPosition is a zero-payload 0x04/0x02 request', () => {
  const msg = parseMessage(buildGetPosition());
  assert.equal(msg.cmdSet, 0x04);
  assert.equal(msg.cmdId, 0x02);
  assert.equal(msg.payload.length, 0);
});
