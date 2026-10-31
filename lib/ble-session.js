import noble from '@abandonware/noble';
import {
  advertisedNameBest,
  advertisedNames,
  gimbalTargetLabel,
  matchesAdvertisedName,
} from './gimbal-target.js';
import { log } from './log.js';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}

const BT_POWERON_TIMEOUT_MS = Number(process.env.BT_POWERON_TIMEOUT_MS ?? 45000);

export async function waitPoweredOn() {
  if (noble.state === 'poweredOn') return;
  await withTimeout(
    new Promise((resolve, reject) => {
      const onState = (state) => {
        if (state === 'poweredOn') {
          noble.removeListener('stateChange', onState);
          resolve();
        } else if (state === 'unauthorized') {
          noble.removeListener('stateChange', onState);
          reject(new Error('Bluetooth unauthorized'));
        } else if (state === 'unsupported') {
          noble.removeListener('stateChange', onState);
          reject(new Error('Bluetooth unsupported in this environment'));
        }
      };
      noble.on('stateChange', onState);
    }),
    BT_POWERON_TIMEOUT_MS,
    'Bluetooth poweredOn',
  );
}

/** Stop an in-flight noble scan — capped so a hung noble call cannot block teardown. */
export async function stopScanningSafe() {
  const stop = async () => {
    if (typeof noble.stopScanningAsync === 'function') {
      await noble.stopScanningAsync().catch(() => {});
    } else if (typeof noble.stopScanning === 'function') {
      try {
        noble.stopScanning();
      } catch {
        /* ignore */
      }
    }
  };
  try {
    await withTimeout(stop(), 3000, 'stopScanning');
  } catch (err) {
    log.warn('ble', `${err.message || err} — continuing`);
  }
}

export async function abortBleScan() {
  await stopScanningSafe();
  noble.removeAllListeners('discover');
}

/**
 * Scan for a gimbal peripheral by advertised name (GIMBAL_NAME_RE).
 */
export async function findPeripheral(target) {
  const nameRe = typeof target === 'object' ? target?.nameRe : null;
  if (!nameRe) {
    throw new Error('No gimbal target — set GIMBAL_NAME_RE to your unit suffix (e.g. YOURSUFFIX)');
  }

  const label = gimbalTargetLabel(target);
  const djiLike = /rs\s*3|rs3|dji/i;
  /** @type {Map<string, string>} id → best advertised name */
  const djiSeen = new Map();

  await waitPoweredOn();
  console.log(`Scanning for gimbal (${label})…`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      noble.removeListener('discover', onDiscover);
      await stopScanningSafe();
      fn();
    };

    const timeout = setTimeout(() => {
      let hint = '';
      if (djiSeen.size) {
        hint = ` — saw DJI-like: ${[...djiSeen.values()].join(', ')}`;
      }
      finish(() => reject(new Error(`Gimbal not found in 30s (${label})${hint}`)));
    }, 30000);

    const onDiscover = async (p) => {
      const names = advertisedNames(p);
      if (names.some((n) => djiLike.test(n))) {
        const best = advertisedNameBest(p) || p.id;
        if (!djiSeen.has(p.id)) {
          djiSeen.set(p.id, best);
          const matched = matchesAdvertisedName(p, nameRe);
          log.info(
            'ble',
            `scan saw ${best} id=${p.id} rssi=${p.rssi} names=${names.join(' | ')} match=${matched}`,
          );
        }
      }
      if (!matchesAdvertisedName(p, nameRe)) return;
      const name = advertisedNameBest(p) || p.id;
      console.log(`Found ${name} id=${p.id} rssi=${p.rssi}`);
      await finish(() => resolve(p));
    };

    noble.on('discover', onDiscover);
    try {
      noble.startScanning([], true);
    } catch (err) {
      finish(() => reject(err));
    }
  });
}

const normUuid = (u) => u.replace(/-/g, '').toLowerCase();

function findFff0Service(services) {
  return services.find((s) => normUuid(s.uuid).includes('fff0'));
}

/**
 * Linux BlueZ often returns [] when discoverServices is filtered by UUID.
 * Discover all services, retry if empty, log UUIDs on failure.
 */
async function discoverAllServices(peripheral) {
  const timeoutMs = Number(process.env.GATT_DISCOVER_MS ?? 15000);
  const retries = Number(process.env.GATT_DISCOVER_RETRIES ?? 2);
  let last = [];

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const t0 = Date.now();
    log.info(
      'ble',
      `discoverServices all start attempt=${attempt}/${retries} state=${peripheral.state}`
    );
    last = await withTimeout(
      peripheral.discoverServicesAsync([]),
      timeoutMs,
      'discoverServices'
    );
    const uuids = last.map((s) => s.uuid).join(', ') || '(none)';
    log.info(
      'ble',
      `discoverServices all ok count=${last.length} ${Date.now() - t0}ms uuids=${uuids}`
    );
    if (last.length > 0) return last;
    if (attempt < retries) {
      log.warn('ble', 'discoverServices empty — retry after 500ms');
      await sleep(500);
    }
  }

  return last;
}

/**
 * Pi/Linux connect can take 30–45s; noble may block the event loop so Promise.race
 * alone is unreliable. Watch peripheral.state + progress logs + hard timeout.
 */
export async function connectPeripheral(peripheral) {
  const timeoutMs = Number(process.env.CONNECT_TIMEOUT_MS ?? 45000);
  const name = peripheral.advertisement?.localName || peripheral.id;
  const t0 = Date.now();

  if (peripheral.state === 'connected') {
    log.info('ble', `connectAsync skip — already connected ${name}`);
    return;
  }

  if (peripheral.state === 'disconnecting') {
    throw new Error(`connect blocked — still disconnecting ${name}`);
  }

  log.info(
    'ble',
    `connectAsync start ${name} state=${peripheral.state} timeout=${timeoutMs}ms`
  );

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(progressIv);
      clearTimeout(hardTimeout);
      if (err) reject(err);
      else resolve();
    };

    const progressIv = setInterval(() => {
      log.info(
        'ble',
        `connectAsync waiting ${name} state=${peripheral.state} ${Date.now() - t0}ms`
      );
      if (peripheral.state === 'connected') finish();
    }, 5000);

    const hardTimeout = setTimeout(() => {
      log.warn(
        'ble',
        `connectAsync timeout ${name} state=${peripheral.state} ${Date.now() - t0}ms`
      );
      // Reject first — noble disconnectAsync can hang forever on a wedged ACL
      // (Pi logs showed 392s "connecting" because this callback awaited it).
      finish(new Error(`connect timed out after ${timeoutMs}ms`));
      peripheral.disconnectAsync().catch(() => {});
    }, timeoutMs);

    peripheral
      .connectAsync()
      .then(() => finish())
      .catch((err) => finish(err));
  });

  log.info('ble', `connectAsync ok ${name} state=${peripheral.state} ${Date.now() - t0}ms`);
}

export async function discoverGimbalChars(peripheral) {
  const connectDelay = Number(process.env.CONNECT_DELAY_MS ?? 500);
  if (connectDelay > 0) {
    log.info('ble', `post-connect GATT delay ${connectDelay}ms`);
    await sleep(connectDelay);
  }

  if (peripheral.state === 'disconnecting') {
    const name = peripheral.advertisement?.localName || peripheral.id;
    throw new Error(`link dropped before GATT — still disconnecting ${name}`);
  }

  if (peripheral.state !== 'connected') {
    log.warn(
      'ble',
      `post-delay state=${peripheral.state} — reconnecting before GATT discover`
    );
    await connectPeripheral(peripheral);
  }

  const services = await discoverAllServices(peripheral);
  const service = findFff0Service(services);
  if (!service) {
    const uuids = services.map((s) => s.uuid).join(', ') || '(none)';
    throw new Error(`Service fff0 not found among: ${uuids}`);
  }

  const t1 = Date.now();
  log.info('ble', `discoverCharacteristics start service=${service.uuid}`);
  const characteristics = await withTimeout(
    service.discoverCharacteristicsAsync([]),
    Number(process.env.GATT_DISCOVER_MS ?? 15000),
    'discoverCharacteristics'
  );
  const chUuids = characteristics.map((c) => c.uuid).join(', ') || '(none)';
  log.info(
    'ble',
    `discoverCharacteristics ok count=${characteristics.length} ${Date.now() - t1}ms uuids=${chUuids}`
  );

  const fff4 = characteristics.find((c) => normUuid(c.uuid).endsWith('fff4'));
  const fff5 = characteristics.find((c) => normUuid(c.uuid).endsWith('fff5'));
  if (!fff4) throw new Error(`Characteristic fff4 not found among: ${chUuids}`);
  if (!fff5) throw new Error(`Characteristic fff5 not found among: ${chUuids}`);
  return { fff4, fff5 };
}

/**
 * DJI pairing prologue [01 00] → fff4.
 * Linux/BlueZ: write-with-response waits for ATT_OP_WRITE_RESP that noble never
 * surfaces — use write-without-response (same as fff5 move frames).
 */
export async function writePairingPrologue(fff4, hex) {
  const data = Buffer.from(hex, 'hex');
  const withoutResponse =
    process.platform === 'linux' || process.env.PAIRING_WRITE_NO_RESPONSE === '1';
  const timeoutMs = Number(process.env.PAIRING_WRITE_MS ?? 5000);
  log.info(
    'ble',
    `pairing write fff4 bytes=${hex} withoutResponse=${withoutResponse}`
  );
  await withTimeout(fff4.writeAsync(data, withoutResponse), timeoutMs, 'pairing write');
  await sleep(Number(process.env.PAIRING_DELAY_MS ?? 300));
  log.info('ble', 'pairing write fff4 ok');
}

/**
 * macOS noble often never calls subscribeAsync()'s callback even when
 * notifications work. Fire-and-forget + wait for first data or short timeout.
 */
export async function enableNotifications(ch, label, { waitMs = 2500 } = {}) {
  let packets = 0;
  const onData = (data) => {
    packets += 1;
    const head = data?.slice(0, 12).toString('hex') || '';
    let extra = '';
    if (data?.length >= 11 && data[0] === 0x55) {
      extra = ` duml ${data[9].toString(16)}/${data[10].toString(16)}`;
    }
    console.log(`  ${label} notify #${packets} len=${data?.length} ${head}${extra}`);
  };
  ch.on('data', onData);

  await new Promise((resolve) => {
    let done = false;
    const finish = (why) => {
      if (done) return;
      done = true;
      console.log(`  ${label} enable: ${why}`);
      resolve();
    };
    ch.once('notify', (state) => finish(`notify event (state=${state})`));
    ch.subscribe((err) => {
      if (err) finish(`subscribe error: ${err.message}`);
      else finish('subscribe callback ok');
    });
    setTimeout(() => finish('no macOS ack — continuing anyway'), 2000);
  });

  const deadline = Date.now() + waitMs;
  while (packets === 0 && Date.now() < deadline) {
    await sleep(200);
  }

  if (packets === 0) {
    console.log(`  ${label}: no data yet — trying CCCD write…`);
    await writeCccd(ch, label);
    while (packets === 0 && Date.now() < deadline + 2000) {
      await sleep(200);
    }
  }

  return packets;
}

async function writeCccd(ch, label) {
  const norm = (u) => u.replace(/-/g, '').toLowerCase();
  const descs = await withTimeout(ch.discoverDescriptorsAsync(), 5000, 'descriptors');
  const cccd = descs.find((d) => norm(d.uuid).endsWith('2902'));
  if (!cccd) {
    console.log(`  ${label}: no CCCD descriptor`);
    return;
  }
  await cccd.writeValueAsync(Buffer.from([0x01, 0x00]));
  console.log(`  ${label}: CCCD 0x0100 written`);
}

/** Stop notify + drop listeners so noble can release the connection. */
export async function disableNotifications(ch) {
  if (!ch) return;
  ch.removeAllListeners('data');
  ch.removeAllListeners('notify');
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      ch.unsubscribe((err) => finish(err?.message || 'ok'));
    } catch {
      finish('unsubscribe threw');
    }
    setTimeout(finish, 400);
  });
}

/**
 * Full teardown — noble keeps the Node process alive unless we unsubscribe,
 * disconnect, stop scanning, and exit explicitly.
 */
export async function closeSession(peripheral, chars = {}) {
  const { fff4, fff5 } = chars;
  await disableNotifications(fff4);
  await disableNotifications(fff5);

  if (peripheral) {
    peripheral.removeAllListeners();
    if (peripheral.state === 'connected' || peripheral.state === 'connecting') {
      await peripheral.disconnectAsync().catch(() => {});
    }
  }

  await stopScanningSafe();
  noble.removeAllListeners('discover');
  noble.removeAllListeners('stateChange');
}

/** Noble teardown can hang on zombie links — never block reconnect on this. */
export async function closeSessionSafe(peripheral, chars = {}, ms = 3000) {
  try {
    await withTimeout(closeSession(peripheral, chars), ms, 'closeSession');
  } catch (err) {
    log.warn('ble', `${err.message || err} — continuing`);
  }
}

/** CLI bench scripts should always exit — noble otherwise hangs the shell. */
export function runAndExit(fn) {
  fn()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
