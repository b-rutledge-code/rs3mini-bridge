/**
 * Operator vocabulary → bridge /move/hold signs.
 * "tilt up" = front/nose up = bridge tilt+1; "tilt down" = nose down = tilt-1.
 */

export const TRIM = {
  down: { pan: 0, tilt: -1, label: 'tilt- (nose down)' },
  up: { pan: 0, tilt: 1, label: 'tilt+ (nose up)' },
  left: { pan: -1, tilt: 0, label: 'pan- (frame left)' },
  right: { pan: 1, tilt: 0, label: 'pan+ (frame right)' },
};

export function parseTrimArgs(argv) {
  const dir = String(argv[2] ?? '').toLowerCase();
  const sec = Number(argv[3] ?? process.env.TRIM_SEC ?? 2);
  const move = TRIM[dir];
  if (!move) {
    throw new Error(`usage: calib:trim <down|up|left|right> [seconds] — got ${dir || '(none)'}`);
  }
  if (!Number.isFinite(sec) || sec <= 0 || sec > 10) {
    throw new Error('seconds must be 0–10');
  }
  return { ...move, sec };
}
