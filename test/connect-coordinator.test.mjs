import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectCoordinator } from '../lib/connect-coordinator.js';

const make = (over = {}) =>
  new ConnectCoordinator({ staleMs: 50, abortScan: async () => {}, ...over });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('start sets the in-flight lock; settle clears it on success', async () => {
  const cc = make();
  let ran = 0;
  const epoch = cc.start(async () => {
    ran += 1;
  });
  assert.equal(cc.connecting, true);
  await cc.settle(epoch);
  assert.equal(ran, 1);
  assert.equal(cc.connecting, false, 'lock cleared after settle');
});

test('coalesce waits on the existing attempt rather than starting a new one', async () => {
  const cc = make();
  let starts = 0;
  const begin = () =>
    cc.start(async () => {
      starts += 1;
      await sleep(20);
    });

  const e1 = begin();
  // A second caller would coalesce instead of starting another attempt.
  await cc.coalesce();
  await cc.settle(e1);
  assert.equal(starts, 1, 'only one attempt ran');
});

test('abort bumps the epoch so a late resolution is no longer current', async () => {
  const cc = make();
  const epoch = cc.start(async () => {
    await sleep(100);
  });
  assert.equal(cc.isCurrent(epoch), true);
  cc.abort();
  assert.equal(cc.isCurrent(epoch), false, 'aborted generation is stale');
  assert.equal(cc.connecting, false, 'lock cleared on abort');
});

test('forceStaleConnect aborts an attempt older than staleMs', async () => {
  const events = [];
  const cc = make({ staleMs: 20, event: (m) => events.push(m) });
  cc.start(() => new Promise(() => {})); // hangs forever
  assert.equal(cc.forceStaleConnect('too soon'), false, 'fresh attempt is not stale');

  await sleep(30);
  assert.equal(cc.forceStaleConnect('aged out'), true, 'aborted once past staleMs');
  assert.equal(cc.connecting, false);
  assert.match(events.at(-1), /stale connect lock/);
});

test('a hung coalesce wait times out and forces an abort', async () => {
  const cc = make({ staleMs: 20, teardownMs: 10 });
  const epoch = cc.start(() => new Promise(() => {})); // never resolves
  await cc.settle(epoch); // budget + teardown wait, then abort
  assert.equal(cc.connecting, false, 'lock cleared after timeout abort');
  assert.equal(cc.isCurrent(epoch), false, 'epoch bumped by the timeout abort');
});

test('reconnect busy flag tracks the background attempt', () => {
  const cc = make();
  assert.equal(cc.reconnecting, false);
  cc.beginReconnect();
  assert.equal(cc.reconnecting, true);
  cc.endReconnect();
  assert.equal(cc.reconnecting, false);
});

test('forceStaleReconnect aborts a background attempt older than staleMs', async () => {
  const cc = make({ staleMs: 20 });
  cc.beginReconnect();
  assert.equal(cc.forceStaleReconnect('fresh'), false);
  await sleep(30);
  assert.equal(cc.forceStaleReconnect('aged'), true);
  assert.equal(cc.reconnecting, false);
});

test('reset clears everything and orphans pending attempts', () => {
  const cc = make();
  const epoch = cc.start(() => new Promise(() => {}));
  cc.beginReconnect();
  cc.reset();
  assert.equal(cc.connecting, false);
  assert.equal(cc.reconnecting, false);
  assert.equal(cc.isCurrent(epoch), false);
});
