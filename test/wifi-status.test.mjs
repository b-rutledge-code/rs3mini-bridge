import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIwLink, parseNmcliDevice } from '../lib/wifi-status.js';

test('parseIwLink: not connected', () => {
  const s = parseIwLink('Not connected.');
  assert.equal(s.connected, false);
  assert.equal(s.ssid, null);
  assert.equal(s.bssid, null);
});

test('parseIwLink: connected reports ssid, signal, bssid', () => {
  const sample = [
    'Connected to aa:bb:cc:dd:ee:ff (on wlan0)',
    '\tSSID: OTHER-SSID',
    '\tfreq: 5200',
    '\tsignal: -54 dBm',
    '\ttx bitrate: 390.0 MBit/s',
  ].join('\n');
  const s = parseIwLink(sample);
  assert.equal(s.connected, true);
  assert.equal(s.ssid, 'OTHER-SSID');
  assert.equal(s.signalDbm, -54);
  assert.equal(s.bssid, 'aa:bb:cc:dd:ee:ff');
});

test('parseNmcliDevice: connected', () => {
  const sample = [
    'GENERAL.STATE:100 (connected)',
    '802-11-WIRELESS.SSID:TEST-SSID',
    'WIFI-PROPERTIES.SIGNAL:72',
  ].join('\n');
  const s = parseNmcliDevice(sample);
  assert.equal(s.connected, true);
  assert.equal(s.ssid, 'TEST-SSID');
  assert.equal(s.signalPct, 72);
});

test('parseNmcliDevice: disconnected has no ssid', () => {
  const sample = ['GENERAL.STATE:30 (disconnected)', '802-11-WIRELESS.SSID:'].join('\n');
  const s = parseNmcliDevice(sample);
  assert.equal(s.connected, false);
  assert.equal(s.ssid, null);
});
