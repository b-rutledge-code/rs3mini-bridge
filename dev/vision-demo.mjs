#!/usr/bin/env node
/** Visible axis demo — 4s hold each direction, before/after frames. No /center. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROBES,
  getBridgeState,
  grabFrame,
  nudgeMove,
  sleep,
  ssimBetween,
  wait066,
  wireDelta,
  wireFromState,
  wireLine,
} from '../lib/vision-bench.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RTSP = process.env.RTSP_URL;
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const OUT = path.join(ROOT, 'proof-demo');
const HOLD_MS = Number(process.env.DEMO_HOLD_MS ?? 4000);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 1500);

async function main() {
  if (!RTSP) throw new Error('Set RTSP_URL');
  if ((await (await fetch(`${BRIDGE}/health/label`)).json()) !== 'OK') {
    throw new Error('Bridge not OK — power-cycle gimbal or reboot Pi');
  }
  fs.mkdirSync(OUT, { recursive: true });
  await wait066(BRIDGE);

  const baselineFrame = path.join(OUT, '00-start.jpg');
  grabFrame(RTSP, baselineFrame);
  const baselineWire = wireFromState(await getBridgeState(BRIDGE));
  console.log(`START ${wireLine(baselineWire)}`);
  console.log(`Watch Larix — ${HOLD_MS / 1000}s per direction\n`);

  for (const probe of PROBES) {
    console.log(`>>> ${probe.name.toUpperCase()} ${HOLD_MS}ms <<<`);
    await sleep(1000);
    await nudgeMove(BRIDGE, probe, HOLD_MS, SETTLE_MS);
    const frame = path.join(OUT, `${probe.name}.jpg`);
    grabFrame(RTSP, frame);
    const wire = wireFromState(await getBridgeState(BRIDGE));
    const d = wireDelta(baselineWire, wire);
    const ssim = ssimBetween(baselineFrame, frame);
    console.log(`  ${wireLine(wire)}  d@2=${d.dTilt} d@8=${d.dPan}  SSIM=${ssim.toFixed(3)}`);
    console.log(`  → ${frame}\n`);
    await sleep(2000);
  }

  console.log('Demo done. Frames in proof-demo/');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
