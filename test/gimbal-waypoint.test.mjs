import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  build062Path,
  decode062Path,
  STAGE0G_062_PAYLOAD,
  TRACK_REF,
  trackHeaderFlags,
  pose066ToTrackWire,
} from '../lib/gimbal-waypoint.js';

test('decode062Path round-trips stage0g capture (doPack layout)', () => {
  const decoded = decode062Path(STAGE0G_062_PAYLOAD);
  assert.equal(decoded.flags, 0x0a);
  assert.equal(decoded.count, 2);
  assert.equal(decoded.waypoints[0].pitch, TRACK_REF.stage0gUp.pitch);
  assert.equal(decoded.waypoints[0].yaw, TRACK_REF.stage0gUp.yaw);
  assert.equal(decoded.waypoints[0].moveTime, 0);
  assert.equal(decoded.waypoints[0].stopTime, 20);
  assert.equal(decoded.waypoints[1].pitch, TRACK_REF.stage0gDown.pitch);
  assert.equal(decoded.waypoints[1].yaw, TRACK_REF.stage0gDown.yaw);
  assert.equal(decoded.waypoints[1].moveTime, 20);
  assert.equal(decoded.waypoints[1].stopTime, 20);
});

test('build062Path matches stage0g capture bytes', () => {
  const built = build062Path([
    { pitch: 834, yaw: 0, moveTime: 0, stopTime: 20 },
    { pitch: -450, yaw: 14, moveTime: 20, stopTime: 20 },
  ]);
  assert.ok(built.equals(STAGE0G_062_PAYLOAD));
});

test('build062Path ↔ decode062Path', () => {
  const built = build062Path([
    { pitch: 834, yaw: 0 },
    { pitch: -450, yaw: 14 },
  ]);
  const decoded = decode062Path(built);
  assert.equal(decoded.waypoints[0].pitch, 834);
  assert.equal(decoded.waypoints[1].pitch, -450);
  assert.equal(decoded.waypoints[1].yaw, 14);
});

test('trackHeaderFlags matches stage0g Preview (0x0a)', () => {
  assert.equal(trackHeaderFlags({ isTripod: 1, startOrStop: 0, recordOrPreview: 1 }), 0x0a);
});

test('pose066ToTrackWire is TLV identity (REA ÷10 then Track ×10)', () => {
  const w = pose066ToTrackWire({
    tiltRaw: -1279,
    panRaw: 769,
    rollRaw: 12,
    layout: 'rs3mini-0x66-tlv',
  });
  assert.equal(w.pitch, -1279);
  assert.equal(w.yaw, 769);
  assert.equal(w.roll, 0);
});
