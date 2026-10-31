import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pushEvent } from './events.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

const IFACE = process.env.WIFI_IFACE || 'wlan0';
const POLL_MS = Number(process.env.WIFI_POLL_MS ?? 15000);

/** @type {{ updatedAt: number, data: object | null, lastLogged: string | null, lastEventKey: string | null, pollTimer: ReturnType<typeof setInterval> | null }} */
const cache = {
  updatedAt: 0,
  data: null,
  lastLogged: null,
  lastEventKey: null,
  pollTimer: null,
};

function emptyStatus(extra = {}) {
  return {
    iface: IFACE,
    connected: false,
    ssid: null,
    signalDbm: null,
    signalPct: null,
    bssid: null,
    ip4: null,
    ...extra,
  };
}

export function parseIwLink(text) {
  if (/not connected/i.test(text)) return emptyStatus();
  const ssid = text.match(/^\s*SSID:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const signalMatch = text.match(/signal:\s*(-?\d+)/);
  const signalDbm = signalMatch ? Number(signalMatch[1]) : null;
  const bssidMatch = text.match(/^Connected to\s+([0-9a-f:]+)/im);
  return {
    ...emptyStatus(),
    connected: Boolean(ssid),
    ssid,
    signalDbm,
    bssid: bssidMatch?.[1] ?? null,
  };
}

export function parseNmcliDevice(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    fields[line.slice(0, i)] = line.slice(i + 1);
  }
  const state = fields['GENERAL.STATE'] ?? '';
  const connected = /connected/i.test(state) && !/disconnected/i.test(state.split('(')[0]);
  const ssid = fields['802-11-WIRELESS.SSID'] || null;
  const signalPctRaw = fields['WIFI-PROPERTIES.SIGNAL'];
  const signalPct = signalPctRaw != null && signalPctRaw !== '' ? Number(signalPctRaw) : null;
  return {
    ...emptyStatus(),
    connected: connected && Boolean(ssid),
    ssid: ssid || null,
    signalPct: Number.isFinite(signalPct) ? signalPct : null,
  };
}

async function readIp4() {
  try {
    const { stdout } = await execFileAsync('ip', ['-4', '-br', 'addr', 'show', IFACE], { timeout: 3000 });
    const m = stdout.match(/\s+(\d+\.\d+\.\d+\.\d+)\/\d+/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readViaIw() {
  const { stdout } = await execFileAsync('iw', ['dev', IFACE, 'link'], { timeout: 3000 });
  const parsed = parseIwLink(stdout);
  parsed.ip4 = await readIp4();
  return parsed;
}

async function readViaNmcli() {
  const { stdout } = await execFileAsync(
    'nmcli',
    ['-t', '-f', 'GENERAL.STATE,802-11-WIRELESS.SSID,WIFI-PROPERTIES.SIGNAL', 'device', 'show', IFACE],
    { timeout: 3000 },
  );
  const parsed = parseNmcliDevice(stdout);
  parsed.ip4 = await readIp4();
  return parsed;
}

function formatSignal(data) {
  if (data.signalDbm != null) return `${data.signalDbm} dBm`;
  if (data.signalPct != null) return `${data.signalPct}%`;
  return 'signal ?';
}

/** SSID / link / IP only — not per-dBm (status page Events table). */
function eventKey(data) {
  if (!data.connected) return 'disconnected';
  return `connected:${data.ssid}:${data.ip4 ?? '?'}`;
}

function pushWifiEvent(data) {
  const key = eventKey(data);
  if (key === cache.lastEventKey) return;
  cache.lastEventKey = key;
  if (data.connected) {
    pushEvent('wifi', `connected ${data.ssid} ${formatSignal(data)} ip=${data.ip4 ?? '?'}`, {
      ssid: data.ssid,
      ip4: data.ip4,
      signalDbm: data.signalDbm,
      signalPct: data.signalPct,
    });
  } else {
    pushEvent('wifi', `disconnected (${IFACE})`);
  }
}

function logIfChanged(data) {
  const key = data.connected
    ? `${data.ssid}:${data.signalDbm ?? data.signalPct ?? '?'}:${data.ip4 ?? '?'}`
    : 'disconnected';
  if (key === cache.lastLogged) return;
  cache.lastLogged = key;
  pushWifiEvent(data);
  if (data.connected) {
    log.info('wifi', `${data.ssid} ${formatSignal(data)} ip=${data.ip4 ?? '?'} (${IFACE})`);
  } else {
    log.info('wifi', `disconnected (${IFACE})`);
  }
}

async function refreshWifi({ logChange = true } = {}) {
  if (process.platform !== 'linux') {
    const data = emptyStatus({ unavailable: true });
    cache.data = data;
    cache.updatedAt = Date.now();
    return { ...data, ageMs: 0 };
  }

  let data;
  try {
    data = await readViaIw();
  } catch {
    try {
      data = await readViaNmcli();
    } catch (err) {
      data = emptyStatus({ error: err.message || String(err) });
    }
  }

  cache.data = data;
  cache.updatedAt = Date.now();
  if (logChange) logIfChanged(data);
  return { ...data, ageMs: 0 };
}

/** Cached WiFi link snapshot for /state and status UI. */
export async function getWifiStatus() {
  const ageMs = cache.updatedAt ? Date.now() - cache.updatedAt : null;
  if (cache.data && ageMs != null && ageMs < POLL_MS) {
    return { ...cache.data, ageMs };
  }
  return refreshWifi({ logChange: false });
}

/** Background poll — logs SSID/signal to journal on change (and at boot). */
export function startWifiPollLoop() {
  if (process.platform !== 'linux' || POLL_MS <= 0) return;
  if (cache.pollTimer) return;
  refreshWifi().catch((err) => log.warn('wifi', err.message || String(err)));
  cache.pollTimer = setInterval(() => {
    refreshWifi().catch((err) => log.warn('wifi', err.message || String(err)));
  }, POLL_MS);
}
