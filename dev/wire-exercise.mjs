#!/usr/bin/env node
/**
 * Exercise bridge endpoints while WIRE_LOG captures fff4/fff5 hex.
 * Usage: BASE_URL=http://127.0.0.1:8787 node dev/wire-exercise.mjs
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

async function req(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 240)}`);
  }
  return json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitOk(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const label = await req('GET', '/health/label');
      const motor = await req('GET', '/motor').catch(() => ({}));
      const state = await req('GET', '/state').catch(() => ({}));
      console.log(
        `  label=${JSON.stringify(label)} motor=${JSON.stringify(motor)} connected=${state?.connected ?? state?.ble?.connected ?? '?'}`,
      );
      if (label === 'OK' || label === 'ASLEEP') return { label, motor, state };
      if (typeof label === 'string' && label.includes('OK')) return { label, motor, state };
    } catch (e) {
      console.log(`  wait: ${e.message}`);
    }
    await sleep(2000);
  }
  throw new Error('timed out waiting for /health/label OK or ASLEEP');
}

async function phase(name, fn) {
  console.log(`\n=== ${name} ===`);
  await fn();
  await sleep(400);
}

async function main() {
  console.log(`wire-exercise → ${BASE}`);
  const start = await waitOk();

  if (start.label === 'ASLEEP' || start.motor?.state === 'ASLEEP' || start.motor?.label === 'ASLEEP') {
    await phase('wake (was asleep)', async () => {
      await req('POST', '/wake');
      await sleep(1000);
      await waitOk(30000);
    });
  }

  // Connect/startup guards may still be active on fresh boot — wait them out.
  console.log('\n=== settle guards (8s) ===');
  await sleep(8000);

  await phase('hold tilt+ 1.5s', async () => {
    await req('POST', '/move/hold', { pan: 0, tilt: 1 });
    await sleep(1500);
    await req('POST', '/move/stop');
  });

  await phase('hold pan- 1.2s', async () => {
    await req('POST', '/move/hold', { pan: -1, tilt: 0 });
    await sleep(1200);
    await req('POST', '/move/stop');
  });

  await phase('nudge tilt- (short hold)', async () => {
    await req('POST', '/move/hold', { pan: 0, tilt: -1 });
    await sleep(120);
    await req('POST', '/move/stop');
  });

  await phase('center', async () => {
    await req('POST', '/center');
    await sleep(3000);
  });

  await phase('sleep', async () => {
    await req('POST', '/sleep');
    await sleep(1500);
  });

  await phase('wake again', async () => {
    await req('POST', '/wake');
    await sleep(2000);
  });

  console.log('\n=== done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
