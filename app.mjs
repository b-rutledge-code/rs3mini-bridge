/**
 * Express app construction for rs3mini-bridge — separated from the listen()/BLE
 * bootstrap in server.mjs so the HTTP layer (guards, token, status mapping) can be
 * imported and tested without noble or a real gimbal session.
 *
 * Full route reference: API.md
 */
import express from 'express';
import { clientIp, isDebug, log } from './lib/log.js';
import { pushEvent, getEvents } from './lib/events.js';
import { hasGimbalTarget, gimbalTargetLabel } from './lib/gimbal-target.js';
import { STAGE0G_062_PAYLOAD } from './lib/gimbal-waypoint.js';

/** Transient BLE conditions → 503 (retryable); everything else → 500. */
const COMMAND_ERROR_RE = /not connected|not found|timed out|disconnected/i;

/**
 * @param {object} deps
 * @param {object} deps.target              Gimbal target descriptor (from buildGimbalTarget()).
 * @param {object} deps.gimbal              gimbal-session module (holdMove, stopMove, …).
 * @param {() => string} [deps.adapterState] BLE adapter state, e.g. () => noble.state.
 * @param {() => Promise<object>} [deps.getWifi] Wi-Fi snapshot for /state.
 * @param {string} [deps.token]             BRIDGE_TOKEN; empty disables auth.
 * @param {number} [deps.startupGuardMs]    Block /move/hold for N ms after app creation.
 * @param {string|null} [deps.staticDir]    Serve the status UI from here (skipped if null).
 */
export function createApp({
  target,
  gimbal,
  adapterState = () => 'unknown',
  getWifi = async () => ({}),
  token = '',
  startupGuardMs = 0,
  staticDir = null,
  hasTarget = hasGimbalTarget,
  targetLabel = gimbalTargetLabel,
  events = { push: pushEvent, get: getEvents },
}) {
  const startedAt = Date.now();
  const blockedByStartupGuard = () =>
    startupGuardMs > 0 && Date.now() - startedAt < startupGuardMs;

  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const started = Date.now();
    const ip = clientIp(req);
    res.on('finish', () => {
      const ms = Date.now() - started;
      const line = `${req.method} ${req.originalUrl} ${ip} ${res.statusCode} ${ms}ms`;
      if (req.path.startsWith('/move') || req.path === '/center' || req.path === '/sleep' || req.path === '/wake' || req.path === '/telemetry/refresh' || req.path === '/track/replay' || req.path === '/angle/recall') {
        log.info('http', line);
      } else if (isDebug()) {
        log.debug('http', line);
      }
    });
    next();
  });

  function checkToken(req, res, next) {
    if (!token) return next();
    const provided = req.get('X-Bridge-Token') || req.query.token;
    if (provided !== token) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    next();
  }

  function requireTarget(res) {
    if (!hasTarget(target)) {
      res.status(503).json({
        ok: false,
        error: 'Gimbal target not configured — set GIMBAL_NAME_RE to your unit suffix',
      });
      return false;
    }
    return true;
  }

  /** One place for the command try/catch + error → status-code classification. */
  async function runCommand(res, label, fn, { classify = true } = {}) {
    try {
      res.json(await fn());
    } catch (err) {
      const msg = err.message || String(err);
      const code = classify && COMMAND_ERROR_RE.test(msg) ? 503 : 500;
      log.warn('move', `${label} failed: ${msg}`);
      res.status(code).json({ ok: false, error: msg });
    }
  }

  function blockGuard(res, req, kind, message) {
    const ip = clientIp(req);
    log.warn('http', `${kind} blocked ${req.method} ${req.originalUrl} ${ip}`);
    events.push('guard', `${kind} blocked move`, { ip });
    res.status(503).json({ ok: false, error: message });
  }

  function parseAxisInput(req) {
    return {
      pan: Number(req.query.pan ?? req.body?.pan ?? 0),
      tilt: Number(req.query.tilt ?? req.body?.tilt ?? 0),
    };
  }

  app.post('/move/hold', checkToken, async (req, res) => {
    if (!requireTarget(res)) return;
    if (blockedByStartupGuard()) {
      blockGuard(res, req, 'startup guard', 'startup guard — motion blocked for a few seconds after bridge boot');
      return;
    }
    if (gimbal.moveBlockedByConnectGuard()) {
      blockGuard(res, req, 'connect guard', 'connect guard — motion blocked for a few seconds after BLE connect');
      return;
    }
    if (gimbal.getMotorLabel() === 'ASLEEP') {
      blockGuard(res, req, 'motor asleep', 'motor asleep — POST /wake or /motor/toggle first');
      return;
    }
    if (!gimbal.getMoveStatus().connected) {
      blockGuard(res, req, 'unlinked', 'not connected — move discarded');
      return;
    }
    const { pan, tilt } = parseAxisInput(req);
    if (pan === 0 && tilt === 0) {
      res.status(400).json({ ok: false, error: 'pan or tilt required' });
      return;
    }
    await runCommand(res, 'holdMove', () => gimbal.holdMove(target, { pan, tilt }));
  });

  app.post('/move/stop', checkToken, async (_req, res) => {
    if (!requireTarget(res)) return;
    await runCommand(res, 'stopMove', () => gimbal.stopMove(), { classify: false });
  });

  app.post('/center', checkToken, async (_req, res) => {
    if (!requireTarget(res)) return;
    await runCommand(res, 'centerGimbal', () => gimbal.centerGimbal(target));
  });

  app.post('/telemetry/refresh', checkToken, async (_req, res) => {
    if (!requireTarget(res)) return;
    await runCommand(res, 'refreshTelemetry', () => gimbal.refreshTelemetry(target));
  });

  app.post('/track/replay', checkToken, async (req, res) => {
    if (!requireTarget(res)) return;
    if (gimbal.moveBlockedByConnectGuard()) {
      blockGuard(res, req, 'connect guard', 'connect guard — track replay blocked for a few seconds after BLE connect');
      return;
    }
    if (gimbal.getMotorLabel() === 'ASLEEP') {
      blockGuard(res, req, 'motor asleep', 'motor asleep — POST /wake or /motor/toggle first');
      return;
    }
    let payload;
    const mode = req.body?.mode ?? req.query.mode;
    if (mode === 'stage0g') {
      payload = STAGE0G_062_PAYLOAD;
    } else {
      const hex = req.body?.payloadHex ?? req.query.payloadHex;
      if (!hex) {
        res.status(400).json({ ok: false, error: 'mode=stage0g or payloadHex required' });
        return;
      }
      payload = Buffer.from(String(hex), 'hex');
    }
    const opts = {
      payload,
      pollMs: Number(req.body?.pollMs ?? req.query.pollMs ?? 4000),
      prePolls: Number(req.body?.prePolls ?? req.query.prePolls ?? 3),
      followMs: Number(req.body?.followMs ?? req.query.followMs ?? 20000),
    };
    await runCommand(res, 'replayTrackPath', () => gimbal.replayTrackPath(target, opts));
  });

  /** Bench: 0x04/0x14 absolute-angle recall (Track-format pitch/yaw int16, 0.1°). */
  app.post('/angle/recall', checkToken, async (req, res) => {
    if (!requireTarget(res)) return;
    if (gimbal.moveBlockedByConnectGuard()) {
      blockGuard(res, req, 'connect guard', 'connect guard — angle recall blocked for a few seconds after BLE connect');
      return;
    }
    if (gimbal.getMotorLabel() === 'ASLEEP') {
      blockGuard(res, req, 'motor asleep', 'motor asleep — POST /wake or /motor/toggle first');
      return;
    }
    const pitch = Number(req.body?.pitch ?? req.query.pitch);
    const yaw = Number(req.body?.yaw ?? req.query.yaw ?? 0);
    const roll = Number(req.body?.roll ?? req.query.roll ?? 0);
    if (!Number.isFinite(pitch) || !Number.isFinite(yaw)) {
      res.status(400).json({ ok: false, error: 'pitch and yaw required' });
      return;
    }
    const opts = {
      pitch,
      roll,
      yaw,
      flags: Number(req.body?.flags ?? req.query.flags ?? 0x07),
      duration: Number(req.body?.duration ?? req.query.duration ?? 80),
      settleMs: Number(req.body?.settleMs ?? req.query.settleMs ?? 3000),
    };
    await runCommand(res, 'recallAbsAngle', () => gimbal.recallAbsAngle(target, opts));
  });

  app.post('/sleep', checkToken, async (_req, res) => {
    if (!requireTarget(res)) return;
    await runCommand(res, 'sleepGimbal', () => gimbal.sleepGimbal(target));
  });

  app.post('/wake', checkToken, async (_req, res) => {
    if (!requireTarget(res)) return;
    await runCommand(res, 'wakeGimbal', () => gimbal.wakeGimbal(target));
  });

  app.post('/motor/toggle', checkToken, async (_req, res) => {
    if (!requireTarget(res)) return;
    await runCommand(res, 'toggleMotor', async () => ({
      ...(await gimbal.toggleMotor(target)),
      toggle: true,
    }));
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, adapter: adapterState(), gimbalTarget: targetLabel(target) });
  });

  app.get('/state', async (_req, res) => {
    const state = gimbal.getGimbalState();
    state.wifi = await getWifi();
    res.json(state);
  });

  app.get('/events', (_req, res) => {
    const events_ = events.get();
    res.json({ ok: true, count: events_.length, events: events_ });
  });

  /** Motor sleep state for Companion poll — from 0x04/0x0f notify (Stage 0c). */
  app.get('/motor', (_req, res) => {
    res.json(gimbal.getMotorLabel());
  });

  /** BLE link status for Companion poll — JSON string (not move/motion state). */
  app.get('/health/label', (_req, res) => {
    res.json(bleLinkLabel());
  });

  /** BLE RSSI dBm for Companion (number), or null when unknown/disconnected. */
  app.get('/health/ble/rssi', (_req, res) => {
    const state = gimbal.getGimbalState?.() || {};
    res.json(finiteNumber(state.ble?.rssiDbm));
  });

  /** Pi Wi‑Fi association for Companion — `UP` / `DOWN`. */
  app.get('/health/wifi', async (_req, res) => {
    const wifi = await getWifi();
    res.json(wifi?.connected ? 'UP' : 'DOWN');
  });

  /** Pi Wi‑Fi RSSI dBm for Companion (number), or null when unknown/down. */
  app.get('/health/wifi/rssi', async (_req, res) => {
    const wifi = await getWifi();
    res.json(wifi?.connected ? finiteNumber(wifi?.signalDbm) : null);
  });

  /** Gimbal battery % for Companion (0–100), or null when unknown. */
  app.get('/health/battery', (_req, res) => {
    const state = gimbal.getGimbalState?.() || {};
    const pct = finiteNumber(state.telemetry?.batteryPercent);
    res.json(pct != null && pct >= 0 && pct <= 100 ? pct : null);
  });

  /** Parse JSON number; null/'' stay null (Number(null)===0 is wrong for RSSI). */
  function finiteNumber(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function bleLinkLabel() {
    const s = gimbal.getMoveStatus();
    if (s.connected) return 'OK';
    if (s.connecting) return 'CONN…';
    if (hasTarget(target) && adapterState() === 'poweredOn') return 'NO GIMB';
    return 'NO BLE';
  }

  if (staticDir) app.use(express.static(staticDir));

  return app;
}
