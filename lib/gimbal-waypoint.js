import { buildMessage, FLAG_REQUEST, TARGET_APP_TO_GIMBAL } from './duml.js';

/** Ronin Track poll — Stage 0g capture payload. */
export const TRACK_6B_PAYLOAD = Buffer.from([0x00, 0x00, 0x01, 0x62]);

/**
 * Stage 0g two-point path (up → down) from HCI capture — golden wire bytes.
 * Layout matches DataGimbalSetTrackStatus.doPack (abbacddc restore).
 */
export const STAGE0G_062_PAYLOAD = Buffer.from(
  '0a02000014000000420300001400140000003efe0e00',
  'hex',
);

/**
 * Header byte 0 flags from doPack:
 *   bit1 isTripod, bit2 startOrStop, bit3 recordOrPreview
 * Stage 0g Preview upload uses 0x0a (tripod + record/preview; startOrStop=0).
 * When startOrStop==1, doPack writes only the flags byte and returns.
 */
export function trackHeaderFlags({
  isTripod = 1,
  startOrStop = 0,
  recordOrPreview = 1,
} = {}) {
  return (
    ((isTripod & 1) << 1) |
    ((startOrStop & 1) << 2) |
    ((recordOrPreview & 1) << 3)
  );
}

/**
 * Build 0x04/0x62 path upload blob — Ronin DataGimbalSetTrackStatus.doPack
 * (abbacddc restore 2026-10-30):
 *   [flags, count] + N × 10 bytes
 *   each point: moveTime, stopTime, roll, pitch, yaw as int16 LE
 *   (app floats × 10, rounded — pass wire int16 / 0.1° here).
 * Midware addRoadPoint(FFFFF) arg order is move,stop,yaw,pitch,roll
 * (remapped into RoadPoint); CreateTrackView.sendToDeviceStart always
 * passes roll=0. Requires ≥2 waypoints (Ronin Preview gate).
 */
export function build062Path(waypoints, opts = {}) {
  if (!waypoints?.length || waypoints.length < 2) {
    throw new Error('Track path requires at least 2 waypoints');
  }
  if (waypoints.length > 10) {
    throw new Error('Track path max 10 waypoints (addRoadPoint gate)');
  }
  const flags = opts.flags ?? trackHeaderFlags(opts);
  const buf = Buffer.alloc(2 + waypoints.length * 10);
  buf[0] = flags & 0xff;
  buf[1] = waypoints.length & 0xff;
  for (let i = 0; i < waypoints.length; i += 1) {
    const pitch = Number(waypoints[i].pitch);
    const yaw = Number(waypoints[i].yaw ?? 0);
    const roll = Number(waypoints[i].roll ?? 0);
    const moveTime = Number(waypoints[i].moveTime ?? (i === 0 ? 0 : 20));
    const stopTime = Number(waypoints[i].stopTime ?? 20);
    for (const [name, v] of [
      ['pitch', pitch],
      ['yaw', yaw],
      ['roll', roll],
      ['moveTime', moveTime],
      ['stopTime', stopTime],
    ]) {
      if (!Number.isFinite(v)) throw new Error(`invalid waypoint ${i}: ${name}`);
    }
    const off = 2 + i * 10;
    buf.writeInt16LE(moveTime | 0, off + 0);
    buf.writeInt16LE(stopTime | 0, off + 2);
    buf.writeInt16LE(roll | 0, off + 4);
    buf.writeInt16LE(pitch | 0, off + 6);
    buf.writeInt16LE(yaw | 0, off + 8);
  }
  return buf;
}

export function build6bPollFrame() {
  return buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x6b, TRACK_6B_PAYLOAD);
}

export function build062UploadFrame(payload) {
  return buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x62, payload);
}

/** Decode waypoints from a 0x62 upload blob (doPack layout). */
export function decode062Path(buf) {
  const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'hex');
  if (payload.length < 2) throw new Error('invalid 0x62 header');
  const flags = payload[0];
  const count = payload[1];
  if (payload.length < 2 + count * 10) {
    throw new Error(`truncated 0x62 path: need ${2 + count * 10}, got ${payload.length}`);
  }
  const waypoints = [];
  for (let i = 0; i < count; i += 1) {
    const off = 2 + i * 10;
    waypoints.push({
      moveTime: payload.readInt16LE(off + 0),
      stopTime: payload.readInt16LE(off + 2),
      roll: payload.readInt16LE(off + 4),
      pitch: payload.readInt16LE(off + 6),
      yaw: payload.readInt16LE(off + 8),
    });
  }
  return { flags, count, waypoints, rawHex: payload.toString('hex') };
}

/** Stage 0g reference — Ronin Track wire angles (0.1° int16), not 0x66 @2/@8. */
export const TRACK_REF = {
  stage0gUp: { pitch: 834, yaw: 0, label: 'stage0g wp1 (almost straight up)' },
  stage0gDown: { pitch: -450, yaw: 14, label: 'stage0g wp2 (tilted down)' },
};

/**
 * Map live 0x66/0x10 attitude wire → Track waypoint wire (0.1° int16).
 *
 * REA (CreateGimbalPathView + DataGimbalSetPushPeripheralStatus):
 *   TLV 0x22/0x24 int16 → ÷10 → PeripheralPosPitch/Yaw degrees → Track ×10.
 * So Track wire == TLV int16 (identity). App getters do not negate.
 * sendToDeviceStart forces roll=0 — keep roll 0 on the wire path.
 *
 * Requires real ActualPose TLVs (layout rs3mini-0x66-tlv / 0x10-tlv).
 * Do not feed rs3mini-0x66-fixed @2/@8 — that false-fires on status-only 0x66.
 */
export function pose066ToTrackWire({
  tiltRaw,
  panRaw,
  rollRaw = 0,
  layout,
} = {}) {
  if (layout && !String(layout).includes('-tlv') && layout !== 'standard') {
    throw new Error(
      `pose066ToTrackWire needs ActualPose TLV layout, got ${layout}`,
    );
  }
  if (!Number.isFinite(Number(tiltRaw))) {
    throw new Error('tiltRaw required');
  }
  return {
    pitch: Number(tiltRaw) | 0,
    yaw: Number(panRaw ?? 0) | 0,
    roll: 0,
    moveTime: 0,
    stopTime: 20,
  };
}
