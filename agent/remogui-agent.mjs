#!/usr/bin/env node
// Remogui MCP agent (Node.js): a small MCP server (Streamable HTTP) that gives
// Remogui a machine to work on without SSH. A Python version with the same
// tools is next to it (remogui_agent.py); the Remogui login screen offers both
// for download (as mcp.mjs and mcp.py).
//
//   node mcp.mjs (--key KEY | --no-key) [--tunnel TOKEN | --no-tunnel] [--port 8787] [--host 127.0.0.1]
//
//   --key KEY       what the login screen must send as the access token.
//   --no-key        no access token at all: anyone with the address can use
//                   this machine. One of --key and --no-key is required.
//   --tunnel TOKEN  run this Cloudflare tunnel (its token, from the Cloudflare
//                   dashboard). Without it a quick tunnel is made and its
//                   https://….trycloudflare.com address is printed.
//   --no-tunnel     no tunnel: reach the agent directly (LAN, reverse proxy).
//
// cloudflared is used from PATH, else downloaded once from Cloudflare's GitHub
// releases into ~/.cache/remogui/. The environment variables REMOGUI_TOKEN,
// CLOUDFLARE_TUNNEL_TOKEN, PORT and HOST work as the options do.
//
// Node.js 20 or newer, no dependencies. For a terminal with resize support install `node-pty`
// next to this file (npm i node-pty); without it a PTY comes from `script`
// (no resize), and without that the terminal tools are not offered.
// The tools and their arguments are described in docs/MCP.md.
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const VERSION = '1.0.0';
const USAGE = `usage: node mcp.mjs (--key KEY | --no-key) [--tunnel TOKEN | --no-tunnel] [--port PORT] [--host HOST]

Remogui MCP agent: lets Remogui use this machine without SSH. It opens a
Cloudflare tunnel and prints the address to log in with.

options:
  -h, --help      show this help message and exit
  --key KEY       access token the login screen must send
  --no-key        no access token: anyone who has the address can use this machine
  --tunnel TOKEN  Cloudflare tunnel token (without it: a quick tunnel)
  --no-tunnel     no tunnel; reach the agent directly
  --port PORT     port to listen on (default 8787)
  --host HOST     address to listen on (0.0.0.0 for a LAN or a container)

example: node mcp.mjs --key "a-long-random-secret"`;
let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      key: { type: 'string', default: process.env.REMOGUI_TOKEN || '' },
      'no-key': { type: 'boolean', default: false },
      tunnel: { type: 'string', default: process.env.CLOUDFLARE_TUNNEL_TOKEN || '' },
      'no-tunnel': { type: 'boolean', default: false },
      port: { type: 'string', default: process.env.PORT || '8787' },
      host: { type: 'string', default: process.env.HOST || '127.0.0.1' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (err) {
  console.error(err.message + '\n\n' + USAGE);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (opts.key && opts['no-key']) {
  console.error('use either --key or --no-key, not both');
  process.exit(2);
}
if (!opts.key && !opts['no-key']) {
  console.log('To start the Remogui MCP agent, give it an access key with --key <key>, or use --no-key to let anyone in. Run it with --help to see every option.');
  process.exit(2);
}
const PORT = Number(opts.port) || 8787;
const HOST = opts.host;
const TOKEN = opts.key; // empty = no check
const MAX_BODY = 64 * 1024 * 1024;
const MAX_READ = 4 * 1024 * 1024;
const MAX_OUTPUT = 8 * 1024 * 1024;
const SESSION_IDLE_MS = 60 * 60 * 1000; // an MCP session unused this long is forgotten
const MAX_SESSIONS = 64;

process.chdir(os.homedir());

// ---- errors

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const FS_CODES = { ENOENT: 'not-found', ENOTDIR: 'not-found', EACCES: 'permission-denied', EPERM: 'permission-denied', EEXIST: 'exists', ENOTEMPTY: 'failure' };
const fsError = (err) => (err instanceof ToolError ? err : new ToolError(FS_CODES[err?.code] || 'failure', err?.message || String(err)));

// ---- file tools

const attrs = (st) => ({ mode: st.mode, size: st.size, mtime: Math.floor(st.mtimeMs / 1000), uid: st.uid, gid: st.gid });
const str = (v, what) => {
  if (typeof v !== 'string' || !v || v.includes('\0')) throw new ToolError('bad-request', `Invalid ${what}`);
  return v;
};
const int = (v, what, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isInteger(v) || v < min || v > max) throw new ToolError('bad-request', `Invalid ${what}`);
  return v;
};

const fsTools = {
  async fs_stat({ path, follow }) {
    return attrs(await (follow === false ? fs.lstat(str(path, 'path')) : fs.stat(str(path, 'path'))));
  },
  async fs_readdir({ path }) {
    const dir = str(path, 'path');
    const names = await fs.readdir(dir);
    const entries = [];
    // lstat each entry; one that vanished meanwhile is skipped
    await Promise.all(
      names.map(async (name) => {
        try {
          entries.push({ name, ...attrs(await fs.lstat(dir.endsWith('/') ? dir + name : dir + '/' + name)) });
        } catch {
          /* gone */
        }
      }),
    );
    return { entries };
  },
  async fs_realpath({ path }) {
    return { path: await fs.realpath(str(path ?? '.', 'path')) };
  },
  async fs_read({ path, offset, length }) {
    const fh = await fs.open(str(path, 'path'), 'r');
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new ToolError('not-a-file', 'Not a regular file');
      const at = int(offset ?? 0, 'offset');
      const want = Math.min(int(length ?? MAX_READ, 'length', 1), MAX_READ);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, at);
      return { data: buf.subarray(0, bytesRead).toString('base64'), size: st.size, eof: at + bytesRead >= st.size };
    } finally {
      await fh.close();
    }
  },
  async fs_write({ path, offset, data, truncate, mode }) {
    const file = str(path, 'path');
    const at = int(offset ?? 0, 'offset');
    if (typeof data !== 'string') throw new ToolError('bad-request', 'Missing data');
    const buf = Buffer.from(data, 'base64');
    const perm = mode == null ? 0o666 : int(mode, 'mode', 0, 0o7777);
    let fh;
    if (truncate) fh = await fs.open(file, 'w', perm);
    else {
      try {
        fh = await fs.open(file, 'r+');
      } catch (err) {
        if (err.code !== 'ENOENT' || at !== 0) throw err;
        fh = await fs.open(file, 'w', perm);
      }
    }
    try {
      if (buf.length) await fh.write(buf, 0, buf.length, at);
    } finally {
      await fh.close();
    }
    return {};
  },
  async fs_mkdir({ path, mode }) {
    await fs.mkdir(str(path, 'path'), { mode: mode == null ? 0o777 : int(mode, 'mode', 0, 0o7777) });
    return {};
  },
  async fs_remove({ path, dir }) {
    if (dir) await fs.rmdir(str(path, 'path'));
    else await fs.unlink(str(path, 'path'));
    return {};
  },
  async fs_rename({ from, to }) {
    await fs.rename(str(from, 'from'), str(to, 'to'));
    return {};
  },
  async fs_chmod({ path, mode }) {
    await fs.chmod(str(path, 'path'), int(mode, 'mode', 0, 0o7777));
    return {};
  },
  async fs_symlink({ target, path }) {
    await fs.symlink(str(target, 'target'), str(path, 'path'));
    return {};
  },
  async fs_readlink({ path }) {
    return { target: await fs.readlink(str(path, 'path')) };
  },
};

// ---- exec

function execTool({ command, stdin, timeoutMs }) {
  str(command, 'command');
  const limit = Math.min(Number(timeoutMs) || 30000, 10 * 60 * 1000);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const out = [];
    const err = [];
    let size = 0;
    const take = (list) => (d) => {
      if (size < MAX_OUTPUT) list.push(d);
      size += d.length;
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof stdin === 'string' ? stdin : undefined);
    const timer = setTimeout(() => child.kill('SIGKILL'), limit);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ToolError('exec-failed', e.message));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: code ?? (signal ? 128 : 0), timedOut: signal === 'SIGKILL' });
    });
  });
}

// ---- terminals (long-polled: the client calls term_read, the agent answers as
// soon as there is output or after waitMs)

let nodePty = null;
try {
  nodePty = await import('node-pty');
} catch {
  /* optional */
}
const hasScript = !nodePty && spawnSync('script', ['--version'], { stdio: 'ignore' }).status !== null;
const TERMS_OK = !!nodePty || hasScript;
const terms = new Map();
let termSeq = 0;
const MAX_TERMS = 8;
const BUFFER_CAP = 4 * 1024 * 1024;

function termOpen({ cols, rows, term }) {
  if (terms.size >= MAX_TERMS) throw new ToolError('too-many', 'Too many terminals');
  const c = Math.min(Math.max(Math.floor(cols) || 80, 2), 500);
  const r = Math.min(Math.max(Math.floor(rows) || 24, 2), 300);
  const shell = process.env.SHELL || '/bin/sh';
  const env = { ...process.env, TERM: typeof term === 'string' && /^[\w.-]{1,40}$/.test(term) ? term : 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' };
  const t = { chunks: [], size: 0, exited: false, waiters: new Set(), proc: null, pty: null };
  const wakeAll = () => {
    for (const w of t.waiters) w();
    t.waiters.clear();
  };
  const push = (d) => {
    t.chunks.push(Buffer.from(d));
    t.size += d.length;
    while (t.size > BUFFER_CAP && t.chunks.length > 1) t.size -= t.chunks.shift().length;
    wakeAll();
  };
  const done = () => {
    t.exited = true;
    wakeAll();
  };
  if (nodePty) {
    t.pty = nodePty.spawn(shell, ['-l'], { name: env.TERM, cols: c, rows: r, cwd: os.homedir(), env });
    t.pty.onData(push);
    t.pty.onExit(done);
  } else {
    t.proc = spawn('script', ['-qfec', `stty cols ${c} rows ${r}; exec ${shell} -l`, '/dev/null'], { cwd: os.homedir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    t.proc.stdout.on('data', push);
    t.proc.stderr.on('data', push);
    t.proc.stdin.on('error', () => {});
    t.proc.on('close', done);
  }
  const tid = ++termSeq;
  terms.set(tid, t);
  return { tid };
}

const termOf = (tid) => {
  const t = terms.get(tid);
  if (!t) throw new ToolError('no-terminal', 'Terminal is closed');
  return t;
};

const termTools = {
  async term_open(args) {
    return termOpen(args);
  },
  async term_write({ tid, data }) {
    const t = termOf(tid);
    const buf = Buffer.from(String(data || ''), 'base64');
    if (buf.length > 256 * 1024) throw new ToolError('bad-request', 'Input too large');
    if (t.pty) t.pty.write(buf.toString('utf8'));
    else t.proc.stdin.write(buf);
    return {};
  },
  async term_read({ tid, waitMs }) {
    const t = termOf(tid);
    const wait = Math.min(Math.max(Number(waitMs) || 0, 0), 20000);
    if (!t.chunks.length && !t.exited && wait) {
      await new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          t.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, wait);
        t.waiters.add(wake);
      });
    }
    const data = Buffer.concat(t.chunks);
    t.chunks = [];
    t.size = 0;
    const exited = t.exited && !data.length;
    if (exited) terms.delete(tid);
    return { data: data.toString('base64'), exited };
  },
  async term_resize({ tid, cols, rows }) {
    const t = termOf(tid);
    if (t.pty) t.pty.resize(Math.min(Math.max(Math.floor(cols) || 80, 2), 500), Math.min(Math.max(Math.floor(rows) || 24, 2), 300));
    return {};
  },
  async term_close({ tid }) {
    const t = terms.get(tid);
    if (t) {
      terms.delete(tid);
      if (t.pty) t.pty.kill();
      else t.proc.kill('SIGHUP');
    }
    return {};
  },
};

// ---- tool registry

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const S = { type: 'string' };
const N = { type: 'integer' };
const B = { type: 'boolean' };

const TOOLS = {
  hello: { description: 'Who and where this agent is.', schema: obj({}), run: async () => ({ home: os.homedir(), user: os.userInfo().username, host: os.hostname(), platform: process.platform, version: VERSION, pty: TERMS_OK, resize: !!nodePty }) },
  fs_stat: { description: 'stat / lstat (follow=false) a path.', schema: obj({ path: S, follow: B }, ['path']), run: fsTools.fs_stat },
  fs_readdir: { description: 'List a directory (lstat attributes per entry).', schema: obj({ path: S }, ['path']), run: fsTools.fs_readdir },
  fs_realpath: { description: 'Resolve a path (relative to the home directory).', schema: obj({ path: S }), run: fsTools.fs_realpath },
  fs_read: { description: 'Read up to length bytes at offset (base64).', schema: obj({ path: S, offset: N, length: N }, ['path']), run: fsTools.fs_read },
  fs_write: { description: 'Write base64 data at offset; truncate=true starts the file afresh.', schema: obj({ path: S, offset: N, data: S, truncate: B, mode: N }, ['path', 'data']), run: fsTools.fs_write },
  fs_mkdir: { description: 'Create one directory.', schema: obj({ path: S, mode: N }, ['path']), run: fsTools.fs_mkdir },
  fs_remove: { description: 'Delete a file or symlink, or an empty directory (dir=true).', schema: obj({ path: S, dir: B }, ['path']), run: fsTools.fs_remove },
  fs_rename: { description: 'Rename or move.', schema: obj({ from: S, to: S }, ['from', 'to']), run: fsTools.fs_rename },
  fs_chmod: { description: 'Change permission bits.', schema: obj({ path: S, mode: N }, ['path', 'mode']), run: fsTools.fs_chmod },
  fs_symlink: { description: 'Create a symlink at path pointing to target.', schema: obj({ target: S, path: S }, ['target', 'path']), run: fsTools.fs_symlink },
  fs_readlink: { description: 'Read a symlink.', schema: obj({ path: S }, ['path']), run: fsTools.fs_readlink },
  exec: { description: 'Run a command with /bin/sh -c; optional stdin text.', schema: obj({ command: S, stdin: S, timeoutMs: N }, ['command']), run: execTool },
};
if (TERMS_OK) {
  Object.assign(TOOLS, {
    term_open: { description: 'Open a terminal (PTY).', schema: obj({ cols: N, rows: N, term: S }), run: termTools.term_open },
    term_write: { description: 'Type into a terminal (base64).', schema: obj({ tid: N, data: S }, ['tid', 'data']), run: termTools.term_write },
    term_read: { description: 'Read terminal output (base64), waiting up to waitMs for some.', schema: obj({ tid: N, waitMs: N }, ['tid']), run: termTools.term_read },
    term_resize: { description: 'Resize a terminal.', schema: obj({ tid: N, cols: N, rows: N }, ['tid', 'cols', 'rows']), run: termTools.term_resize },
    term_close: { description: 'Close a terminal.', schema: obj({ tid: N }, ['tid']), run: termTools.term_close },
  });
}

const reply = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

async function callTool(name, args) {
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'bad-request', message: `Unknown tool: ${name}` }) }] };
  try {
    return reply(await tool.run(args && typeof args === 'object' ? args : {}));
  } catch (err) {
    const e = fsError(err);
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: e.code, message: e.message }) }] };
  }
}

// ---- MCP over Streamable HTTP (plain JSON replies, no server push)

const sessions = new Map(); // session id -> last used (ms)

function newSession() {
  const now = Date.now();
  for (const [sid, used] of sessions) if (now - used > SESSION_IDLE_MS) sessions.delete(sid);
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value); // the oldest
  const sid = randomBytes(16).toString('hex');
  sessions.set(sid, now);
  return sid;
}

function knownSession(sid) {
  const used = sid && sessions.get(sid);
  if (!used || Date.now() - used > SESSION_IDLE_MS) {
    if (sid) sessions.delete(sid);
    return false;
  }
  sessions.set(sid, Date.now());
  return true;
}

async function handleMessage(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined) return null; // a notification: nothing to answer
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: ['2025-06-18', '2025-03-26', '2024-11-05'].includes(params?.protocolVersion) ? params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'remogui-agent', version: VERSION } });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.schema })) });
    case 'tools/call':
      return ok(await callTool(params?.name, params?.arguments));
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

function authorized(req) {
  if (!TOKEN) return true; // started without --key
  const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer /i, ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers }).end(text);
};

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (path !== '/mcp' && path !== '/') return res.writeHead(404).end();
    if (!authorized(req)) return res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
    const sid = req.headers['mcp-session-id'];
    if (req.method === 'DELETE') {
      if (sid) sessions.delete(sid);
      return res.writeHead(200).end();
    }
    if (req.method !== 'POST') return res.writeHead(405, { Allow: 'POST, DELETE' }).end();
    const text = await readBody(req);
    if (text === null) return res.writeHead(413).end();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const batch = Array.isArray(msg);
    const list = batch ? msg : [msg];
    const init = list.some((m) => m?.method === 'initialize');
    // Everything but initialize belongs to a session that initialize started.
    if (!init && !knownSession(sid)) return json(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unknown or expired session' } });
    const answers = [];
    for (const m of list) {
      const a = await handleMessage(m);
      if (a) answers.push(a);
    }
    if (!answers.length) return res.writeHead(202).end();
    json(res, 200, batch ? answers : answers[0], init ? { 'Mcp-Session-Id': newSession() } : {});
  } catch (err) {
    console.error('request failed:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// ---- cloudflared: from PATH, or downloaded once into ~/.cache/remogui

const CF_RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

async function cloudflaredPath() {
  const onPath = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  if (onPath.status === 0) return 'cloudflared';
  const cache = join(process.env.XDG_CACHE_HOME || join(os.homedir(), '.cache'), 'remogui');
  const path = join(cache, 'cloudflared');
  try {
    await fs.access(path, fs.constants.X_OK);
    return path;
  } catch {
    /* not there yet */
  }
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch];
  const system = { linux: 'linux', darwin: 'darwin' }[process.platform];
  if (!arch || !system || (system === 'darwin' && !['amd64', 'arm64'].includes(arch))) {
    throw new Error(`cloudflared is not on PATH and there is no download for ${process.platform}/${process.arch}; install it, or use --no-tunnel`);
  }
  const name = `cloudflared-${system}-${arch}${system === 'darwin' ? '.tgz' : ''}`;
  console.log(`Downloading cloudflared (${name}) from GitHub…`);
  await fs.mkdir(cache, { recursive: true });
  const tmp = join(cache, `.download-${process.pid}`);
  try {
    const res = await fetch(CF_RELEASES + name, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    if (name.endsWith('.tgz')) {
      const dir = tmp + '.d';
      await fs.mkdir(dir, { recursive: true });
      execFileSync('tar', ['-xzf', tmp, '-C', dir]);
      await fs.rename(join(dir, 'cloudflared'), tmp + '.bin');
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(tmp + '.bin', tmp);
    }
    await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw new Error(`Could not download cloudflared: ${err.message} (install it yourself, or use --no-tunnel)`);
  }
  return path;
}

// Starts cloudflared in front of the agent; prints the address to log in with.
async function startTunnel(token) {
  const exe = await cloudflaredPath();
  const env = { ...process.env };
  let args;
  if (token) {
    args = ['tunnel', '--no-autoupdate', 'run'];
    env.TUNNEL_TOKEN = token; // not on the command line, where ps would show it
    console.log('Starting your Cloudflare tunnel…');
  } else {
    args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`];
    console.log('Starting a Cloudflare quick tunnel…');
  }
  const proc = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  process.on('exit', () => proc.exitCode === null && proc.kill());
  let told = false;
  const tail = [];
  const look = (line) => {
    tail.push(line);
    if (tail.length > 15) tail.shift();
    if (told) return;
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line);
    if (!token && m) {
      told = true;
      console.log(`\n  Login address:  ${m[0]}/mcp\n`);
    } else if (token && line.includes('Registered tunnel connection')) {
      told = true;
      console.log(`\n  Tunnel connected. Login address: the public hostname you gave this tunnel in\n  Cloudflare, followed by /mcp (its service must be http://127.0.0.1:${PORT}).\n`);
    }
  };
  createInterface({ input: proc.stdout }).on('line', look);
  createInterface({ input: proc.stderr }).on('line', look);
  proc.on('exit', (code) => {
    console.log(`cloudflared stopped (exit ${code}):\n  ${tail.join('\n  ')}`);
    process.exit(1);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Remogui MCP agent ${VERSION} (Node.js)`);
  console.log(`  Listening on:   http://${HOST}:${PORT}/mcp`);
  console.log(`  Terminal:       ${TERMS_OK ? (nodePty ? 'node-pty' : 'script (no resize)') : 'not available (install node-pty or util-linux script)'}`);
  console.log(TOKEN ? '  Access token:   set (--key)' : '  Access token:   NONE (--no-key). Anyone who has the address can read, change and run anything here.');
  if (!opts['no-tunnel']) {
    startTunnel(opts.tunnel).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  }
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
