import assert from 'node:assert/strict';
import test from 'node:test';
import { decode066Payload, calibRowFromState } from '../lib/calib-decode.js';

test('decode066Payload fixed layout from bench save', () => {
  const hex = '010601040701f90801000a01000b01000c0100';
  const d = decode066Payload(hex);
  assert.equal(d.fixed.tilt, 1025);
  assert.equal(d.fixed.pan, 1);
  assert.equal(d.bridgeTilt, 1025);
  assert.equal(d.bridgePan, 1);
  assert.equal(d.header[0], 0x01);
  assert.equal(d.header[1], 0x06);
});

test('decode066Payload exposes int16 slots and status tlv tags', () => {
  const hex = '010601ff0701fb';
  const d = decode066Payload(hex);
  assert.equal(d.int16Slots['@2'], -255);
  assert.ok(d.fixed || Object.keys(d.tlv).length > 0);
});

test('calibRowFromState bundles bridge + decode', () => {
  const row = calibRowFromState(
    {
      ok: true,
      motor: { state: 'AWAKE' },
      telemetry: {
        source: '0x04/0x66',
        layout: 'rs3mini-0x66-fixed',
        tiltRaw: 1025,
        panRaw: 1,
        tiltDeg: 102.5,
        panDeg: 0.1,
        stale: false,
        rawPayload: '010601040701f90801000a01000b01000c0100',
      },
    },
    { step: 'p01', visual: 'CF framing', action: 'manual' },
  );
  assert.equal(row.step, 'p01');
  assert.equal(row.bridge.tiltRaw, 1025);
  assert.equal(row.decode066.bridgeTilt, 1025);
});
