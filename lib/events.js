/** In-memory ring buffer — last N operator-relevant events (no notify spam). */

const MAX_EVENTS = 20;
const events = [];

/**
 * @param {string} kind — connect | disconnect | move | stop | center | reconnect | guard | watchdog | error | boot | wifi
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 */
export function pushEvent(kind, message, detail) {
  const entry = {
    ts: new Date().toISOString(),
    kind,
    message,
    ...(detail && Object.keys(detail).length ? { detail } : {}),
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) events.shift();
}

/** Newest first. */
export function getEvents() {
  return [...events].reverse();
}

/** @internal test helper */
export function _clearEventsForTest() {
  events.length = 0;
}
