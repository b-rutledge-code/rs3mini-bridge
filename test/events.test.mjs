import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pushEvent, getEvents, _clearEventsForTest } from '../lib/events.js';

beforeEach(() => _clearEventsForTest());

test('getEvents returns newest first', () => {
  pushEvent('boot', 'one');
  pushEvent('move', 'two');
  pushEvent('stop', 'three');
  const ev = getEvents();
  assert.equal(ev.length, 3);
  assert.deepEqual(ev.map((e) => e.message), ['three', 'two', 'one']);
});

test('ring buffer caps at 20 and keeps the newest', () => {
  for (let i = 0; i < 25; i += 1) pushEvent('move', `m${i}`);
  const ev = getEvents();
  assert.equal(ev.length, 20);
  assert.equal(ev[0].message, 'm24', 'newest retained');
  assert.equal(ev[19].message, 'm5', 'oldest 5 dropped');
});

test('detail is included only when non-empty', () => {
  pushEvent('wifi', 'with detail', { ssid: 'OTHER-SSID' });
  pushEvent('wifi', 'empty detail', {});
  pushEvent('wifi', 'no detail');
  const [noDetail, emptyDetail, withDetail] = getEvents();
  assert.deepEqual(withDetail.detail, { ssid: 'OTHER-SSID' });
  assert.equal('detail' in emptyDetail, false);
  assert.equal('detail' in noDetail, false);
});
