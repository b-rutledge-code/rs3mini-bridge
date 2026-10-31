import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createGimbalClient } from '../lib/gimbal-client.js';

const workerPath = fileURLToPath(new URL('./helpers/fake-ble-worker.mjs', import.meta.url));
const clients = [];

function makeClient(envExtra = {}) {
  const gimbal = createGimbalClient({
    workerPath,
    env: {
      ...process.env,
      BLE_WORKER_HEARTBEAT_MS: '40',
      BLE_WORKER_STALE_MS: '250',
      BLE_WORKER_BACKOFF: '50',
      BLE_WORKER_RPC_MS: '2000',
      ...envExtra,
    },
  });
  clients.push(gimbal);
  return gimbal;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(async () => {
  for (const c of clients) {
    await c.shutdownSession().catch(() => {});
  }
});

test('snapshot-backed status after connect', async () => {
  const gimbal = makeClient();
  gimbal.start();
  await sleep(80);
  assert.equal(gimbal.adapterState(), 'poweredOn');
  await gimbal.connectOnStartup({ nameRe: /x/ });
  await sleep(40);
  assert.equal(gimbal.getMoveStatus().connected, true);
  assert.equal(gimbal.getMotorLabel(), 'AWAKE');
  assert.equal(gimbal.getGimbalState().ok, true);
});

test('holdMove RPC returns child result', async () => {
  const gimbal = makeClient();
  gimbal.start();
  await sleep(80);
  const res = await gimbal.holdMove({ nameRe: /x/ }, { tilt: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.axis, 'tilt+');
});

test('watchdog SIGKILL on missed heartbeats then respawns', async () => {
  const gimbal = makeClient();
  gimbal.start();
  await gimbal.connectOnStartup({ nameRe: /x/ });
  await sleep(40);
  assert.equal(gimbal.getMoveStatus().connected, true);
  const firstPid = gimbal._child()?.pid;
  assert.ok(firstPid);

  gimbal._child().send({ type: 'rpc', id: 9999, method: 'stopHeartbeats', args: {} });
  await sleep(800);

  const after = gimbal._child();
  assert.ok(after, 'respawned child');
  assert.notEqual(after.pid, firstPid, 'new worker pid');
});

test('replayTrackPath sends payload as hex, not a Buffer', async () => {
  const gimbal = makeClient();
  gimbal.start();
  const res = await gimbal.replayTrackPath({ nameRe: /x/ }, {
    payload: Buffer.from('aabb', 'hex'),
    followMs: 100,
  });
  assert.equal(res.ok, true);
  assert.equal(res.payloadHex, 'aabb');
  assert.equal(res.hasPayload, false);
});

test('child death leaves connecting true so label stays CONN…', async () => {
  const gimbal = makeClient({ BLE_WORKER_BACKOFF: '2000' });
  gimbal.start();
  await gimbal.connectOnStartup({ nameRe: /x/ });
  await sleep(40);
  assert.equal(gimbal.getMoveStatus().connected, true);
  gimbal._child().kill('SIGKILL');
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < 400) {
    s = gimbal.getMoveStatus();
    if (!s.connected && s.connecting) break;
    await sleep(20);
  }
  assert.equal(s.connected, false);
  assert.equal(s.connecting, true);
});
