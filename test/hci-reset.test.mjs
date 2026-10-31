import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resetHciAdapter } from '../lib/hci-reset.js';

test('resetHciAdapter writes reset and waits for poweredOn', async () => {
  const noble = new EventEmitter();
  noble.state = 'poweredOff';
  let resetCalls = 0;
  noble._bindings = {
    _hci: {
      reset() {
        resetCalls += 1;
        setImmediate(() => {
          noble.state = 'poweredOn';
          noble.emit('stateChange', 'poweredOn');
        });
      },
    },
  };

  const ok = await resetHciAdapter(noble, { timeoutMs: 500 });
  assert.equal(ok, true);
  assert.equal(resetCalls, 1);
});

test('resetHciAdapter returns false when bindings missing', async () => {
  const noble = new EventEmitter();
  noble.state = 'unknown';
  const ok = await resetHciAdapter(noble, { timeoutMs: 50 });
  assert.equal(ok, false);
});
