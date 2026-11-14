// 檔案櫃: Finder-style browser for the remote file system, with right-click
// menus for open / open with / copy / cut / paste / delete / properties.
import './i18n.js'; // this app's texts in the other languages
import { h } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { fmtSize, fmtTime } from '../../core/format.js';
import { P, freeName, isInvisible } from '../../core/path.js';
import { ICON, folderSvg, fileSvg } from '../../core/icons.js';
import { fileCabinetSvg } from './icon.js';
import { conn, rpc } from '../../core/rpc.js';
import { on, emit } from '../../core/events.js';
import { rawSettings } from '../../core/settings.js';
import { appStore } from '../../core/app-store.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, launchApp, getApp, useAppStyle } from '../../shell/apps.js';
import { makeDraggable, registerDropTarget } from '../../shell/drag.js';
import { attachMarquee } from '../../shell/marquee.js';
import { acceptsDrop, dropAction, dropInto } from '../../shell/file-drop.js';
import { shortcutKind, readShortcut } from '../../shell/shortcuts.js';
import { isPinned, pinApp } from '../../shell/start-menu.js';
import { openFile, openWith } from '../../shell/file-open.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { putFiles, takeFiles, clearFiles, cutPaths } from './clipboard.js';
import { tt, tm } from '../../core/i18n.js';

useAppStyle(import.meta.url);

const finders = new Set(); // every open file cabinet window

// List-view columns: default widths and how narrow / wide they may be dragged.
const COLS = { name: 260, mtime: 150, size: 90, kind: 100 };
const COL_MIN = 60;
const DEFAULT_SIDEBAR_W = 150;
const SIDEBAR_MIN = 110;
const SIDEBAR_MAX = 420;
const clampSide = (w) => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Number(w) || DEFAULT_SIDEBAR_W)));

// Saved in ~/.remosh-gui/app/files/. Earlier versions kept the sidebar in the
// system settings and the view options in the browser; those are brought over once.
const data = appStore('files', {
  defaults: { sidebar: null, sidebarWidth: DEFAULT_SIDEBAR_W, view: 'grid', cols: {}, showHidden: false, sort: { key: 'name', dir: 1 } },
  migrate() {
    const old = rawSettings().files || {};
    const out = {};
    if (Array.isArray(old.sidebar)) out.sidebar = [...new Set(old.sidebar.filter((p) => typeof p === 'string' && p.startsWith('/')))];
    if (Number.isFinite(old.sidebarWidth)) out.sidebarWidth = clampSide(old.sidebarWidth);
    for (const key of ['view', 'cols', 'showHidden', 'sort']) {
      const v = store.get(key, undefined);
      if (v !== undefined) out[key] = v;
      store.remove(key);
    }
    return out;
  },
});
const COL_MAX = 900;

function createFinder(home, startPath = home) {
  const win = createWindow({ title: tt('檔案櫃'), appName: tm('檔案櫃'), iconHtml: fileCabinetSvg(), width: 860, height: 540 });
  const st = {
    path: home,
    history: [],
    hIndex: -1,
    entries: [],
    shown: [],
    selected: -1,
    sel: new Set(),
    token: 0,
    view: data.get('view') === 'list' ? 'list' : 'grid',
    cols: { ...COLS, ...data.get('cols') }, // list-view column widths in px
    showHidden: data.get('showHidden') === true,
    sort: data.get('sort'),
  };

  const btn = (icon, title, onclick) => h('button', { type: 'button', class: 'tb-btn', title, 'aria-label': title, html: icon, onclick });
  const bBack = btn(ICON.back, tt('上一頁'), () => go(-1));
  const bFwd = btn(ICON.fwd, tt('下一頁'), () => go(1));
  const bUp = btn(ICON.up, tt('上層資料夾'), () => navigate(P.parent(st.path)));
  const bRefresh = btn(ICON.refresh, tt('重新整理'), () => navigate(st.path, false));
  const bHidden = btn(ICON.eye, tt('顯示隱藏檔'), () => {
    st.showHidden = !st.showHidden;
    data.set('showHidden', st.showHidden);
    render();
  });
  const bGrid = btn(ICON.grid, tt('圖示檢視'), () => setView('grid'));
  const bList = btn(ICON.list, tt('列表檢視'), () => setView('list'));
  const crumbs = h('div', { class: 'crumbs', title: tt('點空白處可直接輸入路徑') });
  const side = h('aside', { class: 'sidebar' });
  const sideGrip = h('div', { class: 'side-resize', title: tt('拖曳調整寬度，點兩下還原'), 'data-no-marquee': '' });
  const files = h('div', { class: 'files', tabindex: '0' });
  const status = h('span');
  const statusPath = h('span', { class: 'path' });

  win.body.append(
    h('div', { class: 'finder-toolbar' }, bBack, bFwd, bUp, crumbs, bRefresh, bHidden, bGrid, bList),
    h('div', { class: 'finder-main' }, side, sideGrip, files),
    h('div', { class: 'statusbar' }, status, h('span', { class: 'spacer' }), statusPath));

  // ---- sidebar: the user's folders (settings), editable by right-click
  const defaultPlaces = [home, '/', '/tmp', '/etc', '/var'];
  const sidebarPaths = () => data.get('sidebar') || defaultPlaces;
  const placeLabel = (p) => (p === home ? tt('家目錄') : p === '/' ? tt('根目錄') : P.base(p));
  const placeIcon = (p) => (p === home ? ICON.home : p === '/' ? ICON.disk : ICON.folder);
  function renderSidebar() {
    side.style.width = clampSide(data.get('sidebarWidth')) + 'px';
    side.replaceChildren(h('h3', null, tt('位置')), ...sidebarPaths().map((p) =>
      h('button', { type: 'button', title: p, 'data-path': p, class: p === st.path ? 'current' : '', onclick: () => navigate(p) },
        h('span', { html: placeIcon(p), style: 'display:flex' }), h('span', null, placeLabel(p)))));
  }
  // Saved with the app's data, so every file cabinet window follows along.
  const setSidebarWidth = (width) => data.set('sidebarWidth', clampSide(width));
  const setSidebar = (paths) => (paths ? data.set('sidebar', paths) : data.remove('sidebar'));
  const moveTo = (paths, path, index) => {
    const next = paths.filter((p) => p !== path);
    next.splice(index, 0, path);
    setSidebar(next);
  };
  side.addEventListener('contextmenu', (ev) => {
    const paths = sidebarPaths();
    const target = ev.target.closest('button[data-path]')?.dataset.path;
    showContextMenu(ev, [
      target && { label: tt('開啟'), run: () => navigate(target) },
      target && { label: tt('上移'), enabled: paths.indexOf(target) > 0, run: () => moveTo(paths, target, paths.indexOf(target) - 1) },
      target && { label: tt('下移'), enabled: paths.indexOf(target) < paths.length - 1, run: () => moveTo(paths, target, paths.indexOf(target) + 1) },
      target && null,
      target && { label: tt('從側邊欄移除'), run: () => setSidebar(paths.filter((p) => p !== target)) },
      target && null,
      { label: tt('加入目前的資料夾（{0}）', placeLabel(st.path)), enabled: !paths.includes(st.path), run: () => setSidebar([...paths, st.path]) },
      { label: tt('還原成預設'), enabled: data.has('sidebar'), run: () => setSidebar(null) },
    ].filter((x) => x !== undefined && x !== false));
  });
  const offSettings = data.onChange(renderSidebar);
  // Drag a place to reorder the list; drop a folder here to add it.
  makeDraggable(side, (ev) => {
    const path = ev.target.closest('button[data-path]')?.dataset.path;
    return path ? { type: 'place', name: placeLabel(path), icon: folderSvg(), data: { path } } : null;
  });
  // Where a drop would land: before the first entry whose middle is below the pointer.
  const dropIndex = (y) => {
    const buttons = [...side.querySelectorAll('button[data-path]')];
    const i = buttons.findIndex((b) => {
      const r = b.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    return i < 0 ? buttons.length : i;
  };
  // A line between the entries shows where it will go.
  const marker = h('div', { class: 'side-insert' });
  const offSideDrop = registerDropTarget(side, {
    accepts: (payload) => payload.type === 'place' || (payload.type === 'file' && payload.data.isDir),
    action: (payload) => (payload.type === 'place' ? tt('移動') : tt('加到側邊欄')),
    onOver(_payload, at) {
      const buttons = [...side.querySelectorAll('button[data-path]')];
      const i = dropIndex(at.clientY);
      const ref = buttons[i] || buttons[buttons.length - 1];
      if (!ref) return marker.remove();
      const top = buttons[i] ? ref.offsetTop - 1 : ref.offsetTop + ref.offsetHeight + 1;
      marker.style.top = top + 'px';
      if (!marker.isConnected) side.append(marker);
    },
    onLeave: () => marker.remove(),
    onDrop(payload, drop) {
      const paths = [...sidebarPaths()];
      let index = dropIndex(drop.clientY);
      const from = paths.indexOf(payload.data.path);
      if (payload.type === 'place') {
        if (from < 0) return;
        paths.splice(from, 1);
        if (from < index) index--;
      } else if (from >= 0) return toast(tt('這個資料夾已經在側邊欄了'));
      paths.splice(index, 0, payload.data.path);
      setSidebar(paths);
    },
  });

  // ---- sidebar width: drag the line between the sidebar and the files
  sideGrip.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const start = side.offsetWidth;
    let width = start;
    document.body.classList.add('dragging', 'col-resizing');
    const move = (ev) => {
      width = Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, start + ev.clientX - down.clientX)));
      side.style.width = width + 'px';
    };
    const up = () => {
      document.body.classList.remove('dragging', 'col-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (width !== start) setSidebarWidth(width);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  sideGrip.addEventListener('dblclick', () => setSidebarWidth(DEFAULT_SIDEBAR_W));

  // ---- list view: column widths
  const applyCols = () => files.style.setProperty('--cols', ['name', 'mtime', 'size', 'kind'].map((k) => `${st.cols[k]}px`).join(' '));
  for (const k of Object.keys(COLS)) st.cols[k] = Math.max(COL_MIN, Math.min(COL_MAX, Number(st.cols[k]) || COLS[k]));
  applyCols();
  files.addEventListener('pointerdown', (down) => {
    const grip = down.target.closest('.col-resize');
    if (!grip || down.button !== 0) return;
    down.preventDefault();
    down.stopPropagation();
    const key = grip.dataset.col;
    const startWidth = st.cols[key];
    document.body.classList.add('dragging', 'col-resizing');
    const move = (ev) => {
      st.cols[key] = Math.max(COL_MIN, Math.min(COL_MAX, startWidth + ev.clientX - down.clientX));
      applyCols();
    };
    const up = () => {
      document.body.classList.remove('dragging', 'col-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      data.set('cols', st.cols);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  function setView(v) {
    st.view = v;
    data.set('view', v);
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
    files.replaceChildren(h('div', { class: 'state' }, tt('讀取中…')));
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
      st.sel = new Set();
      render();
      files.scrollTop = 0;
    } catch (err) {
      if (token !== st.token) return;
      files.replaceChildren(h('div', { class: 'state err' }, tt('無法開啟 {0}：{1}', path, errText(err))));
      status.textContent = '';
      renderChrome(path);
    }
  }

  function isDir(e) {
    return e.type === 'dir' || (e.type === 'link' && e.targetType === 'dir');
  }

  function kind(e) {
    if (isDir(e)) return e.type === 'link' ? tt('資料夾捷徑') : tt('資料夾');
    if (e.type === 'link') return e.targetType === 'broken' ? tt('失效捷徑') : tt('捷徑');
    if (e.type !== 'file') return tt('特殊檔');
    const ext = P.ext(e.name);
    return ext ? tt('{0} 檔', ext.toUpperCase()) : tt('檔案');
  }

  function renderChrome(path) {
    bBack.disabled = st.hIndex <= 0;
    bFwd.disabled = st.hIndex >= st.history.length - 1;
    bUp.disabled = path === '/';
    bHidden.classList.toggle('on', st.showHidden);
    bGrid.classList.toggle('on', st.view === 'grid');
    bList.classList.toggle('on', st.view === 'list');
    renderSidebar();
    const parts = path.split('/').filter(Boolean);
    const kids = [h('button', { type: 'button', onclick: () => navigate('/') }, '/')];
    parts.forEach((part, i) => {
      if (i) kids.push(h('span', { class: 'sep' }, '›'));
      kids.push(h('button', { type: 'button', title: part, onclick: () => navigate('/' + parts.slice(0, i + 1).join('/')) }, part));
    });
    crumbs.replaceChildren(...kids);
    statusPath.textContent = path;
    win.setTitle(P.base(path) === '/' ? tt('檔案櫃') : P.base(path));
  }

  crumbs.addEventListener('click', (ev) => {
    if (ev.target !== crumbs) return;
    const input = h('input', { value: st.path, spellcheck: 'false', 'aria-label': tt('路徑') });
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
    const cut = new Set(cutPaths());
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
    const listable = st.entries.filter((e) => !isInvisible(e.name)); // internal files are never shown
    st.shown = listable.filter((e) => st.showHidden || !e.name.startsWith('.')).sort(cmp);
    files.className = 'files ' + st.view;
    const hidden = listable.length - st.shown.length;
    st.statusBase = tt('{0} 個項目', st.shown.length) + (hidden ? tt('（另有 {0} 個隱藏項目）', hidden) : '');
    status.textContent = st.statusBase;
    if (!st.shown.length) {
      files.replaceChildren(h('div', { class: 'empty' }, hidden ? tt('這個資料夾只有隱藏檔') : tt('這個資料夾是空的')));
      return;
    }
    // A header cell: click sorts, the grip at its right edge resizes the column.
    const head = (k, label) => h('div', { class: 'col' },
      h('button', {
        type: 'button',
        class: st.sort.key === k ? 'sorted' : '',
        onclick: () => {
          st.sort = { key: k, dir: st.sort.key === k ? -st.sort.dir : 1 };
          data.set('sort', st.sort);
          render();
        },
      }, label + (st.sort.key === k ? (st.sort.dir > 0 ? ' ▲' : ' ▼') : '')),
      h('span', { class: 'col-resize', 'data-col': k, title: tt('拖曳調整欄寬'), 'aria-hidden': 'true' }));
    const items = st.shown.map((e, i) => {
      const icon = isDir(e) ? folderSvg() : fileSvg(e.name);
      const el = h('div', { class: 'item' + (e.name.startsWith('.') ? ' hiddenfile' : '') + (cut.has(P.join(st.path, e.name)) ? ' cut' : ''), 'data-i': i, title: e.name },
        st.view === 'list'
          ? [h('div', { class: 'namecell' }, h('span', { html: icon, style: 'display:flex' }), h('span', { class: 'name' }, e.name)),
            h('span', { class: 'meta' }, fmtTime(e.mtime)),
            h('span', { class: 'meta' }, isDir(e) ? '—' : fmtSize(e.size)),
            h('span', { class: 'meta' }, kind(e))]
          : [h('span', { html: icon, style: 'display:flex' }), h('span', { class: 'name' }, e.name)]);
      return el;
    });
    files.replaceChildren(
      h('div', { class: 'list-head', 'data-no-marquee': '' }, head('name', tt('名稱')), head('mtime', tt('修改日期')), head('size', tt('大小')), head('kind', tt('種類'))),
      h('div', { class: 'items' }, items));
    paint();
  }

  // ---- selection: st.sel holds the selected names, st.selected is the item
  // last clicked (the cursor for the keyboard and the anchor for Shift).
  function paint() {
    for (const el of files.querySelectorAll('.item')) el.classList.toggle('selected', st.sel.has(st.shown[Number(el.dataset.i)]?.name));
    if (st.statusBase != null && !files.querySelector('.state')) status.textContent = st.statusBase + (st.sel.size > 1 ? tt('，已選取 {0} 個', st.sel.size) : '');
  }
  // Select exactly one item (or none with -1).
  function select(i) {
    st.selected = i;
    st.sel = new Set(st.shown[i] ? [st.shown[i].name] : []);
    paint();
    files.querySelector(`.item[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function toggle(i) {
    const name = st.shown[i].name;
    if (st.sel.has(name)) st.sel.delete(name);
    else st.sel.add(name);
    st.selected = i;
    paint();
  }
  function selectRange(from, to) {
    const [a, b] = from < to ? [from, to] : [to, from];
    st.sel = new Set(st.shown.slice(a, b + 1).map((e) => e.name));
    paint();
  }
  const chosen = () => st.shown.filter((e) => st.sel.has(e.name));

  function open(e) {
    if (!e) return;
    const full = P.join(st.path, e.name);
    if (isDir(e)) return navigate(full);
    if (e.type === 'file' || (e.type === 'link' && e.targetType === 'file')) return openFile(full, e.size);
    toast(tt('無法開啟「{0}」：{1}', e.name, kind(e)), true);
  }

  // Open several items: files in their apps, folders in file cabinet windows of their own.
  async function openMany(list) {
    if (list.length <= 1) return open(list[0]);
    if (list.length > 10) {
      const ok = await dialog({
        title: tt('要一次開啟 {0} 個項目嗎？', list.length),
        message: tt('每個項目都會開一個視窗。'),
        buttons: [{ label: tt('取消'), value: false, cancel: true, default: true }, { label: tt('開啟'), value: true }],
      });
      if (!ok) return;
    }
    for (const e of list) {
      const full = P.join(st.path, e.name);
      if (isDir(e)) launchApp('files', { path: full });
      else if (isFile(e)) await openFile(full, e.size); // one at a time, in case one asks which app to use
    }
  }

  files.addEventListener('click', (ev) => {
    const el = ev.target.closest('.item');
    const i = el ? Number(el.dataset.i) : -1;
    if (i < 0) return select(-1);
    if (ev.shiftKey && st.selected >= 0) selectRange(st.selected, i);
    else if (ev.ctrlKey || ev.metaKey) toggle(i);
    else select(i);
  });
  files.addEventListener('dblclick', (ev) => {
    const el = ev.target.closest('.item');
    if (el) open(st.shown[Number(el.dataset.i)]);
  });
  // ---- actions behind the right-click menus
  const isFile = (e) => e.type === 'file' || (e.type === 'link' && e.targetType === 'file');
  const refresh = () => navigate(st.path, false);

  // ---- live view: quietly re-read the folder every few seconds, so changes
  // made elsewhere (a terminal, another program) show up on their own.
  const signature = (entries) => entries.map((e) => `${e.name}|${e.type}|${e.size}|${e.mtime}|${e.mode}|${e.targetType || ''}`).sort().join('\n');
  let polling = false;
  async function poll() {
    // Not while hidden, loading, or showing an error for this folder.
    if (polling || win.minimized || document.hidden || !conn.ws || files.querySelector('.state')) return;
    polling = true;
    const token = st.token;
    try {
      const res = await rpc('list', { path: st.path });
      if (token !== st.token || signature(res.entries) === signature(st.entries)) return;
      const keep = st.shown[st.selected]?.name;
      const top = files.scrollTop;
      st.entries = res.entries;
      render(); // the selection is by name, so it survives
      st.selected = keep == null ? -1 : st.shown.findIndex((e) => e.name === keep);
      const still = new Set(st.shown.map((e) => e.name));
      st.sel = new Set([...st.sel].filter((name) => still.has(name)));
      paint();
      files.scrollTop = top;
    } catch {
      /* keep what is shown; a manual refresh will report the problem */
    } finally {
      polling = false;
    }
  }
  const pollTimer = setInterval(poll, 4000);

  async function rename(e) {
    const answer = await dialog({
      title: tt('重新命名'),
      message: tt('「{0}」的新名稱：', e.name),
      input: e.name,
      buttons: [{ label: tt('取消'), value: false, cancel: true }, { label: tt('重新命名'), value: true, default: true }],
    });
    const name = answer.value ? answer.text.trim() : '';
    if (!answer.value || name === e.name) return;
    if (!name || name === '.' || name === '..' || name.includes('/')) return toast(tt('名稱不能是空的，也不能包含 /'), true);
    const from = P.join(st.path, e.name);
    const to = P.join(st.path, name);
    try {
      await rpc('move', { from, to });
    } catch (err) {
      return toast(tt('無法重新命名「{0}」：{1}', e.name, errText(err)), true);
    }
    emit('fs:moved', from, to); // open documents follow the file
    emit('fs:changed', st.path);
  }

  // Copy or cut one entry or a list of them.
  async function copyOrCut(mode, what) {
    const list = [what].flat();
    if (!list.length) return;
    await putFiles(mode, list.map((e) => P.join(st.path, e.name)));
    render(); // cut items are dimmed
    const which = list.length > 1 ? tt('{0} 個項目', list.length) : `「${list[0].name}」`;
    toast(mode === 'cut' ? tt('已剪下{0}，到目的資料夾按貼上', which) : tt('已複製{0}', which));
  }

  async function paste() {
    const clip = await takeFiles();
    if (!clip) return toast(tt('剪貼簿裡沒有檔案'), true);
    if (clip.foreign) return toast(tt('不可跨域貼上：這些檔案是從另一台主機或另一個帳號複製的'), true);
    const dir = st.path;
    const taken = new Set(st.entries.map((e) => e.name));
    let done = 0;
    for (const from of clip.paths) {
      const cutting = clip.mode === 'cut';
      if (cutting && P.parent(from) === dir) continue; // already here
      const name = freeName(P.base(from), taken);
      try {
        await rpc(cutting ? 'move' : 'copy', { from, to: P.join(dir, name) });
        taken.add(name);
        done++;
        if (cutting) {
          emit('fs:moved', from, P.join(dir, name));
          emit('fs:changed', P.parent(from));
        }
      } catch (err) {
        toast(tt('無法貼上「{0}」：{1}', P.base(from), errText(err)), true);
      }
    }
    if (clip.mode === 'cut') await clearFiles();
    if (done) emit('fs:changed', dir);
    else render();
  }

  // Delete one entry or a list of them (asks once).
  async function remove(what) {
    const list = [what].flat();
    if (!list.length) return;
    const dirLike = list.some((e) => e.type === 'dir');
    const ok = await dialog({
      title: list.length > 1 ? tt('確定要刪除這 {0} 個項目嗎？', list.length) : tt('確定要刪除「{0}」嗎？', list[0].name),
      message: dirLike ? tt('資料夾裡的所有內容都會一起刪除，而且無法復原。') : tt('刪除後無法復原。'),
      buttons: [{ label: tt('取消'), value: false, cancel: true, default: true }, { label: tt('刪除'), value: true, danger: true }],
    });
    if (!ok) return;
    for (const e of list) {
      try {
        await rpc('remove', { path: P.join(st.path, e.name) });
      } catch (err) {
        toast(tt('無法刪除「{0}」：{1}', e.name, errText(err)), true);
      }
    }
    emit('fs:changed', st.path);
  }

  const modeText = (mode) => {
    const bits = 'rwxrwxrwx';
    const letters = [...bits].map((c, i) => (mode & (1 << (8 - i)) ? c : '-')).join('');
    return `${letters}（${(mode & 0o7777).toString(8).padStart(3, '0')}）`;
  };
  function properties(e, path) {
    const rows = [
      [tt('名稱'), e.name],
      [tt('位置'), P.parent(path)],
      [tt('種類'), kind(e)],
      !isDir(e) && [tt('大小'), tt('{0}（{1} 位元組）', fmtSize(e.size), e.size.toLocaleString())],
      [tt('修改時間'), fmtTime(e.mtime) || '—'],
      [tt('權限'), modeText(e.mode)],
      e.uid != null && [tt('擁有者'), `UID ${e.uid}，GID ${e.gid}`],
    ].filter(Boolean);
    dialog({
      title: tt('「{0}」的內容', e.name),
      message: h('dl', { class: 'props' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      buttons: [{ label: tt('關閉'), value: true, default: true, cancel: true }],
    });
  }
  async function folderProperties() {
    try {
      const res = await rpc('stat', { path: st.path });
      properties({ ...res.entry, name: P.base(st.path) }, st.path);
    } catch (err) {
      toast(tt('無法讀取內容：{0}', errText(err)), true);
    }
  }

  async function newFolder() {
    const answer = await dialog({
      title: tt('新增資料夾'),
      message: tt('資料夾名稱：'),
      input: tt('新資料夾'),
      buttons: [{ label: tt('取消'), value: false, cancel: true }, { label: tt('建立'), value: true, default: true }],
    });
    const name = answer.value ? answer.text.trim() : '';
    if (!answer.value) return;
    if (!name || name === '.' || name === '..' || name.includes('/')) return toast(tt('資料夾名稱不能是空的，也不能包含 /'), true);
    try {
      const res = await rpc('mkdir', { path: P.join(st.path, name), mode: 0o755 });
      if (!res.created) return toast(tt('已經有「{0}」這個資料夾', name), true);
    } catch (err) {
      return toast(tt('無法建立「{0}」：{1}', name, errText(err)), true);
    }
    emit('fs:changed', st.path);
  }

  // ---- drag items out; drop things in (onto a folder = into that folder)
  makeDraggable(files, (ev) => {
    const el = ev.target.closest('.item');
    const e = el && st.shown[Number(el.dataset.i)];
    if (!e) return null;
    const icon = isDir(e) ? folderSvg() : fileSvg(e.name);
    const path = P.join(st.path, e.name);
    // Dragging one of several selected items takes the whole selection along.
    const group = st.sel.has(e.name) && st.sel.size > 1 ? chosen() : [e];
    return {
      type: 'file',
      name: group.length > 1 ? tt('{0} 個項目', group.length) : e.name,
      icon,
      data: { path, paths: group.map((g) => P.join(st.path, g.name)), isDir: isDir(e), size: e.size },
    };
  });
  attachMarquee(files, {
    itemSelector: '.item',
    onChange(elements, { additive, first }) {
      if (first) st.marqueeBase = additive ? new Set(st.sel) : new Set();
      st.sel = new Set([...st.marqueeBase, ...elements.map((el) => st.shown[Number(el.dataset.i)].name)]);
      paint();
    },
  });
  const offDrop = registerDropTarget(files, {
    accepts: acceptsDrop,
    action: dropAction,
    onDrop(payload, drop) {
      const el = drop.target?.closest?.('.item');
      const onto = el && files.contains(el) ? st.shown[Number(el.dataset.i)] : null;
      const dragged = payload.data?.paths || [];
      const dir = onto && isDir(onto) && !dragged.includes(P.join(st.path, onto.name)) ? P.join(st.path, onto.name) : st.path;
      dropInto(dir, payload, drop);
    },
  });

  files.addEventListener('contextmenu', (ev) => {
    const el = ev.target.closest('.item');
    const e = el ? st.shown[Number(el.dataset.i)] : null;
    // Right-click inside a multi-selection acts on all of it.
    if (e && st.sel.has(e.name) && st.sel.size > 1) {
      const list = chosen();
      return showContextMenu(ev, [
        { label: tt('開啟 {0} 個項目', list.length), run: () => openMany(list) },
        null,
        { label: tt('複製 {0} 個項目', list.length), run: () => copyOrCut('copy', list) },
        { label: tt('剪下 {0} 個項目', list.length), run: () => copyOrCut('cut', list) },
        { label: tt('貼上'), run: paste },
        null,
        { label: tt('刪除 {0} 個項目', list.length), danger: true, run: () => remove(list) },
      ]);
    }
    select(el ? Number(el.dataset.i) : -1);
    if (!e) {
      return showContextMenu(ev, [
        { label: tt('新增資料夾'), run: newFolder },
        { label: tt('在這裡開啟終端機'), run: () => launchApp('terminal', { cwd: st.path }) },
        null,
        { label: tt('貼上'), run: paste },
        { label: tt('重新整理'), run: refresh },
        null,
        { label: tt('內容'), run: folderProperties },
      ]);
    }
    const full = P.join(st.path, e.name);
    const paths = sidebarPaths();
    showContextMenu(ev, [
      { label: tt('開啟'), run: () => open(e) },
      isFile(e) && !shortcutKind(e.name) && { label: tt('開啟程式…'), run: () => openWith(full, e.size) },
      shortcutKind(e.name) === 'app' && { label: tt('釘選到開始'), run: async () => {
        try {
          const sc = await readShortcut(full);
          if (sc?.kind !== 'app' || !getApp(sc.id)) return toast(tt('這不是有效的應用程式捷徑'), true);
          if (isPinned(sc.id)) return toast(tt('已經釘選在開始了'));
          pinApp(sc.id);
        } catch (err) {
          toast(tt('無法讀取捷徑：{0}', errText(err)), true);
        }
      } },
      isDir(e) && { label: tt('在終端機開啟'), run: () => launchApp('terminal', { cwd: full }) },
      isDir(e) && { label: tt('加到側邊欄'), enabled: !paths.includes(full), run: () => setSidebar([...paths, full]) },
      null,
      { label: tt('複製'), run: () => copyOrCut('copy', e) },
      { label: tt('剪下'), run: () => copyOrCut('cut', e) },
      { label: tt('貼上'), run: paste },
      null,
      { label: tt('重新命名'), run: () => rename(e) },
      { label: tt('刪除'), danger: true, run: () => remove(e) },
      null,
      { label: tt('內容'), run: () => properties(e, full) },
    ].filter((x) => x !== false));
  });

  files.addEventListener('keydown', (ev) => {
    const n = st.shown.length;
    const mod = ev.ctrlKey || ev.metaKey;
    const picked = chosen();
    if (mod && !ev.altKey && !ev.shiftKey && 'acxv'.includes(ev.key.toLowerCase())) {
      const k = ev.key.toLowerCase();
      if (k === 'v') paste();
      else if (k === 'a') {
        st.sel = new Set(st.shown.map((e) => e.name));
        paint();
      } else if (picked.length) copyOrCut(k === 'x' ? 'cut' : 'copy', picked);
      else return;
    } else if (ev.key === 'Delete' && picked.length) remove(picked);
    else if (ev.key === 'F2' && picked.length === 1) rename(picked[0]);
    else if (ev.key === 'Enter') openMany(picked.length ? picked : [st.shown[st.selected]].filter(Boolean));
    else if (ev.key === 'Backspace') navigate(P.parent(st.path));
    else if (n && (ev.key === 'ArrowDown' || ev.key === 'ArrowRight')) select(Math.min(n - 1, st.selected + 1));
    else if (n && (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft')) select(Math.max(0, st.selected - 1));
    else return;
    ev.preventDefault();
  });

  win.onNavigate = go; // mouse side buttons, Alt+←/→ (shell/navigation.js)
  win.onFocus = () => {
    if (!win.el.contains(document.activeElement)) files.focus({ preventScroll: true });
  };
  win.destroy = () => {
    st.token++; // drop any listing still in flight
    clearInterval(pollTimer);
    offSettings();
    offDrop();
    offSideDrop();
    finders.delete(win);
  };
  win.navigate = navigate;
  win.getPath = () => st.path;
  navigate(startPath);
  return win;
}

// Each launch opens another window; { path } starts it in that folder.
function openFinder({ path } = {}) {
  finders.add(createFinder(conn.info.home, path || conn.info.home));
}

on('fs:changed', (dir) => {
  for (const f of finders) if (f.getPath() === dir) f.navigate(dir, false);
});
on('session:resume', () => {
  for (const f of finders) f.navigate(f.getPath(), false);
});

registerApp({ id: 'files', order: 10, name: tm('檔案櫃'), icon: fileCabinetSvg, startMenu: true, launch: openFinder });
