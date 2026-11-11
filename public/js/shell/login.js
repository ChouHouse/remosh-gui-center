// Login overlay: host / user / password or private key, host-key trust.
import { $ } from '../core/dom.js';
import { store } from '../core/store.js';
import { errText } from '../core/errors.js';
import { toast } from '../core/ui.js';
import { conn, rpc, openSocket } from '../core/rpc.js';
import { on, emit } from '../core/events.js';

const loginEl = $('#login');
const form = $('#login-form');
const fHost = $('#f-host');
const fPort = $('#f-port');
const fUser = $('#f-user');
const fPass = $('#f-pass');
const loginErr = $('#login-error');
const hostkeyWarn = $('#hostkey-warn');

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

export function showLogin(message, relogin) {
  loginEl.hidden = false;
  $('#login-sub').textContent = message || '連線到 SSH 主機，瀏覽並編輯上面的檔案';
  for (const f of [fHost, fPort, fUser]) f.readOnly = !!relogin;
  loginErr.hidden = true;
  hostkeyWarn.hidden = true;
  fPass.value = '';
  (fHost.value && fUser.value ? fPass : fHost.value ? fUser : fHost).focus();
}

async function doLogin(trustNew) {
  const host = fHost.value.trim();
  const port = Number(fPort.value) || 22;
  const username = fUser.value;
  const key = `${host}:${port}`;
  const known = store.get('hostkeys', {});
  const btn = $('#login-btn');
  loginErr.hidden = true;
  hostkeyWarn.hidden = true;
  btn.disabled = true;
  btn.textContent = '連線中…';
  let ws;
  try {
    ws = await openSocket();
    conn.ws = ws;
    const res = await rpc('connect', {
      host,
      port,
      username,
      ...(keyText ? { privateKey: keyText, passphrase: fPass.value } : { password: fPass.value }),
      expectedFingerprint: trustNew ? undefined : known[key],
    });
    if (known[key] !== res.fingerprint) {
      toast(`已記住 ${key} 的主機金鑰指紋：${res.fingerprint}`);
      known[key] = res.fingerprint;
      store.set('hostkeys', known);
    }
    store.set('last', { host, port, username });
    const resume = !!conn.info; // set when the previous session dropped rather than logged out
    conn.info = res;
    conn.closing = false;
    clearInterval(conn.pingTimer);
    conn.pingTimer = setInterval(() => rpc('ping').catch(() => {}), 25000);
    fPass.value = '';
    loginEl.hidden = true;
    emit(resume ? 'session:resume' : 'session:start');
  } catch (err) {
    if (ws) {
      conn.ws = null;
      ws.close();
    }
    if (err.code === 'hostkey-changed') {
      $('#fp-old').textContent = known[key] || '';
      $('#fp-new').textContent = err.detail?.fingerprint || '';
      hostkeyWarn.hidden = false;
    } else {
      loginErr.textContent = errText(err);
      loginErr.hidden = false;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '登入';
  }
}

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  doLogin(false);
});
$('#trust-new').addEventListener('click', () => doLogin(true));

on('conn:lost', () => showLogin('連線已中斷，請重新輸入密碼登入。開著的視窗會保留。', true));
on('session:end', () => {
  setKey('', '');
  showLogin();
});

export function initLogin() {
  const last = store.get('last', null);
  if (last) {
    fHost.value = last.host || '';
    fPort.value = last.port || 22;
    fUser.value = last.username || '';
  }
  showLogin();
}
