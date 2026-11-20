// MCP backend: the machine behind the desktop is a remote MCP server (Model
// Context Protocol over Streamable HTTP) that offers the Remogui tools; see
// docs/MCP.md for the contract and agent/ for two servers (Node.js, Python).
//
// The ops were written against ssh2's `sftp` and `client`. Rather than touch
// them, this file builds look-alikes of just the calls they make, each one
// answered by tool calls:
//
//   sftp.stat / readdir / readFile / open / read / write / fastGet ...  -> fs_* tools
//   client.exec(command)                                                -> exec tool
//   client.shell()                                                      -> term_* tools (long-polled)
//
// No MCP SDK is needed: the client below speaks the JSON-RPC methods it uses
// (initialize, tools/list, tools/call, ping).
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { open as openLocal } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { codeError, hostAllowed } from '../util.js';

const PROTOCOL_VERSION = '2025-03-26';
const CONNECT_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 30000;
const PIECE = 2 * 1024 * 1024; // bytes per fs_read / fs_write call
const POLL_MS = 2000; // how long term_read may wait for output
const KEEPALIVE_MS = 20000;
const MAX_TOKEN_CHARS = 4096;

// Tools the server must offer. `term_*` are optional: without them the
// terminal app reports that the host cannot open a shell.
const REQUIRED = ['hello', 'fs_stat', 'fs_readdir', 'fs_realpath', 'fs_read', 'fs_write', 'fs_mkdir', 'fs_remove', 'fs_rename', 'fs_chmod', 'fs_symlink', 'fs_readlink', 'exec'];
const TERM_TOOLS = ['term_open', 'term_write', 'term_read', 'term_resize', 'term_close'];

// ---- MCP client (Streamable HTTP, JSON or SSE replies)

class McpClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.sessionId = null;
    this.seq = 0;
  }

  headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async post(body, timeoutMs) {
    let res;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        redirect: 'error', // never follow a redirect with the token attached
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') throw codeError('connect-timeout', 'Timed out');
      throw codeError('connect-failed', err?.cause?.message || err?.message || 'Could not reach the MCP server');
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw codeError('token-refused', 'The MCP server refused the access token');
    }
    if (res.status === 404 && this.sessionId) {
      await res.body?.cancel().catch(() => {});
      throw codeError('closed', 'The MCP session has ended');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw codeError('connect-failed', `The MCP server answered HTTP ${res.status}`);
    }
    return res;
  }

  // One JSON-RPC request; resolves to its `result`.
  async request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const id = ++this.seq;
    const res = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    const type = res.headers.get('content-type') || '';
    let reply = null;
    try {
      if (type.includes('text/event-stream')) {
        for (const block of text.split(/\r?\n\r?\n/)) {
          const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (!data) continue;
          const msg = JSON.parse(data);
          if (msg.id === id) reply = msg;
        }
      } else {
        const msg = JSON.parse(text);
        reply = Array.isArray(msg) ? msg.find((m) => m.id === id) : msg;
      }
    } catch {
      throw codeError('mcp-error', 'The MCP server sent an unreadable reply');
    }
    if (!reply) throw codeError('mcp-error', 'The MCP server sent no reply');
    if (reply.error) throw codeError('mcp-error', reply.error.message || 'MCP error');
    return reply.result;
  }

  async notify(method, params) {
    const res = await this.post({ jsonrpc: '2.0', method, params }, CALL_TIMEOUT_MS);
    await res.body?.cancel().catch(() => {});
  }

  async initialize() {
    const result = await this.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'remogui', version: '1.0.0' } },
      CONNECT_TIMEOUT_MS,
    );
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    const names = [];
    let cursor;
    for (let i = 0; i < 10; i++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      for (const t of r?.tools || []) names.push(t.name);
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return names;
  }

  // Calls a tool and returns its JSON answer. A tool error ({code, message} in
  // the text) becomes a thrown error; SFTP-style numeric codes for the fs ones
  // so the ops' existing handling (`err.code === 2` ...) keeps working.
  async tool(name, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    let data = r?.structuredContent;
    if (data === undefined) {
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { message: text };
      }
    }
    if (r?.isError) throw toolError(name, data);
    return data;
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(3000) });
    } catch {
      /* the session ends on the server's own timeout instead */
    }
  }
}

const SFTP_NUM = { 'not-found': 2, 'permission-denied': 3 };
function toolError(name, data) {
  const code = typeof data?.code === 'string' ? data.code : 'failure';
  const err = new Error(String(data?.message || `${name} failed`));
  if (name.startsWith('fs_')) err.code = SFTP_NUM[code] ?? (code === 'exists' ? 'exists' : 4);
  else err.code = code;
  return err;
}

// ---- sftp look-alike

const nodeify = (promise, cb) => promise.then((r) => cb(null, r), (e) => cb(e));
const attrsOf = (o) => ({ mode: o.mode, size: o.size, mtime: o.mtime, atime: o.mtime, uid: o.uid, gid: o.gid });
const b64 = (buf) => Buffer.from(buf).toString('base64');

function makeSftp(mcp) {
  const writePieces = async (path, buf, offset, truncate, mode) => {
    let at = 0;
    do {
      const piece = buf.subarray(at, at + PIECE);
      await mcp.tool('fs_write', {
        path,
        offset: offset + at,
        data: b64(piece),
        truncate: truncate && at === 0,
        ...(mode != null && at === 0 ? { mode } : {}),
      });
      at += piece.length;
    } while (at < buf.length);
  };

  const readPiece = async (path, offset, length) => {
    const r = await mcp.tool('fs_read', { path, offset, length: Math.min(length, PIECE) });
    return { buf: Buffer.from(r.data || '', 'base64'), size: r.size, eof: !!r.eof };
  };

  // Calls each(buf) for every piece of the file, in order.
  const readAll = async (path, each) => {
    let offset = 0;
    for (;;) {
      const { buf, eof } = await readPiece(path, offset, PIECE);
      if (buf.length) await each(buf);
      offset += buf.length;
      if (eof || !buf.length) break;
    }
  };

  return {
    realpath: (path, cb) => nodeify(mcp.tool('fs_realpath', { path }).then((r) => r.path), cb),
    stat: (path, cb) => nodeify(mcp.tool('fs_stat', { path, follow: true }).then(attrsOf), cb),
    lstat: (path, cb) => nodeify(mcp.tool('fs_stat', { path, follow: false }).then(attrsOf), cb),
    readdir: (path, cb) =>
      nodeify(
        mcp.tool('fs_readdir', { path }).then((r) => (r.entries || []).map((e) => ({ filename: e.name, longname: '', attrs: attrsOf(e) }))),
        cb,
      ),
    mkdir: (path, ...rest) => {
      const cb = rest.pop();
      const mode = rest[0]?.mode;
      nodeify(mcp.tool('fs_mkdir', { path, ...(mode != null ? { mode } : {}) }).then(() => undefined), cb);
    },
    unlink: (path, cb) => nodeify(mcp.tool('fs_remove', { path, dir: false }).then(() => undefined), cb),
    rmdir: (path, cb) => nodeify(mcp.tool('fs_remove', { path, dir: true }).then(() => undefined), cb),
    rename: (from, to, cb) => nodeify(mcp.tool('fs_rename', { from, to }).then(() => undefined), cb),
    chmod: (path, mode, cb) => nodeify(mcp.tool('fs_chmod', { path, mode }).then(() => undefined), cb),
    symlink: (target, path, cb) => nodeify(mcp.tool('fs_symlink', { target, path }).then(() => undefined), cb),
    readlink: (path, cb) => nodeify(mcp.tool('fs_readlink', { path }).then((r) => r.target), cb),

    readFile: (path, ...rest) => {
      const cb = rest.pop();
      const parts = [];
      nodeify(readAll(path, (buf) => parts.push(buf)).then(() => Buffer.concat(parts)), cb);
    },
    writeFile: (path, data, ...rest) => {
      const cb = rest.pop();
      nodeify(writePieces(path, Buffer.from(data), 0, true).then(() => undefined), cb);
    },
    // Copies a file on the machine to a file on this server (the SQLite viewer).
    fastGet: (remote, local, ...rest) => {
      const cb = rest.pop();
      nodeify(
        (async () => {
          const fh = await openLocal(local, 'w', 0o600);
          try {
            await readAll(remote, (buf) => fh.write(buf));
          } finally {
            await fh.close();
          }
        })(),
        cb,
      );
    },

    // File handles are just the path. Opening for writing creates / truncates now.
    open: (path, flags, ...rest) => {
      const cb = rest.pop();
      const w = flags === 'w';
      nodeify(
        (w ? mcp.tool('fs_write', { path, offset: 0, data: '', truncate: true }) : mcp.tool('fs_stat', { path, follow: true })).then(() => ({ path })),
        cb,
      );
    },
    read: (handle, buf, off, len, pos, cb) =>
      nodeify(
        readPiece(handle.path, pos, len).then(({ buf: got }) => {
          got.copy(buf, off);
          return got.length;
        }),
        (err, n) => cb(err, n, buf),
      ),
    write: (handle, buf, off, len, pos, cb) =>
      nodeify(writePieces(handle.path, buf.subarray(off, off + len), pos, false).then(() => undefined), cb),
    close: (_handle, cb) => cb(null),

    // Byte range [start, end] (end inclusive), like ssh2's.
    createReadStream(path, opts = {}) {
      let pos = opts.start || 0;
      const end = opts.end ?? Infinity;
      return new Readable({
        highWaterMark: 256 * 1024,
        read() {
          const want = Math.min(256 * 1024, end - pos + 1);
          if (want <= 0) return this.push(null);
          readPiece(path, pos, want).then(
            ({ buf, eof }) => {
              pos += buf.length;
              if (buf.length) this.push(buf);
              if (!buf.length || eof) this.push(null);
            },
            (err) => this.destroy(err),
          );
        },
      });
    },
    createWriteStream(path, opts = {}) {
      let pos = 0;
      return new Writable({
        construct(done) {
          mcp.tool('fs_write', { path, offset: 0, data: '', truncate: true, ...(opts.mode != null ? { mode: opts.mode } : {}) }).then(() => done(), done);
        },
        write(chunk, _enc, done) {
          const at = pos;
          pos += chunk.length;
          writePieces(path, chunk, at, false).then(() => done(), done);
        },
      });
    },
  };
}

// ---- client look-alike: exec and shell

// ssh2's exec channel as the ops use it: listeners for 'data' / 'close',
// stream.stderr, stream.end(stdin) right after, stream.close().
class ExecStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.stdin = null;
    this.closed = false;
  }

  end(data) {
    if (data != null) this.stdin = String(data);
  }

  close() {
    this.finish();
  }

  finish(code = null) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }
}

// A shell: the server keeps the PTY, this side long-polls term_read.
class ShellStream extends EventEmitter {
  constructor(mcp, tid) {
    super();
    this.mcp = mcp;
    this.tid = tid;
    this.stderr = new EventEmitter();
    this.closed = false;
    this.pending = ''; // keys typed while a term_write is in flight
    this.sending = false;
    this.poll();
  }

  async poll() {
    let failures = 0;
    while (!this.closed) {
      try {
        const r = await this.mcp.tool('term_read', { tid: this.tid, waitMs: POLL_MS }, POLL_MS + CALL_TIMEOUT_MS);
        failures = 0;
        if (r.data) this.emit('data', Buffer.from(r.data, 'base64'));
        if (r.exited) break;
      } catch {
        if (++failures >= 3) break;
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    this.shut();
  }

  shut() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  write(data) {
    this.pending += typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    this.flush();
  }

  async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.pending && !this.closed) {
        const text = this.pending;
        this.pending = '';
        await this.mcp.tool('term_write', { tid: this.tid, data: b64(text) }).catch(() => {});
      }
    } finally {
      this.sending = false;
    }
  }

  setWindow(rows, cols) {
    this.mcp.tool('term_resize', { tid: this.tid, cols, rows }).catch(() => {});
  }

  close() {
    if (this.closed) return;
    this.mcp.tool('term_close', { tid: this.tid }).catch(() => {});
    this.shut();
  }
}

function makeClient(mcp, hasTerm) {
  return {
    exec(command, ...rest) {
      const cb = rest.pop();
      const stream = new ExecStream();
      process.nextTick(() => {
        cb(null, stream);
        // execCapture calls stream.end(stdin) inside the callback, so by the
        // next turn of the loop the input (if any) is known.
        setImmediate(async () => {
          if (stream.closed) return;
          let code = null;
          try {
            const r = await mcp.tool('exec', { command, ...(stream.stdin != null ? { stdin: stream.stdin } : {}), timeoutMs: 60000 }, 70000);
            code = r.code ?? null;
            if (!stream.closed) {
              if (r.stdout) stream.emit('data', Buffer.from(r.stdout, 'utf8'));
              if (r.stderr) stream.stderr.emit('data', Buffer.from(r.stderr, 'utf8'));
            }
          } catch {
            /* the caller sees empty output; a lost connection closes the session */
          }
          stream.finish(code);
        });
      });
    },

    shell(opts, ...rest) {
      const cb = rest.pop();
      if (!hasTerm) return cb(Object.assign(new Error('This MCP server has no terminal tools'), { code: 'exec-failed' }));
      mcp.tool('term_open', { cols: opts?.cols || 80, rows: opts?.rows || 24, term: opts?.term || 'xterm-256color' }).then(
        (r) => cb(null, new ShellStream(mcp, r.tid)),
        (err) => cb(err),
      );
    },
  };
}

// ---- the backend

export async function connectMcp(msg, env) {
  const raw = String(msg.url || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw codeError('bad-request', 'Invalid MCP server address');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw codeError('bad-request', 'The address must start with https:// or http://');
  if (url.username || url.password) throw codeError('bad-request', 'Put the token in the token field, not in the address');
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  if (!hostAllowed(env?.ALLOWED_HOSTS, url.hostname, port)) throw codeError('host-not-allowed', 'This host is not on the allowlist');
  const token = String(msg.token ?? '');
  if (token.length > MAX_TOKEN_CHARS || /[\r\n]/.test(token)) throw codeError('bad-request', 'Invalid token');

  const mcp = new McpClient(url.href, token);
  try {
    await mcp.initialize();
    const names = new Set(await mcp.listTools());
    const missing = REQUIRED.filter((n) => !names.has(n));
    if (missing.length) throw codeError('mcp-incompatible', `This MCP server lacks the Remogui tools: ${missing.join(', ')}`);
    const hasTerm = TERM_TOOLS.every((n) => names.has(n));
    const hello = await mcp.tool('hello');
    const home = String(hello.home || '/');
    const username = String(hello.user || 'mcp');
    // Same server and account -> same id, in every tab (pasting files between machines is refused).
    const domain = createHash('sha256').update(`${url.origin}${url.pathname}\0${username}`).digest('hex').slice(0, 12);

    const closers = [];
    let ended = false;
    const stop = () => {
      if (ended) return false;
      ended = true;
      clearInterval(timer);
      mcp.close();
      return true;
    };
    // A server has no connection to watch, so ping it; three misses in a row
    // count as a dropped connection (the page then logs in again by itself).
    let misses = 0;
    const timer = setInterval(() => {
      mcp.request('ping', {}, 10000).then(
        () => {
          misses = 0;
        },
        (err) => {
          if ((err?.code === 'closed' || ++misses >= 3) && stop()) for (const fn of closers) fn();
        },
      );
    }, KEEPALIVE_MS);
    timer.unref?.();

    return {
      client: makeClient(mcp, hasTerm),
      sftp: makeSftp(mcp),
      info: { mode: 'mcp', home, username, host: url.hostname, port, fingerprint: null, domain },
      onClose: (fn) => closers.push(fn),
      end: () => stop(),
    };
  } catch (err) {
    mcp.close();
    throw err;
  }
}
