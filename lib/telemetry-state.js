/**
 * Live gimbal telemetry + motor state, decoded from inbound BLE notifies.
 *
 * Split out of gimbal-session so the source-priority arbitration is unit-testable
 * without a BLE link. Parsers are injected (the motor parser lives in session-setup,
 * which pulls in noble) so this module itself stays noble-free.
 */

/**
 * Pose source priority — the RS 3 Mini emits attitude on both 0x04/0x66 and
 * 0x04/0x10. 0x66 is richer (includes pan), so it wins; a fresh 0x66 should not be
 * clobbered by a 0x10 that arrives microseconds later.
 */
function poseSourcePriority(source) {
  if (source === '0x04/0x66') return 2;
  if (source === '0x04/0x10') return 1;
  return 0;
}

function emptyTelemetry() {
  return {
    tiltDeg: null,
    tiltRaw: null,
    rollDeg: null,
    rollRaw: null,
    panDeg: null,
    panRaw: null,
    layout: null,
    tlv: null,
    source: null,
    updatedAt: null,
    rawPayload: null,
    batteryPercent: null,
    batteryRaw: null,
    batteryUpdatedAt: null,
  };
}

export class TelemetryState {
  #t = emptyTelemetry();
  #motor = { state: null, updatedAt: null, source: null };
  #staleMs;
  #parseMotor;
  #parseAttitude;
  #isPose;
  #onMotorChange;

  /**
   * @param {object} deps
   * @param {number} deps.staleMs                Window in which a higher-priority pose blocks a lower one.
   * @param {(data: Buffer) => ('AWAKE'|'ASLEEP'|{state:'AWAKE'|'ASLEEP', source?:string}|null)} deps.parseMotor
   *        Motor sleep/wake notify parser. A string is stored as source `notify`.
   *        An object may name the source (`command` or `handle`).
   * @param {(data: Buffer) => object|null} deps.parseAttitude            Attitude/battery parser.
   * @param {(att: object) => boolean} deps.isPose                        Pose-vs-battery classifier.
   * @param {(state: string, source: string) => void} [deps.onMotorChange] Fired only on a state change.
   */
  constructor({ staleMs, parseMotor, parseAttitude, isPose, onMotorChange = () => {} }) {
    this.#staleMs = staleMs;
    this.#parseMotor = parseMotor;
    this.#parseAttitude = parseAttitude;
    this.#isPose = isPose;
    this.#onMotorChange = onMotorChange;
    this.ingest = this.ingest.bind(this);
  }

  /** Live telemetry record (mutated in place — callers read fields off it). */
  get telemetry() {
    return this.#t;
  }

  get motorState() {
    return this.#motor.state;
  }

  get motorSource() {
    return this.#motor.source;
  }

  get motorUpdatedAt() {
    return this.#motor.updatedAt;
  }

  setMotor(state, source) {
    if (state !== 'AWAKE' && state !== 'ASLEEP') return;
    const prev = this.#motor.state;
    // A later report of the same state keeps the origin of the change.
    // The bridge's own command still claims a state a notify already applied.
    if (prev === state) {
      if (source === 'command' && this.#motor.source !== 'command') {
        this.#motor.source = 'command';
        this.#motor.updatedAt = Date.now();
      }
      return;
    }
    this.#motor.state = state;
    this.#motor.updatedAt = Date.now();
    this.#motor.source = source;
    this.#onMotorChange(state, source);
  }

  clearMotor() {
    this.#motor = { state: null, updatedAt: null, source: null };
  }

  clearTelemetry() {
    this.#t = emptyTelemetry();
  }

  /** Decode one inbound notify frame and update motor/pose/battery state. */
  ingest(data) {
    const motor = this.#parseMotor(data);
    if (motor) {
      const state = typeof motor === 'string' ? motor : motor.state;
      const source = typeof motor === 'string' ? 'notify' : motor.source || 'notify';
      if (state) {
        this.setMotor(state, source);
        return;
      }
    }

    const att = this.#parseAttitude(data);
    if (!att) return;

    if (this.#isPose(att)) {
      const incoming = poseSourcePriority(att.source);
      const current = poseSourcePriority(this.#t.source);
      if (
        incoming < current &&
        this.#t.updatedAt &&
        Date.now() - this.#t.updatedAt < this.#staleMs
      ) {
        return;
      }

      this.#t.tiltDeg = att.tiltDeg;
      this.#t.rollDeg = att.rollDeg;
      this.#t.panDeg = att.panDeg;
      this.#t.layout = att.layout;
      this.#t.tlv = att.tlv ?? null;
      this.#t.source = att.source;
      this.#t.updatedAt = Date.now();
      this.#t.rawPayload = att.rawPayload;
      this.#t.tiltRaw = att.pitch;
      this.#t.rollRaw = att.roll;
      this.#t.panRaw = att.yaw;
      return;
    }

    if (att.layout === 'rs3-0d02-battery') {
      this.#t.batteryPercent = att.batteryPercent;
      this.#t.batteryRaw = att.batteryRaw;
      this.#t.batteryUpdatedAt = Date.now();
    }
  }
}
