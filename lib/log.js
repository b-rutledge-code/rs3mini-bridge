/** Bridge logging — LOG_LEVEL=info (default) | debug */

const ORDER = ['debug', 'info', 'warn', 'error'];
const minLevel = ORDER.includes(process.env.LOG_LEVEL?.toLowerCase())
  ? process.env.LOG_LEVEL.toLowerCase()
  : 'info';

function enabled(severity) {
  return ORDER.indexOf(severity) >= ORDER.indexOf(minLevel);
}

function stamp() {
  return new Date().toISOString();
}

function write(severity, tag, message) {
  if (!enabled(severity)) return;
  const line = `${stamp()} [${tag}] ${message}`;
  if (severity === 'error') console.error(line);
  else if (severity === 'warn') console.warn(line);
  else console.log(line);
}

export function isDebug() {
  return enabled('debug');
}

/** Client IP — trust X-Forwarded-For only on LAN bench; use first hop. */
export function clientIp(req) {
  const fwd = req.get('X-Forwarded-For');
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress?.replace(/^::ffff:/, '') || '?';
}

export const log = {
  debug: (tag, message) => write('debug', tag, message),
  info: (tag, message) => write('info', tag, message),
  warn: (tag, message) => write('warn', tag, message),
  error: (tag, message) => write('error', tag, message),
};
