import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrimArgs, TRIM } from '../lib/visual-trim.js';

test('TRIM down = tilt- nose down', () => {
  assert.equal(TRIM.down.tilt, -1);
  assert.equal(TRIM.up.tilt, 1);
});

test('parseTrimArgs', () => {
  const t = parseTrimArgs(['node', 'x', 'down', '2.5']);
  assert.equal(t.tilt, -1);
  assert.equal(t.sec, 2.5);
});
