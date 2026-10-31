/*
 * Connect-coalescing state machine
 * --------------------------------
 * Owns the single source of truth for "at most ONE connect attempt is in flight,
 * and nothing ever blocks forever waiting on it" (noble can hang connect/teardown
 * indefinitely on a Pi). The actual radio work lives in gimbal-session; this class
 * only sequences attempts, detects staleness, and invalidates dead generations.
 *
 *   IDLE ──start()──▶ CONNECTING ──settle() ok──▶ (caller marks CONNECTED)
 *    ▲                    │  │
 *    │  abort()/reset()   │  │ budget elapsed → wait for attempt teardown
 *    └────────────────────┴──┘
 *
 * Callers funnel through ensureConnected(), which coalesces onto the in-flight
 * promise if one exists (coalesce()) or starts a fresh attempt (start()/settle()).
 *
 * Fields move as cohesive units:
 *   #promise / #startedAt / #epoch   the in-flight attempt: promise, start time, generation.
 *   #reconnect.busy / .startedAt     the background reconnect-loop attempt (distinct from a
 *                                    caller-driven connect) so ticks don't stack.
 *
 * epoch is the linchpin: every abort bumps it, so a hung old attempt that finally
 * resolves can be detected as not-current (isCurrent) and ignored rather than
 * clobbering state belonging to a newer attempt.
 */

/** Local timeout that clears its timer so a settled race can't keep the loop alive. */
function raceTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class ConnectCoordinator {
  #promise = null;
  #startedAt = 0;
  #epoch = 0;
  #reconnect = { busy: false, startedAt: 0 };
  #staleMs;
  #teardownMs;
  #abortScan;
  #notify;
  #event;

  /**
   * @param {object} deps
   * @param {number} deps.staleMs            Attempt budget — wait this long for the in-flight promise.
   * @param {number} [deps.teardownMs]       Extra wait for the attempt to finish teardown after budget.
   * @param {() => Promise<void>} [deps.abortScan]  Cancel the underlying BLE scan on abort.
   * @param {(level: 'warn'|'info'|'debug'|'error', msg: string) => void} [deps.notify]  Logger.
   * @param {(msg: string) => void} [deps.event]    Operator event sink.
   */
  constructor({
    staleMs,
    teardownMs,
    abortScan = async () => {},
    notify = () => {},
    event = () => {},
  }) {
    this.#staleMs = staleMs;
    this.#teardownMs = teardownMs ?? Math.min(15000, staleMs);
    this.#abortScan = abortScan;
    this.#notify = notify;
    this.#event = event;
  }

  get connecting() {
    return Boolean(this.#promise);
  }

  get reconnecting() {
    return this.#reconnect.busy;
  }

  /** The in-flight attempt promise, or null. */
  get promise() {
    return this.#promise;
  }

  get epoch() {
    return this.#epoch;
  }

  /** True while `epoch` is still the live generation (i.e. not aborted/superseded). */
  isCurrent(epoch) {
    return epoch === this.#epoch;
  }

  setStaleMs(ms) {
    this.#staleMs = ms;
    this.#teardownMs = Math.min(15000, ms);
  }

  #clearLock() {
    this.#promise = null;
    this.#startedAt = 0;
  }

  #age(startedAt) {
    return startedAt ? Date.now() - startedAt : this.#staleMs + 1;
  }

  /** Bump generation and clear all in-flight state — unwedges a hung noble teardown. */
  abort() {
    this.#epoch += 1;
    this.#clearLock();
    this.#reconnect.busy = false;
    this.#reconnect.startedAt = 0;
    this.#abortScan().catch(() => {});
  }

  /** Clean slate for tests (also bumps epoch so any pending attempt is orphaned). */
  reset() {
    this.#epoch += 1;
    this.#clearLock();
    this.#reconnect.busy = false;
    this.#reconnect.startedAt = 0;
  }

  forceStaleConnect(reason) {
    if (!this.#promise && !this.#startedAt) return false;
    const age = this.#age(this.#startedAt);
    if (age < this.#staleMs) return false;
    this.#notify('warn', `stale connect lock (${reason}) — forcing reconnect ${Math.round(age / 1000)}s`);
    this.#event(`stale connect lock — ${reason}`);
    this.abort();
    return true;
  }

  forceStaleReconnect(reason) {
    if (!this.#reconnect.busy) return false;
    const age = this.#age(this.#reconnect.startedAt);
    if (age < this.#staleMs) return false;
    this.#notify('warn', `stale reconnect busy (${reason}) — forcing ${Math.round(age / 1000)}s`);
    this.#event(`stale reconnect busy — ${reason}`);
    this.abort();
    return true;
  }

  /**
   * Await the in-flight attempt. After the budget, stop the scan and wait for
   * that same attempt to finish teardown. abort() only if teardown itself hangs.
   */
  async #wait(promise, epoch) {
    if (!promise) return;
    try {
      await raceTimeout(promise, this.#staleMs, 'connect coalesce');
    } catch (err) {
      const msg = err?.message || String(err);
      if (!/connect coalesce timed out/i.test(msg)) throw err;
      this.#notify('warn', `${msg} — waiting for attempt teardown`);
      this.#event('connect coalesce timeout — waiting for teardown');
      this.#abortScan().catch(() => {});
      try {
        await raceTimeout(promise, this.#teardownMs, 'connect teardown');
      } catch (teardownErr) {
        const tmsg = teardownErr?.message || String(teardownErr);
        if (!/connect teardown timed out/i.test(tmsg)) throw teardownErr;
        if (epoch === this.#epoch) {
          this.#notify('warn', `${tmsg} — aborting hung connect`);
          this.#event('connect teardown timeout — forcing retry');
          this.abort();
        }
      }
    }
  }

  /** Wait on an existing in-flight attempt; swallow its failure (caller starts fresh). */
  async coalesce() {
    const epoch = this.#epoch;
    try {
      await this.#wait(this.#promise, epoch);
    } catch {
      /* prior attempt failed — caller starts a fresh connect */
    }
  }

  /**
   * Begin a fresh attempt. `attempt(epoch)` runs immediately and its promise becomes
   * the in-flight lock. Returns the epoch the caller should pass back to settle().
   */
  start(attempt) {
    this.#startedAt = Date.now();
    const epoch = this.#epoch;
    this.#promise = attempt(epoch);
    return epoch;
  }

  /** Await our own attempt; rethrow / clear the lock only if still the current generation. */
  async settle(epoch) {
    try {
      await this.#wait(this.#promise, epoch);
    } catch (err) {
      if (this.isCurrent(epoch)) throw err;
    } finally {
      if (this.isCurrent(epoch)) this.#clearLock();
    }
  }

  beginReconnect() {
    this.#reconnect.busy = true;
    this.#reconnect.startedAt = Date.now();
  }

  endReconnect() {
    this.#reconnect.busy = false;
    this.#reconnect.startedAt = 0;
  }
}
