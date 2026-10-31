#!/usr/bin/env node
/**
 * Summarize calibration-poses.jsonl — slot motion, axis signs, 0x66 vs 0x10.
 *
 *   npm run calib:analyze
 *   npm run calib:analyze -- /path/to/calibration-poses.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const file = process.argv[2] ?? process.env.CALIB_LOG ?? path.join(ROOT, 'calibration-poses.jsonl');

if (!fs.existsSync(file)) {
  console.error(`missing ${file}`);
  process.exit(1);
}

const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const good = rows.filter((r) => r.bridge?.source === '0x04/0x66');
const bad = rows.filter((r) => r.bridge?.source !== '0x04/0x66');

console.log(`file: ${file}`);
console.log(`rows: ${rows.length}  0x66: ${good.length}  other: ${bad.length}\n`);

console.log('step   source        tilt    pan   visual');
for (const r of rows) {
  const b = r.bridge ?? {};
  console.log(
    `${String(r.step).padEnd(6)} ${String(b.source ?? '?').padEnd(13)} ${String(b.tiltRaw ?? '').padStart(6)} ${String(b.panRaw ?? '').padStart(6)}  ${(r.visual ?? '').slice(0, 40)}`,
  );
}

if (bad.length) {
  console.log('\nDiscard non-0x66 rows for pose truth.');
}

const p00 = good.find((r) => r.step === 'p00');
const p03 = good.find((r) => r.step === 'p03');
const p04 = good.find((r) => r.step === 'p04');
const p05 = good.find((r) => r.step === 'p05');
const p06 = good.find((r) => r.step === 'p06');
const p01 = good.find((r) => r.step === 'p01');

if (p00 && p03 && p04) {
  console.log('\nTilt axis (@2):');
  console.log(`  center ${p00.bridge.tiltRaw} → tilt+ ${p03.bridge.tiltRaw} → tilt− ${p04.bridge.tiltRaw}`);
}
if (p00 && p05 && p06) {
  console.log('Pan axis (@8):');
  console.log(`  center ${p00.bridge.panRaw} → pan+ ${p05.bridge.panRaw} → pan− ${p06.bridge.panRaw}`);
}
if (p01) {
  console.log(`\nNormal shot (p01): tilt=${p01.bridge.tiltRaw} pan=${p01.bridge.panRaw}`);
}

const slots = ['@0', '@2', '@4', '@6', '@8', '@10', '@12'];
console.log('\nInt16 slots (0x66 rows):');
console.log(`step  ${slots.map((s) => s.padStart(8)).join('')}`);
for (const r of good) {
  const ints = r.decode066?.int16Slots ?? {};
  console.log(
    `${String(r.step).padEnd(5)} ${slots.map((s) => String(ints[s] ?? '').padStart(8)).join('')}`,
  );
}

const closed = rows.filter((r) => String(r.step).startsWith('closed-loop'));
if (closed.length) {
  console.log('\nClosed-loop runs:');
  for (const r of closed) {
    const b = r.bridge ?? {};
    console.log(`  ${r.step}: tilt=${b.tiltRaw} pan=${b.panRaw} target=${r.target?.tiltRaw}/${r.target?.panRaw}`);
  }
}
