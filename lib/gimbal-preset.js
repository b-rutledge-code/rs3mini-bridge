import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PRESET_PATH = path.join(__dirname, '..', 'saved-pose.json');

export function presetPath() {
  return process.env.PRESET_PATH || DEFAULT_PRESET_PATH;
}

/** Why save would be rejected — for CLI exit messages. */
export function saveRejectReason(state) {
  if (!state?.ok) return 'not connected';
  if (state.move?.active) return 'move active — stop first';
  if (state.motor?.state === 'ASLEEP') return 'motor asleep — wake first';
  const t = state.telemetry;
  if (t?.tiltRaw == null) return 'no pose telemetry yet';
  if (t.stale) return `telemetry stale (${t.ageMs ?? '?'}ms)`;
  const layout = String(t.layout ?? '');
  if (!layout.includes('-tlv') && layout !== 'standard') {
    return `need ActualPose TLV (got layout=${t.layout ?? 'none'})`;
  }
  return null;
}

/** Build a save record from GET /state-shaped gimbal state. */
export function poseFromGimbalState(state) {
  const reason = saveRejectReason(state);
  if (reason) throw new Error(reason);

  const t = state.telemetry;
  return {
    savedAt: new Date().toISOString(),
    source: t.source ?? '0x04/0x66',
    layout: t.layout,
    pitch: t.tiltRaw,
    roll: t.rollRaw ?? 0,
    yaw: t.panRaw,
    tiltDeg: t.tiltDeg,
    panDeg: t.panDeg,
    rollDeg: t.rollDeg,
    rawPayload: t.rawPayload,
  };
}

export function savePoseRecord(record, filePath = presetPath()) {
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return filePath;
}

export function loadPoseRecord(filePath = presetPath()) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`no saved pose at ${filePath} — run preset:save first`);
  }
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (record.pitch == null || record.yaw == null) {
    throw new Error(`invalid saved pose in ${filePath}`);
  }
  return record;
}

/** Wire-value distance after recall (empirical gate — not degrees). */
export function poseWireDelta(saved, state) {
  const t = state.telemetry;
  return {
    tilt: Math.abs(Number(saved.pitch) - Number(t.tiltRaw ?? NaN)),
    pan: Math.abs(Number(saved.yaw) - Number(t.panRaw ?? NaN)),
    roll: Math.abs(Number(saved.roll ?? 0) - Number(t.rollRaw ?? 0)),
  };
}

export function withinTolerance(delta, toleranceRaw) {
  return (
    Number.isFinite(delta.tilt) &&
    Number.isFinite(delta.pan) &&
    delta.tilt <= toleranceRaw &&
    delta.pan <= toleranceRaw
  );
}
