// Telemetry source priority: 0x04/0x66 outranks 0x04/0x10. A lower-priority
// frame is ignored while a higher-priority one is fresh, but accepted once the
// fresh one goes stale (TELEMETRY_STALE_MS). Own file → clean state.
process.env.MOVE_INTERVAL_MS = '1';
process.env.MAX_MOVE_MS = '0';
process.env.TELEMETRY_HB_MS = '0';
process.env.TELEMETRY_SETUP = '0';
process.env.CONNECT_GUARD_MS = '0';
process.env.RECONNECT_MS = '0';
process.env.TELEMETRY_STALE_MS = '80';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBleMock } from './helpers/mock-ble.mjs';
import { buildMessage, TARGET_APP_TO_GIMBAL } from '../lib/duml.js';

const ble = await installBleMock();
const gs = await import('../lib/gimbal-session.js');
const target = { nameRe: /RS3 MINI/i };

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
const emit = (frame) => ble.state.lastChars.fff4.emit('data', frame);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  await gs.stopMove();
  await gs.shutdownSession();
  ble.restore();
});

test('fresh 0x66 wins over 0x10; stale 0x66 yields to 0x10', async () => {
  await gs.connectOnStartup(target);
  await gs.holdMove(target, { tilt: 1 });
  assert.equal(gs.getMoveStatus().connected, true);

  emit(poseFrame(0x66, 100, 200));
  let t = gs.getGimbalState().telemetry;
  assert.equal(t.source, '0x04/0x66');
  assert.equal(t.tiltDeg, 10);

  // Lower-priority 0x10 while 0x66 is fresh → ignored.
  emit(poseFrame(0x10, 300, null));
  t = gs.getGimbalState().telemetry;
  assert.equal(t.source, '0x04/0x66', '0x10 ignored while 0x66 fresh');
  assert.equal(t.tiltDeg, 10);

  // After the 0x66 goes stale, 0x10 is accepted.
  await sleep(120);
  emit(poseFrame(0x10, 300, null));
  t = gs.getGimbalState().telemetry;
  assert.equal(t.source, '0x04/0x10', '0x10 accepted once 0x66 is stale');
  assert.equal(t.tiltDeg, 30);
});
