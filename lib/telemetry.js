import { parseMessage } from './duml.js';

/**
 * RS 3 Mini 0x04/0x10 attitude uses the same TLV tags as 0x66 (header 0x01, walk from +1).
 * Do not read int16 at offsets 0/2/4 — bytes 0x22/0x23 are tag IDs, not angle data.
 */

/** 0x04/0x66 and 0x04/0x10 angle tags (jdesbonnet/dji_rs3_control TLV spec). */
export const RS366_TAG = {
  TILT: 0x22,
  ROLL: 0x23,
  PAN: 0x24,
};

/**
 * Parse 0x66 payload TLV records after header byte 0.
 * @returns {Record<number, number> | null}
 */
export function decode0466Fields(payload) {
  if (!payload?.length) return null;
  const fields = {};
  let off = 1;
  while (off + 2 <= payload.length) {
    const tag = payload[off];
    const len = payload[off + 1];
    off += 2;
    if (off + len > payload.length) return null;
    const raw = payload.subarray(off, off + len);
    off += len;
    fields[tag] = readSignedLE(raw);
  }
  return fields;
}

function readSignedLE(buf) {
  if (!buf.length) return 0;
  if (buf.length === 1) return buf.readInt8(0);
  if (buf.length === 2) return buf.readInt16LE(0);
  if (buf.length === 4) return buf.readInt32LE(0);
  let val = 0n;
  for (let i = 0; i < buf.length; i += 1) {
    val |= BigInt(buf[i]) << BigInt(i * 8);
  }
  const bits = BigInt(buf.length * 8);
  const sign = 1n << (bits - 1n);
  if (val >= sign) val -= 1n << bits;
  return Number(val);
}

/**
 * 0x0d/0x02 motor/battery telemetry (RS 3 Mini bench, LCD-verified):
 * battery percent is the LAST byte of the 21-byte payload, plain 0-100.
 * f0..f2 int32 fields retained for motor-balance observation.
 * @returns {{ f0: number, f1: number, f2: number, batteryPercent: number | null } | null}
 */
export function decode0d02Fields(payload) {
  if (!payload || payload.length < 17) return null;
  const f0 = payload.readInt32LE(1);
  const f1 = payload.readInt32LE(5);
  const f2 = payload.readInt32LE(9);
  const last = payload[payload.length - 1];
  const batteryPercent = last >= 0 && last <= 100 ? last : null;
  return { f0, f1, f2, batteryPercent };
}

function poseFromTlv(fields, layout, { requirePan = true } = {}) {
  const tilt = fields[RS366_TAG.TILT];
  if (tilt == null) return null;
  const roll = fields[RS366_TAG.ROLL] ?? 0;
  const pan = fields[RS366_TAG.PAN];
  if (requirePan && pan == null) return null;
  if (!anglesPlausible(tilt, roll, pan ?? 0)) return null;
  return { tilt, roll, pan: pan ?? null, layout, tlv: fields };
}

function poseFrom0466Tlv(fields) {
  return poseFromTlv(fields, 'rs3mini-0x66-tlv', { requirePan: true });
}

function poseFrom0410Tlv(fields) {
  return poseFromTlv(fields, 'rs3mini-0x10-tlv', { requirePan: false });
}

/**
 * Fixed int16 @2/@8 — DISABLED as a pose source.
 * Status-only 0x66 frames often start `01 06 …` (TLV tag 0x06); reading @2/@8
 * invents fake pan/tilt. Track SAVE must use ActualPose tags 0x22/0x24 only
 * (see pose066ToTrackWire / FINDINGS notify→cache).
 */
function poseFrom0466Fixed(_payload) {
  return null;
}

function buildPoseRecord(source, payload, pose) {
  const { tilt, roll, pan, layout, tlv } = pose;
  return {
    source,
    layout,
    pitch: tilt,
    roll,
    yaw: pan,
    tiltDeg: tilt / 10,
    rollDeg: roll / 10,
    panDeg: pan != null ? pan / 10 : null,
    pitchDeg: tilt / 10,
    yawDeg: pan != null ? pan / 10 : null,
    tlv: tlv ? tlvFieldsForJson(tlv) : undefined,
    rawPayload: payload.toString('hex'),
  };
}

/** JSON-friendly tag keys (hex strings). */
function tlvFieldsForJson(fields) {
  const out = {};
  for (const [tag, val] of Object.entries(fields)) {
    out[`0x${Number(tag).toString(16).padStart(2, '0')}`] = val;
  }
  return out;
}

/** Best-effort attitude decode from inbound DUML notifications. */
export function parseAttitude(frame) {
  const msg = parseMessage(frame);
  if (!msg) return null;

  const { cmdSet, cmdId, payload } = msg;

  if (cmdSet === 0x0d && cmdId === 0x02) {
    const bat = decode0d02Fields(payload);
    if (!bat || bat.batteryPercent == null) return null;
    return {
      source: '0x0d/0x02',
      layout: 'rs3-0d02-battery',
      batteryRaw: bat.batteryPercent,
      batteryPercent: bat.batteryPercent,
      motorBalance: { f0: bat.f0, f1: bat.f1, f2: bat.f2 },
      rawPayload: payload.toString('hex'),
    };
  }

  if (cmdSet !== 0x04) return null;

  if (cmdId === 0x05 && payload.length >= 6) {
    return standardAngleRecord('0x04/0x05', payload);
  }

  if (cmdId === 0x10 && payload.length >= 6) {
    const tlvFields = decode0466Fields(payload);
    if (tlvFields) {
      const tlvPose = poseFrom0410Tlv(tlvFields);
      if (tlvPose) return buildPoseRecord('0x04/0x10', payload, tlvPose);
    }
    return null;
  }

  if (cmdId === 0x66) {
    const tlvFields = decode0466Fields(payload);
    if (tlvFields) {
      const tlvPose = poseFrom0466Tlv(tlvFields);
      if (tlvPose) return buildPoseRecord('0x04/0x66', payload, tlvPose);
    }
    const fixedPose = poseFrom0466Fixed(payload);
    if (fixedPose) return buildPoseRecord('0x04/0x66', payload, fixedPose);
  }

  return null;
}

function standardAngleRecord(source, payload) {
  const pitch = payload.readInt16LE(0);
  const roll = payload.readInt16LE(2);
  const yaw = payload.readInt16LE(4);
  if (!anglesPlausible(pitch, roll, yaw)) return null;
  return {
    source,
    layout: 'standard',
    pitch,
    roll,
    yaw,
    pitchDeg: pitch / 10,
    rollDeg: roll / 10,
    yawDeg: yaw / 10,
    rawPayload: payload.toString('hex'),
  };
}

function anglesPlausible(a, b, c) {
  const lim = 2500;
  return [a, b, c].every((v) => Math.abs(v) <= lim);
}

export function isPoseTelemetry(att) {
  return (
    att?.layout?.startsWith('rs3mini-0x66') ||
    att?.layout?.startsWith('rs3mini-0x10') ||
    att?.layout === 'standard'
  );
}

export function formatAttitude(a) {
  if (a.layout?.startsWith('rs3mini-0x66')) {
    const roll = a.rollDeg != null ? ` roll=${a.rollDeg.toFixed(1)}°` : '';
    return `${a.source} tilt=${a.tiltDeg.toFixed(1)}° pan=${a.panDeg.toFixed(1)}°${roll}`;
  }
  if (a.layout === 'rs3-0d02-battery') {
    return `${a.source} battery=${a.batteryPercent}%`;
  }
  if (a.layout?.startsWith('rs3mini-0x10')) {
    const pan = a.panDeg != null ? ` pan=${a.panDeg.toFixed(1)}°` : '';
    return `${a.source} tilt=${a.tiltDeg.toFixed(1)}° roll=${a.rollDeg.toFixed(1)}°${pan}`;
  }
  return `${a.source} pitch=${a.pitchDeg.toFixed(1)}° roll=${a.rollDeg.toFixed(1)}° yaw=${a.yawDeg.toFixed(1)}°`;
}

/** @deprecated use decode0466Fields — bench alias */
export function parseRs366(payload) {
  const fields = decode0466Fields(payload);
  if (fields && fields[RS366_TAG.TILT] != null && fields[RS366_TAG.PAN] != null) {
    const tilt = fields[RS366_TAG.TILT];
    const pan = fields[RS366_TAG.PAN];
    return {
      tilt,
      tiltDeg: tilt / 10,
      pan,
      panDeg: pan / 10,
      roll: fields[RS366_TAG.ROLL],
      rollDeg: fields[RS366_TAG.ROLL] != null ? fields[RS366_TAG.ROLL] / 10 : null,
      tlv: fields,
      rawPayload: payload.toString('hex'),
    };
  }
  if (payload.length >= 10 && payload[0] === 0x01 && payload[1] === 0x06) {
    const tilt = payload.readInt16LE(2);
    const pan = payload.readInt16LE(8);
    return {
      tilt,
      tiltDeg: tilt / 10,
      pan,
      panDeg: pan / 10,
      roll: null,
      rollDeg: null,
      tlv: fields,
      rawPayload: payload.toString('hex'),
    };
  }
  return null;
}
