import { mock } from 'node:test';
import { EventEmitter } from 'node:events';

class FakeChar extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  subscribe(cb) {
    if (typeof cb === 'function') cb();
  }

  unsubscribe(cb) {
    if (typeof cb === 'function') cb();
  }

  async writeAsync(buf) {
    this.writes.push(Buffer.from(buf));
  }
}

class FakePeripheral extends EventEmitter {
  constructor() {
    super();
    this.state = 'connected';
    this.id = 'aabbccddeeff';
    this.address = 'aa:bb:cc:dd:ee:ff';
    this.advertisement = { localName: 'DJI RS3 MINI-TEST' };
  }

  async disconnectAsync() {
    this.state = 'disconnected';
  }
}

/**
 * Replace lib/ble-session.js (the only module that loads noble) and lib/log.js
 * with in-memory fakes, so lib/gimbal-session.js can be exercised on a dev box
 * with no Bluetooth adapter.
 *
 * Must be called BEFORE importing gimbal-session.js. Returns a handle whose
 * `state.findCount` counts findPeripheral() calls — the proxy for "how many
 * connect attempts actually reached the radio".
 *
 * @param {object} [opts]
 * @param {(callIndex: number, makePeripheral: () => object) => Promise<object>} [opts.onFind]
 *   Custom findPeripheral behavior per call. Defaults to resolving a fake peripheral.
 */
export async function installBleMock({ onFind } = {}) {
  // lastPeripheral / lastChars let tests fire 'disconnect' and 'data' events.
  const state = { findCount: 0, lastPeripheral: null, lastChars: null };
  // Mutable so a single mock can serve many scenarios (see setFind/resetFindCount).
  const handlers = { onFind };

  const makePeripheral = () => {
    const p = new FakePeripheral();
    state.lastPeripheral = p;
    return p;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Clear the losing timer when the race settles, otherwise a pending
  // setTimeout keeps the test process alive until the (large) timeout elapses.
  const withTimeout = (promise, ms, label) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  const bleUrl = new URL('../../lib/ble-session.js', import.meta.url).href;
  const bleMock = mock.module(bleUrl, {
    namedExports: {
      sleep,
      withTimeout,
      abortBleScan: async () => {},
      closeSession: async () => {},
      closeSessionSafe: async () => {},
      connectPeripheral: async () => {},
      discoverGimbalChars: async () => {
        const chars = { fff4: new FakeChar(), fff5: new FakeChar() };
        state.lastChars = chars;
        return chars;
      },
      writePairingPrologue: async () => {},
      findPeripheral: async () => {
        const idx = state.findCount;
        state.findCount += 1;
        if (handlers.onFind) return handlers.onFind(idx, makePeripheral);
        return makePeripheral();
      },
    },
  });

  const logUrl = new URL('../../lib/log.js', import.meta.url).href;
  const noop = () => {};
  const logMock = mock.module(logUrl, {
    namedExports: {
      log: { debug: noop, info: noop, warn: noop, error: noop },
      isDebug: () => false,
      clientIp: () => '?',
    },
  });

  return {
    state,
    /** Swap the per-call findPeripheral behavior (use in beforeEach for fresh scenarios). */
    setFind(fn) {
      handlers.onFind = fn;
    },
    resetFindCount() {
      state.findCount = 0;
    },
    restore() {
      bleMock.restore?.();
      logMock.restore?.();
    },
  };
}
