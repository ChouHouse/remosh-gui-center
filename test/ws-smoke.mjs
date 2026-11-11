// Smoke test for the Worker's WebSocket API against a real SSH server.
// usage: node test/ws-smoke.mjs ws://127.0.0.1:3000/ws host port user password
const [url, host, port, username, password] = process.argv.slice(2);
const ws = new WebSocket(url);
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else console.log('event', m);
};
const rpc = (op, args = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, op, ...args }));
  });
const assert = (c, m) => {
  if (!c) {
    console.error('FAIL', m);
    process.exitCode = 1;
  } else console.log('ok  ', m);
};
ws.onerror = (e) => {
  console.error('ws error', e.message || e);
  process.exit(1);
};
ws.onopen = async () => {
  let r = await rpc('list', { path: '/' });
  assert(!r.ok && r.error.code === 'not-connected', 'ops refused before login');
  r = await rpc('connect', { host, port: Number(port), username, password });
  assert(r.ok, 'login ' + JSON.stringify(r.error || { home: r.home, fp: r.fingerprint }));
  if (!r.ok) return ws.close();
  const home = r.home;
  r = await rpc('list', { path: home });
  assert(r.ok && r.entries.some((e) => e.name === 'project' && e.type === 'dir'), 'list home');
  r = await rpc('read', { path: home + '/docs/notes.txt' });
  const text = Buffer.from(r.data || '', 'base64').toString('utf8');
  assert(r.ok && text.includes('中文'), 'read utf-8 file: ' + JSON.stringify(text));
  const p = home + '/docs/smoke.txt';
  const body = 'smoke ' + Date.now() + ' ✓\n';
  r = await rpc('write', { path: p, data: Buffer.from(body).toString('base64') });
  assert(r.ok, 'write file');
  const back = await rpc('read', { path: p });
  assert(Buffer.from(back.data, 'base64').toString('utf8') === body, 'round-trip matches');
  r = await rpc('write', { path: p, data: 'eA==', expectMtime: 1 });
  assert(!r.ok && r.error.code === 'changed-on-server', 'stale write refused');
  r = await rpc('read', { path: home + '/nope.txt' });
  assert(!r.ok && r.error.code === 'not-found', 'missing file -> not-found');
  r = await rpc('read', { path: '/etc/shadow' });
  assert(!r.ok && r.error.code === 'permission-denied', 'unreadable -> permission-denied');
  ws.close();
};
