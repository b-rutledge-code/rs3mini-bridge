/** Fake BLE child for gimbal-client tests — no noble. */
const HEARTBEAT_MS = Number(process.env.BLE_WORKER_HEARTBEAT_MS ?? 50);
const FAULT_BLOCK_MS = Number(process.env.BLE_WORKER_FAULT_MS ?? 60000);

let connected = false;
let connecting = false;
let motor = 'UNKNOWN';
let adapter = 'poweredOn';
let lastError = null;
let beats = true;

function snapshot() {
  return {
    type: 'snapshot',
    adapter,
    moveStatus: {
      connected,
      connecting,
      active: false,
      axis: null,
      lastBleError: lastError,
    },
    motorLabel: motor,
    connectGuardBlocked: false,
    state: {
      ok: connected,
      ble: {
        connected,
        connecting,
        lastError,
        rssiDbm: connected ? -50 : null,
        rssiAgeMs: connected ? 0 : null,
        rssiSource: connected ? 'live' : null,
      },
      move: { active: false, axis: null },
      motor: { state: connected ? motor : null, source: 'fake', ageMs: 0 },
      telemetry: {},
    },
    events: [],
  };
}

function send(msg) {
  process.send(msg);
}

function reply(id, result) {
  send({ type: 'reply', id, ok: true, result });
  send(snapshot());
}

function beat() {
  if (!beats) return;
  send({ type: 'heartbeat', ts: Date.now(), adapter, events: [] });
  send(snapshot());
}

function blockEventLoop(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    /* watchdog bench */
  }
}

process.on('message', (msg) => {
  if (!msg || msg.type !== 'rpc') return;
  const { id, method } = msg;

  if (method === 'connectOnStartup' && process.env.BLE_WORKER_FAULT === 'block') {
    blockEventLoop(FAULT_BLOCK_MS);
  }

  if (method === 'connectOnStartup' || method === 'startReconnectLoop') {
    connecting = true;
    send(snapshot());
    connecting = false;
    connected = true;
    motor = 'AWAKE';
    lastError = null;
    reply(id, { ok: true });
    return;
  }
  if (method === 'holdMove') {
    reply(id, { ok: true, axis: 'tilt+' });
    return;
  }
  if (method === 'stopMove') {
    reply(id, { ok: true, stopped: true });
    return;
  }
  if (method === 'centerGimbal') {
    reply(id, { ok: true, centered: true });
    return;
  }
  if (method === 'replayTrackPath') {
    reply(id, {
      ok: true,
      payloadHex: msg.args?.payloadHex ?? null,
      hasPayload: msg.args?.payload != null,
    });
    return;
  }
  if (method === 'shutdown') {
    reply(id, { ok: true });
    process.exit(0);
    return;
  }
  if (method === 'stopHeartbeats') {
    beats = false;
    reply(id, { ok: true });
    return;
  }
  send({ type: 'reply', id, ok: false, error: `unknown ${method}` });
});

send({ type: 'ready', adapter });
setInterval(beat, HEARTBEAT_MS);
beat();
