#!/usr/bin/env node
/**
 * Learning loop — each cycle adds to accumulated wire+vision evidence.
 * Exit when vote totals confirm opposite @2/@8 signs (not two identical cycles).
 *
 *   source .local/vision.env && npm run vision:learn
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildUnderstanding,
  formatProgress,
  ingestCycle,
  replayJsonl,
  summarize,
} from '../lib/vision-learn-model.js';
import {
  PROBES,
  bridgeApi,
  getBridgeState,
  grabFrame,
  grabFrameRetry,
  nudgeMove,
  probeMovedWire,
  sleep,
  ssimBetween,
  wait066,
  wireDelta,
  wireFromState,
  wireLine,
} from '../lib/vision-bench.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const RTSP = process.env.RTSP_URL;
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const OUT = process.env.VISION_OUT ?? path.join(ROOT, 'vision-learn');
const LOG = process.env.VISION_LEARN_LOG ?? path.join(ROOT, 'vision-learn.jsonl');
const REPORT = process.env.VISION_LEARN_REPORT ?? path.join(ROOT, 'vision-learn-report.json');
const UNDERSTANDING = process.env.VISION_REPORT ?? path.join(ROOT, 'vision-understanding.json');

const HOLD_MS = Number(process.env.LEARN_HOLD_MS ?? 4000);
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 1500);
const GRAB_TIMEOUT = Number(process.env.VISION_GRAB_TIMEOUT_SEC ?? 15);
const MAX_CYCLES = Number(process.env.LEARN_MAX_CYCLES ?? 20);
const VISUAL_MAX = Number(process.env.LEARN_VISUAL_SSIM ?? 0.98);
const CENTER_EACH_PROBE = process.env.LEARN_NO_PROBE_CENTER !== '1';
const CENTER_SETTLE_MS = Number(process.env.CENTER_SETTLE_MS ?? 5000);
const MIN_SAMPLES = Number(process.env.LEARN_MIN_SAMPLES ?? 8);
const MIN_CONFIDENCE = Number(process.env.LEARN_MIN_CONFIDENCE ?? 0.7);
const MIN_MOVE_RATE = Number(process.env.LEARN_MIN_MOVE_RATE ?? 0.55);
const REPLAY_LOG = process.env.LEARN_NO_REPLAY !== '1';
const FOCUS = process.env.LEARN_FOCUS
  ? process.env.LEARN_FOCUS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;
/** Exit 0 when this probe's primary axis hits confidence (e.g. LEARN_EXIT_PROBE=tilt+) */
const EXIT_PROBE = process.env.LEARN_EXIT_PROBE ?? null;
/** Exit 0 when goal met: panAt2 | tiltAt2 | full */
const EXIT_GOAL = process.env.LEARN_EXIT_GOAL ?? null;

const ACTIVE_PROBES = FOCUS?.length
  ? PROBES.filter((p) => FOCUS.includes(p.name))
  : PROBES;

const summarizeOpts = {
  minSamples: MIN_SAMPLES,
  minConfidence: MIN_CONFIDENCE,
  minMoveRate: MIN_MOVE_RATE,
};

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function log(row) {
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

function writeOutputs(aggregate, cycle, cyclesThisRun) {
  const summary = summarize(aggregate, summarizeOpts);
  const understanding = buildUnderstanding(aggregate, summary, { holdMs: HOLD_MS });
  understanding.cyclesThisRun = cyclesThisRun;
  understanding.latestCycle = cycle
    ? { num: cycle.cycleNum, analysis: cycle.analysis, model: cycle.model }
    : null;

  fs.writeFileSync(UNDERSTANDING, `${JSON.stringify(understanding, null, 2)}\n`);
  fs.writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        at: understanding.at,
        cyclesTotal: aggregate.cyclesTotal,
        cyclesThisRun,
        holdMs: HOLD_MS,
        ready: summary.ready,
        uncertain: summary.uncertain,
        claims: summary.claims,
        latest: cycle,
      },
      null,
      2,
    )}\n`,
  );
  return summary;
}

function exitProbeConfident(summary) {
  if (EXIT_GOAL === 'panAt2') return summary.claims.panAt2?.opposite === true;
  if (EXIT_GOAL === 'tiltAt2') return summary.claims.tiltAt2?.opposite === true;
  if (EXIT_GOAL === 'full') return summary.ready === true;
  if (!EXIT_PROBE) return false;
  if (EXIT_PROBE === 'tilt+' || EXIT_PROBE === 'tilt-') {
    return summary.claims.tiltAt2[EXIT_PROBE]?.confident === true;
  }
  if (EXIT_PROBE === 'pan+' || EXIT_PROBE === 'pan-') {
    if (process.env.LEARN_EXIT_FIELD === '@2') {
      return summary.claims.panAt2?.[EXIT_PROBE]?.confident === true;
    }
    return summary.claims.panAt8[EXIT_PROBE]?.confident === true;
  }
  return false;
}

function focusProgress(summary) {
  if (EXIT_GOAL === 'panAt2') {
    const pp = summary.claims.panAt2['pan+'];
    const pm = summary.claims.panAt2['pan-'];
    if (summary.claims.panAt2.opposite) {
      return `  ★ pan+/pan− opposite on @2 (coupling locked)`;
    }
    return `  → pan+ @2: ${pp.confident ? `sign ${pp.sign > 0 ? '+' : '−'}` : pp.reason}  pan− @2: ${pm.confident ? `sign ${pm.sign > 0 ? '+' : '−'}` : pm.reason}`;
  }
  if (!EXIT_PROBE) return '';
  const c =
    EXIT_PROBE === 'tilt+' || EXIT_PROBE === 'tilt-'
      ? summary.claims.tiltAt2[EXIT_PROBE]
      : summary.claims.panAt8[EXIT_PROBE];
  if (!c) return '';
  const field = EXIT_PROBE.startsWith('tilt') ? '@2' : '@8';
  if (c.confident) return `  ★ ${EXIT_PROBE} ${field} LOCKED sign ${c.sign > 0 ? '+' : '−'} (${(c.confidence * 100).toFixed(0)}%)`;
  const p = summary.probes[EXIT_PROBE];
  const dom = field === '@2' ? p?.dTilt : p?.dPan;
  const pct = dom ? (dom.confidence * 100).toFixed(0) : '?';
  return `  → ${EXIT_PROBE} ${field}: ${c.reason ?? '?'} (${pct}% on ${dom?.total ?? 0} wire steps)`;
}

async function runCycle(cycleNum) {
  const label = FOCUS?.length ? FOCUS.join(',') : 'all';
  console.log(`\n══ cycle ${cycleNum}  hold=${HOLD_MS}ms  probes=${label} ══`);
  await wait066(BRIDGE);

  const steps = [];
  for (const probe of ACTIVE_PROBES) {
    if (CENTER_EACH_PROBE) {
      console.log(`  → center before ${probe.name}`);
      await bridgeApi(BRIDGE, 'POST', '/center');
      await sleep(CENTER_SETTLE_MS);
      await wait066(BRIDGE);
    }

    const baselineFrame = path.join(OUT, `c${cycleNum}-${probe.name}-base.jpg`);
    await grabFrameRetry(RTSP, baselineFrame, GRAB_TIMEOUT);
    const baselineWire = wireFromState(await getBridgeState(BRIDGE));
    console.log(`  → ${probe.name} ${HOLD_MS}ms  from ${wireLine(baselineWire)}`);

    await nudgeMove(BRIDGE, probe, HOLD_MS, SETTLE_MS);
    const frame = path.join(OUT, `c${cycleNum}-${probe.name}.jpg`);
    await grabFrameRetry(RTSP, frame, GRAB_TIMEOUT);
    const wire = wireFromState(await getBridgeState(BRIDGE));
    const delta = wireDelta(baselineWire, wire);
    let visualSsim = null;
    try {
      visualSsim = ssimBetween(baselineFrame, frame);
    } catch {
      /* optional */
    }
    const row = {
      probe: probe.name,
      baseline: baselineWire,
      frame,
      wire,
      visualSsim,
      ...delta,
      wireOk: probeMovedWire({ ...delta }),
      visualOk: visualSsim == null || visualSsim < VISUAL_MAX,
    };
    steps.push(row);
    console.log(
      `     d@2=${row.dTilt} d@8=${row.dPan} SSIM=${visualSsim?.toFixed(4) ?? '?'} ${wireLine(wire)}`,
    );
    log({ cycle: cycleNum, phase: 'probe', ...row });
  }

  const tp = steps.find((s) => s.probe === 'tilt+');
  const tm = steps.find((s) => s.probe === 'tilt-');
  const pp = steps.find((s) => s.probe === 'pan+');
  const pm = steps.find((s) => s.probe === 'pan-');
  const sign = (n) => (n == null || n === 0 ? 0 : n > 0 ? 1 : -1);
  const analysis = {
    tiltOpposite:
      tp && tm && sign(tp.dTilt) && sign(tm.dTilt) && sign(tp.dTilt) !== sign(tm.dTilt),
    panOpposite:
      pp && pm && sign(pp.dPan) && sign(pm.dPan) && sign(pp.dPan) !== sign(pm.dPan),
    allMoved: steps.every((s) => s.wireOk || s.visualOk),
  };

  console.log(
    `  this cycle: tilt @2 ${analysis.tiltOpposite ? 'opposite' : '—'}  pan @8 ${analysis.panOpposite ? 'opposite' : '—'}  all moved ${analysis.allMoved ? 'yes' : '—'}`,
  );

  const model = {};
  for (const s of steps) {
    model[s.probe] = { dTilt: s.dTilt, dPan: s.dPan, visualSsim: s.visualSsim, wire: s.wire };
  }
  log({ cycle: cycleNum, phase: 'cycle', analysis, model });

  return { cycleNum, baselineWire: steps[0]?.baseline, steps, analysis, model };
}

async function main() {
  if (!RTSP) die('Set RTSP_URL');
  if ((await (await fetch(`${BRIDGE}/health/label`)).json()) !== 'OK') die('Bridge not OK');

  fs.mkdirSync(OUT, { recursive: true });
  const aggregate = REPLAY_LOG ? replayJsonl(LOG) : { version: 1, cyclesTotal: 0, probes: {} };

  console.log(`Learn loop  RTSP ${RTSP}`);
  console.log(`Bridge ${BRIDGE}  hold=${HOLD_MS}ms  center/probe=${CENTER_EACH_PROBE}`);
  if (FOCUS?.length) console.log(`Focus: ${FOCUS.join(', ')}`);
  if (EXIT_GOAL) console.log(`Drive until: ${EXIT_GOAL}`);
  else if (EXIT_PROBE) console.log(`Drive until: ${EXIT_PROBE} confident`);
  console.log(
    `Accumulate → ${UNDERSTANDING}  (need ${MIN_SAMPLES}+ wire steps, ${MIN_CONFIDENCE * 100}% sign agreement)`,
  );
  if (REPLAY_LOG && aggregate.probes['tilt+']?.n > 0) {
    console.log(`Resumed ${aggregate.cyclesTotal} prior cycles (${aggregate.probes['tilt+'].n} tilt+ rows) from ${LOG}\n`);
    const boot = summarize(aggregate, summarizeOpts);
    console.log(formatProgress(boot));
    if (boot.ready) {
      writeOutputs(aggregate, null, 0);
      console.log(`\nAlready READY from log — ${UNDERSTANDING}`);
      process.exit(0);
    }
    console.log('');
  } else {
    console.log('');
  }

  for (let c = 1; c <= MAX_CYCLES; c += 1) {
    const cycle = await runCycle(c);
    ingestCycle(aggregate, cycle);
    const summary = writeOutputs(aggregate, cycle, c);

    console.log(`\n  ── accumulated (${aggregate.cyclesTotal} cycles total) ──`);
    console.log(formatProgress(summary));
    const fp = focusProgress(summary);
    if (fp) console.log(fp);

    if (exitProbeConfident(summary)) {
      const tag = EXIT_GOAL ?? EXIT_PROBE;
      console.log(`\nDONE — ${tag} → ${UNDERSTANDING}`);
      process.exit(0);
    }
    if (summary.ready) {
      console.log(`\nDONE — full model → ${UNDERSTANDING}`);
      process.exit(0);
    }
    await sleep(1000);
  }

  const final = summarize(aggregate, summarizeOpts);
  console.log(`\nStopped after ${MAX_CYCLES} new cycles (${aggregate.cyclesTotal} total).`);
  console.log(formatProgress(final));
  console.log(`See ${UNDERSTANDING}`);
  process.exit(final.ready ? 0 : 1);
}

main().catch((err) => die(err.message || String(err)));
