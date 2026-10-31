import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../app.mjs';

function fakeGimbal(over = {}) {
  return {
    moveBlockedByConnectGuard: () => false,
    getMotorLabel: () => 'AWAKE',
    getMoveStatus: () => ({ connected: true, connecting: false, active: false, axis: null, lastBleError: null }),
    getGimbalState: () => ({ ok: true, ble: {}, telemetry: {} }),
    holdMove: async () => ({ ok: true, axis: 'tilt+' }),
    stopMove: async () => ({ ok: true, stopped: true }),
    centerGimbal: async () => ({ ok: true, centered: true }),
    refreshTelemetry: async () => ({ ok: true, refreshed: true, source: '0x04/0x66', tiltRaw: 1, panRaw: 2 }),
    sleepGimbal: async () => ({ ok: true, sleep: true }),
    wakeGimbal: async () => ({ ok: true, wake: true }),
    toggleMotor: async () => ({ ok: true, motor: 'ASLEEP' }),
    ...over,
  };
}

function mkDeps({ target = { nameRe: /x/ }, gimbal = {}, ...rest } = {}) {
  return { target, gimbal: fakeGimbal(gimbal), ...rest };
}

async function withApp(deps, fn) {
  const server = createApp(deps).listen(0);
  await once(server, 'listening');
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const post = (base, p, opts) => fetch(base + p, { method: 'POST', ...opts });

test('/health/label maps BLE status to Companion text', async () => {
  const cases = [
    [{ getMoveStatus: () => ({ connecting: true }) }, {}, 'CONN…'],
    [{ getMoveStatus: () => ({ connected: true }) }, {}, 'OK'],
    [{ getMoveStatus: () => ({ connected: false }) }, { adapterState: () => 'poweredOn' }, 'NO GIMB'],
    [{ getMoveStatus: () => ({ connected: false }) }, { adapterState: () => 'poweredOff' }, 'NO BLE'],
  ];
  for (const [gimbal, rest, expected] of cases) {
    await withApp(mkDeps({ gimbal, ...rest }), async (b) => {
      const label = await (await fetch(`${b}/health/label`)).json();
      assert.equal(label, expected);
    });
  }
});

test('/health/ble/rssi, /health/wifi*, /health/battery for Companion split status', async () => {
  await withApp(
    mkDeps({
      gimbal: {
        getMoveStatus: () => ({ connected: true }),
        getGimbalState: () => ({
          ok: true,
          ble: { connected: true, rssiDbm: -52 },
          telemetry: { batteryPercent: 57 },
        }),
      },
      getWifi: async () => ({ connected: true, signalDbm: -41, ssid: 'TEST-SSID' }),
    }),
    async (b) => {
      assert.equal(await (await fetch(`${b}/health/ble/rssi`)).json(), -52);
      assert.equal(await (await fetch(`${b}/health/wifi`)).json(), 'UP');
      assert.equal(await (await fetch(`${b}/health/wifi/rssi`)).json(), -41);
      assert.equal(await (await fetch(`${b}/health/battery`)).json(), 57);
    },
  );
  await withApp(
    mkDeps({
      gimbal: {
        getMoveStatus: () => ({ connected: false }),
        getGimbalState: () => ({
          ok: false,
          ble: { connected: false, rssiDbm: null },
          telemetry: { batteryPercent: null },
        }),
      },
      getWifi: async () => ({ connected: false, signalDbm: null }),
    }),
    async (b) => {
      assert.equal(await (await fetch(`${b}/health/ble/rssi`)).json(), null);
      assert.equal(await (await fetch(`${b}/health/wifi`)).json(), 'DOWN');
      assert.equal(await (await fetch(`${b}/health/wifi/rssi`)).json(), null);
      assert.equal(await (await fetch(`${b}/health/battery`)).json(), null);
    },
  );
});

test('/move/hold 503s when no gimbal target is configured', async () => {
  await withApp(mkDeps({ target: {} }), async (b) => {
    const res = await post(b, '/move/hold?tilt=1');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not configured/i);
  });
});

test('/move/hold honors the startup guard', async () => {
  await withApp(mkDeps({ startupGuardMs: 10000 }), async (b) => {
    const res = await post(b, '/move/hold?tilt=1');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /startup guard/i);
  });
});

test('/move/hold honors the connect guard', async () => {
  await withApp(mkDeps({ gimbal: { moveBlockedByConnectGuard: () => true } }), async (b) => {
    const res = await post(b, '/move/hold?tilt=1');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /connect guard/i);
  });
});

test('/move/hold is blocked while the motor is asleep', async () => {
  await withApp(mkDeps({ gimbal: { getMotorLabel: () => 'ASLEEP' } }), async (b) => {
    const res = await post(b, '/move/hold?tilt=1');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /asleep/i);
  });
});

test('/move/hold requires a non-zero axis', async () => {
  await withApp(mkDeps(), async (b) => {
    const res = await post(b, '/move/hold?pan=0&tilt=0');
    assert.equal(res.status, 400);
  });
});

test('/move/hold discards the command when the gimbal is not linked', async () => {
  let called = false;
  await withApp(mkDeps({
    gimbal: {
      getMoveStatus: () => ({ connected: false, connecting: true }),
      holdMove: async () => { called = true; return { ok: true }; },
    },
  }), async (b) => {
    const res = await post(b, '/move/hold?tilt=1');
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not connected/i);
    assert.equal(called, false);
  });
});

test('/move/hold passes parsed axis through to holdMove', async () => {
  let seen;
  const gimbal = { holdMove: async (_t, axis) => { seen = axis; return { ok: true, axis: 'pan+' }; } };
  await withApp(mkDeps({ gimbal }), async (b) => {
    const res = await post(b, '/move/hold?pan=25&tilt=0');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, axis: 'pan+' });
    assert.deepEqual(seen, { pan: 25, tilt: 0 });
  });
});

test('command errors classify transient BLE failures as 503, others as 500', async () => {
  await withApp(mkDeps({ gimbal: { holdMove: async () => { throw new Error('not connected'); } } }), async (b) => {
    assert.equal((await post(b, '/move/hold?tilt=1')).status, 503);
  });
  await withApp(mkDeps({ gimbal: { holdMove: async () => { throw new Error('boom'); } } }), async (b) => {
    assert.equal((await post(b, '/move/hold?tilt=1')).status, 500);
  });
});

test('/move/stop never classifies as 503 (always 500 on error)', async () => {
  await withApp(mkDeps({ gimbal: { stopMove: async () => { throw new Error('not connected'); } } }), async (b) => {
    assert.equal((await post(b, '/move/stop')).status, 500);
  });
});

test('BRIDGE_TOKEN gates command routes', async () => {
  await withApp(mkDeps({ token: 'sekret' }), async (b) => {
    assert.equal((await post(b, '/move/stop')).status, 401);
    const ok = await post(b, '/move/stop', { headers: { 'X-Bridge-Token': 'sekret' } });
    assert.equal(ok.status, 200);
  });
});

test('/motor/toggle decorates the result', async () => {
  await withApp(mkDeps(), async (b) => {
    const body = await (await post(b, '/motor/toggle')).json();
    assert.equal(body.toggle, true);
    assert.equal(body.motor, 'ASLEEP');
  });
});

test('/state merges gimbal state with the wifi snapshot', async () => {
  await withApp(mkDeps({ getWifi: async () => ({ connected: true, ssid: 'OTHER-SSID' }) }), async (b) => {
    const body = await (await fetch(`${b}/state`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.wifi.ssid, 'OTHER-SSID');
  });
});

test('/events reports count and list from the event sink', async () => {
  const events = { push: () => {}, get: () => [{ kind: 'boot', message: 'up' }] };
  await withApp(mkDeps({ events }), async (b) => {
    const body = await (await fetch(`${b}/events`)).json();
    assert.equal(body.count, 1);
    assert.equal(body.events[0].kind, 'boot');
  });
});

test('/health reports adapter state and target label', async () => {
  await withApp(mkDeps({ adapterState: () => 'poweredOn' }), async (b) => {
    const body = await (await fetch(`${b}/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.adapter, 'poweredOn');
  });
});

test('POST /telemetry/refresh calls refreshTelemetry', async () => {
  let called = false;
  const gimbal = {
    refreshTelemetry: async () => {
      called = true;
      return { ok: true, refreshed: true, source: '0x04/0x66', tiltRaw: 100, panRaw: 200 };
    },
  };
  await withApp(mkDeps({ gimbal }), async (b) => {
    const res = await post(b, '/telemetry/refresh');
    assert.equal(res.status, 200);
    assert.equal(called, true);
    const body = await res.json();
    assert.equal(body.refreshed, true);
    assert.equal(body.source, '0x04/0x66');
  });
});

test('POST /track/replay stage0g calls replayTrackPath', async () => {
  let args;
  const gimbal = {
    replayTrackPath: async (_target, opts) => {
      args = opts;
      return { ok: true, payloadLen: opts.payload.length };
    },
  };
  await withApp(mkDeps({ gimbal }), async (b) => {
    const res = await post(b, '/track/replay', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'stage0g', followMs: 5000 }),
    });
    assert.equal(res.status, 200);
    assert.ok(args?.payload?.length > 0);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

test('POST /angle/recall calls recallAbsAngle', async () => {
  let args;
  const gimbal = {
    recallAbsAngle: async (_target, opts) => {
      args = opts;
      return { ok: true };
    },
  };
  await withApp(mkDeps({ gimbal }), async (b) => {
    const res = await post(b, '/angle/recall', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pitch: 834, yaw: 0 }),
    });
    assert.equal(res.status, 200);
    assert.equal(args.pitch, 834);
    assert.equal(args.yaw, 0);
  });
});
