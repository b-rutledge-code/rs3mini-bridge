import { log } from './log.js';
import { sleep } from './ble-session.js';

/** Last known gimbal BLE address — used after asymmetric drops. */
let lastGimbalAddress = null;

/** Linux by default; `BLUEZ_FORCE_DISCONNECT=0` off, `=1` on (tests on macOS). */
export function bluezCleanupEnabled() {
  if (process.env.BLUEZ_FORCE_DISCONNECT === '0') return false;
  if (process.env.BLUEZ_FORCE_DISCONNECT === '1') return true;
  return process.platform === 'linux';
}

/** MAC from noble address or 12-char id → AA:BB:… */
export function peripheralAddress(peripheral) {
  if (!peripheral) return null;
  const addr = peripheral.address?.trim();
  if (addr && addr !== 'unknown') return addr.toUpperCase();
  const hex = peripheral.id?.replace(/[^a-f0-9]/gi, '');
  if (hex?.length === 12) {
    return hex.match(/.{2}/gi).join(':').toUpperCase();
  }
  return null;
}

export function rememberGimbalAddress(peripheral) {
  const addr = peripheralAddress(peripheral);
  if (addr) lastGimbalAddress = addr;
  return addr;
}

export function getLastGimbalAddress() {
  return lastGimbalAddress;
}

/**
 * Drop a stale ACL in-process: noble disconnect + HCI Reset when a peripheral
 * was on the radio. No bluetoothctl / hciconfig / sudo.
 */
export async function forceBlueZDisconnect(address = lastGimbalAddress, peripheral = null, hooks = {}) {
  if (!bluezCleanupEnabled()) return;

  if (peripheral && typeof peripheral.disconnectAsync === 'function') {
    const state = peripheral.state;
    if (state === 'connected' || state === 'connecting') {
      await peripheral.disconnectAsync().catch(() => {});
      log.info('ble', `noble disconnect ${address || peripheral.id || '?'}`);
    }
  }

  if (peripheral) {
    const reset =
      hooks.resetHciAdapter ?? (await import('./hci-reset.js')).resetHciAdapter;
    const noble = hooks.noble ?? (await import('@abandonware/noble')).default;
    await reset(noble);
  }

  await sleep(Number(process.env.BLUEZ_DISCONNECT_DELAY_MS ?? 400));
}

/** Before scan — clear Pi-side stale state from last session. */
export async function prepareBlueZReconnect(address = lastGimbalAddress, peripheral = null) {
  if (!bluezCleanupEnabled()) return;
  await forceBlueZDisconnect(address, peripheral);
}
