// Editor app: one Monaco window per remote file, with 檔案 / 介面 menus.
import { h } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { P } from '../../core/path.js';
import { fileSvg } from '../../core/icons.js';
import { procoderSvg } from './icon.js';
import { conn, rpc } from '../../core/rpc.js';
import { readFile, writeFile } from '../../core/file-io.js';
import { on, emit } from '../../core/events.js';
import { decodeText, encodeText } from '../../core/text-codec.js';
import { createWindow, wm } from '../../shell/wm.js';
import { attachMenuBar } from '../../shell/menubar.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { registerDropTarget } from '../../shell/drag.js';
import { loadMonaco, themeName, NAME_LANG, EXT_LANG } from './monaco.js';

useAppStyle(import.meta.url);

const editors = new Map(); // key (remote path, or an id for an unsaved new file) -> editor record
const UNTITLED = '未命名';
let untitledSeq = 0;

// Display preferences shared by every editor window and remembered per browser.
const FONT_DEFAULT = 13;
const FONT_MIN = 9;
const FONT_MAX = 32;
const clampFont = (n) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(Number(n)) || FONT_DEFAULT));
const prefs = { fontSize: clampFont(store.get('fontSize', FONT_DEFAULT)), minimap: store.get('minimap', true) !== false };
function applyPrefs() {
  for (const ed of editors.values()) ed.editor?.updateOptions({ fontSize: prefs.fontSize, minimap: { enabled: prefs.minimap } });
}
function setFontSize(n) {
  prefs.fontSize = clampFont(n);
  store.set('fontSize', prefs.fontSize);
  applyPrefs();
}
function setMinimap(on) {
  prefs.minimap = !!on;
  store.set('minimap', prefs.minimap);
  applyPrefs();
}

async function openDropped(paths) {
  let folders = 0;
  for (const path of paths) {
    try {
      const { entry } = await rpc('stat', { path });
      if (entry.type === 'dir') folders++;
      else await openEditor(path, entry.size);
    } catch (err) {
      toast(`無法開啟「${P.base(path)}」：${errText(err)}`, true);
    }
  }
  if (folders) toast(folders === paths.length ? 'Procoder 不能開啟資料夾' : `略過了 ${folders} 個資料夾`);
}

const LARGE_FILE_BYTES = 200 * 1024 * 1024; // above this the user is asked first

// With a path: open that remote file. Without: a new, unsaved document.
async function openEditor(path = null, size = 0) {
  const existing = path && editors.get(path);
  if (existing) return existing.win.focus();

  let name = path ? P.base(path) : UNTITLED; // both change on "save as"
  const win = createWindow({ title: name, appName: 'Procoder', iconHtml: fileSvg(name), width: 820, height: 560 });
  const host = h('div', { class: 'editor-host' }, h('div', { class: 'editor-loading' }, '開啟中…'));
  const sPos = h('span');
  const sLang = h('span');
  const sEnc = h('span');
  const sEol = h('span');
  const sState = h('span');
  const sWrap = h('button', { type: 'button', title: '切換自動換行（Alt+Z）' });
  const sPath = h('span', { class: 'path', title: path }, path);
  const menubar = h('div', { class: 'ed-menubar' });
  win.body.append(menubar, host, h('div', { class: 'statusbar' }, sState, sPath, h('span', { class: 'spacer' }), sPos, sWrap, sEol, sEnc, sLang));
  const ed = { path, key: path || `\0untitled-${++untitledSeq}`, win, editor: null, model: null, saving: false };
  editors.set(ed.key, ed);
  // Files dragged onto the window (from the file cabinet or the desktop) open
  // here too, each in its own window. Any kind of file; folders are left out.
  const offDrop = registerDropTarget(win.el, {
    accepts: (payload) => payload.type === 'file' && !payload.data.isDir,
    action: () => '用 Procoder 開啟',
    onDrop: (payload) => openDropped(payload.data.paths || [payload.data.path]),
  });
  win.destroy = () => {
    offDrop();
    editors.delete(ed.key);
    ed.editor?.dispose();
    ed.model?.dispose();
  };

  // A very large file is not opened straight away: the window says so and
  // waits for the user to insist.
  if (size > LARGE_FILE_BYTES) {
    const go = await new Promise((resolve) => {
      const open = h('button', { type: 'button', class: 'ed-large-open', onclick: () => resolve(true) }, '仍要開啟');
      host.replaceChildren(h('div', { class: 'ed-large' },
        h('p', null, `此檔案大小超過上限 (${Math.round(size / 1024 / 1024)} MB)`), open));
      win.onClose = () => {
        resolve(false);
        return true;
      };
      open.focus();
    });
    win.onClose = null;
    if (!go || editors.get(ed.key) !== ed) return;
  }
  const loading = h('div', { class: 'editor-loading' }, '開啟中…');
  host.replaceChildren(loading);

  let monaco, res;
  try {
    [monaco, res] = await Promise.all([loadMonaco(), path ? readFile(path, {
      onProgress: (done, total) => {
        loading.textContent = `開啟中… ${Math.floor((done / total) * 100)}%`;
      },
    }) : null]);
  } catch (err) {
    await win.close(true);
    return toast(`無法開啟「${name}」：${errText(err)}`, true);
  }
  if (editors.get(ed.key) !== ed) return; // closed while loading
  const decoded = res ? decodeText(res.bytes) : { text: '', encoding: 'UTF-8', bom: false };
  if (!decoded) {
    await win.close(true);
    return toast(`「${name}」不是文字檔，無法在 Procoder 中開啟`, true);
  }
  Object.assign(ed, { encoding: decoded.encoding, bom: decoded.bom, mtime: res ? res.mtime : null });

  const uri = monaco.Uri.from({ scheme: 'sftp', authority: 'remote', path: path || `/untitled-${untitledSeq}` });
  monaco.editor.getModel(uri)?.dispose();
  const lang = NAME_LANG[name.toLowerCase()] || EXT_LANG[P.ext(name)];
  const model = (ed.model = monaco.editor.createModel(decoded.text, lang, uri));
  host.replaceChildren();
  const editor = (ed.editor = monaco.editor.create(host, {
    model,
    theme: themeName(),
    automaticLayout: true,
    fontSize: prefs.fontSize,
    minimap: { enabled: prefs.minimap },
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
    if (!ed.path) return ed.saveAs(); // a new document needs a place first
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
      const r = await writeFile(ed.path, bytes, { expectMtime: ed.mtime, force });
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

  const langFor = (fileName) => {
    const known = NAME_LANG[fileName.toLowerCase()] || EXT_LANG[P.ext(fileName)];
    if (known) return known;
    const lower = fileName.toLowerCase();
    const hit = monaco.languages.getLanguages().find((l) =>
      l.filenames?.some((f) => f.toLowerCase() === lower) || l.extensions?.some((x) => lower.endsWith(x.toLowerCase())));
    return hit?.id || 'plaintext';
  };

  // Point this window at another path (after "save as", or when the file is renamed or moved).
  ed.relocate = (target) => {
    editors.delete(ed.key);
    ed.path = ed.key = target;
    name = P.base(target);
    editors.set(target, ed);
    sPath.textContent = sPath.title = target;
    win.setIcon(fileSvg(name));
    monaco.editor.setModelLanguage(model, langFor(name));
    refresh();
  };

  ed.saveAs = async () => {
    if (ed.saving) return false;
    const answer = await dialog({
      title: '另存新檔',
      message: '輸入要存到主機上的路徑：',
      input: ed.path || P.join(conn.info.home, UNTITLED + '.txt'),
      buttons: [{ label: '取消', value: false, cancel: true }, { label: '儲存', value: true, default: true }],
    });
    const typed = answer.value ? answer.text.trim() : '';
    if (!typed || typed.endsWith('/')) {
      if (answer.value) toast('請輸入包含檔名的路徑', true);
      return false;
    }
    const target = P.norm(typed.startsWith('/') ? typed : P.join(ed.path ? P.parent(ed.path) : conn.info.home, typed));
    if (target === ed.path) return ed.save();
    if (editors.has(target)) {
      toast(`「${P.base(target)}」已經在另一個視窗開啟，請先關閉它`, true);
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
      bytes = encodeText(model.getValue(), ed.encoding, ed.bom);
    } catch (err) {
      toast(`無法儲存：${err.message}`, true);
      return false;
    }
    const version = model.getAlternativeVersionId();
    ed.saving = true;
    refresh();
    try {
      const r = await writeFile(target, bytes);
      // The window now edits the new file, like "Save As" in a desktop editor.
      ed.mtime = r.mtime;
      ed.savedVersion = version;
      ed.relocate(target);
      emit('fs:changed', P.parent(target));
      toast(`已另存為 ${target}`);
      return true;
    } catch (err) {
      toast(`無法另存到「${target}」：${err.code === 'not-found' ? '資料夾不存在' : errText(err)}`, true);
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
  editor.addAction({ id: 'sshdesk.saveAs', label: '另存新檔…', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS], run: () => ed.saveAs() });
  editor.addAction({ id: 'sshdesk.fontLarger', label: '放大文字', keybindings: [KeyMod.CtrlCmd | KeyCode.Equal, KeyMod.CtrlCmd | KeyCode.NumpadAdd], run: () => setFontSize(prefs.fontSize + 1) });
  editor.addAction({ id: 'sshdesk.fontSmaller', label: '縮小文字', keybindings: [KeyMod.CtrlCmd | KeyCode.Minus, KeyMod.CtrlCmd | KeyCode.NumpadSubtract], run: () => setFontSize(prefs.fontSize - 1) });
  editor.addAction({ id: 'sshdesk.fontReset', label: '重設文字大小', keybindings: [KeyMod.CtrlCmd | KeyCode.Digit0, KeyMod.CtrlCmd | KeyCode.Numpad0], run: () => setFontSize(FONT_DEFAULT) });
  editor.addAction({ id: 'sshdesk.toggleMinimap', label: '顯示／隱藏右側縮圖', run: () => setMinimap(!prefs.minimap) });
  editor.addAction({ id: 'sshdesk.toggleWordWrap', label: '切換自動換行', keybindings: [KeyMod.Alt | KeyCode.KeyZ], run: toggleWrap });
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => editor.trigger('keyboard', 'redo', null));

  // ---- menu bar: 檔案 / 介面
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const menus = [
    {
      label: '檔案',
      items: [
        { label: '上一步（復原）', key: mod + 'Z', enabled: () => model.canUndo(), run: () => editor.trigger('menu', 'undo', null) },
        { label: '下一步（重做）', key: mod + 'Y', enabled: () => model.canRedo(), run: () => editor.trigger('menu', 'redo', null) },
        null,
        { label: '存檔', key: mod + 'S', run: () => ed.save() },
        { label: '另存新檔…', key: mod + (mod === '⌘' ? '⇧S' : 'Shift+S'), run: () => ed.saveAs() },
        null,
        { label: '關閉', run: () => win.close() },
      ],
    },
    {
      label: '介面',
      items: [
        { label: '放大文字', key: mod + '+', enabled: () => prefs.fontSize < FONT_MAX, run: () => setFontSize(prefs.fontSize + 1) },
        { label: '縮小文字', key: mod + '-', enabled: () => prefs.fontSize > FONT_MIN, run: () => setFontSize(prefs.fontSize - 1) },
        { label: () => `重設文字大小（目前 ${prefs.fontSize}）`, key: mod + '0', enabled: () => prefs.fontSize !== FONT_DEFAULT, run: () => setFontSize(FONT_DEFAULT) },
        null,
        { label: '顯示右側縮圖', checked: () => prefs.minimap, run: () => setMinimap(!prefs.minimap) },
        { label: '自動換行', key: 'Alt+Z', checked: () => editor.getRawOptions().wordWrap === 'on', run: toggleWrap },
      ],
    },
  ];
    attachMenuBar(menubar, menus, () => editor.focus());
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
    for (const ed of editors.values()) if (ed.win === wm.focused) (ev.shiftKey ? ed.saveAs : ed.save)?.();
  }
});

// Monaco rejects in-flight language-service requests with "Canceled" when a
// model is closed; that is expected, so keep it out of the console.
window.addEventListener('unhandledrejection', (ev) => {
  if (ev.reason?.name === 'Canceled') ev.preventDefault();
});

// A renamed or moved file (or a folder above it) takes its open windows along.
const movedPath = (path, from, to) => (path === from ? to : path?.startsWith(from + '/') ? to + path.slice(from.length) : null);
on('fs:moved', (from, to) => {
  for (const ed of [...editors.values()]) {
    const next = movedPath(ed.path, from, to);
    if (next && !editors.has(next)) ed.relocate?.(next);
  }
});

on('session:start', () => loadMonaco().catch(() => {})); // warm up so the first file opens quickly

registerApp({
  id: 'editor',
  name: 'Procoder',
  icon: procoderSvg,
  startMenu: true,
  extensions: 'all',
  launch: (args) => openEditor(args?.path, args?.size),
  unsavedCount: () => [...editors.values()].filter((ed) => ed.isDirty?.()).length,
});
