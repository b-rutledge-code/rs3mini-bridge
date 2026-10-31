import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyLearnModel,
  ingestProbe,
  replayJsonl,
  summarize,
} from '../lib/vision-learn-model.js';

test('ingestProbe accumulates sign votes', () => {
  const m = emptyLearnModel();
  ingestProbe(m, {
    probe: 'tilt+',
    dTilt: -256,
    dPan: 0,
    wireOk: true,
    visualOk: true,
  });
  ingestProbe(m, {
    probe: 'tilt+',
    dTilt: -512,
    dPan: 0,
    wireOk: true,
    visualOk: true,
  });
  assert.equal(m.probes['tilt+'].n, 2);
  assert.equal(m.probes['tilt+'].dTiltVotes['-1'], 2);
  const s = summarize(m, { minSamples: 2, minConfidence: 0.7, minMoveRate: 0.5 });
  assert.equal(s.claims.tiltAt2['tilt+'].confident, true);
  assert.equal(s.claims.tiltAt2['tilt+'].sign, -1);
});

test('ready when tilt and pan opposites confident', () => {
  const m = emptyLearnModel();
  const rows = [
    ['tilt+', -256, 0],
    ['tilt+', -512, 0],
    ['tilt+', -256, 256],
    ['tilt-', 256, 0],
    ['tilt-', 512, 0],
    ['tilt-', 256, 256],
    ['pan+', 0, 512],
    ['pan+', 256, 512],
    ['pan+', 0, 256],
    ['pan-', 0, -256],
    ['pan-', 0, -512],
    ['pan-', 0, -256],
    ['pan-', 256, -512],
  ];
  for (const [probe, dTilt, dPan] of rows) {
    ingestProbe(m, { probe, dTilt, dPan, wireOk: true, visualOk: true });
  }
  m.cyclesTotal = 3;
  const s = summarize(m, { minSamples: 3, minConfidence: 0.65, minMoveRate: 0.5 });
  assert.equal(s.claims.tiltAt2.opposite, true);
  assert.equal(s.claims.panAt8.opposite, true);
  assert.equal(s.ready, true);
});

test('replayJsonl reads probe phases', () => {
  const m = replayJsonl(new URL('../vision-learn.jsonl', import.meta.url).pathname);
  assert.ok(m.probes['tilt+'].n > 0, 'expected tilt+ rows in vision-learn.jsonl');
});
