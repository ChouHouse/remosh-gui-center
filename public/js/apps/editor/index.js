// Editor app: one Monaco window per remote file, with 檔案 / 介面 menus.
import { h } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { fmtSize } from '../../core/format.js';
import { P } from '../../core/path.js';
import { fileSvg } from '../../core/icons.js';
import { rpc } from '../../core/rpc.js';
import { on, emit } from '../../core/events.js';
import { decodeText, encodeText, toBase64, fromBase64 } from '../../core/text-codec.js';
import { createWindow, wm } from '../../shell/wm.js';
import { attachMenuBar } from '../../shell/menubar.js';
import { registerApp } from '../../shell/apps.js';
import { loadMonaco, themeName, NAME_LANG, EXT_LANG } from './monaco.js';

const editors = new Map(); // remote path -> editor record

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

async function openEditor(path, size) {
  const existing = editors.get(path);
  if (existing) return existing.win.focus();
  if (size > 5 * 1024 * 1024) return toast(`「${P.base(path)}」太大（${fmtSize(size)}），編輯器上限是 5 MB`, true);

  let name = P.base(path); // both change on "save as"
  const win = createWindow({ title: name, appName: '編輯器', iconHtml: fileSvg(name), width: 820, height: 560 });
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
  const ed = { path, win, editor: null, model: null, saving: false };
  editors.set(path, ed);
  win.destroy = () => {
    editors.delete(ed.path);
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
  if (editors.get(path) !== ed) return; // closed while loading
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
      const r = await rpc('write', { path: ed.path, data: toBase64(bytes), expectMtime: ed.mtime, force: !!force });
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

  ed.saveAs = async () => {
    if (ed.saving) return false;
    const answer = await dialog({
      title: '另存新檔',
      message: '輸入要存到主機上的路徑：',
      input: ed.path,
      buttons: [{ label: '取消', value: false, cancel: true }, { label: '儲存', value: true, default: true }],
    });
    const typed = answer.value ? answer.text.trim() : '';
    if (!typed || typed.endsWith('/')) {
      if (answer.value) toast('請輸入包含檔名的路徑', true);
      return false;
    }
    const target = P.norm(typed.startsWith('/') ? typed : P.join(P.parent(ed.path), typed));
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
      const r = await rpc('write', { path: target, data: toBase64(bytes) });
      // The window now edits the new file, like "Save As" in a desktop editor.
      editors.delete(ed.path);
      ed.path = target;
      name = P.base(target);
      editors.set(target, ed);
      ed.mtime = r.mtime;
      ed.savedVersion = version;
      sPath.textContent = sPath.title = target;
      win.setIcon(fileSvg(name));
      monaco.editor.setModelLanguage(model, langFor(name));
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

on('session:start', () => loadMonaco().catch(() => {})); // warm up so the first file opens quickly

registerApp({
  id: 'editor',
  name: '編輯器',
  icon: () => fileSvg(''),
  extensions: 'all',
  launch: ({ path, size }) => openEditor(path, size),
  unsavedCount: () => [...editors.values()].filter((ed) => ed.isDirty?.()).length,
});
