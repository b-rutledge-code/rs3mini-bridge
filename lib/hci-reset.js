import { log } from './log.js';

const RESET_WAIT_MS = Number(process.env.HCI_RESET_WAIT_MS ?? 8000);

/**
 * Send HCI Reset on noble's raw socket, then wait for poweredOn.
 * Uses noble._bindings._hci.reset() (abandonware 1.9.2-26). No shell.
 */
export async function resetHciAdapter(noble, { timeoutMs = RESET_WAIT_MS } = {}) {
  const hci = noble?._bindings?._hci;
  if (typeof hci?.reset !== 'function') {
    log.warn('ble', 'HCI Reset unavailable — noble bindings not ready');
    return false;
  }

  log.info('ble', 'HCI Reset');
  const wait = new Promise((resolve) => {
    const finish = (ok) => {
      noble.removeListener('stateChange', onState);
      clearTimeout(timer);
      resolve(ok);
    };
    const onState = (state) => {
      if (state === 'poweredOn') finish(true);
    };
    const timer = setTimeout(() => finish(noble.state === 'poweredOn'), timeoutMs);
    noble.on('stateChange', onState);
  });

  try {
    hci.reset();
  } catch (err) {
    log.warn('ble', `HCI Reset write failed: ${err.message || err}`);
    return false;
  }

  return wait;
}
