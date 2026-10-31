#!/usr/bin/env node
/**
 * rs3mini-bridge — HTTP API for DJI Ronin RS 3 Mini (BLE).
 *
 * Parent process: Express on :8787. BLE lives in a forked child (ble-worker.mjs)
 * so a hung noble connect cannot freeze HTTP.
 *
 * Commands (POST): /move/hold  /move/stop  /center  /sleep  /wake  /motor/toggle
 * Status (GET):    /health/label  /motor  /state  /events  /health  /
 *
 * Full reference: API.md
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';
import { createGimbalClient } from './lib/gimbal-client.js';
import { pushEvent } from './lib/events.js';
import { log } from './lib/log.js';
import { buildGimbalTarget, gimbalTargetLabel, hasGimbalTarget } from './lib/gimbal-target.js';
import { getWifiStatus, startWifiPollLoop } from './lib/wifi-status.js';

const PORT = Number(process.env.PORT || 8787);
const GIMBAL_TARGET = buildGimbalTarget();
const STARTUP_GUARD_MS = Number(process.env.STARTUP_GUARD_MS ?? 5000);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const gimbal = createGimbalClient();

const app = createApp({
  target: GIMBAL_TARGET,
  gimbal,
  adapterState: () => gimbal.adapterState(),
  getWifi: getWifiStatus,
  token: process.env.BRIDGE_TOKEN || '',
  startupGuardMs: STARTUP_GUARD_MS,
  staticDir: publicDir,
});

function minLevelLabel() {
  return process.env.LOG_LEVEL?.toLowerCase() === 'debug' ? 'debug' : 'info';
}

const server = app.listen(PORT, () => {
  pushEvent('boot', `bridge listening on :${PORT}`);
  log.info('bridge', `listening on :${PORT} LOG_LEVEL=${minLevelLabel()} STARTUP_GUARD_MS=${STARTUP_GUARD_MS} CONNECT_GUARD_MS=${process.env.CONNECT_GUARD_MS ?? 8000} MOVE_HOLD_MS=${process.env.MOVE_HOLD_MS ?? 0} HOLD_PROMOTE_MS=${process.env.HOLD_PROMOTE_MS ?? 250} NUDGE_MS=${process.env.NUDGE_MS ?? 180} RELEASE_NEUTRAL_FRAMES=${process.env.RELEASE_NEUTRAL_FRAMES ?? 3} MAX_MOVE_MS=${process.env.MAX_MOVE_MS ?? process.env.MAX_HOLD_MS ?? 15000}`);
  log.info('bridge', `gimbal target: ${gimbalTargetLabel(GIMBAL_TARGET)}`);
  log.info('bridge', 'Commands: POST /move/hold /move/stop /center /sleep /wake /motor/toggle');
  log.info('bridge', 'Status UI: GET /');
  log.info('bridge', 'Recent events: GET /events');
  if (process.env.BRIDGE_TOKEN) log.info('bridge', 'BRIDGE_TOKEN set — require X-Bridge-Token header');
  startWifiPollLoop();
  gimbal.start();
  if (hasGimbalTarget(GIMBAL_TARGET)) {
    gimbal.startReconnectLoop(GIMBAL_TARGET);
    void gimbal.connectOnStartup(GIMBAL_TARGET);
  }
});

async function onShutdown() {
  server.close();
  await gimbal.shutdownSession();
  process.exit(0);
}

process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);
