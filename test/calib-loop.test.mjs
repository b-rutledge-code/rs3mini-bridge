import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  is066State,
  loadTargetFromJsonl,
  nudgeForAxis,
  pickNudge,
  rungIndex,
  wireRung,
  withinTolerance,
} from '../lib/calib-loop.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('withinTolerance', () => {
  assert.equal(withinTolerance(100, 150, 64), true);
  assert.equal(withinTolerance(100, 200, 64), false);
  assert.equal(withinTolerance(257, 257, 128), true);
  assert.equal(withinTolerance(1, 257, 128), false);
  assert.equal(withinTolerance(-511, -500, 128), true);
});

test('wireRung quantizes k·256+1', () => {
  assert.equal(wireRung(2305), 2305);
  assert.equal(wireRung(2300), 2305);
  assert.equal(wireRung(-511), -511);
  assert.equal(rungIndex(257), 1);
  assert.equal(rungIndex(-511), -2);
});

test('nudgeForAxis uses bench-learned tilt signs', () => {
  assert.deepEqual(nudgeForAxis(769, 2049, 'tilt'), { pan: 0, tilt: -1 });
  assert.deepEqual(nudgeForAxis(2049, 769, 'tilt'), { pan: 0, tilt: 1 });
});

test('nudgeForAxis pan+ raises wire', () => {
  assert.deepEqual(nudgeForAxis(-511, 1, 'pan'), { pan: 1, tilt: 0 });
  assert.deepEqual(nudgeForAxis(1, -511, 'pan'), { pan: -1, tilt: 0 });
});

test('pickNudge tiltFirst sequences axes', () => {
  assert.deepEqual(pickNudge(769, 1, 2305, -511, 128, { tiltFirst: true }), {
    pan: 0,
    tilt: -1,
  });
  assert.deepEqual(pickNudge(2305, 1, 2305, -511, 128, { tiltFirst: true }), {
    pan: -1,
    tilt: 0,
  });
});

test('is066State requires fresh 0x66', () => {
  assert.equal(
    is066State({ ok: true, telemetry: { stale: false, source: '0x04/0x66', tiltRaw: 1 } }),
    true,
  );
  assert.equal(
    is066State({ ok: true, telemetry: { stale: false, source: '0x04/0x10', tiltRaw: 0 } }),
    false,
  );
});

test('loadTargetFromJsonl skips non-0x66 rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-'));
  const file = path.join(dir, 'poses.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ step: 'p02', bridge: { source: '0x04/0x10', tiltRaw: 0 } }),
      JSON.stringify({ step: 'p01', bridge: { source: '0x04/0x66', tiltRaw: 2049, panRaw: 1 }, visual: 'normal' }),
    ].join('\n'),
  );
  const t = loadTargetFromJsonl(file, 'p01');
  assert.equal(t.tiltRaw, 2049);
  assert.equal(t.panRaw, 1);
  fs.rmSync(dir, { recursive: true });
});
