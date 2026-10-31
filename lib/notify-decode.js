import { buildMessage, parseMessage, TARGET_APP_TO_GIMBAL } from './duml.js';
import {
  decode0466Fields,
  formatAttitude,
  parseAttitude,
  RS366_TAG,
} from './telemetry.js';

export function cmdKey(msg) {
  return `${msg.cmdSet.toString(16).padStart(2, '0')}/${msg.cmdId.toString(16).padStart(2, '0')}`;
}

export function parseNotifyFrame(data) {
  const msg = parseMessage(data);
  if (!msg) return null;
  return { ...msg, key: cmdKey(msg) };
}

/** Track payloads seen per cmd key in a phase. */
export class NotifyCollector {
  constructor() {
    /** @type {Map<string, { count: number, payloads: Set<string>, last: Buffer | null }>} */
    this.byKey = new Map();
  }

  ingest(data) {
    const msg = parseNotifyFrame(data);
    if (!msg) return null;
    let entry = this.byKey.get(msg.key);
    if (!entry) {
      entry = { count: 0, payloads: new Set(), last: null };
      this.byKey.set(msg.key, entry);
    }
    entry.count += 1;
    entry.payloads.add(msg.payload.toString('hex'));
    entry.last = msg.payload;
    return msg;
  }
}

export function decodeInt16Fields(payload, maxFields = 8) {
  const out = [];
  for (let off = 0; off + 1 < payload.length && out.length < maxFields; off += 2) {
    out.push({
      off,
      raw: payload.readInt16LE(off),
      deg: (payload.readInt16LE(off) / 10).toFixed(1),
    });
  }
  return out;
}

export { parseRs366 } from './telemetry.js';

export function decodeRs366Tags(payload) {
  const fields = decode0466Fields(payload);
  if (!fields) return [];
  return Object.entries(fields).map(([tag, val]) => ({
    tag: Number(tag),
    val,
    deg: (val / 10).toFixed(1),
  }));
}

/** 0x0d/0x02 layout (bench decode-0d02) — tentative. */
export function parse0d02(payload) {
  if (payload.length < 20) return null;
  const seq = payload.readInt16LE(0);
  const tag = payload.readInt16LE(2);
  const val = payload.readInt16LE(4);
  const flags = payload.readInt16LE(6);
  const tail = payload.readInt16LE(18);
  return { seq, tag, val, valDeg: val / 10, flags, tail, rawPayload: payload.toString('hex') };
}

export function formatPayloadVerbose(key, hex) {
  const payload = Buffer.from(hex, 'hex');
  const lines = [`  hex=${hex}  len=${payload.length}`];
  const int16 = decodeInt16Fields(payload, 16);
  lines.push(`  int16: ${int16.map((f) => `@${f.off}=${f.raw}(${f.deg}°)`).join(' ')}`);
  if (key === '04/66') {
    const fields = decode0466Fields(payload);
    if (fields) {
      const parts = Object.entries(fields)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([tag, val]) => {
          const n = Number(tag);
          const label =
            n === RS366_TAG.TILT
              ? 'tilt'
              : n === RS366_TAG.ROLL
                ? 'roll'
                : n === RS366_TAG.PAN
                  ? 'pan'
                  : `0x${n.toString(16)}`;
          return `${label}=${(val / 10).toFixed(1)}°`;
        });
      lines.push(`  tlv: ${parts.join(' ')}`);
    }
  }
  if (key === '0d/02') {
    const od = parse0d02(payload);
    if (od) {
      lines.push(
        `  seq@0=${od.seq}  const@2=${od.tag}  val@4=${od.valDeg.toFixed(1)}°  flags@6=${od.flags}  tail@18=${od.tail}`
      );
    }
  }
  return lines.join('\n');
}

/**
 * Dump every unique payload for a cmd key, split by baseline vs move phase.
 */
export function printVerboseKeyReport(baseline, moved, key = '04/66') {
  const bEntry = baseline.byKey.get(key);
  const mEntry = moved.byKey.get(key);
  if (!bEntry && !mEntry) {
    console.log(`\n=== Verbose ${key}: no payloads ===`);
    return;
  }

  const bSet = bEntry?.payloads ?? new Set();
  const mSet = mEntry?.payloads ?? new Set();
  const onlyBaseline = [...bSet].filter((h) => !mSet.has(h)).sort();
  const onlyMove = [...mSet].filter((h) => !bSet.has(h)).sort();
  const shared = [...bSet].filter((h) => mSet.has(h)).sort();

  console.log(`\n=== Verbose ${key} ===`);
  console.log(`  baseline: ${bEntry?.count ?? 0} packets, ${bSet.size} unique`);
  console.log(`  move:     ${mEntry?.count ?? 0} packets, ${mSet.size} unique`);

  if (onlyBaseline.length) {
    console.log(`\n  --- baseline-only (${onlyBaseline.length}) ---`);
    for (const hex of onlyBaseline) console.log(formatPayloadVerbose(key, hex));
  }
  if (shared.length) {
    console.log(`\n  --- shared (${shared.length}) ---`);
    for (const hex of shared) console.log(formatPayloadVerbose(key, hex));
  }
  if (onlyMove.length) {
    console.log(`\n  --- move-only (${onlyMove.length}) ---`);
    for (const hex of onlyMove) console.log(formatPayloadVerbose(key, hex));
  }
}

/**
 * Compare two collectors — report cmd keys whose payload set grew or changed.
 */
export function diffCollectors(baseline, moved) {
  const keys = new Set([...baseline.byKey.keys(), ...moved.byKey.keys()]);
  const rows = [];
  for (const key of [...keys].sort()) {
    const b = baseline.byKey.get(key);
    const m = moved.byKey.get(key);
    const bSet = b?.payloads ?? new Set();
    const mSet = m?.payloads ?? new Set();
    const onlyMove = [...mSet].filter((h) => !bSet.has(h));
    const changed = onlyMove.length > 0 || (bSet.size !== mSet.size && mSet.size > 0);
    if (!changed && !m) continue;
    rows.push({
      key,
      baselineCount: b?.count ?? 0,
      moveCount: m?.count ?? 0,
      baselineUnique: bSet.size,
      moveUnique: mSet.size,
      newDuringMove: onlyMove,
      sampleMove: m?.last ?? b?.last ?? null,
      sampleBaseline: b?.last ?? null,
    });
  }
  return rows;
}

export function formatDiffRow(row) {
  const lines = [
    `${row.key}  baseline=${row.baselineCount}/${row.baselineUnique}uniq  move=${row.moveCount}/${row.moveUnique}uniq`,
  ];
  if (row.sampleBaseline && row.sampleMove) {
    const bFields = decodeInt16Fields(row.sampleBaseline);
    const mFields = decodeInt16Fields(row.sampleMove);
    const deltas = mFields
      .map((f) => {
        const b = bFields.find((x) => x.off === f.off);
        if (!b || b.raw === f.raw) return null;
        return `@${f.off}: ${b.deg}° → ${f.deg}°`;
      })
      .filter(Boolean);
    if (deltas.length) lines.push(`  int16 delta: ${deltas.join(', ')}`);
  }
  if (row.newDuringMove.length) {
    lines.push(`  new payload(s): ${row.newDuringMove.join(' | ')}`);
  }
  if (row.sampleMove) {
    const fake = buildMessage(TARGET_APP_TO_GIMBAL, 0x00, ...keyToCmd(row.key), row.sampleMove);
    const a = parseAttitude(fake);
    if (a) lines.push(`  parseAttitude: ${formatAttitude(a)}`);
  }
  return lines.join('\n');
}

function keyToCmd(key) {
  const [cs, ci] = key.split('/');
  return [parseInt(cs, 16), parseInt(ci, 16)];
}

export function printDiffReport(baseline, moved) {
  const rows = diffCollectors(baseline, moved).filter(
    (r) => r.newDuringMove.length || r.moveUnique > r.baselineUnique
  );
  if (!rows.length) {
    console.log('\nNo notify payload changes detected during move.');
    console.log('Try --setup (session setup) or a longer move duration.');
    return;
  }
  console.log(`\n=== Notify changes during move (${rows.length} cmd keys) ===`);
  for (const row of rows) {
    console.log(formatDiffRow(row));
  }
}
