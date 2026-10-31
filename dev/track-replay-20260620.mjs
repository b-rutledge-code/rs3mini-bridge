#!/usr/bin/env node
/**
 * Replay the 5 Preview blobs from btsnoop_track-20260620.log (2026-06-20 capture).
 *
 *   # Pi bridge (Ronin closed):
 *   BRIDGE_URL=http://<bridge-host>:8787 npm run track:replay-capture
 *
 *   # Direct BLE on Mac (stop rs3mini-bridge on Pi first):
 *   GIMBAL_NAME_RE=YOURSUFFIX npm run track:replay-capture -- --ble
 *
 * Env: TRACK_PAUSE_MS (default 8000 between previews), TRACK_FOLLOW_MS (default 22000)
 */

import { decode062Path } from '../lib/gimbal-waypoint.js';

/** First 22 bytes of each 0x62 payload (44 hex chars). */
export const TRACK_20260620_PREVIEWS = [
  {
    id: 1,
    hex: '0a02000014000000020000001400140000004900ee00',
    note: 'wp0≈center (0.2°,0°) → wp1 (7.3°,23.8°)',
  },
  {
    id: 2,
    hex: '0a020000140000007000dd001400140000007700ec00',
    note: 'wp0 (11.2°,22.1°) → wp1 (11.9°,23.6°)',
  },
  {
    id: 3,
    hex: '0a0200001400000022001a011400140000002b002701',
    note: 'wp0 (3.4°,28.2°) → wp1 (4.3°,29.5°)',
  },
  {
    id: 4,
    hex: '0a020000140000003300a70014001400000071007300',
    note: 'wp0 (5.1°,16.7°) → wp1 (11.3°,11.5°)',
  },
  {
    id: 5,
    hex: '0a02000014000000330038001400140000004d001600',
    note: 'wp0 (5.1°,5.6°) → wp1 (7.7°,2.2°)',
  },
];

const PAUSE_MS = Number(process.env.TRACK_PAUSE_MS ?? 8000);
const FOLLOW_MS = Number(process.env.TRACK_FOLLOW_MS ?? 22000);
const POLL_MS = Number(process.env.TRACK_POLL_MS ?? 4000);
const PRE_POLLS = Number(process.env.TRACK_PRE_POLLS ?? 3);
const TIMEOUT_MS = Number(process.env.TRACK_HTTP_TIMEOUT_MS ?? 120000);
const useBle = process.argv.includes('--ble');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function replayHttp(bridge, hex) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${bridge}/track/replay`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payloadHex: hex,
        followMs: FOLLOW_MS,
        pollMs: POLL_MS,
        prePolls: PRE_POLLS,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

async function replayBle(hex) {
  process.env.CONNECT_GUARD_MS = process.env.CONNECT_GUARD_MS ?? '0';
  process.env.STARTUP_GUARD_MS = process.env.STARTUP_GUARD_MS ?? '0';
  const { buildGimbalTarget, hasGimbalTarget, gimbalTargetLabel } = await import('../lib/gimbal-target.js');
  const gimbal = await import('../lib/gimbal-session.js');
  const target = buildGimbalTarget();
  if (!hasGimbalTarget(target)) {
    throw new Error('Set GIMBAL_NAME_RE (e.g. YOURSUFFIX) for --ble mode');
  }
  await gimbal.connectGimbal(target);
  const payload = Buffer.from(hex, 'hex');
  await gimbal.replayTrackPath(target, {
    payload,
    pollMs: POLL_MS,
    prePolls: PRE_POLLS,
    followMs: FOLLOW_MS,
  });
  gimbal.stopReconnectLoop();
  await gimbal.shutdownSession();
}

async function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(Number).filter(Boolean);
  const previews = ids.length
    ? TRACK_20260620_PREVIEWS.filter((p) => ids.includes(p.id))
    : TRACK_20260620_PREVIEWS;
  if (!previews.length) {
    throw new Error('usage: track:replay-capture [--ble] [1] [2] … (default: all 5)');
  }

  const bridge = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
  if (!useBle) {
    const health = await fetch(`${bridge}/health/label`).catch(() => null);
    if (!health?.ok) {
      throw new Error(`Bridge not reachable at ${bridge} — start Pi service or use --ble with GIMBAL_NAME_RE`);
    }
    const label = await health.text();
    console.log(`Bridge ${bridge} → ${label}\n`);
  } else {
    console.log('Direct BLE replay (--ble)\n');
  }

  console.log(`${previews.length} preview(s) · pause ${PAUSE_MS}ms · follow ${FOLLOW_MS}ms\n`);

  for (let i = 0; i < previews.length; i += 1) {
    const preview = previews[i];
    const decoded = decode062Path(preview.hex);
    console.log(`\n========== PREVIEW ${preview.id} ==========`);
    console.log(preview.note);
    console.log(
      `  wp0 pitch=${decoded.waypoints[0].pitch} yaw=${decoded.waypoints[0].yaw}`,
    );
    console.log(
      `  wp1 pitch=${decoded.waypoints[1].pitch} yaw=${decoded.waypoints[1].yaw}`,
    );
    console.log(`  hex: ${preview.hex}`);
    console.log(`Starting in 5s…`);
    await sleep(5000);

    if (useBle) {
      await replayBle(preview.hex);
    } else {
      const body = await replayHttp(bridge, preview.hex);
      console.log(`  replay ok: ${body.slice(0, 120)}`);
    }
    console.log(`PREVIEW ${preview.id} done — tell me what you saw.\n`);
    if (i < previews.length - 1) {
      console.log(`Pause ${PAUSE_MS / 1000}s before next…`);
      await sleep(PAUSE_MS);
    }
  }

  console.log(`\nDone — ${previews.length} replay(s) sent.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
