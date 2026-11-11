/* SSH Desk front end: login, window manager, Finder-style browser, Monaco editor windows. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- utilities
  const $ = (sel, root = document) => root.querySelector(sel);

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('sshdesk.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('sshdesk.' + key, JSON.stringify(value));
      } catch {
        /* storage unavailable: preferences just do not persist */
      }
    },
  };

  const ERROR_TEXT = {
    'auth-failed': '登入失敗：帳號、密碼或金鑰不正確',
    'connect-failed': '無法連線到主機，請確認位置與連接埠',
    'connect-timeout': '連線逾時',
    'host-not-allowed': '這個 Worker 不允許連線到這台主機',
    'hostkey-changed': '主機金鑰與上次不同',
    'bad-key': '無法讀取這個私鑰檔（格式不支援，或不是私鑰）',
    'key-needs-passphrase': '這把私鑰有密碼保護，請輸入金鑰密碼',
    'key-bad-passphrase': '金鑰密碼不正確',
    'not-found': '找不到檔案或資料夾',
    'permission-denied': '權限不足',
    'too-large': '檔案太大（上限 5 MB）',
    'not-a-file': '這不是一般檔案',
    'not-connected': '連線已中斷',
    disconnected: '連線已中斷',
    timeout: '主機沒有回應',
    closed: '主機關閉了連線',
  };
  function errText(err) {
    return ERROR_TEXT[err?.code] || err?.message || String(err);
  }
  function appError(code, message) {
    const e = new Error(message || ERROR_TEXT[code] || code);
    e.code = code;
    return e;
  }

  function toast(text, isError) {
    const el = h('div', { class: 'toast' + (isError ? ' err' : '') }, text);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), isError ? 7000 : 4000);
  }

  function dialog({ title, message, buttons }) {
    return new Promise((resolve) => {
      const done = (value) => {
        modal.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onKey = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          done(buttons.find((b) => b.cancel)?.value ?? null);
        }
      };
      const btns = buttons.map((b) =>
        h('button', { type: 'button', class: [b.default && 'default', b.danger && 'danger'].filter(Boolean).join(' '), onclick: () => done(b.value) }, b.label),
      );
      const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'box' }, h('h2', null, title), h('p', null, message), h('div', { class: 'btns' }, btns)));
      document.body.append(modal);
      document.addEventListener('keydown', onKey, true);
      (btns[buttons.findIndex((b) => b.default)] || btns[0]).focus();
    });
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do {
      n /= 1024;
      i++;
    } while (n >= 1024 && i < units.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
  }
  function fmtTime(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const P = {
    norm(path) {
      const out = [];
      for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
      }
      return '/' + out.join('/');
    },
    join(dir, name) {
      return dir === '/' ? '/' + name : dir + '/' + name;
    },
    parent(path) {
      const i = path.lastIndexOf('/');
      return i <= 0 ? '/' : path.slice(0, i);
    },
    base(path) {
      return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
    },
    ext(name) {
      const i = name.lastIndexOf('.');
      return i > 0 ? name.slice(i + 1).toLowerCase() : '';
    },
  };

  // -------------------------------------------------------------------- icons
  const EXT_COLORS = ['#d9534f', '#e08a1e', '#2e9e5b', '#1f8fd6', '#7a5bd6', '#c2409a', '#4f7a8a'];
  function folderSvg() {
    return '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M4 12a4 4 0 0 1 4-4h10l5 5h17a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="var(--folder-dark)"/><path d="M4 18h40v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="var(--folder)"/></svg>';
  }
  function fileSvg(name) {
    const ext = P.ext(name).replace(/[^a-z0-9]/g, '').slice(0, 4).toUpperCase();
    let hash = 0;
    for (const ch of ext) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const label = ext
      ? `<text x="24" y="35" text-anchor="middle" font-size="${ext.length > 3 ? 8 : 9.5}" font-weight="700" font-family="system-ui,sans-serif" fill="${EXT_COLORS[hash % EXT_COLORS.length]}">${ext}</text>`
      : '<path d="M16 24h16M16 30h16M16 36h10" stroke="var(--file-edge)" stroke-width="1.6" stroke-linecap="round"/>';
    return `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M11 4h18l10 10v28a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="var(--file)" stroke="var(--file-edge)" stroke-width="1.5"/><path d="M29 4v10h10" fill="none" stroke="var(--file-edge)" stroke-width="1.5"/>${label}</svg>`;
  }
  const stroke = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    back: stroke('<path d="M10 3 5 8l5 5"/>'),
    fwd: stroke('<path d="m6 3 5 5-5 5"/>'),
    up: stroke('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
    refresh: stroke('<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>'),
    grid: stroke('<rect x="2.5" y="2.5" width="4" height="4"/><rect x="9.5" y="2.5" width="4" height="4"/><rect x="2.5" y="9.5" width="4" height="4"/><rect x="9.5" y="9.5" width="4" height="4"/>'),
    list: stroke('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
    eye: stroke('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
    home: stroke('<path d="M2.5 7.5 8 3l5.5 4.5V13h-4v-3.5h-3V13h-4z"/>'),
    disk: stroke('<rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M5 9.5h.01M7.5 9.5h3.5"/>'),
    folder: stroke('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>'),
  };

  // --------------------------------------------------------------- connection
  const conn = { ws: null, seq: 0, pending: new Map(), info: null, pingTimer: null, closing: false };

  function rpc(op, args) {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return Promise.reject(appError('not-connected'));
    return new Promise((resolve, reject) => {
      const id = ++conn.seq;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(appError('timeout'));
      }, 60000);
      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ id, op, ...args }));
    });
  }

  function openSocket() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(appError('connect-failed', '無法連上 Worker'));
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const p = conn.pending.get(msg.id);
        if (!p) return;
        conn.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg);
        else {
          const e = appError(msg.error?.code || 'error', ERROR_TEXT[msg.error?.code] || msg.error?.message);
          e.detail = msg.error;
          p.reject(e);
        }
      };
      ws.onclose = () => {
        if (conn.ws !== ws) return;
        conn.ws = null;
        clearInterval(conn.pingTimer);
        for (const p of conn.pending.values()) {
          clearTimeout(p.timer);
          p.reject(appError('disconnected'));
        }
        conn.pending.clear();
        if (conn.info && !conn.closing) showLogin('連線已中斷，請重新輸入密碼登入。開著的視窗會保留。', true);
      };
    });
  }

  // -------------------------------------------------------------------- login
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

  function showLogin(message, relogin) {
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
      conn.info = res;
      conn.closing = false;
      clearInterval(conn.pingTimer);
      conn.pingTimer = setInterval(() => rpc('ping').catch(() => {}), 25000);
      fPass.value = '';
      loginEl.hidden = true;
      enterDesktop();
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

  // ----------------------------------------------------------- window manager
  const winLayer = $('#windows');
  const dock = $('#dock');
  const wm = { wins: [], z: 10, focused: null, cascade: 0 };

  function createWindow({ title, iconHtml, width, height, pinned }) {
    const win = { title, minimized: false, maximized: false, onClose: null, onFocus: null };
    const titleEl = h('div', { class: 'title' }, title);
    const bar = h('div', { class: 'titlebar' },
      h('div', { class: 'traffic' },
        h('button', { type: 'button', class: 'close', title: '關閉', 'aria-label': '關閉', onclick: () => win.close() }),
        h('button', { type: 'button', class: 'min', title: '縮到工作列', 'aria-label': '縮到工作列', onclick: () => win.minimize() }),
        h('button', { type: 'button', class: 'max', title: '放大', 'aria-label': '放大', onclick: () => win.toggleMax() })),
      titleEl);
    win.body = h('div', { class: 'win-body' });
    win.el = h('section', { class: 'win' }, bar, win.body,
      ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('div', { class: 'rs ' + d, 'data-dir': d })));

    const area = winLayer.getBoundingClientRect();
    const w = Math.min(width, area.width - 16);
    const hgt = Math.min(height, area.height - 16);
    const off = (wm.cascade++ % 8) * 26;
    Object.assign(win.el.style, {
      width: w + 'px',
      height: hgt + 'px',
      left: Math.max(8, Math.min((area.width - w) / 2 - 90 + off, area.width - w - 8)) + 'px',
      top: Math.max(8, Math.min(24 + off, area.height - hgt - 8)) + 'px',
    });

    const lbl = h('span', { class: 'lbl' }, title);
    win.dockEl = h('button', { type: 'button', class: 'dock-item open', title },
      h('span', { class: 'ico', html: iconHtml }), lbl, h('span', { class: 'dirty', title: '尚未儲存' }));
    win.dockEl.addEventListener('click', () => {
      if (win.minimized) win.focus();
      else if (wm.focused === win) win.minimize();
      else win.focus();
    });
    if (pinned) dock.prepend(win.dockEl, h('span', { class: 'dock-sep' }));
    else dock.append(win.dockEl);

    win.setTitle = (t) => {
      win.title = t;
      titleEl.textContent = t;
      lbl.textContent = t;
      win.dockEl.title = t;
      if (wm.focused === win) $('#active-title').textContent = t;
    };
    win.setDirty = (d) => win.dockEl.classList.toggle('is-dirty', d);
    win.focus = () => {
      if (win.minimized) {
        win.minimized = false;
        win.el.classList.remove('minimized');
        win.dockEl.classList.remove('minimized');
      }
      win.el.style.zIndex = ++wm.z;
      if (wm.focused !== win) {
        wm.focused?.el.classList.remove('focused');
        wm.focused?.dockEl.classList.remove('active');
        wm.focused = win;
        win.el.classList.add('focused');
        win.dockEl.classList.add('active');
        $('#active-title').textContent = win.title;
      }
      win.onFocus?.();
    };
    win.minimize = () => {
      win.minimized = true;
      win.el.classList.add('minimized');
      win.dockEl.classList.add('minimized');
      win.dockEl.classList.remove('active');
      win.el.classList.remove('focused');
      if (wm.focused === win) {
        wm.focused = null;
        $('#active-title').textContent = '';
        focusTop();
      }
    };
    win.toggleMax = () => {
      win.maximized = !win.maximized;
      win.el.classList.toggle('maximized', win.maximized);
      win.focus();
    };
    win.close = async (force) => {
      if (pinned && !force) return win.minimize();
      if (!force && win.onClose && (await win.onClose()) === false) return false;
      win.destroy?.();
      win.el.remove();
      win.dockEl.remove();
      wm.wins.splice(wm.wins.indexOf(win), 1);
      if (wm.focused === win) {
        wm.focused = null;
        $('#active-title').textContent = '';
        focusTop();
      }
      return true;
    };

    win.el.addEventListener('pointerdown', () => {
      if (wm.focused !== win) win.focus();
    }, true);
    bar.addEventListener('dblclick', (ev) => {
      if (!ev.target.closest('.traffic')) win.toggleMax();
    });
    bar.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('.traffic') || win.maximized) return;
      dragRect(ev, win, 'move');
    });
    for (const handle of win.el.querySelectorAll('.rs')) {
      handle.addEventListener('pointerdown', (ev) => {
        if (ev.button === 0) dragRect(ev, win, handle.dataset.dir);
      });
    }

    winLayer.append(win.el);
    wm.wins.push(win);
    win.focus();
    return win;
  }

  function focusTop() {
    const next = wm.wins.filter((w) => !w.minimized).sort((a, b) => b.el.style.zIndex - a.el.style.zIndex)[0];
    if (next) next.focus();
  }

  function dragRect(ev, win, mode) {
    ev.preventDefault();
    const el = win.el;
    const area = winLayer.getBoundingClientRect();
    const start = { x: ev.clientX, y: ev.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    const MIN_W = 320;
    const MIN_H = 200;
    document.body.classList.add('dragging');
    const move = (e) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      let { l, t, w, h: hh } = start;
      if (mode === 'move') {
        l += dx;
        t += dy;
        l = Math.max(80 - w, Math.min(l, area.width - 80));
        t = Math.max(0, Math.min(t, area.height - 34));
      } else {
        if (mode.includes('e')) w = Math.max(MIN_W, start.w + dx);
        if (mode.includes('s')) hh = Math.max(MIN_H, start.h + dy);
        if (mode.includes('w')) {
          w = Math.max(MIN_W, start.w - dx);
          l = start.l + start.w - w;
        }
        if (mode.includes('n')) {
          hh = Math.max(MIN_H, Math.min(start.h - dy, start.t + start.h));
          t = start.t + start.h - hh;
        }
      }
      Object.assign(el.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: hh + 'px' });
    };
    const up = () => {
      document.body.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ------------------------------------------------------------------- finder
  let finder = null;

  function createFinder(home) {
    const win = createWindow({ title: 'Finder', iconHtml: folderSvg(), width: 860, height: 540, pinned: true });
    const st = {
      path: home,
      history: [],
      hIndex: -1,
      entries: [],
      shown: [],
      selected: -1,
      token: 0,
      view: store.get('view', 'grid'),
      showHidden: store.get('showHidden', false),
      sort: store.get('sort', { key: 'name', dir: 1 }),
    };

    const btn = (icon, title, onclick) => h('button', { type: 'button', class: 'tb-btn', title, 'aria-label': title, html: icon, onclick });
    const bBack = btn(ICON.back, '上一頁', () => go(-1));
    const bFwd = btn(ICON.fwd, '下一頁', () => go(1));
    const bUp = btn(ICON.up, '上層資料夾', () => navigate(P.parent(st.path)));
    const bRefresh = btn(ICON.refresh, '重新整理', () => navigate(st.path, false));
    const bHidden = btn(ICON.eye, '顯示隱藏檔', () => {
      st.showHidden = !st.showHidden;
      store.set('showHidden', st.showHidden);
      render();
    });
    const bGrid = btn(ICON.grid, '圖示檢視', () => setView('grid'));
    const bList = btn(ICON.list, '列表檢視', () => setView('list'));
    const crumbs = h('div', { class: 'crumbs', title: '點空白處可直接輸入路徑' });
    const side = h('aside', { class: 'sidebar' });
    const files = h('div', { class: 'files', tabindex: '0' });
    const status = h('span');
    const statusPath = h('span', { class: 'path' });

    win.body.append(
      h('div', { class: 'finder-toolbar' }, bBack, bFwd, bUp, crumbs, bRefresh, bHidden, bGrid, bList),
      h('div', { class: 'finder-main' }, side, files),
      h('div', { class: 'statusbar' }, status, h('span', { class: 'spacer' }), statusPath));

    const places = [
      { label: '家目錄', path: home, icon: ICON.home },
      { label: '根目錄', path: '/', icon: ICON.disk },
      { label: 'tmp', path: '/tmp', icon: ICON.folder },
      { label: 'etc', path: '/etc', icon: ICON.folder },
      { label: 'var', path: '/var', icon: ICON.folder },
    ];
    side.append(h('h3', null, '位置'), ...places.map((p) => {
      p.el = h('button', { type: 'button', title: p.path, onclick: () => navigate(p.path) }, h('span', { html: p.icon, style: 'display:flex' }), h('span', null, p.label));
      return p.el;
    }));

    function setView(v) {
      st.view = v;
      store.set('view', v);
      render();
    }

    function go(delta) {
      const i = st.hIndex + delta;
      if (i < 0 || i >= st.history.length) return;
      st.hIndex = i;
      navigate(st.history[i], false);
    }

    async function navigate(path, push = true) {
      path = P.norm(path);
      const token = ++st.token;
      files.replaceChildren(h('div', { class: 'state' }, '讀取中…'));
      try {
        const res = await rpc('list', { path });
        if (token !== st.token) return;
        if (push && st.history[st.hIndex] !== path) {
          st.history.splice(st.hIndex + 1);
          st.history.push(path);
          st.hIndex = st.history.length - 1;
        }
        st.path = path;
        st.entries = res.entries;
        st.selected = -1;
        render();
        files.scrollTop = 0;
      } catch (err) {
        if (token !== st.token) return;
        files.replaceChildren(h('div', { class: 'state err' }, `無法開啟 ${path}：${errText(err)}`));
        status.textContent = '';
        renderChrome(path);
      }
    }

    function isDir(e) {
      return e.type === 'dir' || (e.type === 'link' && e.targetType === 'dir');
    }

    function kind(e) {
      if (isDir(e)) return e.type === 'link' ? '資料夾捷徑' : '資料夾';
      if (e.type === 'link') return e.targetType === 'broken' ? '失效捷徑' : '捷徑';
      if (e.type !== 'file') return '特殊檔';
      const ext = P.ext(e.name);
      return ext ? ext.toUpperCase() + ' 檔' : '檔案';
    }

    function renderChrome(path) {
      bBack.disabled = st.hIndex <= 0;
      bFwd.disabled = st.hIndex >= st.history.length - 1;
      bUp.disabled = path === '/';
      bHidden.classList.toggle('on', st.showHidden);
      bGrid.classList.toggle('on', st.view === 'grid');
      bList.classList.toggle('on', st.view === 'list');
      for (const p of places) p.el.classList.toggle('current', p.path === path);
      const parts = path.split('/').filter(Boolean);
      const kids = [h('button', { type: 'button', onclick: () => navigate('/') }, '/')];
      parts.forEach((part, i) => {
        if (i) kids.push(h('span', { class: 'sep' }, '›'));
        kids.push(h('button', { type: 'button', title: part, onclick: () => navigate('/' + parts.slice(0, i + 1).join('/')) }, part));
      });
      crumbs.replaceChildren(...kids);
      statusPath.textContent = path;
      win.setTitle(P.base(path) === '/' ? 'Finder' : P.base(path));
    }

    crumbs.addEventListener('click', (ev) => {
      if (ev.target !== crumbs) return;
      const input = h('input', { value: st.path, spellcheck: 'false', 'aria-label': '路徑' });
      const finish = (commit) => {
        if (!input.isConnected) return;
        const v = input.value.trim();
        renderChrome(st.path);
        if (commit && v) navigate(v.startsWith('/') ? v : P.join(st.path, v));
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(false));
      crumbs.replaceChildren(input);
      input.focus();
      input.select();
    });

    function render() {
      renderChrome(st.path);
      const { key, dir } = st.sort;
      const cmp = (a, b) => {
        const d = isDir(b) - isDir(a);
        if (d) return d;
        let r = 0;
        if (key === 'size') r = a.size - b.size;
        else if (key === 'mtime') r = a.mtime - b.mtime;
        else if (key === 'kind') r = kind(a).localeCompare(kind(b), 'zh-Hant');
        return (r || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })) * dir;
      };
      st.shown = st.entries.filter((e) => st.showHidden || !e.name.startsWith('.')).sort(cmp);
      files.className = 'files ' + st.view;
      const hidden = st.entries.length - st.shown.length;
      status.textContent = `${st.shown.length} 個項目` + (hidden ? `（另有 ${hidden} 個隱藏項目）` : '');
      if (!st.shown.length) {
        files.replaceChildren(h('div', { class: 'empty' }, hidden ? '這個資料夾只有隱藏檔' : '這個資料夾是空的'));
        return;
      }
      const head = (k, label) => h('button', {
        type: 'button',
        class: st.sort.key === k ? 'sorted' : '',
        onclick: () => {
          st.sort = { key: k, dir: st.sort.key === k ? -st.sort.dir : 1 };
          store.set('sort', st.sort);
          render();
        },
      }, label + (st.sort.key === k ? (st.sort.dir > 0 ? ' ▲' : ' ▼') : ''));
      const items = st.shown.map((e, i) => {
        const icon = isDir(e) ? folderSvg() : fileSvg(e.name);
        const el = h('div', { class: 'item' + (e.name.startsWith('.') ? ' hiddenfile' : ''), 'data-i': i, title: e.name },
          st.view === 'list'
            ? [h('div', { class: 'namecell' }, h('span', { html: icon, style: 'display:flex' }), h('span', { class: 'name' }, e.name)),
              h('span', { class: 'meta' }, fmtTime(e.mtime)),
              h('span', { class: 'meta' }, isDir(e) ? '—' : fmtSize(e.size)),
              h('span', { class: 'meta' }, kind(e))]
            : [h('span', { html: icon, style: 'display:flex' }), h('span', { class: 'name' }, e.name)]);
        return el;
      });
      files.replaceChildren(
        h('div', { class: 'list-head' }, head('name', '名稱'), head('mtime', '修改日期'), head('size', '大小'), head('kind', '種類')),
        h('div', { class: 'items' }, items));
      select(st.selected);
    }

    function select(i) {
      st.selected = i;
      files.querySelectorAll('.item.selected').forEach((el) => el.classList.remove('selected'));
      const el = files.querySelector(`.item[data-i="${i}"]`);
      if (el) {
        el.classList.add('selected');
        el.scrollIntoView({ block: 'nearest' });
      }
    }

    function open(e) {
      if (!e) return;
      const full = P.join(st.path, e.name);
      if (isDir(e)) return navigate(full);
      if (e.type === 'file' || (e.type === 'link' && e.targetType === 'file')) return openEditor(full, e.size);
      toast(`無法開啟「${e.name}」：${kind(e)}`, true);
    }

    files.addEventListener('click', (ev) => {
      const el = ev.target.closest('.item');
      select(el ? Number(el.dataset.i) : -1);
    });
    files.addEventListener('dblclick', (ev) => {
      const el = ev.target.closest('.item');
      if (el) open(st.shown[Number(el.dataset.i)]);
    });
    files.addEventListener('keydown', (ev) => {
      const n = st.shown.length;
      if (ev.key === 'Enter') open(st.shown[st.selected]);
      else if (ev.key === 'Backspace') navigate(P.parent(st.path));
      else if (n && (ev.key === 'ArrowDown' || ev.key === 'ArrowRight')) select(Math.min(n - 1, st.selected + 1));
      else if (n && (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft')) select(Math.max(0, st.selected - 1));
      else return;
      ev.preventDefault();
    });

    win.onFocus = () => {
      if (!win.el.contains(document.activeElement)) files.focus({ preventScroll: true });
    };
    win.navigate = navigate;
    navigate(home);
    return win;
  }

  // ------------------------------------------------------------ text encoding
  let big5Table = null;
  function big5Encoder() {
    if (big5Table) return big5Table;
    // Browsers can decode Big5 but not encode it, so build the reverse table
    // from the decoder (same range and duplicate rules as the WHATWG encoder).
    const map = new Map();
    const dec = new TextDecoder('big5');
    const pair = new Uint8Array(2);
    const preferLast = new Set(['═', '╞', '╡', '╪', '十', '卅']);
    for (let lead = 0xa1; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail > 0x7e && trail < 0xa1) continue;
        pair[0] = lead;
        pair[1] = trail;
        const s = dec.decode(pair);
        if (s.includes('�') || [...s].length !== 1) continue;
        if (!map.has(s) || preferLast.has(s)) map.set(s, (lead << 8) | trail);
      }
    }
    return (big5Table = map);
  }

  function decodeText(bytes) {
    const probe = bytes.subarray(0, 8192);
    if (probe.includes(0)) return null;
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8', bom };
    } catch {
      /* not UTF-8 */
    }
    try {
      return { text: new TextDecoder('big5', { fatal: true }).decode(bytes), encoding: 'Big5', bom: false };
    } catch {
      return null;
    }
  }

  function encodeText(text, encoding, bom) {
    if (encoding === 'UTF-8') {
      const body = new TextEncoder().encode(text);
      if (!bom) return body;
      const out = new Uint8Array(body.length + 3);
      out.set([0xef, 0xbb, 0xbf]);
      out.set(body, 3);
      return out;
    }
    const table = big5Encoder();
    const out = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else {
        const v = table.get(ch);
        if (v == null) throw appError('unencodable', `字元「${ch}」無法用 Big5 儲存`);
        out.push(v >> 8, v & 0xff);
      }
    }
    return Uint8Array.from(out);
  }

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // ------------------------------------------------------------------- monaco
  let monacoPromise = null;
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  const themeName = () => (darkQuery.matches ? 'vs-dark' : 'vs');

  function loadMonaco() {
    if (monacoPromise) return monacoPromise;
    monacoPromise = new Promise((resolve, reject) => {
      // Absolute URL: the language-service web workers resolve it from a blob: context.
      window.require.config({ paths: { vs: location.origin + '/vs' }, 'vs/nls': { availableLanguages: { '*': 'zh-tw' } } });
      window.require(['vs/editor/editor.main'], () => {
        const monaco = window.monaco;
        const ts = monaco.languages.typescript;
        for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
          d.setCompilerOptions({
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            allowNonTsExtensions: true,
            allowJs: true,
            jsx: ts.JsxEmit.Preserve,
            noEmit: true,
          });
          // Each file is checked alone (its imports are not on this machine),
          // so silence "cannot find module / node types" noise.
          d.setDiagnosticsOptions({ diagnosticCodesToIgnore: [2307, 2792, 7016, 2580, 2591, 2688] });
        }
        darkQuery.addEventListener('change', () => monaco.editor.setTheme(themeName()));
        resolve(monaco);
      }, reject);
    });
    monacoPromise.catch(() => {
      monacoPromise = null;
    });
    return monacoPromise;
  }

  const NAME_LANG = {
    '.bashrc': 'shell', '.bash_profile': 'shell', '.bash_logout': 'shell', '.profile': 'shell', '.zshrc': 'shell',
    '.gitconfig': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', '.env': 'ini',
    makefile: 'makefile', dockerfile: 'dockerfile',
  };
  const EXT_LANG = { conf: 'ini', cfg: 'ini', service: 'ini', asp: 'html', asa: 'html', inc: 'php', jsonc: 'json', mjs: 'javascript', cjs: 'javascript', env: 'ini' };

  // ------------------------------------------------------------------ editors
  const editors = new Map(); // remote path -> editor record

  async function openEditor(path, size) {
    const existing = editors.get(path);
    if (existing) return existing.win.focus();
    if (size > 5 * 1024 * 1024) return toast(`「${P.base(path)}」太大（${fmtSize(size)}），編輯器上限是 5 MB`, true);

    const name = P.base(path);
    const win = createWindow({ title: name, iconHtml: fileSvg(name), width: 820, height: 560 });
    const host = h('div', { class: 'editor-host' }, h('div', { class: 'editor-loading' }, '開啟中…'));
    const sPos = h('span');
    const sLang = h('span');
    const sEnc = h('span');
    const sEol = h('span');
    const sState = h('span');
    const sWrap = h('button', { type: 'button', title: '切換自動換行（Alt+Z）' });
    win.body.append(host, h('div', { class: 'statusbar' }, sState, h('span', { class: 'path', title: path }, path), h('span', { class: 'spacer' }), sPos, sWrap, sEol, sEnc, sLang));
    const ed = { path, win, editor: null, model: null, saving: false };
    editors.set(path, ed);
    win.destroy = () => {
      editors.delete(path);
      ed.editor?.dispose();
      ed.model?.dispose();
    };

    let monaco, res;
    try {
      [monaco, res] = await Promise.all([loadMonaco(), rpc('read', { path })]);
    } catch (err) {
      await win.close(true);
      return toast(`無法開啟「${name}」：${errText(err)}`, true);
    }
    if (!editors.has(path)) return; // closed while loading
    const decoded = decodeText(fromBase64(res.data));
    if (!decoded) {
      await win.close(true);
      return toast(`「${name}」不是文字檔，無法在編輯器中開啟`, true);
    }
    Object.assign(ed, { encoding: decoded.encoding, bom: decoded.bom, mtime: res.mtime });

    const uri = monaco.Uri.from({ scheme: 'sftp', authority: 'remote', path });
    monaco.editor.getModel(uri)?.dispose();
    const lang = NAME_LANG[name.toLowerCase()] || EXT_LANG[P.ext(name)];
    const model = (ed.model = monaco.editor.createModel(decoded.text, lang, uri));
    host.replaceChildren();
    const editor = (ed.editor = monaco.editor.create(host, {
      model,
      theme: themeName(),
      automaticLayout: true,
      fontSize: 13,
      wordWrap: store.get('wordWrap', 'off'),
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      renderWhitespace: 'selection',
      smoothScrolling: true,
    }));
    ed.savedVersion = model.getAlternativeVersionId();

    const isDirty = () => model.getAlternativeVersionId() !== ed.savedVersion;
    const refresh = () => {
      const dirty = isDirty();
      win.setTitle((dirty ? '● ' : '') + name);
      win.setDirty(dirty);
      sState.textContent = ed.saving ? '儲存中…' : dirty ? '已修改' : '已儲存';
      sState.className = dirty ? 'dirty-flag' : '';
      const pos = editor.getPosition();
      sPos.textContent = pos ? `第 ${pos.lineNumber} 行，第 ${pos.column} 欄` : '';
      sLang.textContent = model.getLanguageId();
      sEnc.textContent = ed.encoding + (ed.bom ? ' BOM' : '');
      sEol.textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
      sWrap.textContent = editor.getRawOptions().wordWrap === 'on' ? '換行：開' : '換行：關';
    };
    ed.isDirty = isDirty;

    ed.save = async (force) => {
      if (ed.saving) return false;
      let bytes;
      try {
        bytes = encodeText(model.getValue(), ed.encoding, ed.bom);
      } catch (err) {
        toast(`無法儲存「${name}」：${err.message}`, true);
        return false;
      }
      const version = model.getAlternativeVersionId();
      ed.saving = true;
      refresh();
      try {
        const r = await rpc('write', { path, data: toBase64(bytes), expectMtime: ed.mtime, force: !!force });
        ed.mtime = r.mtime;
        ed.savedVersion = version;
        return true;
      } catch (err) {
        if (err.code === 'changed-on-server') {
          ed.saving = false;
          const choice = await dialog({
            title: '主機上的檔案已被修改',
            message: `「${name}」在你開啟之後，主機上的內容有變動。要用你的版本覆寫嗎？`,
            buttons: [{ label: '取消', value: false, cancel: true }, { label: '覆寫', value: true, danger: true, default: true }],
          });
          return choice ? ed.save(true) : false;
        }
        toast(`無法儲存「${name}」：${errText(err)}`, true);
        return false;
      } finally {
        ed.saving = false;
        refresh();
      }
    };

    const toggleWrap = () => {
      const next = editor.getRawOptions().wordWrap === 'on' ? 'off' : 'on';
      store.set('wordWrap', next);
      for (const other of editors.values()) other.editor?.updateOptions({ wordWrap: next });
      for (const other of editors.values()) other.refresh?.();
    };
    ed.refresh = refresh;
    sWrap.addEventListener('click', toggleWrap);

    const { KeyMod, KeyCode } = monaco;
    editor.addAction({ id: 'sshdesk.save', label: '儲存到主機', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS], run: () => ed.save() });
    editor.addAction({ id: 'sshdesk.toggleWordWrap', label: '切換自動換行', keybindings: [KeyMod.Alt | KeyCode.KeyZ], run: toggleWrap });
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => editor.trigger('keyboard', 'redo', null));

    model.onDidChangeContent(refresh);
    model.onDidChangeLanguage(refresh);
    editor.onDidChangeCursorPosition(refresh);

    win.onFocus = () => editor.focus();
    win.onClose = async () => {
      if (!isDirty()) return true;
      win.focus();
      const choice = await dialog({
        title: `要儲存「${name}」的修改嗎？`,
        message: '不儲存的話，修改的內容會遺失。',
        buttons: [
          { label: '不儲存', value: 'discard', danger: true },
          { label: '取消', value: 'cancel', cancel: true },
          { label: '儲存', value: 'save', default: true },
        ],
      });
      if (choice === 'discard') return true;
      if (choice === 'save') return ed.save();
      return false;
    };
    refresh();
    if (wm.focused === win) editor.focus();
  }

  // Ctrl/Cmd+S anywhere saves the focused editor instead of the browser's "save page".
  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      if (ev.target.closest?.('.monaco-editor')) return; // Monaco's own keybinding handles it
      for (const ed of editors.values()) if (ed.win === wm.focused) ed.save?.();
    }
  });

  // Monaco rejects in-flight language-service requests with "Canceled" when a
  // model is closed; that is expected, so keep it out of the console.
  window.addEventListener('unhandledrejection', (ev) => {
    if (ev.reason?.name === 'Canceled') ev.preventDefault();
  });

  window.addEventListener('beforeunload', (ev) => {
    if ([...editors.values()].some((ed) => ed.isDirty?.())) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  // ------------------------------------------------------------------ desktop
  function enterDesktop() {
    $('#desktop').hidden = false;
    $('#conn-label').textContent = `${conn.info.username}@${conn.info.host}${conn.info.port === 22 ? '' : ':' + conn.info.port}`;
    if (!finder) {
      finder = createFinder(conn.info.home);
      loadMonaco().catch(() => {}); // warm up so the first file opens quickly
    } else {
      finder.navigate(finder.el.querySelector('.statusbar .path').textContent, false);
    }
  }

  $('#disconnect').addEventListener('click', async () => {
    const dirty = [...editors.values()].filter((ed) => ed.isDirty?.()).length;
    if (dirty) {
      const ok = await dialog({
        title: '確定要中斷連線嗎？',
        message: `還有 ${dirty} 個檔案尚未儲存，中斷後修改會遺失。`,
        buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '中斷連線', value: true, danger: true }],
      });
      if (!ok) return;
    }
    conn.closing = true;
    conn.info = null;
    setKey('', '');
    conn.ws?.close();
    for (const win of [...wm.wins]) await win.close(true);
    dock.replaceChildren();
    finder = null;
    wm.cascade = 0;
    $('#desktop').hidden = true;
    showLogin();
  });

  // --------------------------------------------------------------------- boot
  const last = store.get('last', null);
  if (last) {
    fHost.value = last.host || '';
    fPort.value = last.port || 22;
    fUser.value = last.username || '';
  }
  showLogin();
})();
