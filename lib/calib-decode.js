import { decode0466Fields, RS366_TAG } from './telemetry.js';

const TAG_NAMES = {
  [RS366_TAG.TILT]: 'tilt(0x22)',
  [RS366_TAG.ROLL]: 'roll(0x23)',
  [RS366_TAG.PAN]: 'pan(0x24)',
  6: 'status(0x06)',
  7: 'status(0x07)',
  8: 'status(0x08)',
  0x0a: 'tag(0x0a)',
  0x0b: 'tag(0x0b)',
  0x0c: 'tag(0x0c)',
};

function readInt16LE(buf, off) {
  if (off + 2 > buf.length) return null;
  return buf.readInt16LE(off);
}

/**
 * Explore every plausible tilt/pan decode for a 0x04/0x66 notify payload.
 * Used by calib bench — does not pick a single winner.
 */
export function decode066Payload(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'hex');
  const tlv = decode0466Fields(buf);

  const int16Slots = {};
  for (let off = 0; off + 2 <= buf.length && off <= 14; off += 2) {
    int16Slots[`@${off}`] = readInt16LE(buf, off);
  }

  const fixed =
    buf.length >= 10 && buf[0] === 0x01 && buf[1] === 0x06
      ? { tilt: readInt16LE(buf, 2), pan: readInt16LE(buf, 8), layout: 'rs3mini-0x66-fixed' }
      : null;

  const jdesbonnet =
    tlv && tlv[RS366_TAG.TILT] != null
      ? {
          tilt: tlv[RS366_TAG.TILT],
          roll: tlv[RS366_TAG.ROLL] ?? null,
          pan: tlv[RS366_TAG.PAN] ?? null,
          layout: 'rs3mini-0x66-tlv',
        }
      : null;

  const tlvNamed = {};
  if (tlv) {
    for (const [tag, val] of Object.entries(tlv)) {
      const key = TAG_NAMES[Number(tag)] ?? `tag(0x${Number(tag).toString(16)})`;
      tlvNamed[key] = val;
    }
  }

  return {
    rawHex: buf.toString('hex'),
    len: buf.length,
    header: buf.length >= 2 ? [buf[0], buf[1]] : [],
    int16Slots,
    fixed,
    jdesbonnet,
    tlv: tlvNamed,
    bridgeTilt: fixed?.tilt ?? jdesbonnet?.tilt ?? null,
    bridgePan: fixed?.pan ?? jdesbonnet?.pan ?? null,
  };
}

/** Build a calibration log row from gimbal GET /state-shaped telemetry. */
export function calibRowFromState(state, { step, visual, action, notes = '' } = {}) {
  const t = state.telemetry ?? {};
  const decode = t.rawPayload ? decode066Payload(t.rawPayload) : null;
  return {
    at: new Date().toISOString(),
    step: step ?? null,
    visual: visual ?? null,
    action: action ?? null,
    notes: notes || undefined,
    motor: state.motor?.state ?? null,
    bridge: {
      source: t.source ?? null,
      layout: t.layout ?? null,
      tiltRaw: t.tiltRaw ?? null,
      panRaw: t.panRaw ?? null,
      rollRaw: t.rollRaw ?? null,
      tiltDeg: t.tiltDeg ?? null,
      panDeg: t.panDeg ?? null,
      stale: Boolean(t.stale),
      ageMs: t.ageMs ?? null,
    },
    decode066: decode,
  };
}
