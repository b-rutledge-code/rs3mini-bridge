#!/usr/bin/env node
/**
 * Scan for BLE peripherals — look for DJI RS gimbal by name.
 * Usage: npm run scan
 *
 * Prereq: System Settings → Privacy → Bluetooth → allow Terminal (or Cursor).
 */

import noble from '@abandonware/noble';
import { advertisedNameBest, advertisedNames } from '../lib/gimbal-target.js';

/** Loose filter for listing — set GIMBAL_NAME_RE to your unit suffix for the bridge. */
const LIST_NAME_RE = /rs\s*3|rs3|dji/i;
const SCAN_MS = Number(process.env.SCAN_MS || 15000);

const seen = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function note(peripheral) {
  const name = advertisedNameBest(peripheral) || '(no name)';
  const key = peripheral.id || peripheral.address;
  if (seen.has(key)) return;
  seen.set(key, true);
  const hit = advertisedNames(peripheral).some((n) => LIST_NAME_RE.test(n));
  const flag = hit ? '>>>' : '   ';
  const alt = advertisedNames(peripheral);
  const altHint =
    alt.length > 1 ? `  [also: ${alt.slice(1).join(' | ')}]` : '';
  console.log(
    `${flag} ${name.padEnd(24)} id=${peripheral.id} rssi=${peripheral.rssi}${altHint}`,
  );
}

async function waitPoweredOn() {
  if (noble.state === 'poweredOn') return;
  await new Promise((resolve, reject) => {
    const onState = (state) => {
      console.log(`Bluetooth state: ${state}`);
      if (state === 'poweredOn') {
        noble.removeListener('stateChange', onState);
        resolve();
      } else if (state === 'unauthorized') {
        noble.removeListener('stateChange', onState);
        reject(
          new Error(
            'Bluetooth unauthorized — enable Terminal in System Settings → Privacy → Bluetooth'
          )
        );
      } else if (state === 'unsupported') {
        noble.removeListener('stateChange', onState);
        reject(
          new Error(
            'Bluetooth unsupported in this environment — run from macOS Terminal (not Cursor sandbox) with Bluetooth on'
          )
        );
      }
    };
    noble.on('stateChange', onState);
  });
}

async function main() {
  await waitPoweredOn();
  console.log(
    `Scanning ${SCAN_MS / 1000}s — power on gimbal, no other BLE central connected…`
  );
  noble.on('discover', note);
  await noble.startScanningAsync([], true);
  await sleep(SCAN_MS);
  await noble.stopScanningAsync();
  noble.removeAllListeners('discover');
  noble.removeAllListeners('stateChange');

  if (!seen.size) {
    console.log('\nNo devices seen. Check gimbal power and Bluetooth permission.');
    process.exit(1);
  }
  console.log('\n>>> lines are likely RS 3 Mini. Copy the suffix from the name (after DJI RS3 MINI-)');
  console.log('  into GIMBAL_NAME_RE in /etc/rs3mini-bridge.env (e.g. GIMBAL_NAME_RE=YOURSUFFIX)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
