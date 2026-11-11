// ssh-desk Worker
//
// The browser opens one WebSocket to /ws. For that WebSocket the Worker opens a
// TCP socket to the SSH server, logs in with the supplied password, starts an
// SFTP session and then answers small JSON requests (list / read / write ...).
// Nothing is stored: the password lives only in memory for the login.

import { connect } from 'cloudflare:sockets';
import { Duplex } from 'node:stream';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import ssh2 from 'ssh2';

const { Client, utils } = ssh2;

const MAX_KEY_CHARS = 32 * 1024;

const MAX_FILE_BYTES = 5 * 1024 * 1024; // largest file the editor will load/save
const CONNECT_TIMEOUT_MS = 20000;

// workerd's node:crypto cannot run ssh2's AEAD paths (AES-GCM needs the auth
// tag before update(); chacha20-poly1305 needs the native addon), so negotiate
// AES-CTR + HMAC-SHA2, which every OpenSSH server offers by default.
const ALGORITHMS = {
  cipher: ['aes256-ctr', 'aes192-ctr', 'aes128-ctr'],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ],
  compress: ['none'],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket', { status: 426 });
      }
      // Only pages served by this same Worker may open the socket.
      const origin = request.headers.get('Origin');
      if (origin && new URL(origin).host !== url.host) {
        return new Response('Forbidden origin', { status: 403 });
      }
      const pair = new WebSocketPair();
      pair[1].accept();
      new Session(pair[1], env);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return env.ASSETS.fetch(request);
  },
};

class Session {
  constructor(ws, env) {
    this.ws = ws;
    this.env = env;
    this.client = null;
    this.sftp = null;
    this.busy = false;
    ws.addEventListener('message', (ev) => this.onMessage(ev));
    ws.addEventListener('close', () => this.dispose());
    ws.addEventListener('error', () => this.dispose());
  }

  send(obj) {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* socket already closed */
    }
  }

  dispose() {
    try {
      this.client?.end();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.sftp = null;
  }

  async onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    } catch {
      return this.send({ error: { code: 'bad-request', message: 'Invalid JSON' } });
    }
    const { id, op } = msg;
    try {
      const result = await this.handle(op, msg);
      this.send({ id, ok: true, ...result });
    } catch (err) {
      this.send({ id, ok: false, error: describeError(err) });
    }
  }

  async handle(op, msg) {
    if (op === 'ping') return {};
    if (op === 'connect') return this.login(msg);
    if (!this.sftp) throw codeError('not-connected', 'Not connected');
    const sftp = this.sftp;
    switch (op) {
      case 'realpath':
        return { path: await call(sftp, 'realpath', reqPath(msg.path || '.')) };
      case 'list': {
        const path = reqPath(msg.path);
        const items = await call(sftp, 'readdir', path);
        const entries = await Promise.all(
          items.map(async (it) => {
            const e = entry(it.filename, it.attrs);
            if (e.type === 'link') {
              // Resolve what a symlink points at so the UI can open it.
              try {
                const target = await call(sftp, 'stat', joinPath(path, it.filename));
                e.targetType = typeOf(target);
                if (e.targetType === 'file') e.size = target.size;
              } catch {
                e.targetType = 'broken';
              }
            }
            return e;
          }),
        );
        return { path, entries };
      }
      case 'stat': {
        const path = reqPath(msg.path);
        return { entry: entry(baseName(path), await call(sftp, 'stat', path)) };
      }
      case 'read': {
        const path = reqPath(msg.path);
        const st = await call(sftp, 'stat', path);
        if (typeOf(st) !== 'file') throw codeError('not-a-file', 'Not a regular file');
        if (st.size > MAX_FILE_BYTES) {
          throw codeError('too-large', `File is larger than ${MAX_FILE_BYTES} bytes`);
        }
        const buf = await call(sftp, 'readFile', path);
        return { path, size: buf.length, mtime: st.mtime, mode: st.mode, data: buf.toString('base64') };
      }
      case 'write': {
        const path = reqPath(msg.path);
        if (typeof msg.data !== 'string') throw codeError('bad-request', 'Missing data');
        const buf = Buffer.from(msg.data, 'base64');
        if (buf.length > MAX_FILE_BYTES) throw codeError('too-large', 'File too large');
        // Optional lost-update guard: refuse when the file changed on the server
        // since the editor loaded it, unless the client says to overwrite.
        if (msg.expectMtime != null && !msg.force) {
          try {
            const cur = await call(sftp, 'stat', path);
            if (cur.mtime !== msg.expectMtime) {
              throw codeError('changed-on-server', 'File changed on the server');
            }
          } catch (e) {
            if (e.code === 'changed-on-server') throw e;
            /* file vanished: fall through and recreate it */
          }
        }
        await call(sftp, 'writeFile', path, buf);
        const st = await call(sftp, 'stat', path);
        return { path, size: st.size, mtime: st.mtime };
      }
      default:
        throw codeError('bad-request', `Unknown op: ${op}`);
    }
  }

  async login(msg) {
    if (this.client || this.busy) throw codeError('bad-request', 'Already connected');
    const host = String(msg.host || '').trim();
    const port = Number(msg.port || 22);
    const username = String(msg.username || '');
    const password = String(msg.password ?? '');
    if (!host || !/^[A-Za-z0-9.\-:_]+$/.test(host)) throw codeError('bad-request', 'Invalid host');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw codeError('bad-request', 'Invalid port');
    if (!username) throw codeError('bad-request', 'Username is required');
    // Optional private key (OpenSSH / PEM / PPK text). Parse it up front so a
    // wrong passphrase or unsupported file is reported before any network I/O.
    let privateKey;
    if (msg.privateKey != null && msg.privateKey !== '') {
      if (typeof msg.privateKey !== 'string' || msg.privateKey.length > MAX_KEY_CHARS) {
        throw codeError('bad-key', 'Invalid private key');
      }
      const passphrase = msg.passphrase ? String(msg.passphrase) : undefined;
      let parsed;
      try {
        parsed = utils.parseKey(msg.privateKey, passphrase);
      } catch (e) {
        parsed = e;
      }
      if (parsed instanceof Error) {
        const text = String(parsed.message || '');
        if (/no passphrase given/i.test(text)) throw codeError('key-needs-passphrase', text);
        if (passphrase && /passphrase|decrypt|integrity|MAC|bad/i.test(text)) throw codeError('key-bad-passphrase', text);
        throw codeError('bad-key', text || 'Cannot read private key');
      }
      const key = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!key.isPrivateKey()) throw codeError('bad-key', 'This is a public key, not a private key');
      privateKey = { key: msg.privateKey, passphrase };
    }
    if (!hostAllowed(this.env?.ALLOWED_HOSTS, host, port)) {
      throw codeError('host-not-allowed', 'This host is not on the allowlist');
    }

    this.busy = true;
    let socket;
    try {
      socket = connect({ hostname: host, port });
      await withTimeout(socket.opened, CONNECT_TIMEOUT_MS, 'connect-timeout');
    } catch (err) {
      this.busy = false;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      if (err?.code === 'connect-timeout') throw err;
      throw codeError('connect-failed', err?.message || 'Could not reach the host');
    }

    const client = new Client();
    let fingerprint = null;
    try {
      await new Promise((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.once('close', () => reject(codeError('closed', 'Connection closed')));
        client.connect({
          sock: socketToDuplex(socket),
          username,
          ...(privateKey
            ? { privateKey: privateKey.key, passphrase: privateKey.passphrase }
            : { password, tryKeyboard: true }),
          readyTimeout: CONNECT_TIMEOUT_MS,
          keepaliveInterval: 20000,
          keepaliveCountMax: 3,
          algorithms: ALGORITHMS,
          hostVerifier: (key) => {
            fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
            // Trust-on-first-use: the browser remembers the fingerprint and
            // sends it back on later logins.
            return !msg.expectedFingerprint || msg.expectedFingerprint === fingerprint;
          },
        });
        // Servers that only offer keyboard-interactive: answer prompts with the password.
        client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
          finish(prompts.map(() => password));
        });
      });
      const sftp = await new Promise((resolve, reject) => {
        client.sftp((err, s) => (err ? reject(err) : resolve(s)));
      });
      this.client = client;
      this.sftp = sftp;
      client.removeAllListeners('error');
      client.removeAllListeners('close');
      client.on('error', () => {});
      client.on('close', () => {
        this.sftp = null;
        this.client = null;
        this.send({ event: 'disconnected' });
        try {
          this.ws.close(1000, 'ssh closed');
        } catch {
          /* ignore */
        }
      });
      const home = await call(sftp, 'realpath', '.');
      return { home, fingerprint, username, host, port };
    } catch (err) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
      if (fingerprint && msg.expectedFingerprint && msg.expectedFingerprint !== fingerprint) {
        const e = codeError('hostkey-changed', 'Host key does not match the remembered one');
        e.fingerprint = fingerprint;
        throw e;
      }
      throw err;
    } finally {
      this.busy = false;
    }
  }
}

// ---- helpers ---------------------------------------------------------------

function socketToDuplex(socket) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      writer.write(chunk).then(() => cb(), cb);
    },
    final(cb) {
      writer.close().then(() => cb(), () => cb());
    },
    destroy(err, cb) {
      socket.close().catch(() => {});
      cb(err);
    },
  });
  duplex.setNoDelay = () => duplex;
  duplex.setKeepAlive = () => duplex;
  duplex.setTimeout = () => duplex;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        duplex.push(Buffer.from(value));
      }
      duplex.push(null);
    } catch (err) {
      duplex.destroy(err);
    }
  })();
  return duplex;
}

function call(obj, method, ...args) {
  return new Promise((resolve, reject) => {
    obj[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(codeError(code, 'Timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function codeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const SFTP_CODES = { 2: 'not-found', 3: 'permission-denied', 4: 'failure' };

function describeError(err) {
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

function reqPath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw codeError('bad-request', 'Invalid path');
  return p;
}

function joinPath(dir, name) {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

function baseName(p) {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '/';
}

function typeOf(attrs) {
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

function entry(name, attrs) {
  return { name, type: typeOf(attrs), size: attrs.size, mtime: attrs.mtime, mode: attrs.mode & 0o7777 };
}

function hostAllowed(list, host, port) {
  const items = String(list || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!items.length) return true;
  const h = host.toLowerCase();
  return items.includes(h) || items.includes(`${h}:${port}`);
}
