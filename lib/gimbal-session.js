import {
  abortBleScan,
  closeSession,
  closeSessionSafe,
  connectPeripheral,
  discoverGimbalChars,
  findPeripheral,
  sleep,
  withTimeout,
  writePairingPrologue,
} from './ble-session.js';
import {
  forceBlueZDisconnect,
  getLastGimbalAddress,
  rememberGimbalAddress,
} from './bluez-cleanup.js';
import { gimbalTargetLabel, hasGimbalTarget } from './gimbal-target.js';
import { buildAbsAngle } from './duml.js';
import { build062UploadFrame, build6bPollFrame } from './gimbal-waypoint.js';
import { buildJoystickFrame, buildNeutralFrame, loadPairingHex, pickMovePlan } from './gimbal-move.js';
import {
  buildHeartbeat12Frame,
  parseMotorSleepNotify,
  runRecenterSession,
  runSessionSetup,
  sendCenterTap,
  sendSleepWake,
} from './session-setup.js';
import { isPoseTelemetry, parseAttitude } from './telemetry.js';
import { ConnectCoordinator } from './connect-coordinator.js';
import { TelemetryState } from './telemetry-state.js';
import { pushEvent } from './events.js';
import { log } from './log.js';
import { attachWireRx, installWireTap, wireLogEnabled } from './wire-log.js';

const INTERVAL_MS = Number(process.env.MOVE_INTERVAL_MS || 140);
const NEUTRAL_BURST = 5;
const RELEASE_NEUTRAL_FRAMES = Number(process.env.RELEASE_NEUTRAL_FRAMES ?? 3);
let HOLD_PROMOTE_MS = Number(process.env.HOLD_PROMOTE_MS ?? 250);
let NUDGE_MS = Number(process.env.NUDGE_MS ?? 180);
/** Absolute auto-stop if finger-up never arrives (0 = disabled). */
const MAX_MOVE_MS = Number(
  process.env.MAX_MOVE_MS ?? process.env.MAX_HOLD_MS ?? 15000,
);
/**
 * Optional orphan safety: silence after last /move/hold → stopMove.
 * Page 3 press/release uses 0 (release = POST /move/stop). Lab scripts may set >0.
 * Mutable for tests via _setMoveHoldMsForTest.
 */
let MOVE_HOLD_MS = Number(process.env.MOVE_HOLD_MS ?? 0);
/** Background BLE reconnect interval when gimbal drops (0 = off). */
const RECONNECT_MS = Number(process.env.RECONNECT_MS ?? 5000);
/** Block /move/hold after each BLE connect — Stream Deck key-sync often fires tilt=1 on Up. */
const CONNECT_GUARD_MS = Number(process.env.CONNECT_GUARD_MS ?? 8000);
/** 0x12 heartbeat interval for live 0x04/0x66 tilt telemetry (0 = off). */
const TELEMETRY_HB_MS = Number(process.env.TELEMETRY_HB_MS ?? 1000);
/** Run connect prologue on link-up so 0x66 notify stream starts (no recenter). */
const TELEMETRY_SETUP =
  (process.env.TELEMETRY_SETUP ?? process.env.TELEMETRY_RONIN ?? '1') !== '0';
/** /state reports stale when last 0x66 is older than this. */
const TELEMETRY_STALE_MS = Number(process.env.TELEMETRY_STALE_MS ?? 3000);
/** Refresh connected-link RSSI for status UI (0 = scan-only, no live poll). */
const BLE_RSSI_POLL_MS = Number(process.env.BLE_RSSI_POLL_MS ?? 5000);

let telemetryHbTimer = null;

let moveAllowedAfter = 0;
let holdLeaseTimer = null;
/** Wall-clock deadline when MOVE_HOLD_MS > 0; each hold extends this. */
let moveAuthorizedUntil = 0;
let pressStartedAt = 0;
let nudgeTimer = null;
let neutralFramesRemaining = 0;
let stickWriterPromise = null;
let stickWriterGeneration = 0;
let stickWriterWake = null;
let stickWriterWakePending = false;

function armConnectGuard() {
  if (!CONNECT_GUARD_MS) return;
  moveAllowedAfter = Date.now() + CONNECT_GUARD_MS;
  log.info('ble', `connect guard — motion blocked for ${CONNECT_GUARD_MS}ms`);
  pushEvent('guard', `connect guard — motion blocked ${CONNECT_GUARD_MS}ms`);
}

export function moveBlockedByConnectGuard() {
  return CONNECT_GUARD_MS > 0 && Date.now() < moveAllowedAfter;
}

let moveWatchdog = null;
let reconnectTimer = null;
let lastBleError = null;

/** Hard cap for the coalesce watchdog (scan + ACL + relink + GATT). Mutable for tests. */
let connectTotalMs = Number(process.env.CONNECT_TOTAL_MS ?? 160000);
/** Coalesce wait — defaults to the same attempt budget. */
const CONNECT_STALE_MS = Number(process.env.CONNECT_STALE_MS ?? connectTotalMs);

/**
 * Single source of truth for the connect-coalescing invariant ("one attempt in
 * flight, never block forever"). The state machine lives in connect-coordinator.js;
 * the radio work for an attempt is attemptConnect() below. session.cancelConnect is
 * the cross-cutting cooperative cancel (checked here and by the move commands).
 */
const cc = new ConnectCoordinator({
  staleMs: CONNECT_STALE_MS,
  abortScan: abortBleScan,
  notify: (level, msg) => log[level]('ble', msg),
  event: (msg) => pushEvent('error', msg),
});

/** Inbound sleep/wake the bridge did not itself write. */
function parseHandleMotor(data) {
  const state = parseMotorSleepNotify(data);
  if (!state) return null;
  return { state, source: 'handle' };
}

/** Live telemetry + motor state from BLE notifies; arbitration lives here. */
const telem = new TelemetryState({
  staleMs: TELEMETRY_STALE_MS,
  parseMotor: parseHandleMotor,
  parseAttitude,
  isPose: isPoseTelemetry,
  onMotorChange: (state, source) => {
    log.info('ble', `motor ${state} (from ${source})`);
    pushEvent('motor', state, { source });
  },
});

function clearMoveWatchdog() {
  if (moveWatchdog) clearTimeout(moveWatchdog);
  moveWatchdog = null;
}

function clearNudgeTimer() {
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = null;
}

function clearHoldLeaseTimer() {
  if (holdLeaseTimer) clearTimeout(holdLeaseTimer);
  holdLeaseTimer = null;
}

function clearHoldLease() {
  clearHoldLeaseTimer();
  moveAuthorizedUntil = 0;
}

function clearMoveState() {
  stickWriterGeneration += 1;
  stickWriterPromise = null;
  if (stickWriterWake) stickWriterWake();
  stickWriterWake = null;
  stickWriterWakePending = false;
  clearNudgeTimer();
  clearHoldLease();
  clearMoveWatchdog();
  pressStartedAt = 0;
  neutralFramesRemaining = 0;
  session.active = false;
  session.sticks = [];
  session.frameIdx = 0;
  session.axis = null;
}

/** Optional orphan lease (MOVE_HOLD_MS=0 → free-run until /move/stop or MAX_MOVE_MS). */
function armHoldLease() {
  clearHoldLeaseTimer();
  if (!MOVE_HOLD_MS) {
    moveAuthorizedUntil = Number.POSITIVE_INFINITY;
    return;
  }
  moveAuthorizedUntil = Date.now() + MOVE_HOLD_MS;
  holdLeaseTimer = setTimeout(() => {
    log.info('move', `MOVE_HOLD_MS ${MOVE_HOLD_MS} — hold lease expired`);
    pushEvent('watchdog', `hold lease expired after ${MOVE_HOLD_MS}ms`);
    stopMove().catch((err) => log.error('move', `hold lease stop failed: ${err.message || err}`));
  }, MOVE_HOLD_MS);
}

function armMoveWatchdog() {
  clearMoveWatchdog();
  if (!MAX_MOVE_MS) return;
  moveWatchdog = setTimeout(() => {
    log.warn('move', `MAX_MOVE_MS ${MAX_MOVE_MS} — auto stopMove`);
    pushEvent('watchdog', `auto stop after ${MAX_MOVE_MS}ms`);
    stopMove().catch((err) => log.error('move', `watchdog stop failed: ${err.message || err}`));
  }, MAX_MOVE_MS);
}

function stopTelemetryHb() {
  if (telemetryHbTimer) clearInterval(telemetryHbTimer);
  telemetryHbTimer = null;
}

async function enableTelemetrySubscription(chars) {
  chars.fff4.removeAllListeners('data');
  chars.fff4.on('data', telem.ingest);
  await new Promise((resolve) => {
    chars.fff4.subscribe((err) => {
      if (err) log.warn('ble', `fff4 subscribe: ${err.message || err}`);
      resolve();
    });
    setTimeout(resolve, 1500);
  });
  if (wireLogEnabled()) {
    installWireTap(chars);
    attachWireRx(chars);
  }
}

function startTelemetryHb() {
  if (!TELEMETRY_HB_MS || telemetryHbTimer || !session.chars) return;
  const hb = buildHeartbeat12Frame();
  telemetryHbTimer = setInterval(() => {
    session.chars?.fff5.writeAsync(hb, true).catch(() => {});
  }, TELEMETRY_HB_MS);
  log.info('ble', `telemetry heartbeat every ${TELEMETRY_HB_MS}ms`);
}

async function ensureTelemetryStream() {
  assertBleReady();
  await enableTelemetrySubscription(session.chars);
  assertBleReady();
  if (TELEMETRY_SETUP && !session.telemetrySetupReady) {
    await runSessionSetup(session.chars, { heartbeats: 3, heartbeatMs: 400 });
    assertBleReady();
    session.telemetrySetupReady = true;
    log.info('ble', 'telemetry session setup ready');
  }
  startTelemetryHb();
}

function assertBleReady() {
  if (session.cancelConnect) throw new Error('connect cancelled');
  if (!session.peripheral || session.peripheral.state !== 'connected' || !session.chars) {
    throw new Error('disconnected');
  }
}

async function finishPostConnect() {
  try {
    assertBleReady();
    await ensureTelemetryStream();
    assertBleReady();
    await sendNeutralBurst();
    assertBleReady();
  } catch (err) {
    const msg = err.message || String(err);
    if (session.cancelConnect || msg === 'disconnected' || msg === 'connect cancelled') {
      log.debug('ble', `post-connect aborted: ${msg}`);
      return;
    }
    log.warn('ble', `post-connect setup failed: ${msg}`);
    pushEvent('error', `post-connect: ${msg}`);
  }
}

/** @type {{ dbm: number | null, updatedAt: number | null, source: string | null }} */
let linkRssi = { dbm: null, updatedAt: null, source: null };
let rssiPollIv = null;

function noteRssi(dbm, source) {
  const n = Number(dbm);
  if (!Number.isFinite(n)) return;
  linkRssi = { dbm: n, updatedAt: Date.now(), source };
}

function clearRssi() {
  stopRssiPoll();
  linkRssi = { dbm: null, updatedAt: null, source: null };
}

function stopRssiPoll() {
  if (rssiPollIv) clearInterval(rssiPollIv);
  rssiPollIv = null;
}

async function refreshRssi(peripheral) {
  if (!session.peripheral || session.peripheral !== peripheral) return;
  if (peripheral.state !== 'connected') return;
  try {
    let dbm;
    if (typeof peripheral.updateRssiAsync === 'function') {
      dbm = await withTimeout(peripheral.updateRssiAsync(), 3000, 'updateRssi');
    } else if (typeof peripheral.updateRssi === 'function') {
      dbm = await withTimeout(
        new Promise((resolve, reject) => {
          peripheral.updateRssi((err, rssi) => (err ? reject(err) : resolve(rssi)));
        }),
        3000,
        'updateRssi',
      );
    }
    noteRssi(Number.isFinite(Number(dbm)) ? dbm : peripheral.rssi, 'live');
  } catch {
    if (Number.isFinite(Number(peripheral.rssi))) noteRssi(peripheral.rssi, 'cached');
  }
}

function startRssiPoll(peripheral) {
  stopRssiPoll();
  noteRssi(peripheral.rssi, 'scan');
  if (BLE_RSSI_POLL_MS <= 0) return;
  rssiPollIv = setInterval(() => {
    void refreshRssi(peripheral);
  }, BLE_RSSI_POLL_MS);
  void refreshRssi(peripheral);
}

function attachDisconnectHandler(peripheral) {
  peripheral.removeAllListeners('disconnect');
  peripheral.once('disconnect', () => {
    session.cancelConnect = true;
    const addr = rememberGimbalAddress(peripheral);
    const chars = session.chars;
    log.warn('ble', 'gimbal BLE disconnected');
    pushEvent('disconnect', 'gimbal BLE disconnected');
    lastBleError = 'disconnected';
    stopTelemetryHb();
    clearRssi();
    telem.clearTelemetry();
    telem.clearMotor();
    clearMoveState();
    session.chars = null;
    session.peripheral = null;
    session.recenterSetupReady = false;
    session.telemetrySetupReady = false;
    void closeSession(peripheral, chars || {}).catch(() => {});
    if (addr) void forceBlueZDisconnect(addr, peripheral);
  });
}

/** Drop stale handles when noble says the link is gone. */
async function invalidateIfDisconnected() {
  if (!session.peripheral) return;
  if (session.peripheral.state === 'connected' && session.chars) return;

  log.info('ble', `session stale state=${session.peripheral.state}`);
  lastBleError = `stale:${session.peripheral.state}`;
  stopTelemetryHb();
  clearRssi();
  telem.clearTelemetry();
  telem.clearMotor();
  clearMoveState();
  const peripheral = session.peripheral;
  const chars = session.chars;
  session.peripheral = null;
  session.chars = null;
  session.recenterSetupReady = false;
  session.telemetrySetupReady = false;
  if (peripheral.state === 'connected' || peripheral.state === 'connecting') {
    await closeSessionSafe(peripheral, chars || {});
  }
}

/** @type {{ peripheral: import('@abandonware/noble').Peripheral | null, chars: object | null, sticks: { a: number, b: number, c: number }[], frameIdx: number, active: boolean, axis: string | null, cancelConnect: boolean }} */
const session = {
  peripheral: null,
  chars: null,
  sticks: [],
  frameIdx: 0,
  active: false,
  axis: null,
  cancelConnect: false,
  recenterSetupReady: false,
  telemetrySetupReady: false,
};

function normalizeAxis(pan, tilt) {
  const panN = Math.max(-50, Math.min(50, Number(pan) || 0));
  const tiltN = Math.max(-50, Math.min(50, Number(tilt) || 0));
  if (panN === 0 && tiltN === 0) {
    throw new Error('pan or tilt required');
  }
  return { pan: panN, tilt: tiltN };
}

async function teardownConnection() {
  log.debug('ble', 'teardownConnection');
  stopTelemetryHb();
  clearRssi();
  telem.clearTelemetry();
  telem.clearMotor();
  clearMoveState();
  const peripheral = session.peripheral;
  const chars = session.chars;
  const addr = peripheral ? rememberGimbalAddress(peripheral) : getLastGimbalAddress();
  if (chars) {
    try {
      await sendNeutralBurst();
    } catch (err) {
      log.warn('ble', `teardown neutral burst: ${err.message || err}`);
    }
  }
  if (peripheral) {
    await closeSessionSafe(peripheral, chars || {});
  }
  if (addr) await forceBlueZDisconnect(addr, peripheral);
  session.peripheral = null;
  session.chars = null;
  session.recenterSetupReady = false;
  session.telemetrySetupReady = false;
}

function sessionIsLive() {
  return session.peripheral?.state === 'connected' && Boolean(session.chars);
}

function attemptCancelled(myEpoch) {
  return session.cancelConnect || !cc.isCurrent(myEpoch);
}

/** Previous attempt's teardown. The next connect waits for this. */
let radioQuiet = Promise.resolve();

/** Tear down this attempt's radio. BlueZ disconnect runs here, not at the next scan. */
async function teardownAttempt(peripheral, chars) {
  const job = (async () => {
    await abortBleScan();
    if (peripheral) rememberGimbalAddress(peripheral);
    if (peripheral) await closeSessionSafe(peripheral, chars || {});
    const addr = getLastGimbalAddress();
    if (addr) await forceBlueZDisconnect(addr, peripheral);
  })();
  const guarded = withTimeout(job, 12000, 'teardown').catch((err) => {
    log.warn('ble', `${err.message || err} — teardown continuing`);
  });
  radioQuiet = guarded;
  await guarded;
}

/** One connect attempt (scan → link → GATT → pairing). Bails if cancelled or superseded. */
function attemptConnect(gimbalId, myEpoch) {
  return (async () => {
    let peripheral;
    let chars;
    const runConnect = async () => {
      log.info('ble', `connecting ${gimbalTargetLabel(gimbalId)}`);
      peripheral = await findPeripheral(gimbalId);
      if (attemptCancelled(myEpoch)) return;
      noteRssi(peripheral.rssi, 'scan');
      log.info('ble', `scan done — starting link to ${peripheral.advertisement?.localName || peripheral.id} rssi=${peripheral.rssi ?? '?'}`);
      await connectPeripheral(peripheral);
      if (attemptCancelled(myEpoch)) return;
      chars = await discoverGimbalChars(peripheral);
      if (attemptCancelled(myEpoch)) return;
      await writePairingPrologue(chars.fff4, loadPairingHex());
      if (attemptCancelled(myEpoch)) {
        await teardownAttempt(peripheral, chars);
        return;
      }
      session.peripheral = peripheral;
      session.chars = chars;
      rememberGimbalAddress(peripheral);
      attachDisconnectHandler(peripheral);
      startRssiPoll(peripheral);
      lastBleError = null;
      const name = peripheral.advertisement?.localName || peripheral.id;
      log.info('ble', `connected ${name} rssi=${peripheral.rssi ?? '?'}`);
      pushEvent('connect', `connected ${name}`, {
        rssi: Number.isFinite(Number(peripheral.rssi)) ? Number(peripheral.rssi) : null,
      });
      telem.setMotor('AWAKE', 'connect');
      armConnectGuard();
    };

    try {
      await runConnect();
    } catch (err) {
      lastBleError = err.message || String(err);
      log.warn('ble', `connect failed: ${lastBleError}`);
      pushEvent('error', `connect failed: ${lastBleError}`);
      session.cancelConnect = true;
      if (session.peripheral === peripheral && session.chars) {
        log.warn('ble', 'connect error after pairing — keeping live session');
        return;
      }
      await teardownAttempt(peripheral, chars);
      if (session.peripheral === peripheral) {
        session.peripheral = null;
        session.chars = null;
      }
      throw err;
    }
  })();
}

async function ensureConnected(gimbalId) {
  await radioQuiet;
  await invalidateIfDisconnected();
  if (sessionIsLive()) return;

  if (cc.connecting) {
    await cc.coalesce();
    if (sessionIsLive()) return;
    if (cc.connecting) {
      throw new Error('BLE session not connected');
    }
  }

  session.cancelConnect = false;
  const myEpoch = cc.start((epoch) => attemptConnect(gimbalId, epoch));
  await cc.settle(myEpoch);

  if (!session.chars) {
    throw new Error('BLE session not connected');
  }

  await finishPostConnect();
}

async function sendNeutralBurst() {
  if (!session.chars) return;
  for (let i = 0; i < NEUTRAL_BURST; i += 1) {
    await session.chars.fff5.writeAsync(buildNeutralFrame(), true);
    await sleep(INTERVAL_MS);
  }
}

async function writeStickFrame(stick) {
  if (!session.chars || !stick) return;
  const frame = buildJoystickFrame(stick.a, stick.b, stick.c);
  await session.chars.fff5.writeAsync(frame, true);
}

function stickWriterHasWork() {
  return session.active || neutralFramesRemaining > 0;
}

function wakeStickWriter() {
  if (stickWriterWake) {
    const wake = stickWriterWake;
    stickWriterWake = null;
    wake();
  } else {
    stickWriterWakePending = true;
  }
}

async function waitForWriterTick() {
  if (stickWriterWakePending) {
    stickWriterWakePending = false;
    return;
  }
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stickWriterWake === finish) stickWriterWake = null;
      resolve();
    };
    const timer = setTimeout(finish, INTERVAL_MS);
    stickWriterWake = finish;
  });
}

/**
 * One state-driven writer. It reads the current desired stick on every tick:
 * a new direction replaces the old one immediately, and neutral is interruptible.
 */
function ensureStickWriter() {
  if (stickWriterPromise || !sessionIsLive() || !stickWriterHasWork()) return;

  const generation = ++stickWriterGeneration;
  stickWriterPromise = (async () => {
    while (
      generation === stickWriterGeneration &&
      sessionIsLive() &&
      stickWriterHasWork()
    ) {
      try {
        if (session.active && session.sticks.length) {
          const stick = session.sticks[session.frameIdx % session.sticks.length];
          session.frameIdx += 1;
          await writeStickFrame(stick);
        } else {
          await session.chars.fff5.writeAsync(buildNeutralFrame(), true);
          neutralFramesRemaining = Math.max(0, neutralFramesRemaining - 1);
        }
      } catch (err) {
        log.error('ble', `stick writer failed: ${err.message || err}`);
        clearMoveState();
        await teardownConnection();
        return;
      }
      await waitForWriterTick();
    }
  })()
    .catch((err) => log.error('ble', `stick writer loop failed: ${err.message || err}`))
    .finally(() => {
      if (generation !== stickWriterGeneration) return;
      stickWriterPromise = null;
      if (sessionIsLive() && stickWriterHasWork()) ensureStickWriter();
    });
}

function finishMoveToNeutral(axis, source) {
  const writerRunning = Boolean(stickWriterPromise);
  clearNudgeTimer();
  clearHoldLease();
  clearMoveWatchdog();
  pressStartedAt = 0;
  session.active = false;
  session.sticks = [];
  session.frameIdx = 0;
  session.axis = null;
  neutralFramesRemaining = Math.max(1, RELEASE_NEUTRAL_FRAMES);
  ensureStickWriter();
  if (writerRunning) wakeStickWriter();
  log.info('move', `${source} axis=${axis ?? 'none'}`);
  if (axis) pushEvent('stop', `stop ${axis}`);
}

/**
 * Set the current desired stick. Page 3 button down calls this route; it requires
 * an already-live BLE session (HTTP rejects unlinked movement before this call).
 */
export async function holdMove(gimbalId, { pan = 0, tilt = 0 } = {}) {
  if (!sessionIsLive()) throw new Error('not connected');

  const { pan: panN, tilt: tiltN } = normalizeAxis(pan, tilt);
  const { axis, phases } = pickMovePlan(panN, tiltN);
  const refreshed = session.active && session.axis === axis;
  const writerRunning = Boolean(stickWriterPromise);

  clearNudgeTimer();
  neutralFramesRemaining = 0;
  if (!refreshed) pressStartedAt = Date.now();
  session.sticks = phases.map((p) => p.stick);
  session.frameIdx = 0;
  session.axis = axis;
  session.active = true;
  armHoldLease();
  armMoveWatchdog();
  ensureStickWriter();
  if (writerRunning) wakeStickWriter();

  log.info('move', `holdMove axis=${axis} pan=${panN} tilt=${tiltN}`);
  pushEvent('move', `hold ${axis}`);
  return {
    ok: true,
    axis,
    pan: panN,
    tilt: tiltN,
    active: true,
    ...(refreshed ? { refreshed: true } : {}),
    name: session.peripheral?.advertisement?.localName || gimbalId,
  };
}

/** Lab / preset — connect and wait until session is ready (same as HTTP commands). */
export async function connectGimbal(gimbalId) {
  await ensureConnected(gimbalId);
  return getGimbalState();
}

/**
 * Send 0x04/0x14 absolute-angle recall (experimental — bench only until gate passes).
 * Uses session prologue + heartbeat; does not recenter.
 */
export async function recallAbsAngle(
  gimbalId,
  { pitch, roll = 0, yaw, flags = 0x07, duration = 80, settleMs = 3000 } = {},
) {
  if (pitch == null || yaw == null) {
    throw new Error('pitch and yaw required');
  }

  session.cancelConnect = false;
  if (session.active) {
    clearNudgeTimer();
    neutralFramesRemaining = 0;
    session.active = false;
    clearMoveWatchdog();
    if (session.chars) await sendNeutralBurst();
    session.sticks = [];
    session.frameIdx = 0;
    session.axis = null;
  }

  await ensureConnected(gimbalId);
  if (session.cancelConnect) {
    session.cancelConnect = false;
    return { ok: false, cancelled: true };
  }

  if (!session.telemetrySetupReady && TELEMETRY_SETUP) {
    await runSessionSetup(session.chars, { heartbeats: 5, heartbeatMs: 400 });
    session.telemetrySetupReady = true;
  }
  startTelemetryHb();

  const frame = buildAbsAngle(pitch, roll, yaw, { flags, duration });
  await session.chars.fff5.writeAsync(frame, true);
  log.info('move', `recallAbsAngle pitch=${pitch} roll=${roll} yaw=${yaw} flags=${flags} duration=${duration}`);
  pushEvent('preset', `recall pitch=${pitch} yaw=${yaw}`);
  if (settleMs > 0) await sleep(settleMs);

  return { ok: true, pitch, roll, yaw, flags, duration };
}

/**
 * Replay Ronin Track path — 0x6b poll + 0x62 upload (bench only, Stage 0f/0g).
 */
export async function replayTrackPath(
  gimbalId,
  { payload, pollMs = 4000, prePolls = 3, followMs = 20000 } = {},
) {
  if (!payload?.length) throw new Error('0x62 payload required');

  session.cancelConnect = false;
  if (session.active) {
    clearNudgeTimer();
    neutralFramesRemaining = 0;
    session.active = false;
    clearMoveWatchdog();
    if (session.chars) await sendNeutralBurst();
    session.sticks = [];
    session.frameIdx = 0;
    session.axis = null;
  }

  await ensureConnected(gimbalId);
  if (session.cancelConnect) {
    session.cancelConnect = false;
    return { ok: false, cancelled: true };
  }

  if (!session.telemetrySetupReady && TELEMETRY_SETUP) {
    await runSessionSetup(session.chars, { heartbeats: 5, heartbeatMs: 400 });
    session.telemetrySetupReady = true;
  }
  startTelemetryHb();

  const poll = () => session.chars.fff5.writeAsync(build6bPollFrame(), true);
  for (let i = 0; i < prePolls; i += 1) {
    await poll();
    if (i + 1 < prePolls) await sleep(pollMs);
  }

  await session.chars.fff5.writeAsync(build062UploadFrame(payload), true);
  log.info('move', `replayTrackPath 0x62 len=${payload.length}`);
  pushEvent('preset', `track 0x62 len=${payload.length}`);
  await sleep(500);
  await poll();

  const end = Date.now() + followMs;
  while (Date.now() < end) {
    await poll();
    await sleep(pollMs);
  }

  return { ok: true, payloadLen: payload.length };
}

/**
 * Re-send connect prologue + 0x12 heartbeat without 0x04/0x4c recenter.
 * Wakes 0x04/0x66 telemetry when the link is stuck on static 0x10.
 */
export async function refreshTelemetry(gimbalId, { heartbeats = 5, heartbeatMs = 400, settleMs = 1500 } = {}) {
  session.cancelConnect = false;
  if (session.active) {
    clearNudgeTimer();
    neutralFramesRemaining = 0;
    session.active = false;
    clearMoveWatchdog();
    if (session.chars) await sendNeutralBurst();
    session.sticks = [];
    session.frameIdx = 0;
    session.axis = null;
  }

  await ensureConnected(gimbalId);
  if (session.cancelConnect) {
    session.cancelConnect = false;
    return { ok: false, cancelled: true };
  }

  await runSessionSetup(session.chars, { heartbeats, heartbeatMs });
  session.telemetrySetupReady = true;
  startTelemetryHb();
  if (settleMs > 0) await sleep(settleMs);

  const t = telem.telemetry;
  log.info('ble', 'refreshTelemetry prologue + heartbeat (no recenter)');
  pushEvent('telemetry', 'refresh');

  return {
    ok: true,
    refreshed: true,
    source: t.source,
    tiltRaw: t.tiltRaw,
    panRaw: t.panRaw,
    name: session.peripheral?.advertisement?.localName || gimbalId,
  };
}

export async function centerGimbal(gimbalId) {
  session.cancelConnect = false;
  clearNudgeTimer();
  neutralFramesRemaining = 0;
  clearHoldLease();
  clearMoveWatchdog();
  if (session.active) {
    session.active = false;
    if (session.chars) await sendNeutralBurst();
    session.sticks = [];
    session.frameIdx = 0;
    session.axis = null;
  }

  await ensureConnected(gimbalId);
  if (session.cancelConnect) {
    session.cancelConnect = false;
    return { ok: true, cancelled: true };
  }

  // Connect already ran session prologue (includes a 0x04/0x01 stick frame). Replaying
  // that on every CTR is what bucks the head before 0x4c — skip once set up.
  if (session.recenterSetupReady || session.telemetrySetupReady) {
    if (session.chars) {
      await session.chars.fff5.writeAsync(buildNeutralFrame(), true);
      await sleep(80);
    }
    await sendCenterTap(session.chars);
    session.recenterSetupReady = true;
    session.telemetrySetupReady = true;
    startTelemetryHb();
    log.info('move', 'centerGimbal 0x04/0x4c fe01 (no prologue)');
  } else {
    await runRecenterSession(session.chars, {
      heartbeats: 5,
      heartbeatMs: 1000,
    });
    session.recenterSetupReady = true;
    session.telemetrySetupReady = true;
    startTelemetryHb();
    log.info('move', 'centerGimbal session prologue + 0x04/0x4c fe01');
  }
  pushEvent('center', 'recenter');

  return {
    ok: true,
    centered: true,
    name: session.peripheral?.advertisement?.localName || gimbalId,
  };
}

async function sendSleepWakeCommand(gimbalId, mode) {
  session.cancelConnect = false;
  if (session.active) {
    clearNudgeTimer();
    neutralFramesRemaining = 0;
    session.active = false;
    clearMoveWatchdog();
    if (session.chars) await sendNeutralBurst();
    session.sticks = [];
    session.frameIdx = 0;
    session.axis = null;
  }

  await ensureConnected(gimbalId);
  if (session.cancelConnect) {
    session.cancelConnect = false;
    return { ok: true, cancelled: true };
  }

  if (!session.telemetrySetupReady && TELEMETRY_SETUP) {
    await runSessionSetup(session.chars, { heartbeats: 2, heartbeatMs: 400 });
    session.telemetrySetupReady = true;
    startTelemetryHb();
  }

  await sendSleepWake(session.chars, mode);
  telem.setMotor(mode === 'sleep' ? 'ASLEEP' : 'AWAKE', 'command');
  log.info('move', `${mode}Gimbal 0x04/0x0f 23 01 ${mode === 'sleep' ? '11' : '10'}`);
  pushEvent(mode, mode);

  return {
    ok: true,
    [mode]: true,
    motor: telem.motorState,
    name: session.peripheral?.advertisement?.localName || gimbalId,
  };
}

export async function sleepGimbal(gimbalId) {
  return sendSleepWakeCommand(gimbalId, 'sleep');
}

export async function wakeGimbal(gimbalId) {
  return sendSleepWakeCommand(gimbalId, 'wake');
}

/** AWAKE → sleep; ASLEEP or UNKNOWN → wake. */
export async function toggleMotor(gimbalId) {
  const state = getMotorLabel();
  if (state === 'AWAKE') return sleepGimbal(gimbalId);
  return wakeGimbal(gimbalId);
}

/**
 * Finger up. A short press completes a fixed nudge; a promoted hold stops now.
 * Idle key-sync stops are cheap no-ops.
 */
export async function stopMove() {
  const wasActive = session.active;
  const axis = session.axis;
  if (!wasActive) {
    return { ok: true, stopped: true, active: false, axis: null, idle: true };
  }

  const elapsedMs = pressStartedAt ? Date.now() - pressStartedAt : HOLD_PROMOTE_MS;
  const nudgeRemainingMs = Math.max(0, NUDGE_MS - elapsedMs);
  const isTap = elapsedMs < HOLD_PROMOTE_MS;

  if (isTap && nudgeRemainingMs > 0) {
    clearNudgeTimer();
    nudgeTimer = setTimeout(() => {
      if (session.active && session.axis === axis) {
        finishMoveToNeutral(axis, 'nudge complete');
      }
    }, nudgeRemainingMs);
    log.info(
      'move',
      `stopMove tap axis=${axis} elapsed=${elapsedMs}ms remaining=${nudgeRemainingMs}ms`,
    );
    return {
      ok: true,
      stopped: false,
      active: true,
      nudge: true,
      axis,
      elapsedMs,
      remainingMs: nudgeRemainingMs,
    };
  }

  finishMoveToNeutral(axis, isTap ? 'tap stop' : 'hold stop');
  return {
    ok: true,
    stopped: true,
    active: false,
    nudge: isTap,
    axis,
    elapsedMs,
  };
}

export function getMoveStatus() {
  const connected = sessionIsLive();
  return {
    connected,
    active: session.active,
    axis: session.axis,
    connecting: !connected && (cc.connecting || cc.reconnecting),
    lastBleError,
  };
}

/** Motor label for Companion poll — AWAKE, ASLEEP, or UNKNOWN when not connected. */
export function getMotorLabel() {
  if (session.peripheral?.state !== 'connected' || !session.chars) return 'UNKNOWN';
  return telem.motorState ?? 'AWAKE';
}

/** Live gimbal attitude from 0x04/0x10 / 0x04/0x66 BLE notify. */
export function getGimbalState() {
  const moveStatus = getMoveStatus();
  const telemetry = telem.telemetry;
  const ageMs = telemetry.updatedAt ? Date.now() - telemetry.updatedAt : null;
  const motorAgeMs = telem.motorUpdatedAt ? Date.now() - telem.motorUpdatedAt : null;
  const stale =
    !moveStatus.connected ||
    telemetry.tiltDeg == null ||
    ageMs == null ||
    ageMs > TELEMETRY_STALE_MS;

  return {
    ok: moveStatus.connected,
    ble: {
      connected: moveStatus.connected,
      connecting: moveStatus.connecting,
      lastError: moveStatus.lastBleError,
      rssiDbm: linkRssi.dbm,
      rssiAgeMs: linkRssi.updatedAt ? Date.now() - linkRssi.updatedAt : null,
      rssiSource: linkRssi.source,
    },
    move: {
      active: moveStatus.active,
      axis: moveStatus.axis,
    },
    motor: {
      state: moveStatus.connected ? (telem.motorState ?? 'AWAKE') : null,
      source: telem.motorSource,
      ageMs: motorAgeMs,
    },
    telemetry: {
      tiltDeg: telemetry.tiltDeg,
      tiltRaw: telemetry.tiltRaw,
      rollDeg: telemetry.rollDeg,
      rollRaw: telemetry.rollRaw,
      panDeg: telemetry.panDeg,
      panRaw: telemetry.panRaw,
      layout: telemetry.layout,
      tlv: telemetry.tlv,
      source: telemetry.source,
      ageMs,
      stale,
      rawPayload: telemetry.rawPayload,
      batteryPercent: telemetry.batteryPercent,
      batteryRaw: telemetry.batteryRaw,
      batteryAgeMs: telemetry.batteryUpdatedAt
        ? Date.now() - telemetry.batteryUpdatedAt
        : null,
    },
  };
}

async function tryBackgroundReconnect(gimbalId) {
  if (!hasGimbalTarget(gimbalId)) return;
  if (cc.connecting || cc.reconnecting) return;
  if (sessionIsLive()) return;

  cc.beginReconnect();
  pushEvent('scan', 'background reconnect attempt');
  try {
    await ensureConnected(gimbalId);
    if (sessionIsLive()) {
      log.info('ble', 'background reconnect ok');
      pushEvent('reconnect', 'background reconnect ok');
    }
  } catch (err) {
    log.warn('ble', `background reconnect: ${err.message || err}`);
    pushEvent('error', `reconnect: ${err.message || err}`);
  } finally {
    cc.endReconnect();
  }
}

/** Poll BLE reconnect while gimbal is away (power cycle, out of range). */
export function startReconnectLoop(gimbalId) {
  stopReconnectLoop();
  if (!hasGimbalTarget(gimbalId) || !RECONNECT_MS) return;
  reconnectTimer = setInterval(() => {
    tryBackgroundReconnect(gimbalId).catch((err) => {
      log.debug('ble', `reconnect loop: ${err.message || err}`);
    });
  }, RECONNECT_MS);
  log.info('ble', `reconnect loop every ${RECONNECT_MS}ms`);
}

export function stopReconnectLoop() {
  if (reconnectTimer) clearInterval(reconnectTimer);
  reconnectTimer = null;
}

/** Connect at boot; reconnect loop handles retries if the gimbal is off or drops. */
export async function connectOnStartup(gimbalId) {
  if (!hasGimbalTarget(gimbalId)) return;
  try {
    await ensureConnected(gimbalId);
    log.info('ble', 'startup connect ok');
  } catch (err) {
    log.warn('ble', `startup connect failed: ${err.message || err}`);
  }
}

export async function shutdownSession() {
  stopReconnectLoop();
  session.cancelConnect = true;
  session.active = false;
  await teardownConnection();
}

/** @internal test helper — clean slate for module-level singleton state between scenarios. */
export function _resetForTest() {
  stopReconnectLoop();
  clearMoveState();
  stopTelemetryHb();
  clearRssi();
  cc.reset();
  session.peripheral = null;
  session.chars = null;
  session.sticks = [];
  session.frameIdx = 0;
  session.active = false;
  session.axis = null;
  session.cancelConnect = false;
  session.recenterSetupReady = false;
  session.telemetrySetupReady = false;
  telem.clearMotor();
  telem.clearTelemetry();
  lastBleError = null;
  radioQuiet = Promise.resolve();
}

/** @internal test helper — override connect timing (defaults read from env at load). */
export function _setConnectTimingForTest({ staleMs, totalMs } = {}) {
  if (staleMs != null) cc.setStaleMs(staleMs);
  if (totalMs != null) connectTotalMs = totalMs;
}

/** @internal test helper — override hold lease (0 = disabled). */
export function _setMoveHoldMsForTest(ms) {
  MOVE_HOLD_MS = Number(ms);
}

/** @internal test helper — override tap/hold feel timing. */
export function _setDeckTimingForTest({ promoteMs, nudgeMs } = {}) {
  if (promoteMs != null) HOLD_PROMOTE_MS = Number(promoteMs);
  if (nudgeMs != null) NUDGE_MS = Number(nudgeMs);
}

/** @internal test helper — one scheduler tick (no force-stale). */
export async function _tickReconnectForTest(gimbalId) {
  await tryBackgroundReconnect(gimbalId);
}
