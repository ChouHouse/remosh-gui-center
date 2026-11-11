// 檔案櫃: Finder-style browser for the remote file system, with right-click
// menus for open / open with / copy / cut / paste / delete / properties.
import { h } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { fmtSize, fmtTime } from '../../core/format.js';
import { P } from '../../core/path.js';
import { ICON, folderSvg, fileSvg } from '../../core/icons.js';
import { conn, rpc } from '../../core/rpc.js';
import { on, emit } from '../../core/events.js';
import { getSettings, updateSettings } from '../../core/settings.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp } from '../../shell/apps.js';
import { openFile, openWith } from '../../shell/file-open.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { putFiles, takeFiles, clearFiles, cutPaths } from './clipboard.js';

let finder = null;

function createFinder(home) {
  const win = createWindow({ title: '檔案櫃', appName: '檔案櫃', iconHtml: folderSvg(), width: 860, height: 540 });
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

  // ---- sidebar: the user's folders (settings), editable by right-click
  const defaultPlaces = [home, '/', '/tmp', '/etc', '/var'];
  const sidebarPaths = () => getSettings().files.sidebar || defaultPlaces;
  const placeLabel = (p) => (p === home ? '家目錄' : p === '/' ? '根目錄' : P.base(p));
  const placeIcon = (p) => (p === home ? ICON.home : p === '/' ? ICON.disk : ICON.folder);
  function renderSidebar() {
    side.replaceChildren(h('h3', null, '位置'), ...sidebarPaths().map((p) =>
      h('button', { type: 'button', title: p, 'data-path': p, class: p === st.path ? 'current' : '', onclick: () => navigate(p) },
        h('span', { html: placeIcon(p), style: 'display:flex' }), h('span', null, placeLabel(p)))));
  }
  const setSidebar = (paths) =>
    updateSettings((s) => {
      s.files.sidebar = paths;
    }).catch((err) => toast(`無法儲存側邊欄：${errText(err)}`, true));
  side.addEventListener('contextmenu', (ev) => {
    const paths = sidebarPaths();
    const target = ev.target.closest('button[data-path]')?.dataset.path;
    showContextMenu(ev, [
      target && { label: '開啟', run: () => navigate(target) },
      target && { label: '從側邊欄移除', run: () => setSidebar(paths.filter((p) => p !== target)) },
      target && null,
      { label: `加入目前的資料夾（${placeLabel(st.path)}）`, enabled: !paths.includes(st.path), run: () => setSidebar([...paths, st.path]) },
      { label: '還原成預設', enabled: getSettings().files.sidebar != null, run: () => setSidebar(null) },
    ].filter((x) => x !== undefined && x !== false));
  });
  const offSettings = on('settings:changed', renderSidebar);

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
    renderSidebar();
    const parts = path.split('/').filter(Boolean);
    const kids = [h('button', { type: 'button', onclick: () => navigate('/') }, '/')];
    parts.forEach((part, i) => {
      if (i) kids.push(h('span', { class: 'sep' }, '›'));
      kids.push(h('button', { type: 'button', title: part, onclick: () => navigate('/' + parts.slice(0, i + 1).join('/')) }, part));
    });
    crumbs.replaceChildren(...kids);
    statusPath.textContent = path;
    win.setTitle(P.base(path) === '/' ? '檔案櫃' : P.base(path));
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
    if (e.type === 'file' || (e.type === 'link' && e.targetType === 'file')) return openFile(full, e.size);
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
  // ---- actions behind the right-click menus
  const isFile = (e) => e.type === 'file' || (e.type === 'link' && e.targetType === 'file');
  const refresh = () => navigate(st.path, false);

  async function copyOrCut(mode, e) {
    await putFiles(mode, [P.join(st.path, e.name)]);
    render(); // cut items are dimmed
    toast(mode === 'cut' ? `已剪下「${e.name}」，到目的資料夾按貼上` : `已複製「${e.name}」`);
  }

  // A name that is not taken in this folder: "a.txt" -> "a 複本.txt" -> "a 複本 2.txt".
  function freeName(name, taken) {
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i++) {
      const candidate = `${stem} 複本${i > 1 ? ' ' + i : ''}${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  async function paste() {
    const clip = await takeFiles();
    if (!clip) return toast('剪貼簿裡沒有檔案', true);
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
        if (cutting) emit('fs:changed', P.parent(from));
      } catch (err) {
        toast(`無法貼上「${P.base(from)}」：${errText(err)}`, true);
      }
    }
    if (clip.mode === 'cut') await clearFiles();
    if (done) emit('fs:changed', dir);
    else render();
  }

  async function remove(e) {
    const dirLike = e.type === 'dir';
    const ok = await dialog({
      title: `確定要刪除「${e.name}」嗎？`,
      message: dirLike ? '資料夾裡的所有內容都會一起刪除，而且無法復原。' : '刪除後無法復原。',
      buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '刪除', value: true, danger: true }],
    });
    if (!ok) return;
    try {
      await rpc('remove', { path: P.join(st.path, e.name) });
    } catch (err) {
      toast(`無法刪除「${e.name}」：${errText(err)}`, true);
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
      ['名稱', e.name],
      ['位置', P.parent(path)],
      ['種類', kind(e)],
      !isDir(e) && ['大小', `${fmtSize(e.size)}（${e.size.toLocaleString()} 位元組）`],
      ['修改時間', fmtTime(e.mtime) || '—'],
      ['權限', modeText(e.mode)],
      e.uid != null && ['擁有者', `UID ${e.uid}，GID ${e.gid}`],
    ].filter(Boolean);
    dialog({
      title: `「${e.name}」的內容`,
      message: h('dl', { class: 'props' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      buttons: [{ label: '關閉', value: true, default: true, cancel: true }],
    });
  }
  async function folderProperties() {
    try {
      const res = await rpc('stat', { path: st.path });
      properties({ ...res.entry, name: P.base(st.path) }, st.path);
    } catch (err) {
      toast(`無法讀取內容：${errText(err)}`, true);
    }
  }

  files.addEventListener('contextmenu', (ev) => {
    const el = ev.target.closest('.item');
    const e = el ? st.shown[Number(el.dataset.i)] : null;
    select(el ? Number(el.dataset.i) : -1);
    if (!e) {
      return showContextMenu(ev, [
        { label: '貼上', run: paste },
        { label: '重新整理', run: refresh },
        null,
        { label: '內容', run: folderProperties },
      ]);
    }
    const full = P.join(st.path, e.name);
    const paths = sidebarPaths();
    showContextMenu(ev, [
      { label: '開啟', run: () => open(e) },
      isFile(e) && { label: '開啟程式…', run: () => openWith(full, e.size) },
      isDir(e) && { label: '加到側邊欄', enabled: !paths.includes(full), run: () => setSidebar([...paths, full]) },
      null,
      { label: '複製', run: () => copyOrCut('copy', e) },
      { label: '剪下', run: () => copyOrCut('cut', e) },
      { label: '貼上', run: paste },
      null,
      { label: '刪除', danger: true, run: () => remove(e) },
      null,
      { label: '內容', run: () => properties(e, full) },
    ].filter((x) => x !== false));
  });

  files.addEventListener('keydown', (ev) => {
    const n = st.shown.length;
    const cur = st.shown[st.selected];
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && !ev.altKey && !ev.shiftKey && 'cxv'.includes(ev.key.toLowerCase())) {
      const k = ev.key.toLowerCase();
      if (k === 'v') paste();
      else if (cur) copyOrCut(k === 'x' ? 'cut' : 'copy', cur);
      else return;
    } else if (ev.key === 'Delete' && cur) remove(cur);
    else if (ev.key === 'Enter') open(st.shown[st.selected]);
    else if (ev.key === 'Backspace') navigate(P.parent(st.path));
    else if (n && (ev.key === 'ArrowDown' || ev.key === 'ArrowRight')) select(Math.min(n - 1, st.selected + 1));
    else if (n && (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft')) select(Math.max(0, st.selected - 1));
    else return;
    ev.preventDefault();
  });

  win.onFocus = () => {
    if (!win.el.contains(document.activeElement)) files.focus({ preventScroll: true });
  };
  win.destroy = () => {
    st.token++; // drop any listing still in flight
    offSettings();
    if (finder === win) finder = null;
  };
  win.navigate = navigate;
  win.getPath = () => st.path;
  navigate(home);
  return win;
}

function openFinder() {
  if (finder) finder.focus();
  else finder = createFinder(conn.info.home);
}

on('fs:changed', (dir) => {
  if (finder?.getPath() === dir) finder.navigate(dir, false);
});
on('session:resume', () => finder?.navigate(finder.getPath(), false));

registerApp({ id: 'files', name: '檔案櫃', icon: folderSvg, startMenu: true, launch: openFinder });
