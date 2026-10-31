/**
 * Incremental vision+wire learning — aggregate probe rows across cycles/runs.
 */

import fs from 'node:fs';

export const PROBE_NAMES = ['tilt+', 'tilt-', 'pan+', 'pan-'];

function sign(n) {
  if (n == null || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

function voteKey(s) {
  return String(s);
}

function emptyProbeStats() {
  return {
    n: 0,
    moved: 0,
    wireOk: 0,
    visualOk: 0,
    subRung: 0,
    dTiltVotes: { '-1': 0, '0': 0, '1': 0 },
    dPanVotes: { '-1': 0, '0': 0, '1': 0 },
  };
}

export function emptyLearnModel() {
  return {
    version: 1,
    cyclesTotal: 0,
    probes: Object.fromEntries(PROBE_NAMES.map((p) => [p, emptyProbeStats()])),
  };
}

/** One probe row from vision-learn (after hold). */
export function ingestProbe(model, row) {
  const name = row.probe;
  if (!model.probes[name]) return model;
  const s = model.probes[name];
  s.n += 1;
  const moved = Boolean(row.wireOk || row.visualOk);
  if (moved) s.moved += 1;
  if (row.wireOk) s.wireOk += 1;
  if (row.visualOk) s.visualOk += 1;
  const st = sign(row.dTilt);
  const sp = sign(row.dPan);
  if (st !== 0) s.dTiltVotes[voteKey(st)] += 1;
  else if (moved) s.subRung += 1;
  if (sp !== 0) s.dPanVotes[voteKey(sp)] += 1;
  return model;
}

export function ingestCycle(model, cycle) {
  for (const step of cycle.steps ?? []) ingestProbe(model, step);
  model.cyclesTotal += 1;
  return model;
}

function dominant(votes, { ignoreZero = true } = {}) {
  let best = 0;
  let count = 0;
  let total = 0;
  for (const [k, v] of Object.entries(votes)) {
    if (ignoreZero && k === '0') continue;
    total += v;
    if (v > count) {
      count = v;
      best = Number(k);
    }
  }
  const confidence = total ? count / total : 0;
  return { sign: total ? best : 0, count, total, confidence };
}

function probeSummary(stats) {
  const dTilt = dominant(stats.dTiltVotes);
  const dPan = dominant(stats.dPanVotes);
  const moveRate = stats.n ? stats.moved / stats.n : 0;
  return {
    n: stats.n,
    moved: stats.moved,
    moveRate,
    wireOk: stats.wireOk,
    visualOk: stats.visualOk,
    subRung: stats.subRung,
    dTilt: {
      sign: dTilt.sign,
      confidence: dTilt.confidence,
      total: dTilt.total,
      votes: { ...stats.dTiltVotes },
    },
    dPan: {
      sign: dPan.sign,
      confidence: dPan.confidence,
      total: dPan.total,
      votes: { ...stats.dPanVotes },
    },
  };
}

/**
 * @param {object} opts
 * @param {number} opts.minSamples — min probe rows before a sign claim counts
 * @param {number} opts.minConfidence — dominant sign fraction among non-zero votes (or all votes for moved)
 * @param {number} opts.minMoveRate — fraction of rows where wire or vision moved
 */
export function summarize(model, opts = {}) {
  const minSamples = opts.minSamples ?? 8;
  const minConfidence = opts.minConfidence ?? 0.7;
  const minMoveRate = opts.minMoveRate ?? 0.55;

  const probes = {};
  for (const name of PROBE_NAMES) {
    probes[name] = probeSummary(model.probes[name]);
  }

  function signConfident(stats, field) {
    if (stats.n < minSamples) return { confident: false, reason: 'need more samples' };
    if (stats.moveRate < minMoveRate) return { confident: false, reason: 'low move rate' };
    const dom = field === 'dTilt' ? stats.dTilt : stats.dPan;
    if (dom.total < minSamples) return { confident: false, reason: 'need more non-zero wire steps' };
    if (dom.sign === 0) return { confident: false, reason: 'no wire sign yet' };
    if (dom.confidence < minConfidence) return { confident: false, reason: 'split votes' };
    return { confident: true, sign: dom.sign, confidence: dom.confidence };
  }

  const tiltPlus = signConfident(probes['tilt+'], 'dTilt');
  const tiltMinus = signConfident(probes['tilt-'], 'dTilt');
  const panPlus = signConfident(probes['pan+'], 'dPan');
  const panMinus = signConfident(probes['pan-'], 'dPan');
  const panPlusAt2 = signConfident(probes['pan+'], 'dTilt');
  const panMinusAt2 = signConfident(probes['pan-'], 'dTilt');

  const tiltOpposite =
    tiltPlus.confident &&
    tiltMinus.confident &&
    tiltPlus.sign !== tiltMinus.sign;
  const panOpposite =
    panPlus.confident && panMinus.confident && panPlus.sign !== panMinus.sign;
  const panAt2Opposite =
    panPlusAt2.confident &&
    panMinusAt2.confident &&
    panPlusAt2.sign !== panMinusAt2.sign;

  const uncertain = [];
  if (!tiltPlus.confident) uncertain.push('tilt+ @2');
  if (!tiltMinus.confident) uncertain.push('tilt- @2');
  if (!panPlus.confident) uncertain.push('pan+ @8');
  if (!panMinus.confident) uncertain.push('pan- @8');
  if (!panPlusAt2.confident) uncertain.push('pan+ @2 (coupling)');
  if (!panMinusAt2.confident) uncertain.push('pan- @2 (coupling)');

  const coupling = [];
  for (const name of ['tilt+', 'tilt-']) {
    const p = probes[name];
    if (p.n >= minSamples && p.dPan.sign !== 0 && p.dPan.confidence >= 0.5) {
      coupling.push(`${name} moves @8 (sign ${p.dPan.sign})`);
    }
  }
  for (const name of ['pan+', 'pan-']) {
    const p = probes[name];
    if (p.n >= minSamples && p.dTilt.sign !== 0 && p.dTilt.confidence >= 0.5) {
      coupling.push(`${name} moves @2 (sign ${p.dTilt.sign})`);
    }
  }

  const ready = tiltOpposite && panOpposite;

  return {
    probes,
    claims: {
      tiltAt2: {
        'tilt+': tiltPlus,
        'tilt-': tiltMinus,
        opposite: tiltOpposite,
      },
      panAt8: {
        'pan+': panPlus,
        'pan-': panMinus,
        opposite: panOpposite,
      },
      panAt2: {
        'pan+': panPlusAt2,
        'pan-': panMinusAt2,
        opposite: panAt2Opposite,
      },
      coupling,
    },
    uncertain,
    ready,
    thresholds: { minSamples, minConfidence, minMoveRate },
  };
}

export function formatProgress(summary) {
  const lines = [];
  const fmt = (name, field, dom) => {
    const p = summary.probes[name];
    const d = field === '@2' ? p.dTilt : p.dPan;
    const tag = d.confidence >= 0.7 && d.sign !== 0 ? `${d.sign > 0 ? '+' : '−'}` : '?';
    return `${name} ${field}→${tag} (${p.moved}/${p.n} moved)`;
  };
  lines.push(
    [
      fmt('tilt+', '@2', null),
      fmt('tilt-', '@2', null),
      fmt('pan+', '@8', null),
      fmt('pan-', '@8', null),
    ].join('  '),
  );
  if (summary.uncertain.length) lines.push(`  still uncertain: ${summary.uncertain.join(', ')}`);
  if (summary.claims.coupling.length) {
    lines.push(`  coupling: ${summary.claims.coupling.slice(0, 2).join('; ')}`);
  }
  if (summary.ready) lines.push('  READY — opposite signs confirmed on @2 and @8');
  return lines.join('\n');
}

export function buildUnderstanding(model, summary, meta = {}) {
  return {
    at: new Date().toISOString(),
    cyclesTotal: model.cyclesTotal,
    holdMs: meta.holdMs ?? null,
    ...summary,
    notes: [
      'tiltDeg/panDeg are wire/10 — not field aim',
      'moved = wireOk OR visualOk (SSIM below threshold)',
      'signs learned from accumulated votes, not one perfect cycle',
    ],
  };
}

export function loadLearnModel(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return emptyLearnModel();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw.probes?.['tilt+']?.dTiltVotes) {
      return {
        version: 1,
        cyclesTotal: raw.cyclesTotal ?? 0,
        probes: raw.probes,
      };
    }
    if (raw.probes?.['tilt+']?.n != null && raw.probes['tilt+'].dTilt?.votes) {
      return rebuildFromUnderstanding(raw);
    }
  } catch {
    /* fall through */
  }
  return emptyLearnModel();
}

function rebuildFromUnderstanding(doc) {
  const model = emptyLearnModel();
  model.cyclesTotal = doc.cyclesTotal ?? 0;
  for (const name of PROBE_NAMES) {
    const p = doc.probes?.[name];
    if (!p) continue;
    model.probes[name] = {
      n: p.n ?? 0,
      moved: p.moved ?? 0,
      wireOk: p.wireOk ?? 0,
      visualOk: p.visualOk ?? 0,
      subRung: p.subRung ?? 0,
      dTiltVotes: p.dTilt?.votes ?? { '-1': 0, '0': 0, '1': 0 },
      dPanVotes: p.dPan?.votes ?? { '-1': 0, '0': 0, '1': 0 },
    };
  }
  return model;
}

/** Replay vision-learn.jsonl probe rows into a fresh aggregate. */
export function replayJsonl(filePath) {
  const model = emptyLearnModel();
  if (!filePath || !fs.existsSync(filePath)) return model;
  const seenCycles = new Set();
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.phase !== 'probe' || !row.probe) continue;
    ingestProbe(model, row);
    if (row.cycle) seenCycles.add(row.cycle);
  }
  model.cyclesTotal = seenCycles.size;
  return model;
}

export function mergeModels(a, b) {
  const out = emptyLearnModel();
  out.cyclesTotal = (a.cyclesTotal ?? 0) + (b.cyclesTotal ?? 0);
  for (const name of PROBE_NAMES) {
    const sa = a.probes[name];
    const sb = b.probes[name];
    out.probes[name] = {
      n: sa.n + sb.n,
      moved: sa.moved + sb.moved,
      wireOk: sa.wireOk + sb.wireOk,
      visualOk: sa.visualOk + sb.visualOk,
      subRung: sa.subRung + sb.subRung,
      dTiltVotes: {
        '-1': sa.dTiltVotes['-1'] + sb.dTiltVotes['-1'],
        '0': sa.dTiltVotes['0'] + sb.dTiltVotes['0'],
        '1': sa.dTiltVotes['1'] + sb.dTiltVotes['1'],
      },
      dPanVotes: {
        '-1': sa.dPanVotes['-1'] + sb.dPanVotes['-1'],
        '0': sa.dPanVotes['0'] + sb.dPanVotes['0'],
        '1': sa.dPanVotes['1'] + sb.dPanVotes['1'],
      },
    };
  }
  return out;
}
