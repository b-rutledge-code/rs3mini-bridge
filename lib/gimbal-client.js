import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pushEvent } from './events.js';
import { log } from './log.js';

const DEFAULT_WORKER = fileURLToPath(new URL('../ble-worker.mjs', import.meta.url));

function numEnv(env, key, fallback) {
  const n = Number(env?.[key] ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function backoffList(env) {
  return String(env?.BLE_WORKER_BACKOFF ?? '1000,2000,5000')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function emptySnapshot({ connecting = false, adapter = 'unknown' } = {}) {
  return {
    adapter,
    moveStatus: {
      connected: false,
      connecting,
      active: false,
      axis: null,
      lastBleError: null,
    },
    motorLabel: 'UNKNOWN',
    connectGuardBlocked: false,
    state: {
      ok: false,
      ble: {
        connected: false,
        connecting,
        lastError: null,
        rssiDbm: null,
        rssiAgeMs: null,
        rssiSource: null,
      },
      move: { active: false, axis: null },
      motor: { state: null, source: null, ageMs: null },
      telemetry: {},
    },
  };
}

function eventKey(e) {
  return `${e.ts}|${e.kind}|${e.message}`;
}

/**
 * Parent-side BLE proxy. Same names app.mjs / server.mjs use on gimbal-session.
 * Status reads come from the last child snapshot — never wait on the radio.
 */
export function createGimbalClient({
  workerPath = DEFAULT_WORKER,
  env = process.env,
  forkFn = fork,
} = {}) {
  const HEARTBEAT_STALE_MS = numEnv(
    env,
    'BLE_WORKER_STALE_MS',
    numEnv(env, 'CONNECT_TOTAL_MS', 160000) + 20000,
  );
  const CONNECT_RPC_MS = numEnv(
    env,
    'BLE_WORKER_CONNECT_MS',
    numEnv(env, 'CONNECT_TOTAL_MS', 160000) + 15000,
  );
  const RPC_MS = numEnv(env, 'BLE_WORKER_RPC_MS', 30000);
  const BACKOFF_MS = backoffList(env);

  let child = null;
  let snapshot = emptySnapshot();
  let reqId = 0;
  const pending = new Map();
  let lastBeat = 0;
  let watchIv = null;
  let respawnTimer = null;
  let backoffIdx = 0;
  let shuttingDown = false;
  let resetNext = false;
  const seenEvents = new Set();
  let started = false;
  let targetRef = null;
  let reconnectWanted = false;
  let gen = 0;

  function applySnapshot(msg) {
    snapshot = {
      adapter: msg.adapter ?? snapshot.adapter,
      moveStatus: msg.moveStatus ?? snapshot.moveStatus,
      motorLabel: msg.motorLabel ?? snapshot.motorLabel,
      connectGuardBlocked: Boolean(msg.connectGuardBlocked),
      state: msg.state ?? snapshot.state,
    };
    if (Array.isArray(msg.events)) {
      for (const e of [...msg.events].reverse()) {
        const key = eventKey(e);
        if (seenEvents.has(key)) continue;
        seenEvents.add(key);
        if (e.kind === 'boot') continue;
        pushEvent(e.kind, e.message, e.detail);
      }
    }
  }

  function failPending(reason) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pending.delete(id);
    }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'heartbeat' || msg.type === 'ready') {
      lastBeat = Date.now();
      backoffIdx = 0;
      if (msg.adapter) snapshot.adapter = msg.adapter;
      if (msg.events) applySnapshot({ events: msg.events, adapter: msg.adapter });
      return;
    }
    if (msg.type === 'snapshot') {
      lastBeat = Date.now();
      applySnapshot(msg);
      return;
    }
    if (msg.type === 'reply') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'worker error'));
    }
  }

  function onExit(code, signal) {
    log.warn('ble', `worker exit code=${code} signal=${signal || '-'}`);
    child = null;
    failPending('worker exited');
    snapshot = emptySnapshot({
      connecting: !shuttingDown,
      adapter: snapshot.adapter === 'poweredOn' || snapshot.adapter === 'unknown'
        ? 'poweredOn'
        : snapshot.adapter,
    });
    if (!shuttingDown) scheduleRespawn();
  }

  function spawn() {
    if (shuttingDown || child) return;
    const childEnv = { ...env };
    childEnv.BLE_WORKER_RESET = resetNext ? '1' : '0';
    resetNext = false;
    log.info('ble', `fork worker reset=${childEnv.BLE_WORKER_RESET}`);
    const myGen = ++gen;
    child = forkFn(workerPath, [], {
      env: childEnv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    lastBeat = Date.now();
    snapshot = emptySnapshot({ connecting: true, adapter: snapshot.adapter });
    const thisChild = child;
    child.on('message', (msg) => {
      if (gen !== myGen || child !== thisChild) return;
      onMessage(msg);
    });
    child.on('exit', (code, signal) => {
      if (gen !== myGen) return;
      onExit(code, signal);
    });
    child.on('error', (err) => {
      log.warn('ble', `worker error: ${err.message || err}`);
    });
    if (reconnectWanted && targetRef) {
      rpc('startReconnectLoop', {}, RPC_MS).catch((err) => {
        log.debug('ble', `reconnect loop after spawn: ${err.message || err}`);
      });
      rpc('connectOnStartup', {}, CONNECT_RPC_MS).catch((err) => {
        log.warn('ble', `startup connect: ${err.message || err}`);
      });
    }
  }

  function scheduleRespawn() {
    if (shuttingDown || respawnTimer) return;
    const wait = BACKOFF_MS[Math.min(backoffIdx, BACKOFF_MS.length - 1)] ?? 5000;
    backoffIdx += 1;
    resetNext = true;
    log.warn('ble', `worker respawn in ${wait}ms`);
    respawnTimer = setTimeout(() => {
      respawnTimer = null;
      spawn();
    }, wait);
  }

  function killChild(reason) {
    if (!child) return;
    log.warn('ble', `SIGKILL worker — ${reason}`);
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }

  function startWatch() {
    if (watchIv) return;
    watchIv = setInterval(() => {
      if (!child || shuttingDown) return;
      if (pending.size) return;
      if (Date.now() - lastBeat > HEARTBEAT_STALE_MS) {
        killChild(`heartbeat stale ${Date.now() - lastBeat}ms`);
      }
    }, Math.min(1000, Math.max(100, HEARTBEAT_STALE_MS / 4)));
  }

  function waitReady(ms = 5000) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (child?.connected && lastBeat) return resolve();
        if (Date.now() - t0 >= ms) return reject(new Error('worker not ready'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  async function rpc(method, args = {}, timeoutMs = RPC_MS) {
    await waitReady();
    return new Promise((resolve, reject) => {
      if (!child || !child.connected) {
        reject(new Error('worker not connected'));
        return;
      }
      const id = ++reqId;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (method === 'connectOnStartup') {
          killChild(`connect RPC timed out after ${timeoutMs}ms`);
        }
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.send({ type: 'rpc', id, method, args });
    });
  }

  return {
    start() {
      if (started) return;
      started = true;
      spawn();
      startWatch();
    },

    adapterState() {
      return snapshot.adapter || 'unknown';
    },

    moveBlockedByConnectGuard() {
      return snapshot.connectGuardBlocked;
    },

    getMotorLabel() {
      return snapshot.motorLabel ?? 'UNKNOWN';
    },

    getMoveStatus() {
      return { ...snapshot.moveStatus };
    },

    getGimbalState() {
      return structuredClone(snapshot.state);
    },

    async holdMove(_target, { pan = 0, tilt = 0 } = {}) {
      return rpc('holdMove', { pan, tilt });
    },

    async stopMove() {
      return rpc('stopMove');
    },

    async centerGimbal(_target) {
      return rpc('centerGimbal');
    },

    async refreshTelemetry(_target) {
      return rpc('refreshTelemetry');
    },

    async sleepGimbal(_target) {
      return rpc('sleepGimbal');
    },

    async wakeGimbal(_target) {
      return rpc('wakeGimbal');
    },

    async toggleMotor(_target) {
      return rpc('toggleMotor');
    },

    async recallAbsAngle(_target, opts = {}) {
      return rpc('recallAbsAngle', opts);
    },

    async replayTrackPath(_target, opts = {}) {
      const args = { ...opts };
      if (Buffer.isBuffer(args.payload)) {
        args.payloadHex = args.payload.toString('hex');
        delete args.payload;
      }
      return rpc('replayTrackPath', args, CONNECT_RPC_MS);
    },

    async connectOnStartup(target) {
      targetRef = target;
      reconnectWanted = true;
      try {
        return await rpc('connectOnStartup', {}, CONNECT_RPC_MS);
      } catch (err) {
        log.warn('ble', `startup connect failed: ${err.message || err}`);
        return { ok: false, error: err.message || String(err) };
      }
    },

    startReconnectLoop(target) {
      targetRef = target;
      reconnectWanted = true;
      rpc('startReconnectLoop', {}, RPC_MS).catch((err) => {
        log.debug('ble', `startReconnectLoop: ${err.message || err}`);
      });
    },

    stopReconnectLoop() {
      reconnectWanted = false;
      return rpc('stopReconnectLoop', {}, RPC_MS).catch(() => {});
    },

    async shutdownSession() {
      shuttingDown = true;
      if (respawnTimer) clearTimeout(respawnTimer);
      respawnTimer = null;
      if (watchIv) clearInterval(watchIv);
      watchIv = null;
      if (child) {
        try {
          await rpc('shutdown', {}, 4000);
        } catch {
          killChild('shutdown');
        }
        await new Promise((resolve) => {
          if (!child) return resolve();
          child.once('exit', resolve);
          setTimeout(resolve, 2000);
        });
      }
      failPending('shutdown');
    },

    /** @internal test helper */
    _snapshot() {
      return snapshot;
    },

    /** @internal test helper */
    _child() {
      return child;
    },
  };
}
