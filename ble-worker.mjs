#!/usr/bin/env node
/**
 * BLE child — owns noble + gimbal-session. Parent talks over fork IPC.
 * stdout/stderr inherit to journald.
 */
import noble from '@abandonware/noble';
import * as gimbal from './lib/gimbal-session.js';
import { getEvents } from './lib/events.js';
import { waitPoweredOn } from './lib/ble-session.js';
import { resetHciAdapter } from './lib/hci-reset.js';
import { buildGimbalTarget, hasGimbalTarget } from './lib/gimbal-target.js';
import { log } from './lib/log.js';

const HEARTBEAT_MS = Number(process.env.BLE_WORKER_HEARTBEAT_MS ?? 1000);
const FAULT_BLOCK_MS = Number(process.env.BLE_WORKER_FAULT_MS ?? 60000);
const target = buildGimbalTarget();

function send(msg) {
  if (typeof process.send === 'function') process.send(msg);
}

function snapshot() {
  return {
    type: 'snapshot',
    adapter: noble.state,
    moveStatus: gimbal.getMoveStatus(),
    motorLabel: gimbal.getMotorLabel(),
    state: gimbal.getGimbalState(),
    connectGuardBlocked: gimbal.moveBlockedByConnectGuard(),
    events: getEvents(),
  };
}

function reply(id, result) {
  send({ type: 'reply', id, ok: true, result });
  send(snapshot());
}

function replyErr(id, err) {
  send({ type: 'reply', id, ok: false, error: err.message || String(err) });
  send(snapshot());
}

function heartbeat() {
  send({
    type: 'heartbeat',
    ts: Date.now(),
    adapter: noble.state,
    events: getEvents(),
  });
  send(snapshot());
}

function blockEventLoop(ms) {
  const t0 = Date.now();
  log.warn('ble', `BLE_WORKER_FAULT=block — spinning ${ms}ms`);
  while (Date.now() - t0 < ms) {
    /* intentional event-loop block for watchdog bench */
  }
}

async function handleRpc(msg) {
  const { id, method, args = {} } = msg;

  if (method === 'connectOnStartup' && process.env.BLE_WORKER_FAULT === 'block') {
    blockEventLoop(FAULT_BLOCK_MS);
  }

  try {
    let result;
    switch (method) {
      case 'connectOnStartup':
        await gimbal.connectOnStartup(target);
        result = { ok: true };
        break;
      case 'startReconnectLoop':
        gimbal.startReconnectLoop(target);
        result = { ok: true };
        break;
      case 'stopReconnectLoop':
        gimbal.stopReconnectLoop();
        result = { ok: true };
        break;
      case 'holdMove':
        result = await gimbal.holdMove(target, {
          pan: Number(args.pan ?? 0),
          tilt: Number(args.tilt ?? 0),
        });
        break;
      case 'stopMove':
        result = await gimbal.stopMove();
        break;
      case 'centerGimbal':
        result = await gimbal.centerGimbal(target);
        break;
      case 'refreshTelemetry':
        result = await gimbal.refreshTelemetry(target);
        break;
      case 'sleepGimbal':
        result = await gimbal.sleepGimbal(target);
        break;
      case 'wakeGimbal':
        result = await gimbal.wakeGimbal(target);
        break;
      case 'toggleMotor':
        result = await gimbal.toggleMotor(target);
        break;
      case 'recallAbsAngle':
        result = await gimbal.recallAbsAngle(target, args);
        break;
      case 'replayTrackPath': {
        const opts = { ...args };
        if (opts.payloadHex && !opts.payload) {
          opts.payload = Buffer.from(String(opts.payloadHex), 'hex');
          delete opts.payloadHex;
        }
        result = await gimbal.replayTrackPath(target, opts);
        break;
      }
      case 'shutdown':
        await gimbal.shutdownSession();
        reply(id, { ok: true });
        process.exit(0);
        return;
      default:
        throw new Error(`unknown method ${method}`);
    }
    reply(id, result);
  } catch (err) {
    replyErr(id, err);
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'rpc') {
    handleRpc(msg).catch((err) => replyErr(msg.id, err));
  }
});

async function main() {
  if (process.env.BLE_WORKER_RESET === '1') {
    await waitPoweredOn();
    await resetHciAdapter(noble);
    await waitPoweredOn();
  }

  if (hasGimbalTarget(target)) {
    log.info('ble', 'worker ready');
  } else {
    log.warn('ble', 'worker ready — no GIMBAL_NAME_RE');
  }

  send({ type: 'ready', adapter: noble.state });
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
}

main().catch((err) => {
  log.error('ble', `worker boot: ${err.message || err}`);
  process.exit(1);
});
