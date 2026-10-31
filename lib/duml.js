import { CRC } from 'crc-full';

const CRC8 = new CRC('CRC8', 8, 0x31, 0xee, 0, true, true);
const CRC16 = new CRC('CRC16', 16, 0x1021, 0x496c, 0, true, true);

export const TARGET_APP_TO_GIMBAL = 0x0402;
/** App→params module (0x02→0xe5). SubscribeGimbalParams / 0x12 that arms 0x66 pose TLVs. */
export const TARGET_APP_TO_PARAMS = 0xe502;
export const FLAG_REQUEST = 0x40;

let msgSeq = 0x1700;

export function resetSequence(val = 0x1700) {
  msgSeq = val;
}

export function buildMessage(target, flags, cmdSet, cmdId, payload = Buffer.alloc(0)) {
  const totalLen = 13 + payload.length;
  const buf = Buffer.alloc(totalLen);
  let off = 0;
  buf[off++] = 0x55;
  const version = 1;
  buf[off++] = totalLen & 0xff;
  buf[off++] = ((totalLen >> 8) & 0x03) | (version << 2);
  buf[off++] = CRC8.compute(buf.subarray(0, 3));
  buf.writeUInt16LE(target, off);
  off += 2;
  // RS 3 Mini capture uses LE seq on wire (differs from Osmo lib-osmo-ble BE).
  buf.writeUInt16LE(msgSeq++, off);
  off += 2;
  buf[off++] = flags;
  buf[off++] = cmdSet;
  buf[off++] = cmdId;
  if (payload.length) payload.copy(buf, off);
  off += payload.length;
  buf.writeUInt16LE(CRC16.compute(buf.subarray(0, off)), off);
  return buf;
}

export function parseMessage(data) {
  if (!data?.length || data[0] !== 0x55 || data.length < 13) return null;
  const len = data[1] | ((data[2] & 0x03) << 8);
  if (data.length < len) return null;
  return {
    len,
    flags: data[8],
    cmdSet: data[9],
    cmdId: data[10],
    payload: data.subarray(11, len - 2),
  };
}

/**
 * AbsAngleControl (0x04/0x14) — layout from Ronin DataGimbalAbsAngleControl.doPack
 * (abbacddc restore): yaw, roll, pitch int16 LE; flags; overtime.
 * flags bits: 0x01 controlMode, 0x02 YawInvalid, 0x04 RollInvalid, 0x08 PitchInvalid
 * (invalid bit set → that axis ignored).
 */
export function buildAbsAngle(pitch, roll, yaw, { flags = 0x07, duration = 80 } = {}) {
  const payload = Buffer.alloc(8);
  payload.writeInt16LE(yaw, 0);
  payload.writeInt16LE(roll, 2);
  payload.writeInt16LE(pitch, 4);
  payload.writeUInt8(flags, 6);
  payload.writeUInt8(duration, 7);
  return buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x14, payload);
}

export function buildGetPosition() {
  return buildMessage(TARGET_APP_TO_GIMBAL, FLAG_REQUEST, 0x04, 0x02, Buffer.alloc(0));
}
