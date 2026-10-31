import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessage,
  parseMessage,
  resetSequence,
  TARGET_APP_TO_GIMBAL,
} from '../lib/duml.js';
import {
  buildSleepFrame,
  buildWakeFrame,
  buildHeartbeat12Frame,
  buildSubscribeGimbalParams12,
  buildSetPushPeripheralStatus,
  PUSH_PERIPHERAL_REQUEST,
  parseMotorSleepNotify,
} from '../lib/session-setup.js';

test('buildSleepFrame is 0x04/0x0f with mode 0x11', () => {
  const msg = parseMessage(buildSleepFrame());
  assert.equal(msg.cmdSet, 0x04);
  assert.equal(msg.cmdId, 0x0f);
  assert.deepEqual([...msg.payload], [0x23, 0x01, 0x11]);
});

test('buildWakeFrame is 0x04/0x0f with mode 0x10', () => {
  const msg = parseMessage(buildWakeFrame());
  assert.equal(msg.cmdSet, 0x04);
  assert.equal(msg.cmdId, 0x0f);
  assert.deepEqual([...msg.payload], [0x23, 0x01, 0x10]);
});

test('buildHeartbeat12Frame is 0x04/0x12 to params module 0xe5', () => {
  const frame = buildHeartbeat12Frame();
  const msg = parseMessage(frame);
  assert.equal(msg.cmdSet, 0x04);
  assert.equal(msg.cmdId, 0x12);
  assert.equal(frame[4], 0x02, 'sender app');
  assert.equal(frame[5], 0xe5, 'receiver params (pose subscribe)');
  assert.match(msg.payload.toString('hex'), /6624c01d00001c/);
});

test('buildSubscribeGimbalParams12 Stage 0 payload matches capture header', () => {
  resetSequence(0x1734);
  const frame = buildSubscribeGimbalParams12();
  assert.equal(
    frame.toString('hex'),
    '552104bf02e534170004121051010000000c00005000f1036624c01d00001c4919',
  );
});

test('buildSetPushPeripheralStatus StartContinuePush is 0x04/0x66 ACK flags', () => {
  const msg = parseMessage(buildSetPushPeripheralStatus());
  assert.equal(msg.cmdSet, 0x04);
  assert.equal(msg.cmdId, 0x66);
  assert.equal(msg.flags, 0xc0);
  assert.deepEqual([...msg.payload], [0x00, PUSH_PERIPHERAL_REQUEST.StartContinuePush, 0x00]);
});

test('buildSetPushPeripheralStatus RequestSinglePush payload', () => {
  const msg = parseMessage(
    buildSetPushPeripheralStatus(PUSH_PERIPHERAL_REQUEST.RequestSinglePush),
  );
  assert.deepEqual([...msg.payload], [0x00, 0x02, 0x00]);
});

test('parseMotorSleepNotify reads our own sleep/wake writes back', () => {
  assert.equal(parseMotorSleepNotify(buildSleepFrame()), 'ASLEEP');
  assert.equal(parseMotorSleepNotify(buildWakeFrame()), 'AWAKE');
});

test('parseMotorSleepNotify reads the gimbal notify echo (00 23 01 ..)', () => {
  const echo = (mode) =>
    buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x04, 0x0f, Buffer.from([0x00, 0x23, 0x01, mode]));
  assert.equal(parseMotorSleepNotify(echo(0x11)), 'ASLEEP');
  assert.equal(parseMotorSleepNotify(echo(0x10)), 'AWAKE');
});

test('parseMotorSleepNotify ignores unrelated frames', () => {
  const hb = buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x04, 0x12, Buffer.alloc(2));
  assert.equal(parseMotorSleepNotify(hb), null);
});

test('parseMotorSleepNotify reads handle sleep from the abnormal-status push', () => {
  const frame = (bit) => {
    const payload = Buffer.alloc(5);
    payload[4] = bit;
    return buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x04, 0x27, payload);
  };
  assert.equal(parseMotorSleepNotify(frame(0x01)), 'ASLEEP');
  assert.equal(parseMotorSleepNotify(frame(0x11)), 'ASLEEP');
  assert.equal(parseMotorSleepNotify(frame(0x00)), 'AWAKE');
  assert.equal(parseMotorSleepNotify(frame(0x02)), 'AWAKE');
  const short = buildMessage(TARGET_APP_TO_GIMBAL, 0x00, 0x04, 0x27, Buffer.alloc(4));
  assert.equal(parseMotorSleepNotify(short), null);
});
