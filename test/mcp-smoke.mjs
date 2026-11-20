// End-to-end test of the MCP backend: starts an agent (agent/remogui-agent.mjs
// and agent/remogui_agent.py, one after the other) and the web server, logs in
// with mode "mcp" over the WebSocket and runs the ops through it.
// usage: node test/mcp-smoke.mjs [node|python]   (both when not given)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_PORT = 18787;
const WEB_PORT = 18080;
const TOKEN = 'smoke-token';
const AGENTS = {
  node: [process.execPath, ['agent/remogui-agent.mjs', '--no-tunnel']],
  python: ['python3', ['agent/remogui_agent.py', '--no-tunnel']],
};
const which = process.argv[2] ? [process.argv[2]] : Object.keys(AGENTS);

let failed = 0;
const assert = (c, m) => {
  if (!c) {
    console.error('FAIL', m);
    failed++;
  } else console.log('ok  ', m);
};

async function waitPort(port) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await sleep(100);
    }
  }
}

async function smoke(kind) {
  console.log(`---- ${kind} agent`);
  const home = mkdtempSync(join(tmpdir(), 'remogui-smoke-'));
  mkdirSync(join(home, 'docs'));
  writeFileSync(join(home, 'docs', 'notes.txt'), '中文 notes\n');
  writeFileSync(join(home, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 123, 7));
  execFileSync('python3', ['-I', '-c', "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute('create table t(a)'); d.executemany('insert into t values (?)', [(i,) for i in range(42)]); d.commit()", join(home, 'docs', 'data.db')]);

  const kids = [];
  const run = (cmd, args, env) => {
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', () => {});
    kids.push(child);
    return child;
  };
  const [cmd, args] = AGENTS[kind];
  run(cmd, [...args, '--port', String(AGENT_PORT), '--key', TOKEN], {});
  run(process.execPath, ['server/main.js'], { PORT: WEB_PORT, WEB_PASSWORD: '' });
  await waitPort(AGENT_PORT);
  await waitPort(WEB_PORT);

  const ws = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('ws failed'));
  });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else events.push(m);
  };
  const rpc = (op, a = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, op, ...a }));
    });
  const b64 = (s) => Buffer.from(s).toString('base64');
  const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
  const url = `http://127.0.0.1:${AGENT_PORT}/mcp`;

  try {
    // the agent itself: no token, no session
    let res = await fetch(url, { method: 'POST', body: '{}' });
    assert(res.status === 401, 'agent: no token -> 401');
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hello' } }) });
    assert(res.status === 404, 'agent: a tool call outside a session is refused');

    let r = await rpc('connect', { mode: 'mcp', url, token: 'wrong' });
    assert(!r.ok && r.error.code === 'token-refused', 'wrong token -> token-refused');
    r = await rpc('connect', { mode: 'mcp', url: 'ftp://x/y', token: TOKEN });
    assert(!r.ok && r.error.code === 'bad-request', 'non-http url refused');
    r = await rpc('connect', { mode: 'nope' });
    assert(!r.ok && r.error.code === 'bad-request', 'unknown mode refused');

    r = await rpc('connect', { mode: 'mcp', url, token: TOKEN });
    assert(r.ok && r.mode === 'mcp' && r.home === home && r.username, 'login via MCP: ' + JSON.stringify(r.error || { home: r.home, user: r.username }));
    if (!r.ok) throw new Error('cannot log in');
    const h = r.home;

    r = await rpc('list', { path: h });
    assert(r.ok && r.entries.some((e) => e.name === 'docs' && e.type === 'dir') && r.entries.some((e) => e.name === 'big.bin' && e.type === 'file'), 'list home');
    r = await rpc('read', { path: h + '/docs/notes.txt' });
    assert(r.ok && unb64(r.data).includes('中文'), 'read utf-8');
    const p = h + '/docs/out.txt';
    const body = 'smoke ✓ ' + Date.now();
    r = await rpc('write', { path: p, data: b64(body) });
    assert(r.ok && r.size === Buffer.byteLength(body), 'write');
    const back = await rpc('read', { path: p });
    assert(unb64(back.data) === body, 'round-trip');
    r = await rpc('write', { path: p, data: 'eA==', expectMtime: 1 });
    assert(!r.ok && r.error.code === 'changed-on-server', 'stale write refused');
    r = await rpc('read', { path: h + '/nope.txt' });
    assert(!r.ok && r.error.code === 'not-found', 'missing -> not-found');

    // chunked read of a file bigger than one piece
    let got = 0;
    for (let off = 0; ; ) {
      r = await rpc('readChunk', { path: h + '/big.bin', offset: off, length: 3 * 1024 * 1024 });
      if (!r.ok) break;
      got += Buffer.from(r.data, 'base64').length;
      off = got;
      if (r.eof) break;
    }
    assert(r.ok && got === 5 * 1024 * 1024 + 123, 'readChunk covers a 5 MiB file: ' + got);
    r = await rpc('writeChunk', { path: h + '/chunk.txt', offset: 0, data: b64('abc') });
    r = await rpc('writeChunk', { path: h + '/chunk.txt', offset: 3, data: b64('def'), last: true });
    assert(r.ok && r.size === 6, 'writeChunk in two pieces');

    r = await rpc('mkdir', { path: h + '/dir1', mode: 0o755 });
    assert(r.ok && r.created, 'mkdir');
    r = await rpc('mkdir', { path: h + '/dir1' });
    assert(r.ok && !r.created, 'mkdir twice is quiet');
    r = await rpc('copy', { from: h + '/docs', to: h + '/dir1/docs-copy' });
    assert(r.ok, 'copy folder');
    r = await rpc('list', { path: h + '/dir1/docs-copy' });
    assert(r.ok && r.entries.some((e) => e.name === 'notes.txt'), 'copied file is there');
    r = await rpc('move', { from: h + '/dir1/docs-copy', to: h + '/dir1/moved' });
    assert(r.ok, 'move');
    r = await rpc('chmod', { path: h + '/dir1/moved/notes.txt', mode: 0o600 });
    assert(r.ok, 'chmod');
    r = await rpc('stat', { path: h + '/dir1/moved/notes.txt' });
    assert(r.ok && r.entry.mode === 0o600, 'chmod took effect');
    r = await rpc('remove', { path: h + '/dir1' });
    assert(r.ok, 'remove tree');
    r = await rpc('stat', { path: h + '/dir1' });
    assert(!r.ok && r.error.code === 'not-found', 'tree is gone');

    // the SQLite viewer copies the database to the server (sftp.fastGet)
    r = await rpc('sqliteOpen', { path: h + '/docs/data.db' });
    assert(r.ok && r.tables.some((t) => t.name === 't' && t.rows === 42), 'SQLite viewer opens a database: ' + JSON.stringify(r.error || r.tables?.map((t) => t.name)));
    if (r.ok) await rpc('sqliteClose', { db: r.db });

    r = await rpc('stats');
    assert(r.ok && r.out.includes('@@host') && r.out.includes('@@end'), 'stats (exec tool)');
    r = await rpc('sysInfo');
    assert(r.ok && r.cores > 0, 'sysInfo');
    r = await rpc('hasCommands', { names: ['sh', 'definitely-not-a-command'] });
    assert(r.ok && r.found.includes('sh') && !r.found.includes('definitely-not-a-command'), 'hasCommands');
    r = await rpc('procInfo', { pid: process.pid });
    assert(r.ok && r.alive, 'procInfo');

    r = await rpc('termOpen', { cols: 80, rows: 24 });
    if (r.ok) {
      const tid = r.tid;
      const saw = (s) => events.some((e) => e.event === 'term:data' && unb64(e.data).includes(s));
      await rpc('termInput', { tid, data: 'echo hello-$((6*7))\n' });
      for (let i = 0; i < 50 && !saw('hello-42'); i++) await sleep(200);
      assert(saw('hello-42'), 'terminal runs a command');
      r = await rpc('termResize', { tid, cols: 100, rows: 30 });
      assert(r.ok, 'terminal resize accepted');
      if (kind === 'python') {
        await rpc('termInput', { tid, data: 'stty size\n' });
        for (let i = 0; i < 50 && !saw('30 100'); i++) await sleep(200);
        assert(saw('30 100'), 'the terminal really is 100 × 30 now');
      }
      await rpc('termClose', { tid });
      for (let i = 0; i < 30 && !events.some((e) => e.event === 'term:exit'); i++) await sleep(100);
      assert(events.some((e) => e.event === 'term:exit'), 'terminal closes');
    } else assert(false, 'termOpen: ' + JSON.stringify(r.error));

    // started without --key: no token needed (and none checked)
    run(cmd, [...args, '--port', String(AGENT_PORT + 1)], {});
    await waitPort(AGENT_PORT + 1);
    const ws2 = new WebSocket(`ws://127.0.0.1:${WEB_PORT}/ws`);
    await new Promise((res) => (ws2.onopen = res));
    const r2 = await new Promise((res) => {
      ws2.onmessage = (ev) => res(JSON.parse(ev.data));
      ws2.send(JSON.stringify({ id: 1, op: 'connect', mode: 'mcp', url: `http://127.0.0.1:${AGENT_PORT + 1}/mcp`, token: '' }));
    });
    ws2.close();
    assert(r2.ok && r2.home === home, 'an agent started without --key lets in a login with no token');
  } catch (err) {
    console.error('ERROR', err);
    failed++;
  } finally {
    ws.close();
    for (const k of kids) k.kill();
    await sleep(300);
    rmSync(home, { recursive: true, force: true });
  }
}

for (const kind of which) await smoke(kind);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
