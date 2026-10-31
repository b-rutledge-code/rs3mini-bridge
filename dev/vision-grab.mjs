#!/usr/bin/env node
/**
 * Grab one JPEG from Larix RTSP (or any RTSP URL).
 *   RTSP_URL=rtsp://10.0.x.x:8554/live npm run vision:grab
 *   RTSP_URL=... OUT=reference.jpg npm run vision:grab
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RTSP = process.env.RTSP_URL;
const OUT = process.env.OUT ?? path.join(ROOT, 'vision-current.jpg');
const TIMEOUT_SEC = Number(process.env.VISION_GRAB_TIMEOUT_SEC ?? 15);

if (!RTSP) {
  console.error('Set RTSP_URL — Larix shows it when streaming (Remote access / Connection).');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });

try {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-rtsp_transport',
      'tcp',
      '-timeout',
      String(TIMEOUT_SEC * 1_000_000),
      '-i',
      RTSP,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-y',
      OUT,
    ],
    { stdio: 'inherit', timeout: (TIMEOUT_SEC + 5) * 1000 },
  );
} catch (err) {
  console.error('\nGrab failed. Check: Larix streaming, same Wi‑Fi, RTSP URL, ffmpeg.');
  process.exit(1);
}

console.log(`→ ${OUT}`);
