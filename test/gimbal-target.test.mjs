import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGimbalNameRe,
  buildGimbalTarget,
  hasGimbalTarget,
  gimbalTargetLabel,
  advertisedNames,
  advertisedNameBest,
  matchesAdvertisedName,
} from '../lib/gimbal-target.js';

test('parseGimbalNameRe builds a case-insensitive match from a bare suffix', () => {
  const re = parseGimbalNameRe('YOURSUFFIX');
  assert.ok(re.test('DJI RS3 MINI-050bxv'), 'matches advertised name case-insensitively');
});

test('parseGimbalNameRe treats off/false/0/empty as disabled', () => {
  for (const raw of ['0', 'off', 'OFF', 'false', '', '   ', undefined]) {
    assert.equal(parseGimbalNameRe(raw), null, `"${raw}" disables matching`);
  }
});

test('parseGimbalNameRe honors explicit /pattern/flags syntax', () => {
  const re = parseGimbalNameRe('/^DJI RS3/i');
  assert.ok(re.test('dji rs3 mini-1'));
  assert.equal(re.flags, 'i');
});

test('buildGimbalTarget / hasGimbalTarget / label', () => {
  const target = buildGimbalTarget({ GIMBAL_NAME_RE: 'YOURSUFFIX' });
  assert.equal(hasGimbalTarget(target), true);
  assert.match(gimbalTargetLabel(target), /name~/);

  const empty = buildGimbalTarget({});
  assert.equal(hasGimbalTarget(empty), false);
  assert.match(gimbalTargetLabel(empty), /unset/);
});

test('advertisedNames prefers complete name and dedupes', () => {
  const p = { advertisement: { localName: 'DJI RS3 MINI', localNameComplete: 'DJI RS3 MINI-YOURSUFFIX' } };
  assert.deepEqual(advertisedNames(p), ['DJI RS3 MINI-YOURSUFFIX', 'DJI RS3 MINI']);
  assert.equal(advertisedNameBest(p), 'DJI RS3 MINI-YOURSUFFIX');

  const same = { advertisement: { localName: 'X', localNameComplete: 'X' } };
  assert.deepEqual(advertisedNames(same), ['X'], 'no duplicate when equal');
});

test('matchesAdvertisedName tests every advertised name', () => {
  const re = parseGimbalNameRe('YOURSUFFIX');
  const hit = { advertisement: { localNameComplete: 'DJI RS3 MINI-YOURSUFFIX' } };
  const miss = { advertisement: { localName: 'DJI RS3 MINI-999ZZZ' } };
  assert.equal(matchesAdvertisedName(hit, re), true);
  assert.equal(matchesAdvertisedName(miss, re), false);
  assert.equal(matchesAdvertisedName(hit, null), false, 'no regex → no match');
});
