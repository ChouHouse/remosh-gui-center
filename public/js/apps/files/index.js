// 檔案櫃: Finder-style browser for the remote file system, with right-click
// menus for open / open with / copy / cut / paste / delete / properties.
import { h } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { fmtSize, fmtTime } from '../../core/format.js';
import { P, freeName, isInvisible } from '../../core/path.js';
import { ICON, folderSvg, fileSvg } from '../../core/icons.js';
import { conn, rpc } from '../../core/rpc.js';
import { on, emit } from '../../core/events.js';
import { getSettings, updateSettings } from '../../core/settings.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, launchApp, getApp } from '../../shell/apps.js';
import { makeDraggable, registerDropTarget } from '../../shell/drag.js';
import { attachMarquee } from '../../shell/marquee.js';
import { acceptsDrop, dropAction, dropInto } from '../../shell/file-drop.js';
import { shortcutKind, readShortcut } from '../../shell/shortcuts.js';
import { isPinned, pinApp } from '../../shell/start-menu.js';
import { openFile, openWith } from '../../shell/file-open.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { putFiles, takeFiles, clearFiles, cutPaths } from './clipboard.js';

const finders = new Set(); // every open file cabinet window

function createFinder(home, startPath = home) {
  const win = createWindow({ title: '檔案櫃', appName: '檔案櫃', iconHtml: folderSvg(), width: 860, height: 540 });
  const st = {
    path: home,
    history: [],
    hIndex: -1,
    entries: [],
    shown: [],
    selected: -1,
    sel: new Set(),
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
      st.sel = new Set();
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
    const listable = st.entries.filter((e) => !isInvisible(e.name)); // internal files are never shown
    st.shown = listable.filter((e) => st.showHidden || !e.name.startsWith('.')).sort(cmp);
    files.className = 'files ' + st.view;
    const hidden = listable.length - st.shown.length;
    st.statusBase = `${st.shown.length} 個項目` + (hidden ? `（另有 ${hidden} 個隱藏項目）` : '');
    status.textContent = st.statusBase;
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
    paint();
  }

  // ---- selection: st.sel holds the selected names, st.selected is the item
  // last clicked (the cursor for the keyboard and the anchor for Shift).
  function paint() {
    for (const el of files.querySelectorAll('.item')) el.classList.toggle('selected', st.sel.has(st.shown[Number(el.dataset.i)]?.name));
    if (st.statusBase != null && !files.querySelector('.state')) status.textContent = st.statusBase + (st.sel.size > 1 ? `，已選取 ${st.sel.size} 個` : '');
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
    toast(`無法開啟「${e.name}」：${kind(e)}`, true);
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
      title: '重新命名',
      message: `「${e.name}」的新名稱：`,
      input: e.name,
      buttons: [{ label: '取消', value: false, cancel: true }, { label: '重新命名', value: true, default: true }],
    });
    const name = answer.value ? answer.text.trim() : '';
    if (!answer.value || name === e.name) return;
    if (!name || name === '.' || name === '..' || name.includes('/')) return toast('名稱不能是空的，也不能包含 /', true);
    const from = P.join(st.path, e.name);
    const to = P.join(st.path, name);
    try {
      await rpc('move', { from, to });
    } catch (err) {
      return toast(`無法重新命名「${e.name}」：${errText(err)}`, true);
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
    const which = list.length > 1 ? `${list.length} 個項目` : `「${list[0].name}」`;
    toast(mode === 'cut' ? `已剪下${which}，到目的資料夾按貼上` : `已複製${which}`);
  }

  async function paste() {
    const clip = await takeFiles();
    if (!clip) return toast('剪貼簿裡沒有檔案', true);
    if (clip.foreign) return toast('不可跨域貼上：這些檔案是從另一台主機或另一個帳號複製的', true);
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
        toast(`無法貼上「${P.base(from)}」：${errText(err)}`, true);
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
      title: list.length > 1 ? `確定要刪除這 ${list.length} 個項目嗎？` : `確定要刪除「${list[0].name}」嗎？`,
      message: dirLike ? '資料夾裡的所有內容都會一起刪除，而且無法復原。' : '刪除後無法復原。',
      buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '刪除', value: true, danger: true }],
    });
    if (!ok) return;
    for (const e of list) {
      try {
        await rpc('remove', { path: P.join(st.path, e.name) });
      } catch (err) {
        toast(`無法刪除「${e.name}」：${errText(err)}`, true);
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

  async function newFolder() {
    const answer = await dialog({
      title: '新增資料夾',
      message: '資料夾名稱：',
      input: '新資料夾',
      buttons: [{ label: '取消', value: false, cancel: true }, { label: '建立', value: true, default: true }],
    });
    const name = answer.value ? answer.text.trim() : '';
    if (!answer.value) return;
    if (!name || name === '.' || name === '..' || name.includes('/')) return toast('資料夾名稱不能是空的，也不能包含 /', true);
    try {
      const res = await rpc('mkdir', { path: P.join(st.path, name), mode: 0o755 });
      if (!res.created) return toast(`已經有「${name}」這個資料夾`, true);
    } catch (err) {
      return toast(`無法建立「${name}」：${errText(err)}`, true);
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
      name: group.length > 1 ? `${group.length} 個項目` : e.name,
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
        { label: `複製 ${list.length} 個項目`, run: () => copyOrCut('copy', list) },
        { label: `剪下 ${list.length} 個項目`, run: () => copyOrCut('cut', list) },
        { label: '貼上', run: paste },
        null,
        { label: `刪除 ${list.length} 個項目`, danger: true, run: () => remove(list) },
      ]);
    }
    select(el ? Number(el.dataset.i) : -1);
    if (!e) {
      return showContextMenu(ev, [
        { label: '新增資料夾', run: newFolder },
        { label: '在這裡開啟終端機', run: () => launchApp('terminal', { cwd: st.path }) },
        null,
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
      isFile(e) && !shortcutKind(e.name) && { label: '開啟程式…', run: () => openWith(full, e.size) },
      shortcutKind(e.name) === 'app' && { label: '釘選到開始', run: async () => {
        try {
          const sc = await readShortcut(full);
          if (sc?.kind !== 'app' || !getApp(sc.id)) return toast('這不是有效的應用程式捷徑', true);
          if (isPinned(sc.id)) return toast('已經釘選在開始了');
          pinApp(sc.id);
        } catch (err) {
          toast(`無法讀取捷徑：${errText(err)}`, true);
        }
      } },
      isDir(e) && { label: '在終端機開啟', run: () => launchApp('terminal', { cwd: full }) },
      isDir(e) && { label: '加到側邊欄', enabled: !paths.includes(full), run: () => setSidebar([...paths, full]) },
      null,
      { label: '複製', run: () => copyOrCut('copy', e) },
      { label: '剪下', run: () => copyOrCut('cut', e) },
      { label: '貼上', run: paste },
      null,
      { label: '重新命名', run: () => rename(e) },
      { label: '刪除', danger: true, run: () => remove(e) },
      null,
      { label: '內容', run: () => properties(e, full) },
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
    clearInterval(pollTimer);
    offSettings();
    offDrop();
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

registerApp({ id: 'files', name: '檔案櫃', icon: folderSvg, startMenu: true, launch: openFinder });
