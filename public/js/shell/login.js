// Login overlay: host / user / password or private key.
// Host keys are deliberately not remembered: hosts here are often containers
// that get a new key every time they are recreated.
import { $, h } from '../core/dom.js';
import { store } from '../core/store.js';
import { errText } from '../core/errors.js';
import { conn, rpc, openSocket } from '../core/rpc.js';
import { on, emit } from '../core/events.js';
import { ensureGate } from './gate.js';
import { host, otherSessions, onSessionsChange } from './sessions.js';

const loginEl = $('#login');
const form = $('#login-form');
const fHost = $('#f-host');
const fPort = $('#f-port');
const fUser = $('#f-user');
const fPass = $('#f-pass');
const loginErr = $('#login-error');

// Private key text stays in memory only (never in localStorage).
let keyText = '';
const fKey = $('#f-key');
function setKey(text, name) {
  keyText = text;
  fKey.value = '';
  $('#key-name').textContent = text ? name : '未選擇（選填，改用金鑰登入）';
  $('#key-clear').hidden = !text;
  $('.keyrow').classList.toggle('has-key', !!text);
  $('#pass-label').textContent = text ? '金鑰密碼（沒有設定可留空）' : '密碼';
}
$('#key-pick').addEventListener('click', () => fKey.click());
$('#key-clear').addEventListener('click', () => setKey('', ''));
fKey.addEventListener('change', async () => {
  const file = fKey.files[0];
  if (!file) return;
  loginErr.hidden = true;
  if (file.size > 32 * 1024) {
    loginErr.textContent = '這個檔案太大，不像是私鑰檔';
    loginErr.hidden = false;
    return setKey('', '');
  }
  setKey(await file.text(), file.name);
  fPass.focus();
});

// ---- servers logged in to before: host, port and account in a cookie (never
// the password or a key), listed beside the form to fill it in with one click.
const SERVERS_COOKIE = 'remosh_servers';
const SERVERS_MAX = 8;
const sameServer = (a, b) => a.host === b.host && Number(a.port) === Number(b.port) && a.username === b.username;
function readServers() {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(SERVERS_COOKIE + '='));
  if (!hit) return [];
  try {
    const list = JSON.parse(decodeURIComponent(hit.slice(SERVERS_COOKIE.length + 1)));
    return Array.isArray(list) ? list.filter((s) => s && typeof s.host === 'string' && typeof s.username === 'string').slice(0, SERVERS_MAX) : [];
  } catch {
    return [];
  }
}
function writeServers(list) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${SERVERS_COOKIE}=${encodeURIComponent(JSON.stringify(list.slice(0, SERVERS_MAX)))}; Max-Age=${list.length ? 365 * 86400 : 0}; Path=/; SameSite=Lax${secure}`;
  renderServers();
}
const rememberServer = (server) => writeServers([server, ...readServers().filter((s) => !sameServer(s, server))]);
function renderServers() {
  const list = readServers();
  const now = { host: fHost.value.trim(), port: Number(fPort.value) || 22, username: fUser.value };
  $('#saved-servers').replaceChildren(...(list.length
    ? [h('h2', null, '登入過的主機'), ...list.map((s) =>
      h('div', { class: 'saved-server' + (sameServer(s, now) ? ' on' : '') },
        h('button', {
          type: 'button', class: 'fill', title: '填入這台主機的位置、連接埠和帳號',
          onclick: () => {
            fHost.value = s.host;
            fPort.value = s.port || 22;
            fUser.value = s.username;
            loginErr.hidden = true;
            renderServers();
            fPass.focus();
          },
        }, h('strong', null, s.username + '@' + s.host), h('span', null, '連接埠 ' + (s.port || 22))),
        h('button', { type: 'button', class: 'forget', title: '從清單移除', 'aria-label': '從清單移除', onclick: () => writeServers(readServers().filter((o) => !sameServer(o, s))) }, '×')))]
    : []));
}
for (const f of [fHost, fPort, fUser]) f.addEventListener('input', renderServers);

export function showLogin(message, relogin) {
  loginEl.hidden = false;
  form.classList.toggle('relogin', !!relogin);
  renderServers();
  $('#login-sub').textContent = message || '連線到 SSH 主機，瀏覽並編輯上面的檔案';
  for (const f of [fHost, fPort, fUser]) f.readOnly = !!relogin;
  loginErr.hidden = true;
  fPass.value = '';
  (fHost.value && fUser.value ? fPass : fHost.value ? fUser : fHost).focus();
}

// What the user last logged in with. Kept in memory only, for as long as this
// page is open, so a dropped connection can be brought back without asking;
// forgotten at logout. Nothing is written to the browser's storage.
let saved = null;

// Opens a connection and logs in; throws when that does not work.
async function connectWith(creds) {
  let ws;
  try {
    await ensureGate(); // the access cookie may have expired since the page loaded
    ws = await openSocket();
    conn.ws = ws;
    const res = await rpc('connect', creds);
    const resume = !!conn.info; // set when the previous session dropped rather than logged out
    conn.info = res;
    conn.closing = false;
    clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => rpc('ping').catch(() => {}), 25000);
    saved = creds;
    loginEl.hidden = true;
    emit(resume ? 'session:resume' : 'session:start');
  } catch (err) {
    if (ws) {
      if (conn.ws === ws) conn.ws = null;
      ws.close();
    }
    throw err;
  }
}

async function doLogin() {
  const host = fHost.value.trim();
  const port = Number(fPort.value) || 22;
  const username = fUser.value;
  const btn = $('#login-btn');
  loginErr.hidden = true;
  btn.disabled = true;
  btn.textContent = '連線中…';
  try {
    await connectWith({
      host,
      port,
      username,
      ...(keyText ? { privateKey: keyText, passphrase: fPass.value } : { password: fPass.value }),
    });
    store.set('last', { host, port, username });
    rememberServer({ host, port, username });
    fPass.value = '';
  } catch (err) {
    loginErr.textContent = errText(err);
    loginErr.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = '登入';
  }
}

// The connection dropped: log in again quietly. Only when that fails (the
// password no longer works, or the host stays unreachable) is the user asked.
const RETRY_WAITS_MS = [0, 2000, 5000];
const NO_RETRY = new Set(['auth-failed', 'bad-key', 'key-needs-passphrase', 'key-bad-passphrase', 'host-not-allowed']);
const banner = h('div', { id: 'reconnecting', hidden: true, role: 'status' }, '連線中斷，正在重新連線…');
document.body.append(banner);
let reconnecting = false;
async function reconnect() {
  if (reconnecting) return;
  const creds = saved;
  if (!creds) return showLogin('連線已中斷，請重新輸入密碼登入。開著的視窗會保留。', true);
  reconnecting = true;
  banner.hidden = false;
  let ok = false;
  for (const wait of RETRY_WAITS_MS) {
    await new Promise((r) => setTimeout(r, wait));
    if (saved !== creds) break; // logged out meanwhile
    try {
      await connectWith(creds);
      ok = true;
      break;
    } catch (err) {
      if (NO_RETRY.has(err.code)) break;
    }
  }
  banner.hidden = true;
  reconnecting = false;
  if (!ok && saved === creds) {
    saved = null;
    showLogin('連線已中斷，自動重新連線沒有成功，請重新輸入密碼登入。開著的視窗會保留。', true);
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  doLogin();
});

on('conn:lost', reconnect);
on('session:end', () => {
  saved = null;
  setKey('', '');
  showLogin();
});

// Users who are still signed in wait at the bottom left of the login screen.
function renderKept() {
  const others = otherSessions();
  $('#kept-sessions').replaceChildren(...(others.length
    ? [h('h2', null, '已登入'), ...others.map((s) =>
      h('button', { type: 'button', 'data-session': s.id, title: `回到 ${s.label}`, onclick: () => host.switchTo(s.id) },
        h('span', { class: 'avatar' }, [...s.label][0]), h('span', null, s.label)))]
    : []));
}
onSessionsChange(renderKept);

export function initLogin() {
  renderKept();
  store.remove('hostkeys'); // fingerprints remembered by earlier versions
  const last = store.get('last', null);
  if (last) {
    fHost.value = last.host || '';
    fPort.value = last.port || 22;
    fUser.value = last.username || '';
    // Logged in with an earlier version: start the list with that server.
    if (last.host && last.username && !readServers().length) writeServers([{ host: last.host, port: last.port || 22, username: last.username }]);
  }
  showLogin();
}
