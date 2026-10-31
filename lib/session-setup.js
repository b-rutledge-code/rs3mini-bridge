import {
  buildMessage,
  parseMessage,
  TARGET_APP_TO_GIMBAL,
  TARGET_APP_TO_PARAMS,
} from './duml.js';
import { sleep } from './ble-session.js';

/**
 * Connect prologue — Stage 0b recenter capture (order preserved).
 * 0x04/0x12 slots use HEARTBEAT_12_PAYLOAD → r=e5 (pose mask 0x22–0x24).
 * Do not send 66 0c c0 1d to e5 — that downgrades ActualPose off.
 */
const PROLOGUE_HEX = [
  '550d0433020401004000014eff',
  '550d04330204020040000182e2',
  '550d04330227030040070e24d5',
  '550d0433022704004000010750',
  null, // 0x12 — see buildSubscribeGimbalParams12
  '550e046602e50600400032118702',
  '550d043302040700400001d6c4',
  '550d043302e508004000011228',
  null, // 0x12
  '550d043302270a004007078119',
  null, // 0x12
  '5514046d02e50c00400071040004000002014583',
  '550e046602e50d0040003211a22f',
  null, // 0x12
];

/**
 * SendPack.doPack flags: (cmdType << 7) | (isNeedAck << 5) | encryptType.
 * DataGimbalSetPushPeripheralStatus.start uses CMDTYPE.ACK (1) + NEEDACK.YES (2) → 0xC0.
 */
const FLAG_ACK_NEED = 0xc0;

/** RequestType.data — DataGimbalSetPushPeripheralStatus$RequestType clinit. */
export const PUSH_PERIPHERAL_REQUEST = {
  StartContinuePush: 0,
  StopContinuePush: 1,
  RequestSinglePush: 2,
};

/**
 * Enable/disable 0x04/0x66 peripheral TLV push (ActualPose tags 0x22/0x23/0x24).
 * Restored doPack: 3-byte body `[0, requestType, 0]`; cmdId SetPushPeripheralStatus=0x66.
 */
export function buildSetPushPeripheralStatus(
  requestType = PUSH_PERIPHERAL_REQUEST.StartContinuePush,
  { flags = FLAG_ACK_NEED } = {},
) {
  const payload = Buffer.from([0x00, requestType & 0xff, 0x00]);
  return buildMessage(TARGET_APP_TO_GIMBAL, flags, 0x04, 0x66, payload);
}

/**
 * 0x04/0x12 SubscribeGimbalParams payload (Stage 0 / stage0e pose-positive).
 * Entries: [cmdId][maxTag][bitmask…] — `66 24 c0 1d 00 00 1c` arms tags
 * 0x22/0x23/0x24. Must be addressed to receiver 0xe5 (TARGET_APP_TO_PARAMS);
 * the same bytes to r=04 leave this Mini on status-only 0x66.
 */
const HEARTBEAT_12_PAYLOAD = Buffer.from(
  '1051010000000c00005000f1036624c01d00001c',
  'hex',
);

/** Track-era alternate order (pose-positive in track-20260620). */
export const HEARTBEAT_12_TRACK_PAYLOAD = Buffer.from(
  '6624c01d00001c103e010030000c000050',
  'hex',
);

/** Recenter tap — 0x04/0x4c payload fe 01 (flags 0x40). */
const CENTER_PAYLOAD = Buffer.from([0xfe, 0x01]);

/** Stage 0c sleep/wake — 0x04/0x0f payload 23 01 {11|10} (flags 0x00). */
const SLEEP_WAKE_PREFIX = Buffer.from([0x23, 0x01]);
const SLEEP_MODE = 0x11;
const WAKE_MODE = 0x10;

export function buildSleepFrame() {
  return buildMessage(
    TARGET_APP_TO_GIMBAL,
    0x00,
    0x04,
    0x0f,
    Buffer.concat([SLEEP_WAKE_PREFIX, Buffer.from([SLEEP_MODE])]),
  );
}

export function buildWakeFrame() {
  return buildMessage(
    TARGET_APP_TO_GIMBAL,
    0x00,
    0x04,
    0x0f,
    Buffer.concat([SLEEP_WAKE_PREFIX, Buffer.from([WAKE_MODE])]),
  );
}

/** Replay exact Stage 0c capture frames (seq/CRC preserved). */
export const SLEEP_WAKE_CAPTURE_HEX = {
  sleep: '5510045602041e0040040f2301115034',
  wake: '551004560204250040040f2301103d6f',
};

const MOTOR_SLEEP_PREFIX = Buffer.from([0x23, 0x01]);

/**
 * Motor sleep/wake on fff4.
 * 0x04/0x0f is the sleep command and its echo (`23 01 11` asleep / `10` awake).
 * 0x04/0x27 is the abnormal-status push. Sleep is bit 0 of payload byte 4,
 * which is what the handle updates when the bridge did not send the command.
 */
export function parseMotorSleepNotify(data) {
  const msg = parseMessage(data);
  if (!msg || msg.cmdSet !== 0x04) return null;
  const p = msg.payload;
  if (msg.cmdId === 0x27) {
    if (p.length < 5) return null;
    return (p[4] & 0x01) !== 0 ? 'ASLEEP' : 'AWAKE';
  }
  if (msg.cmdId !== 0x0f) return null;
  // Notify echo: 00 23 01 {11|10}
  if (p.length >= 4 && p[0] === 0x00 && p.subarray(1, 3).equals(MOTOR_SLEEP_PREFIX)) {
    if (p[3] === 0x11) return 'ASLEEP';
    if (p[3] === 0x10) return 'AWAKE';
  }
  // Write path (same cmd): 23 01 {11|10}
  if (p.length >= 3 && p.subarray(0, 2).equals(MOTOR_SLEEP_PREFIX)) {
    if (p[2] === 0x11) return 'ASLEEP';
    if (p[2] === 0x10) return 'AWAKE';
  }
  return null;
}

/**
 * SubscribeGimbalParams (0x04/0x12) → params module 0xe5.
 * This is what arms continuous ActualPose on 0x66 (not SetPushPeripheral alone).
 */
export function buildSubscribeGimbalParams12(payload = HEARTBEAT_12_PAYLOAD) {
  return buildMessage(TARGET_APP_TO_PARAMS, 0x00, 0x04, 0x12, payload);
}

export function buildHeartbeat12Frame() {
  // Capture uses flags 0x00 on 0x12, not 0x40. Receiver must be 0xe5.
  return buildSubscribeGimbalParams12(HEARTBEAT_12_PAYLOAD);
}

export function buildCenterFrame() {
  return buildMessage(TARGET_APP_TO_GIMBAL, 0x40, 0x04, 0x4c, CENTER_PAYLOAD);
}

/**
 * Post-connect session setup — prologue + 0x12→e5 pose subscribe (no recenter).
 * StartContinuePush is optional midware; HCI shows 0x12→e5 with 66 24… is sufficient.
 */
export async function runSessionSetup(chars, { heartbeats = 5, heartbeatMs = 1000 } = {}) {
  const prologueHb = buildSubscribeGimbalParams12();
  for (const hex of PROLOGUE_HEX) {
    const frame = hex ? Buffer.from(hex, 'hex') : prologueHb;
    await chars.fff5.writeAsync(frame, true);
    await sleep(50);
  }
  await chars.fff5.writeAsync(
    buildSetPushPeripheralStatus(PUSH_PERIPHERAL_REQUEST.StartContinuePush),
    true,
  );
  await sleep(50);
  const hb = buildHeartbeat12Frame();
  for (let i = 0; i < heartbeats; i += 1) {
    await chars.fff5.writeAsync(hb, true);
    if (i + 1 < heartbeats) await sleep(heartbeatMs);
  }
}

/**
 * Session setup + 0x04/0x4c recenter. Joystick works without this; recenter does not.
 */
export async function runRecenterSession(chars, { heartbeats = 5, heartbeatMs = 1000 } = {}) {
  await runSessionSetup(chars, { heartbeats, heartbeatMs });
  await sendCenterTap(chars);
}

/** Mechanical recenter only — no connect prologue (prologue includes a 0x04/0x01 stick poke). */
export async function sendCenterTap(chars) {
  await chars.fff5.writeAsync(buildCenterFrame(), true);
  await sleep(150);
  await chars.fff5.writeAsync(buildCenterFrame(), true);
}

/**
 * Motor sleep/wake — Stage 0c. Requires connected session (0x12 heartbeat ok).
 * Does not run full recenter prologue; does not disconnect BLE.
 */
export async function sendSleepWake(chars, mode) {
  const frame =
    mode === 'sleep'
      ? buildSleepFrame()
      : mode === 'wake'
        ? buildWakeFrame()
        : null;
  if (!frame) throw new Error(`invalid sleep/wake mode: ${mode}`);
  await chars.fff5.writeAsync(frame, true);
}
