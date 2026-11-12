// Small helpers shared by the session and the ops.
export function call(obj, method, ...args) {
  return new Promise((resolve, reject) => {
    obj[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
  });
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
