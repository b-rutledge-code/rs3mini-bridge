// Connect-coalescing behavior, exercised against gimbal-session through the BLE mock.
// Now that the coordinator exposes reset(), every scenario gets a clean slate via
// _resetForTest() in one file (no more one-process-per-scenario).
process.env.MOVE_INTERVAL_MS = '1';
process.env.MAX_MOVE_MS = '0';
process.env.MOVE_HOLD_MS = '0';
process.env.TELEMETRY_HB_MS = '0';
process.env.TELEMETRY_SETUP = '0';
process.env.CONNECT_GUARD_MS = '0';
process.env.RECONNECT_MS = '0';
process.env.HOLD_PROMOTE_MS = '20';
process.env.NUDGE_MS = '12';
process.env.RELEASE_NEUTRAL_FRAMES = '3';

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installBleMock } from './helpers/mock-ble.mjs';
import { parseMessage } from '../lib/duml.js';

const ble = await installBleMock();
const gs = await import('../lib/gimbal-session.js');
const target = { nameRe: /RS3 MINI/i };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  gs._resetForTest();
  gs._setMoveHoldMsForTest(0);
  gs._setDeckTimingForTest({ promoteMs: 20, nudgeMs: 12 });
  ble.resetFindCount();
  ble.setFind(null); // default: resolve a fake peripheral immediately
  gs._setConnectTimingForTest({ staleMs: 90000, totalMs: 90000 });
});

after(async () => {
  await gs.shutdownSession();
  ble.restore();
});

test('two concurrent connectGimbal calls coalesce onto one connect', async () => {
  // Slow the scan so the second caller arrives mid-connect.
  ble.setFind(async (_idx, makePeripheral) => {
    await sleep(15);
    return makePeripheral();
  });

  const [a, b] = await Promise.all([
    gs.connectGimbal(target),
    gs.connectGimbal(target),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(ble.state.findCount, 1, 'exactly one connect attempt reached the radio');
  assert.equal(gs.getMoveStatus().connected, true);

});

test('a hung connect does not wedge the next attempt', async () => {
  gs._setConnectTimingForTest({ staleMs: 80, totalMs: 80 });
  // First attempt hangs forever; the second connects normally.
  ble.setFind((idx, makePeripheral) => (idx === 0 ? new Promise(() => {}) : makePeripheral()));

  await gs.connectOnStartup(target);
  assert.equal(ble.state.findCount, 1, 'first attempt reached the radio');
  assert.equal(gs.getMoveStatus().connected, false, 'hung attempt left us disconnected');

  const res = await gs.connectGimbal(target);
  assert.equal(res.ok, true);
  assert.equal(ble.state.findCount, 2, 'a fresh connect attempt started');
  assert.equal(gs.getMoveStatus().connected, true, 'recovered to connected');

});

test('holdMove on a dead session throws without starting a connect', async () => {
  await assert.rejects(
    gs.holdMove(target, { tilt: 1 }),
    /not connected/,
  );
  assert.equal(ble.state.findCount, 0);
});

test('a BLE disconnect tears down the active session', async () => {
  await gs.connectOnStartup(target);
  await gs.holdMove(target, { tilt: 1 });
  assert.equal(gs.getMoveStatus().connected, true);
  assert.equal(gs.getMoveStatus().active, true);

  ble.state.lastPeripheral.state = 'disconnected';
  ble.state.lastPeripheral.emit('disconnect');
  await new Promise((r) => setImmediate(r));

  const status = gs.getMoveStatus();
  assert.equal(status.connected, false, 'session no longer connected');
  assert.equal(status.active, false, 'move loop stopped');
  assert.equal(status.lastBleError, 'disconnected');
});

test('reconnect tick does not start a second radio attempt', async () => {
  ble.setFind(async (_idx, makePeripheral) => {
    await sleep(80);
    return makePeripheral();
  });

  const connectP = gs.connectOnStartup(target);
  await sleep(10);
  assert.equal(gs.getMoveStatus().connecting, true, 'first attempt in flight');

  await gs._tickReconnectForTest(target);
  await connectP;

  assert.equal(ble.state.findCount, 1, 'scheduler tick did not start a sibling connect');
  assert.equal(gs.getMoveStatus().connected, true);
  assert.equal(gs.getMoveStatus().connecting, false, 'committed session is not connecting');
});

test('idle stopMove flood does not abort the startup connect', async () => {
  ble.setFind(async (_idx, makePeripheral) => {
    await sleep(60);
    return makePeripheral();
  });

  const connectP = gs.connectOnStartup(target);
  await sleep(10);
  assert.equal(gs.getMoveStatus().connecting, true, 'connect is in flight');

  await gs.stopMove();
  await gs.stopMove();
  await gs.stopMove();

  await connectP;

  assert.equal(gs.getMoveStatus().connected, true, 'connect survived the flood');
  assert.equal(ble.state.findCount, 1, 'no retry — the original attempt completed');
});

test('connected quick tap completes a fixed nudge then stops', async () => {
  await gs.connectOnStartup(target);
  assert.equal(gs.getMoveStatus().connected, true);

  await gs.holdMove(target, { tilt: 1 });
  const stopped = await gs.stopMove();
  assert.equal(stopped.nudge, true);
  assert.equal(stopped.stopped, false);
  assert.equal(gs.getMoveStatus().active, true, 'nudge remains active to its fixed deadline');
  await sleep(18);
  assert.equal(gs.getMoveStatus().active, false, 'nudge deadline centers the stick');

  const writes = ble.state.lastChars?.fff5.writes ?? [];
  assert.ok(writes.length >= 2, 'tap must stream enough joystick frames to move');
});

test('second hold on same axis refreshes without re-enqueue', async () => {
  await gs.connectOnStartup(target);
  const first = await gs.holdMove(target, { tilt: 1 });
  assert.equal(first.active, true);
  assert.equal(first.refreshed, undefined);

  const second = await gs.holdMove(target, { tilt: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.refreshed, true);
  assert.equal(second.active, true);
  assert.equal(gs.getMoveStatus().active, true);

  await sleep(25);
  await gs.stopMove();
  assert.equal(gs.getMoveStatus().active, false);
});

test('promoted hold free-runs until stopMove then stops promptly', async () => {
  await gs.connectOnStartup(target);
  // Page 3 default: no orphan lease
  gs._setMoveHoldMsForTest(0);

  await gs.holdMove(target, { tilt: 1 });
  const writesAfterStart = ble.state.lastChars?.fff5.writes?.length ?? 0;
  await sleep(25);
  const writesMidHold = ble.state.lastChars?.fff5.writes?.length ?? 0;
  assert.ok(writesMidHold > writesAfterStart, 'press/release hold must stream while finger down');
  assert.equal(gs.getMoveStatus().active, true);

  const stopped = await gs.stopMove();
  assert.equal(stopped.nudge, false);
  assert.equal(stopped.stopped, true);
  assert.equal(gs.getMoveStatus().active, false);
});

test('latest direction replaces the old axis without replaying stale frames', async () => {
  await gs.connectOnStartup(target);
  const writes = ble.state.lastChars.fff5.writes;

  await gs.holdMove(target, { pan: -1 });
  await sleep(4);
  await gs.holdMove(target, { tilt: 1 });
  const switchIndex = writes.length;
  await sleep(6);

  const afterSwitch = writes.slice(switchIndex).map((frame) => {
    const msg = parseMessage(frame);
    return {
      a: msg.payload.readUInt16LE(0),
      c: msg.payload.readUInt16LE(4),
    };
  });
  assert.ok(afterSwitch.length > 0, 'new axis writes frames');
  assert.ok(
    afterSwitch.every(({ a, c }) => a > 1024 && c === 1024),
    'only latest tilt+ intent is written after the switch',
  );

  await gs.stopMove();
});

test('new press interrupts an in-flight neutral sequence', async () => {
  await gs.connectOnStartup(target);
  const writes = ble.state.lastChars.fff5.writes;

  await gs.holdMove(target, { tilt: 1 });
  await sleep(25);
  await gs.stopMove();
  await sleep(1);
  await gs.holdMove(target, { pan: 1 });
  const switchIndex = writes.length;
  await sleep(6);

  const afterSwitch = writes.slice(switchIndex).map((frame) => {
    const msg = parseMessage(frame);
    return {
      a: msg.payload.readUInt16LE(0),
      c: msg.payload.readUInt16LE(4),
    };
  });
  assert.ok(afterSwitch.length > 0);
  assert.ok(
    afterSwitch.every(({ a, c }) => a === 1024 && c > 1024),
    'interruptible neutral yields to latest pan+ intent',
  );

  await gs.stopMove();
});

test('optional MOVE_HOLD_MS lease expiry ends motion with neutral write', async () => {
  await gs.connectOnStartup(target);
  gs._setMoveHoldMsForTest(40);

  await gs.holdMove(target, { tilt: 1 });
  assert.equal(gs.getMoveStatus().active, true);

  const writesBefore = ble.state.lastChars?.fff5.writes?.length ?? 0;
  await sleep(120);
  assert.equal(gs.getMoveStatus().active, false, 'lease expiry must stop the move');
  const writesAfter = ble.state.lastChars?.fff5.writes?.length ?? 0;
  assert.ok(writesAfter > writesBefore, 'lease expiry must send neutral frames');
});

test('idle stopMove is a cheap no-op', async () => {
  await gs.connectOnStartup(target);
  const writesBefore = ble.state.lastChars?.fff5.writes?.length ?? 0;
  const result = await gs.stopMove();
  const writesAfter = ble.state.lastChars?.fff5.writes?.length ?? 0;
  assert.equal(result.idle, true);
  assert.equal(writesAfter, writesBefore, 'idle stop adds no neutral burst');
});
