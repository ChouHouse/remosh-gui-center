// One Procoder window: tabs sharing a single Monaco editor, with the file tree
// down the left side. index.js keeps track of the windows.
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { P } from '../../core/path.js';
import { fileSvg } from '../../core/icons.js';
import { copyText } from '../../core/clipboard.js';
import { procoderSvg } from './icon.js';
import { conn, rpc } from '../../core/rpc.js';
import { readFile, writeFile } from '../../core/file-io.js';
import { emit } from '../../core/events.js';
import { decodeText, encodeText } from '../../core/text-codec.js';
import { createWindow, wm } from '../../shell/wm.js';
import { attachMenuBar } from '../../shell/menubar.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { registerDropTarget } from '../../shell/drag.js';
import { pickPath } from '../../shell/picker.js';
import { loadMonaco, themeName, NAME_LANG, EXT_LANG } from './monaco.js';
import { buildWelcome } from './welcome.js';
import { createTree } from './tree.js';
import {
  APP_NAME, UNTITLED, WELCOME, LARGE_FILE_BYTES, FONT_DEFAULT, FONT_MIN, FONT_MAX, SIDE_DEFAULT, clampSide,
  data, prefs, setFontSize, setMinimap, toggleWrap, recentList, remember, forget, sideShown, toggleSide, isFolderRef,
} from './prefs.js';

// ---- documents
const isDirty = (doc) => !!doc.model && doc.model.getAlternativeVersionId() !== doc.savedVersion;
const docIcon = (doc) => (doc.kind === 'welcome' ? procoderSvg() : fileSvg(doc.name));

function langFor(monaco, fileName) {
  const lower = fileName.toLowerCase();
  const known = NAME_LANG[lower] || EXT_LANG[P.ext(fileName)];
  if (known) return known;
  const hit = monaco.languages.getLanguages().find((l) =>
    l.filenames?.some((f) => f.toLowerCase() === lower) || l.extensions?.some((x) => lower.endsWith(x.toLowerCase())));
  return hit?.id || 'plaintext';
}

const movedPath = (path, from, to) => (path === from ? to : path?.startsWith(from + '/') ? to + path.slice(from.length) : null);

// hub (index.js) knows every Procoder window:
//   hub.owner(path)     -> { inst, doc } when some window has that file open
//   hub.newWindow()     open another Procoder window
//   hub.nextUntitled()  number for a new, unsaved document
//   hub.used(inst)      this window was just used (files open in the last one)
//   hub.closed(inst)    this window is gone
// folder: the folder to show in the file tree from the start.
export function createProcoder(hub, { folder = null } = {}) {
  let app = null; // { win, tabsEl, pane, host, main, tree, editor, monaco, s: status-bar parts }
  const docs = []; // open tabs, in tab order
  let active = null;
  const findDoc = (path) => docs.find((d) => d.path === path);

  function applySide() {
    if (!app) return;
    app.main.classList.toggle('no-side', !sideShown());
    app.tree.el.style.width = clampSide(data.get('sideWidth')) + 'px';
  }
  // Preferences changed (in any window): follow them.
  function onPrefs() {
    applySide();
    app?.editor?.updateOptions({ fontSize: prefs.fontSize, minimap: { enabled: prefs.minimap }, wordWrap: prefs.wordWrap });
    if (active?.kind === 'welcome') show();
    else refresh();
  }

  // ---- the window
  function ensureWindow() {
    if (app) {
      app.win.focus();
      return app;
    }
    const win = createWindow({ title: APP_NAME, appName: APP_NAME, iconHtml: procoderSvg(), width: 980, height: 620 });
    const s = {
      state: h('span'),
      path: h('span', { class: 'path' }),
      pos: h('span'),
      wrap: h('button', { type: 'button', title: '切換自動換行（Alt+Z）', onclick: toggleWrap }),
      eol: h('span'),
      enc: h('span'),
      lang: h('span'),
    };
    const menubar = h('div', { class: 'ed-menubar' });
    const tabsEl = h('div', { class: 'pc-tabs', role: 'tablist' });
    const host = h('div', { class: 'editor-host' });
    const pane = h('div', { class: 'pc-pane' });
    const tree = createTree({ openFile, openFolder: askOpenFolder, closeFolder, removed });
    const grip = h('div', { class: 'pc-side-grip', title: '拖曳調整寬度，點兩下還原' });
    const main = h('div', { class: 'pc-main' }, tree.el, grip,
      h('div', { class: 'pc-work' },
        h('div', { class: 'pc-tabbar' }, tabsEl,
          h('button', { type: 'button', class: 'pc-tab-add', title: '新增檔案', 'aria-label': '新增檔案', onclick: () => openFile() }, '+')),
        h('div', { class: 'pc-stage' }, host, pane)));
    grip.addEventListener('pointerdown', (down) => {
      if (down.button !== 0) return;
      down.preventDefault();
      const start = tree.el.offsetWidth;
      let width = start;
      document.body.classList.add('dragging', 'col-resizing');
      const move = (ev) => {
        width = clampSide(start + ev.clientX - down.clientX);
        tree.el.style.width = width + 'px';
      };
      const up = () => {
        document.body.classList.remove('dragging', 'col-resizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (width !== start) data.set('sideWidth', width);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => data.set('sideWidth', SIDE_DEFAULT));
    win.body.append(menubar, main,
      h('div', { class: 'statusbar' }, s.state, s.path, h('span', { class: 'spacer' }), s.pos, s.wrap, s.eol, s.enc, s.lang));
    const me = (app = { win, tabsEl, host, pane, s, main, tree, editor: null, monaco: null });
    applySide();
    if (folder) tree.setRoot(folder);
    attachMenuBar(menubar, buildMenus(), focusEditor);

    // Files dragged onto the window (from the file cabinet or the desktop) open
    // as tabs; a dropped folder becomes the folder in the file tree.
    const offDrop = registerDropTarget(win.el, {
      accepts: (payload) => payload.type === 'file',
      action: () => '用 Procoder 開啟',
      onDrop: (payload) => openDropped(payload.data.paths || [payload.data.path]),
    });
    win.onFocus = () => {
      hub.used(inst);
      focusEditor();
    };
    win.onClose = async () => {
      for (const doc of docs.filter(isDirty)) if (!(await confirmDiscard(doc))) return false;
      return true;
    };
    win.destroy = () => {
      offDrop();
      me.editor?.dispose();
      for (const doc of docs) doc.model?.dispose();
      docs.length = 0;
      active = null;
      if (app === me) app = null;
      hub.closed(inst);
    };
    return app;
  }

  function focusEditor() {
    if (app?.editor && active?.model) app.editor.focus();
  }

  // Monaco and the window's single editor, made the first time a file needs it.
  async function ensureEditor() {
    const me = app;
    const monaco = await loadMonaco();
    if (!me || me !== app || me.editor) return monaco;
    me.monaco = monaco;
    const editor = (me.editor = monaco.editor.create(me.host, {
      model: null,
      theme: themeName(),
      automaticLayout: true,
      fontSize: prefs.fontSize,
      minimap: { enabled: prefs.minimap },
      wordWrap: prefs.wordWrap,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      renderWhitespace: 'selection',
      smoothScrolling: true,
    }));
    const { KeyMod, KeyCode } = monaco;
    const act = (id, label, keybindings, run) => editor.addAction({ id: 'sshdesk.' + id, label, keybindings, run });
    act('save', '儲存到主機', [KeyMod.CtrlCmd | KeyCode.KeyS], () => active && saveDoc(active));
    act('saveAs', '另存新檔…', [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS], () => active && saveDocAs(active));
    act('fontLarger', '放大文字', [KeyMod.CtrlCmd | KeyCode.Equal, KeyMod.CtrlCmd | KeyCode.NumpadAdd], () => setFontSize(prefs.fontSize + 1));
    act('fontSmaller', '縮小文字', [KeyMod.CtrlCmd | KeyCode.Minus, KeyMod.CtrlCmd | KeyCode.NumpadSubtract], () => setFontSize(prefs.fontSize - 1));
    act('fontReset', '重設文字大小', [KeyMod.CtrlCmd | KeyCode.Digit0, KeyMod.CtrlCmd | KeyCode.Numpad0], () => setFontSize(FONT_DEFAULT));
    act('toggleMinimap', '顯示／隱藏右側縮圖', undefined, () => setMinimap(!prefs.minimap));
    act('toggleWordWrap', '切換自動換行', [KeyMod.Alt | KeyCode.KeyZ], toggleWrap);
    act('toggleSide', '顯示／隱藏檔案樹', [KeyMod.CtrlCmd | KeyCode.KeyB], toggleSide);
    act('closeTab', '關閉分頁', [KeyMod.Alt | KeyCode.KeyW], () => active && closeDoc(active));
    editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => editor.trigger('keyboard', 'redo', null));
    editor.onDidChangeCursorPosition(refresh);
    return monaco;
  }

  // ---- menu bar: 檔案 / 介面
  function buildMenus() {
    const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
    const file = () => !!active?.model;
    const edit = (what) => app.editor.trigger('menu', what, null);
    return [
      {
        label: '檔案',
        items: [
          { label: '開新視窗', run: () => hub.newWindow() },
          null,
          { label: '新增檔案', run: () => openFile() },
          { label: '開啟檔案…', run: askOpen },
          { label: '開啟資料夾…', run: askOpenFolder },
          { label: '關閉資料夾', enabled: () => !!app.tree.root, run: closeFolder },
          null,
          { label: '上一步（復原）', key: mod + 'Z', enabled: () => file() && active.model.canUndo(), run: () => edit('undo') },
          { label: '下一步（重做）', key: mod + 'Y', enabled: () => file() && active.model.canRedo(), run: () => edit('redo') },
          null,
          { label: '存檔', key: mod + 'S', enabled: file, run: () => saveDoc(active) },
          { label: '另存新檔…', key: mod + (mod === '⌘' ? '⇧S' : 'Shift+S'), enabled: file, run: () => saveDocAs(active) },
          null,
          { label: '關閉分頁', key: 'Alt+W', enabled: () => !!active, run: () => closeDoc(active) },
          { label: '結束 Procoder', run: () => app.win.close() },
        ],
      },
      {
        label: '介面',
        items: [
          { label: '歡迎頁面', run: openWelcome },
          { label: '顯示檔案樹', key: mod + 'B', checked: sideShown, run: toggleSide },
          null,
          { label: '放大文字', key: mod + '+', enabled: () => prefs.fontSize < FONT_MAX, run: () => setFontSize(prefs.fontSize + 1) },
          { label: '縮小文字', key: mod + '-', enabled: () => prefs.fontSize > FONT_MIN, run: () => setFontSize(prefs.fontSize - 1) },
          { label: () => `重設文字大小（目前 ${prefs.fontSize}）`, key: mod + '0', enabled: () => prefs.fontSize !== FONT_DEFAULT, run: () => setFontSize(FONT_DEFAULT) },
          null,
          { label: '顯示右側縮圖', checked: () => prefs.minimap, run: () => setMinimap(!prefs.minimap) },
          { label: '自動換行', key: 'Alt+Z', checked: () => prefs.wordWrap === 'on', run: toggleWrap },
        ],
      },
    ];
  }

  // ---- tabs
  function addDoc(doc) {
    const close = h('button', { type: 'button', class: 'pc-tab-close', title: '關閉', 'aria-label': '關閉', onclick: () => closeDoc(doc) }, '×');
    doc.icoEl = h('span', { class: 'pc-tab-ico' });
    doc.nameEl = h('span', { class: 'pc-tab-name' });
    const tab = (doc.tabEl = h('div', { class: 'pc-tab', role: 'tab' }, doc.icoEl, doc.nameEl, close));
    tab.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0 || ev.target.closest('.pc-tab-close')) return;
      activate(doc);
      dragTab(ev, doc);
    });
    // Middle click closes the tab. On Linux the browser would also paste the
    // selection into whatever has the focus (the next file), so hold that back.
    for (const type of ['mousedown', 'mouseup']) {
      tab.addEventListener(type, (ev) => {
        if (ev.button === 1) ev.preventDefault();
      });
    }
    tab.addEventListener('auxclick', (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault();
      closeDoc(doc);
    });
    tab.addEventListener('contextmenu', (ev) => {
      const others = docs.filter((d) => d !== doc);
      const right = docs.slice(docs.indexOf(doc) + 1);
      showContextMenu(ev, [
        { label: '關閉', run: () => closeDoc(doc) },
        { label: '關閉其他分頁', enabled: others.length > 0, run: () => closeMany(others) },
        { label: '關閉右側分頁', enabled: right.length > 0, run: () => closeMany(right) },
        { label: '關閉全部分頁', run: () => closeMany([...docs]) },
        doc.path ? null : false,
        doc.path ? { label: '複製路徑', run: () => copyText(doc.path) } : false,
      ].filter((item) => item !== false));
    });
    docs.push(doc);
    app.tabsEl.append(tab);
    paintTab(doc);
    return doc;
  }

  function paintTab(doc) {
    doc.icoEl.innerHTML = docIcon(doc);
    doc.nameEl.textContent = doc.name;
    doc.tabEl.title = doc.path || doc.name;
    doc.tabEl.dataset.name = doc.name;
    doc.tabEl.classList.toggle('dirty', isDirty(doc));
  }

  // Drag a tab sideways to change the order.
  function dragTab(ev, doc) {
    const startX = ev.clientX;
    let moving = false;
    const move = (e) => {
      if (!moving && Math.abs(e.clientX - startX) < 6) return;
      moving = true;
      doc.tabEl.classList.add('moving');
      const from = docs.indexOf(doc);
      const to = docs.findIndex((o, i) => {
        if (o === doc) return false;
        const r = o.tabEl.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        return i > from ? e.clientX > mid && e.clientX < r.right + 40 : e.clientX < mid && e.clientX > r.left - 40;
      });
      if (to < 0) return;
      const over = docs[to];
      docs.splice(from, 1);
      docs.splice(to, 0, doc);
      if (to > from) over.tabEl.after(doc.tabEl);
      else over.tabEl.before(doc.tabEl);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      doc.tabEl.classList.remove('moving');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  function activate(doc) {
    if (active === doc) return;
    if (active?.model && app.editor?.getModel() === active.model) active.view = app.editor.saveViewState();
    active = doc;
    show();
    doc.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Put the active tab on screen: the editor for a loaded file, otherwise its
  // own page (welcome, loading, "too large").
  function show() {
    if (!app || !active) return;
    for (const d of docs) {
      d.tabEl.classList.toggle('active', d === active);
      d.tabEl.setAttribute('aria-selected', d === active);
    }
    const doc = active;
    if (doc.model && app.editor) {
      if (app.editor.getModel() !== doc.model) {
        app.editor.setModel(doc.model);
        if (doc.view) app.editor.restoreViewState(doc.view);
      }
      app.pane.style.display = 'none';
      app.pane.replaceChildren();
      if (wm.focused === app.win) app.editor.focus();
    } else {
      if (doc.kind === 'welcome') {
        doc.page = buildWelcome(recentList(), { newFile: () => openFile(), openFile: askOpen, openFolder: askOpenFolder, openRecent: openPath, forget });
      }
      app.pane.replaceChildren(doc.page || '');
      app.pane.style.display = '';
    }
    app.tree.setCurrent(doc.path);
    refresh();
  }

  function refresh() {
    if (!app || !active) return;
    const { win, s, editor } = app;
    const doc = active;
    const dirty = isDirty(doc);
    win.setTitle((dirty ? '● ' : '') + doc.name);
    win.setIcon(docIcon(doc));
    win.setDirty(docs.some(isDirty));
    const ready = !!doc.model && editor?.getModel() === doc.model;
    s.state.textContent = !doc.model ? '' : doc.saving ? '儲存中…' : dirty ? '已修改' : '已儲存';
    s.state.className = dirty ? 'dirty-flag' : '';
    s.path.textContent = s.path.title = doc.path || '';
    const pos = ready && editor.getPosition();
    s.pos.textContent = pos ? `第 ${pos.lineNumber} 行，第 ${pos.column} 欄` : '';
    s.lang.textContent = ready ? doc.model.getLanguageId() : '';
    s.enc.textContent = ready ? doc.encoding + (doc.bom ? ' BOM' : '') : '';
    s.eol.textContent = ready ? (doc.model.getEOL() === '\r\n' ? 'CRLF' : 'LF') : '';
    s.wrap.textContent = ready ? (prefs.wordWrap === 'on' ? '換行：開' : '換行：關') : '';
    s.wrap.style.display = ready ? '' : 'none';
  }

  // Take a tab away without asking. The neighbour becomes active; when a file
  // was the last tab the welcome page comes back, and closing the welcome page
  // as the last tab closes Procoder.
  function removeDoc(doc, { keepWindow = true } = {}) {
    const at = docs.indexOf(doc);
    if (at < 0) return;
    docs.splice(at, 1);
    doc.tabEl.remove();
    if (doc.model) {
      if (app.editor?.getModel() === doc.model) app.editor.setModel(null);
      doc.model.dispose();
    }
    if (active !== doc) return refresh();
    active = null;
    const next = docs[at] || docs[at - 1];
    if (next) activate(next);
    else if (doc.kind === 'welcome' || !keepWindow) app.win.close(true);
    else openWelcome();
  }

  // Ask about unsaved changes. true = the tab may go.
  async function confirmDiscard(doc) {
    if (!isDirty(doc)) return true;
    app.win.focus();
    activate(doc);
    const choice = await dialog({
      title: `要儲存「${doc.name}」的修改嗎？`,
      message: '不儲存的話，修改的內容會遺失。',
      buttons: [
        { label: '不儲存', value: 'discard', danger: true },
        { label: '取消', value: 'cancel', cancel: true },
        { label: '儲存', value: 'save', default: true },
      ],
    });
    if (choice === 'discard') return true;
    if (choice === 'save') return saveDoc(doc);
    return false;
  }

  async function closeDoc(doc) {
    if (!docs.includes(doc) || !(await confirmDiscard(doc))) return false;
    removeDoc(doc);
    return true;
  }

  async function closeMany(list) {
    for (const doc of list) if (!(await closeDoc(doc))) return;
  }

  // ---- opening
  function openWelcome() {
    ensureWindow();
    activate(docs.find((d) => d.kind === 'welcome') || addDoc({ kind: 'welcome', name: WELCOME, path: null }));
  }

  // With a path: that remote file (its tab, when it is already open). Without: a
  // new, unsaved document.
  function openFile(path = null, size = 0) {
    ensureWindow();
    // A file is open in one place only: if another Procoder window has it, go there.
    const owner = path && hub.owner(path);
    if (owner) return owner.inst.showDoc(owner.doc);
    const seq = path ? 0 : hub.nextUntitled();
    const doc = addDoc({ kind: 'file', path, name: path ? P.base(path) : seq > 1 ? `${UNTITLED} ${seq}` : UNTITLED, seq, model: null, saving: false });
    activate(doc);
    return loadDoc(doc, size);
  }

  async function loadDoc(doc, size) {
    const setPage = (page) => {
      doc.page = page;
      if (active === doc) show();
    };
    // A very large file is not opened straight away: the tab says so and waits
    // for the user to insist.
    if (size > LARGE_FILE_BYTES) {
      const open = h('button', { type: 'button', class: 'ed-large-open', onclick: () => loadDoc(doc, 0) }, '仍要開啟');
      setPage(h('div', { class: 'ed-large' }, h('p', null, `此檔案大小超過上限 (${Math.round(size / 1024 / 1024)} MB)`), open));
      return;
    }
    const loading = h('div', { class: 'editor-loading' }, '開啟中…');
    setPage(loading);
    const fail = (message) => {
      if (docs.includes(doc)) removeDoc(doc, { keepWindow: docs.length > 1 });
      toast(message, true);
    };
    let monaco, res;
    try {
      [monaco, res] = await Promise.all([ensureEditor(), doc.path ? readFile(doc.path, {
        onProgress: (done, total) => {
          loading.textContent = `開啟中… ${Math.floor((done / total) * 100)}%`;
        },
      }) : null]);
    } catch (err) {
      return fail(`無法開啟「${doc.name}」：${errText(err)}`);
    }
    if (!docs.includes(doc)) return; // closed while loading
    const decoded = res ? decodeText(res.bytes) : { text: '', encoding: 'UTF-8', bom: false };
    if (!decoded) return fail(`「${doc.name}」不是文字檔，無法在 Procoder 中開啟`);
    Object.assign(doc, { encoding: decoded.encoding, bom: decoded.bom, mtime: res ? res.mtime : null });

    const uri = monaco.Uri.from({ scheme: 'sftp', authority: 'remote', path: doc.path || `/untitled-${doc.seq}` });
    monaco.editor.getModel(uri)?.dispose();
    const model = (doc.model = monaco.editor.createModel(decoded.text, doc.path ? langFor(monaco, doc.name) : undefined, uri));
    doc.savedVersion = model.getAlternativeVersionId();
    doc.page = null;
    model.onDidChangeContent(() => {
      paintTab(doc);
      if (active === doc) refresh();
      else app?.win.setDirty(docs.some(isDirty));
    });
    model.onDidChangeLanguage(() => active === doc && refresh());
    if (doc.path) remember(doc.path);
    if (active === doc) show();
  }

  // A path from the welcome page or a dialog: a file opens as a tab, a folder
  // (also written with a trailing slash) opens in the file tree.
  async function openPath(ref) {
    const path = isFolderRef(ref) ? ref.slice(0, -1) : ref;
    try {
      const { entry } = await rpc('stat', { path });
      if (entry.type === 'dir') return openFolder(path);
      await openFile(path, entry.size);
    } catch (err) {
      if (err.code === 'not-found') forget(ref);
      toast(`無法開啟「${P.base(path)}」：${errText(err)}`, true);
    }
  }

  function openFolder(path) {
    ensureWindow();
    data.set('folder', path);
    data.set('sideShown', true);
    app.tree.setRoot(path);
    remember(path === '/' ? '/' : path + '/');
  }

  function closeFolder() {
    if (data.get('folder') === app?.tree.root) data.set('folder', null);
    app?.tree.setRoot(null);
  }

  // Something was deleted from the file tree: its tabs go too, unless they
  // hold changes that were never saved.
  function removed(path) {
    for (const doc of [...docs]) if (movedPath(doc.path, path, path) && !isDirty(doc)) removeDoc(doc);
  }

  const startDir = () => (active?.path ? P.parent(active.path) : app?.tree.root || conn.info.home);

  async function askOpen() {
    const path = await pickPath({ mode: 'file', start: startDir() });
    if (path) await openPath(path);
  }

  async function askOpenFolder() {
    const path = await pickPath({ mode: 'folder', start: app?.tree.root || startDir() });
    if (path) openFolder(path);
  }

  async function openDropped(paths) {
    let folder = null;
    for (const path of paths) {
      try {
        const { entry } = await rpc('stat', { path });
        if (entry.type === 'dir') folder = folder || path;
        else await openFile(path, entry.size);
      } catch (err) {
        toast(`無法開啟「${P.base(path)}」：${errText(err)}`, true);
      }
    }
    if (folder) openFolder(folder);
  }
  // ---- saving
  async function saveDoc(doc, force) {
    if (!doc?.model || doc.saving) return false;
    if (!doc.path) return saveDocAs(doc); // a new document needs a place first
    let bytes;
    try {
      bytes = encodeText(doc.model.getValue(), doc.encoding, doc.bom);
    } catch (err) {
      toast(`無法儲存「${doc.name}」：${err.message}`, true);
      return false;
    }
    const version = doc.model.getAlternativeVersionId();
    doc.saving = true;
    refresh();
    try {
      const r = await writeFile(doc.path, bytes, { expectMtime: doc.mtime, force });
      doc.mtime = r.mtime;
      doc.savedVersion = version;
      return true;
    } catch (err) {
      if (err.code === 'changed-on-server') {
        doc.saving = false;
        const choice = await dialog({
          title: '主機上的檔案已被修改',
          message: `「${doc.name}」在你開啟之後，主機上的內容有變動。要用你的版本覆寫嗎？`,
          buttons: [{ label: '取消', value: false, cancel: true }, { label: '覆寫', value: true, danger: true, default: true }],
        });
        return choice ? saveDoc(doc, true) : false;
      }
      toast(`無法儲存「${doc.name}」：${errText(err)}`, true);
      return false;
    } finally {
      doc.saving = false;
      if (docs.includes(doc)) paintTab(doc);
      refresh();
    }
  }

  // Point a tab at another path (after "save as", or when the file is renamed or moved).
  function relocate(doc, target) {
    doc.path = target;
    doc.name = P.base(target);
    if (app?.monaco && doc.model) app.monaco.editor.setModelLanguage(doc.model, langFor(app.monaco, doc.name));
    paintTab(doc);
    refresh();
  }

  async function saveDocAs(doc) {
    if (!doc?.model || doc.saving) return false;
    const target = await pickPath({ mode: 'save', start: doc.path ? P.parent(doc.path) : app?.tree.root || conn.info.home, name: doc.path ? doc.name : UNTITLED + '.txt' });
    if (!target) return false;
    if (target === doc.path) return saveDoc(doc);
    if (hub.owner(target)) {
      toast(`「${P.base(target)}」已經在另一個分頁開啟，請先關閉它`, true);
      return false;
    }
    try {
      const existing = await rpc('stat', { path: target });
      if (existing.entry.type === 'dir') {
        toast(`「${target}」是資料夾，請輸入檔名`, true);
        return false;
      }
      const overwrite = await dialog({
        title: `「${P.base(target)}」已經存在`,
        message: `要取代 ${target} 嗎？原本的內容會被覆蓋。`,
        buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '取代', value: true, danger: true }],
      });
      if (!overwrite) return false;
    } catch (err) {
      if (err.code !== 'not-found') {
        toast(`無法另存到「${target}」：${errText(err)}`, true);
        return false;
      }
    }
    let bytes;
    try {
      bytes = encodeText(doc.model.getValue(), doc.encoding, doc.bom);
    } catch (err) {
      toast(`無法儲存：${err.message}`, true);
      return false;
    }
    const version = doc.model.getAlternativeVersionId();
    doc.saving = true;
    refresh();
    try {
      const r = await writeFile(target, bytes);
      // The tab now edits the new file, like "Save As" in a desktop editor.
      doc.mtime = r.mtime;
      doc.savedVersion = version;
      relocate(doc, target);
      remember(target);
      emit('fs:changed', P.parent(target));
      toast(`已另存為 ${target}`);
      return true;
    } catch (err) {
      toast(`無法另存到「${target}」：${err.code === 'not-found' ? '資料夾不存在' : errText(err)}`, true);
      return false;
    } finally {
      doc.saving = false;
      refresh();
    }
  }

  // ---- what index.js uses
  const inst = {
    get win() {
      return app?.win;
    },
    docs,
    findDoc,
    onPrefs,
    openFile,
    openFolder,
    openWelcome,
    showDoc(doc) {
      app.win.focus();
      activate(doc);
    },
    save: (as) => active && (as ? saveDocAs : saveDoc)(active),
    closeActive: () => active && closeDoc(active),
    moved(from, to) {
      for (const doc of docs) {
        const next = movedPath(doc.path, from, to);
        if (next && !hub.owner(next)) relocate(doc, next);
      }
    },
    refreshTree: (dir) => app?.tree.refresh(dir),
    dirtyCount: () => docs.filter(isDirty).length,
  };
  ensureWindow();
  return inst;
}
