import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { forceBlueZDisconnect } from '../lib/bluez-cleanup.js';

const prevForce = process.env.BLUEZ_FORCE_DISCONNECT;
const prevDelay = process.env.BLUEZ_DISCONNECT_DELAY_MS;

afterEach(() => {
  if (prevForce === undefined) delete process.env.BLUEZ_FORCE_DISCONNECT;
  else process.env.BLUEZ_FORCE_DISCONNECT = prevForce;
  if (prevDelay === undefined) delete process.env.BLUEZ_DISCONNECT_DELAY_MS;
  else process.env.BLUEZ_DISCONNECT_DELAY_MS = prevDelay;
});

function enableCleanup() {
  process.env.BLUEZ_FORCE_DISCONNECT = '1';
  process.env.BLUEZ_DISCONNECT_DELAY_MS = '0';
}

test('forceBlueZDisconnect uses noble disconnect + HCI Reset, not a shell', async () => {
  enableCleanup();
  let disconnected = false;
  let resetOn;
  const peripheral = {
    id: 'aabbccddeeff',
    state: 'connected',
    async disconnectAsync() {
      disconnected = true;
      this.state = 'disconnected';
    },
  };
  const noble = { tag: 'fake-noble' };

  await forceBlueZDisconnect('AA:BB:CC:DD:EE:FF', peripheral, {
    noble,
    resetHciAdapter: async (n) => {
      resetOn = n;
    },
  });

  assert.equal(disconnected, true);
  assert.equal(resetOn, noble);
});

test('forceBlueZDisconnect skips HCI Reset when there is no peripheral', async () => {
  enableCleanup();
  let resetCalls = 0;
  await forceBlueZDisconnect('AA:BB:CC:DD:EE:FF', null, {
    noble: {},
    resetHciAdapter: async () => {
      resetCalls += 1;
    },
  });
  assert.equal(resetCalls, 0);
});
