/**
 * Parse GIMBAL_NAME_RE — unit suffix from gimbal LCD or DJI app (e.g. YOURSUFFIX).
 * Gimbal advertises as DJI RS3 MINI-<suffix>. Bridge always scans; this filters ads.
 */
export function parseGimbalNameRe(raw) {
  const s = raw?.trim();
  if (!s) return null;
  if (s === '0' || /^off|false$/i.test(s)) return null;
  if (s.startsWith('/') && s.lastIndexOf('/') > 0) {
    const end = s.lastIndexOf('/');
    return new RegExp(s.slice(1, end), s.slice(end + 1));
  }
  return new RegExp(s, 'i');
}

/** Runtime discovery target from env — BLE advertised name match only. */
export function buildGimbalTarget(env = process.env) {
  const nameRe = parseGimbalNameRe(env.GIMBAL_NAME_RE);
  return { nameRe };
}

export function hasGimbalTarget(target) {
  return Boolean(target?.nameRe);
}

/** Human-readable target for logs and scan timeout errors. */
export function gimbalTargetLabel(target) {
  if (target?.nameRe) return `name~${target.nameRe}`;
  return '(unset — set GIMBAL_NAME_RE)';
}

/**
 * BLE may send a truncated localName and the full suffix in localNameComplete.
 * Test both; prefer complete for display.
 */
export function advertisedNames(peripheral) {
  const ad = peripheral?.advertisement;
  if (!ad) return [];
  const out = [];
  if (ad.localNameComplete) out.push(ad.localNameComplete);
  if (ad.localName && ad.localName !== ad.localNameComplete) out.push(ad.localName);
  return out;
}

export function advertisedNameBest(peripheral) {
  return advertisedNames(peripheral)[0] || '';
}

export function matchesAdvertisedName(peripheral, nameRe) {
  if (!nameRe) return false;
  return advertisedNames(peripheral).some((n) => nameRe.test(n));
}
