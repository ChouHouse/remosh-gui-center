// Small helpers shared by the session and the ops.
export function call(obj, method, ...args) {
  return new Promise((resolve, reject) => {
    obj[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

export function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(codeError(code, 'Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export const SFTP_CODES = { 2: 'not-found', 3: 'permission-denied', 4: 'failure' };

export function describeError(err) {
  let code = 'error';
  if (typeof err?.code === 'string') code = err.code;
  else if (typeof err?.code === 'number') code = SFTP_CODES[err.code] || 'failure';
  if (err?.level === 'client-authentication') code = 'auth-failed';
  else if (err?.level === 'client-timeout') code = 'connect-timeout';
  else if (err?.level === 'client-socket' && code === 'error') code = 'connect-failed';
  const out = { code, message: String(err?.message || err) };
  if (err?.fingerprint) out.fingerprint = err.fingerprint;
  return out;
}

export function reqPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw codeError('bad-request', 'Invalid path');
  return p;
}

export function joinPath(dir, name) {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

export function baseName(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

export function typeOf(attrs) {
  switch (attrs.mode & 0o170000) {
    case 0o040000:
      return 'dir';
    case 0o100000:
      return 'file';
    case 0o120000:
      return 'link';
    default:
      return 'other';
  }
}

export function entry(name, attrs) {
  return { name, type: typeOf(attrs), size: attrs.size, mtime: attrs.mtime, mode: attrs.mode & 0o7777, uid: attrs.uid, gid: attrs.gid };
}

export function hostAllowed(list, host, port) {
  const items = String(list || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length) return true;
  const h = host.toLowerCase();
  return items.includes(h) || items.includes(`${h}:${port}`);
}

// Loopback, RFC 1918, link-local, CGNAT and unique-local addresses, plus names
// that only resolve inside a LAN.
export function isPrivateHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}
