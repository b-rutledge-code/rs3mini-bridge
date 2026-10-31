import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPoseRecord,
  poseFromGimbalState,
  poseWireDelta,
  savePoseRecord,
  saveRejectReason,
  withinTolerance,
} from '../lib/gimbal-preset.js';

function okState(overrides = {}) {
  return {
    ok: true,
    move: { active: false },
    motor: { state: 'AWAKE' },
    telemetry: {
      tiltRaw: 769,
      panRaw: 12,
      rollRaw: 0,
      tiltDeg: 76.9,
      panDeg: 1.2,
      rollDeg: 0,
      source: '0x04/0x66',
      layout: 'rs3mini-0x66-fixed',
      stale: false,
      ageMs: 200,
      rawPayload: '0106…',
    },
    ...overrides,
  };
}

test('saveRejectReason blocks disconnected / stale / asleep / moving', () => {
  assert.equal(saveRejectReason({ ok: false }), 'not connected');
  assert.equal(saveRejectReason(okState({ move: { active: true } })), 'move active — stop first');
  assert.equal(saveRejectReason(okState({ motor: { state: 'ASLEEP' } })), 'motor asleep — wake first');
  assert.equal(
    saveRejectReason(okState({ telemetry: { ...okState().telemetry, tiltRaw: null } })),
    'no pose telemetry yet',
  );
  assert.equal(
    saveRejectReason(okState({ telemetry: { ...okState().telemetry, stale: true, ageMs: 5000 } })),
    'telemetry stale (5000ms)',
  );
  assert.equal(saveRejectReason(okState()), null);
});

test('poseFromGimbalState maps tilt/pan raw to pitch/yaw', () => {
  const record = poseFromGimbalState(okState());
  assert.equal(record.pitch, 769);
  assert.equal(record.yaw, 12);
  assert.equal(record.roll, 0);
  assert.match(record.savedAt, /^\d{4}-/);
});

test('save and load round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-'));
  const file = path.join(dir, 'saved-pose.json');
  const record = poseFromGimbalState(okState());
  savePoseRecord(record, file);
  const loaded = loadPoseRecord(file);
  assert.equal(loaded.pitch, 769);
  assert.equal(loaded.yaw, 12);
});

test('poseWireDelta and withinTolerance', () => {
  const saved = { pitch: 1000, yaw: 200, roll: 0 };
  const delta = poseWireDelta(saved, okState({ telemetry: { ...okState().telemetry, tiltRaw: 1040, panRaw: 210 } }));
  assert.equal(delta.tilt, 40);
  assert.equal(delta.pan, 10);
  assert.equal(withinTolerance(delta, 80), true);
  assert.equal(withinTolerance({ tilt: 100, pan: 5, roll: 0 }, 80), false);
});
