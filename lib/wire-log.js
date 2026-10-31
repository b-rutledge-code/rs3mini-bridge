/**
 * Optional GATT wire capture — set WIRE_LOG=/path/to.jsonl
 * Appends one JSON line per fff5 TX / fff4 RX with hex + DUML peek.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseMessage } from './duml.js';
import { log } from './log.js';

const WIRE_LOG = process.env.WIRE_LOG || '';

let opened = false;

function peekDuml(buf) {
  const msg = parseMessage(buf);
  if (!msg) return {};
  return {
    cmdSet: msg.cmdSet,
    cmdId: msg.cmdId,
    flags: msg.flags,
    payloadHex: msg.payload?.toString('hex') || '',
    payloadLen: msg.payload?.length ?? 0,
  };
}

export function wireLogEnabled() {
  return Boolean(WIRE_LOG);
}

export function appendWire(dir, data, meta = {}) {
  if (!WIRE_LOG) return;
  try {
    if (!opened) {
      fs.mkdirSync(path.dirname(WIRE_LOG), { recursive: true });
      opened = true;
      log.info('wire', `capturing → ${WIRE_LOG}`);
    }
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        dir,
        hex: buf.toString('hex'),
        len: buf.length,
        ...peekDuml(buf),
        ...meta,
      }) + '\n';
    fs.appendFileSync(WIRE_LOG, line);
  } catch (err) {
    log.warn('wire', `append failed: ${err.message || err}`);
  }
}

/** Wrap fff5.writeAsync once; attach fff4 data listener (call after subscribe). */
export function installWireTap(chars) {
  if (!WIRE_LOG || !chars?.fff5 || chars.__wireTapped) return;
  chars.__wireTapped = true;
  const orig = chars.fff5.writeAsync.bind(chars.fff5);
  chars.fff5.writeAsync = async (data, withoutResponse) => {
    appendWire('tx', data, {
      char: 'fff5',
      withoutResponse: !!withoutResponse,
    });
    return orig(data, withoutResponse);
  };
  log.info('wire', 'fff5 TX tap armed');
}

export function attachWireRx(chars) {
  if (!WIRE_LOG || !chars?.fff4 || chars.__wireRx) return;
  chars.__wireRx = true;
  chars.fff4.on('data', (data) => {
    appendWire('rx', data, { char: 'fff4' });
  });
  log.info('wire', 'fff4 RX tap armed');
}
