// 記事本: a plain <textarea> editor (no Monaco) for quick text edits.
import './i18n.js'; // this app's texts in the other languages
import { h } from '../../core/dom.js';
import { store } from '../../core/store.js';
import { appStore } from '../../core/app-store.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { fmtSize } from '../../core/format.js';
import { P } from '../../core/path.js';
import { notepadSvg } from './icon.js';
import { conn, rpc } from '../../core/rpc.js';
import { on, emit } from '../../core/events.js';
import { decodeText, encodeText, toBase64, fromBase64 } from '../../core/text-codec.js';
import { createWindow } from '../../shell/wm.js';
import { attachMenuBar } from '../../shell/menubar.js';
import { pickPath } from '../../shell/picker.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { tt, tm } from '../../core/i18n.js';

useAppStyle(import.meta.url);

const MAX_BYTES = 5 * 1024 * 1024;
const UNTITLED = tm('未命名');
const notes = new Set(); // every open notepad
// Saved in ~/.remosh-gui/app/notepad/ (earlier versions kept it in the browser).
const data = appStore('notepad', {
  defaults: { wrap: true },
  migrate() {
    const wrap = store.get('notepadWrap', undefined);
    store.remove('notepadWrap');
    return wrap === undefined ? {} : { wrap: !!wrap };
  },
});

async function openNotepad({ path = null, size = 0 } = {}) {
  if (path) {
    const open = [...notes].find((n) => n.path === path);
    if (open) return open.win.focus();
    if (size > MAX_BYTES) return toast(tt('「{0}」太大（{1}），記事本上限是 5 MB', P.base(path), fmtSize(size)), true);
  }
  const win = createWindow({ title: path ? P.base(path) : tt(UNTITLED), appName: tm('記事本'), iconHtml: notepadSvg(), width: 600, height: 440 });
  const area = h('textarea', { class: 'np-text', spellcheck: 'false', 'aria-label': tt('文字內容') });
  const menubar = h('div', { class: 'ed-menubar' });
  const sState = h('span');
  const sPath = h('span', { class: 'path' });
  const sInfo = h('span');
  win.body.append(menubar, area, h('div', { class: 'statusbar' }, sState, sPath, h('span', { class: 'spacer' }), sInfo));
  const note = { win, path, encoding: 'UTF-8', bom: false, crlf: false, mtime: null, saved: '', saving: false };
  notes.add(note);
  win.destroy = () => notes.delete(note);

  const isDirty = () => area.value !== note.saved;
  note.isDirty = isDirty;
  note.refresh = () => refresh();
  const showWrap = (on) => {
    area.wrap = on ? 'soft' : 'off';
  };
  const setWrap = (on) => {
    showWrap(on);
    data.set('wrap', on);
  };
  showWrap(data.get('wrap') !== false);
  const refresh = () => {
    const name = note.path ? P.base(note.path) : tt(UNTITLED);
    const dirty = isDirty();
    win.setTitle((dirty ? '● ' : '') + name);
    win.setDirty(dirty);
    sState.textContent = note.saving ? tt('儲存中…') : dirty ? tt('已修改') : note.path ? tt('已儲存') : tt('新文件');
    sState.className = dirty ? 'dirty-flag' : '';
    sPath.textContent = sPath.title = note.path || '';
    sInfo.textContent = `${note.encoding}${note.bom ? ' BOM' : ''} · ${note.crlf ? 'CRLF' : 'LF'}`;
  };

  if (path) {
    area.disabled = true;
    try {
      const res = await rpc('read', { path });
      const decoded = decodeText(fromBase64(res.data));
      if (!decoded) throw Object.assign(new Error(tt('不是文字檔')), { code: 'binary' });
      note.crlf = decoded.text.includes('\r\n');
      // A textarea always uses \n; CRLF is put back on save.
      area.value = note.saved = decoded.text.replace(/\r\n/g, '\n');
      Object.assign(note, { encoding: decoded.encoding, bom: decoded.bom, mtime: res.mtime });
    } catch (err) {
      await win.close(true);
      return toast(tt('無法開啟「{0}」：{1}', P.base(path), err.code === 'binary' ? tt('不是文字檔') : errText(err)), true);
    }
    if (!notes.has(note)) return; // closed while loading
    area.disabled = false;
  }

  async function write(target, guard) {
    let bytes;
    try {
      bytes = encodeText(note.crlf ? area.value.replace(/\n/g, '\r\n') : area.value, note.encoding, note.bom);
    } catch (err) {
      toast(tt('無法儲存：{0}', err.message), true);
      return false;
    }
    const text = area.value;
    note.saving = true;
    refresh();
    try {
      const r = await rpc('write', { path: target, data: toBase64(bytes), ...guard });
      const moved = target !== note.path;
      Object.assign(note, { path: target, mtime: r.mtime, saved: text });
      if (moved) emit('fs:changed', P.parent(target));
      return true;
    } catch (err) {
      if (err.code === 'changed-on-server') {
        note.saving = false;
        const overwrite = await dialog({
          title: tt('主機上的檔案已被修改'),
          message: tt('「{0}」在你開啟之後，主機上的內容有變動。要用你的版本覆寫嗎？', P.base(target)),
          buttons: [{ label: tt('取消'), value: false, cancel: true }, { label: tt('覆寫'), value: true, danger: true, default: true }],
        });
        return overwrite ? write(target, { force: true }) : false;
      }
      toast(tt('無法儲存「{0}」：{1}', P.base(target), err.code === 'not-found' ? tt('資料夾不存在') : errText(err)), true);
      return false;
    } finally {
      note.saving = false;
      refresh();
    }
  }

  async function saveAs() {
    const target = await pickPath({ mode: 'save', start: note.path ? P.parent(note.path) : conn.info.home, name: note.path ? P.base(note.path) : tt(UNTITLED) + '.txt' });
    if (!target) return false;
    if (target === note.path) return save();
    if ([...notes].some((n) => n !== note && n.path === target)) {
      toast(tt('「{0}」已經在另一個記事本視窗開啟', P.base(target)), true);
      return false;
    }
    try {
      const existing = await rpc('stat', { path: target });
      if (existing.entry.type === 'dir') {
        toast(tt('「{0}」是資料夾，請輸入檔名', target), true);
        return false;
      }
      const replace = await dialog({
        title: tt('「{0}」已經存在', P.base(target)),
        message: tt('要取代 {0} 嗎？原本的內容會被覆蓋。', target),
        buttons: [{ label: tt('取消'), value: false, cancel: true, default: true }, { label: tt('取代'), value: true, danger: true }],
      });
      if (!replace) return false;
    } catch (err) {
      if (err.code !== 'not-found') {
        toast(tt('無法另存到「{0}」：{1}', target, errText(err)), true);
        return false;
      }
    }
    return write(target, {});
  }
  const save = () => {
    if (note.saving) return false;
    return note.path ? write(note.path, { expectMtime: note.mtime }) : saveAs();
  };
  note.save = save;

  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  attachMenuBar(menubar, [
    {
      label: tt('檔案'),
      items: [
        { label: tt('存檔'), key: mod + 'S', run: save },
        { label: tt('另存新檔…'), key: mod + (mod === '⌘' ? '⇧S' : 'Shift+S'), run: saveAs },
        null,
        { label: tt('關閉'), run: () => win.close() },
      ],
    },
    { label: tt('介面'), items: [{ label: tt('自動換行'), checked: () => area.wrap !== 'off', run: () => setWrap(area.wrap === 'off') }] },
  ], () => area.focus());

  win.el.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      (ev.shiftKey ? saveAs : save)();
    }
  });
  // Right-click: the browser's own menu is turned off, so offer the basics here.
  area.addEventListener('contextmenu', (ev) => {
    const hasSelection = area.selectionStart !== area.selectionEnd;
    const command = (name) => () => {
      area.focus();
      document.execCommand(name);
      refresh();
    };
    showContextMenu(ev, [
      { label: tt('剪下'), enabled: hasSelection, run: command('cut') },
      { label: tt('複製'), enabled: hasSelection, run: command('copy') },
      { label: tt('貼上'), run: async () => {
        area.focus();
        try {
          area.setRangeText(await navigator.clipboard.readText(), area.selectionStart, area.selectionEnd, 'end');
          refresh();
        } catch {
          toast(tt('瀏覽器不允許讀取剪貼簿，請改用 Ctrl+V'), true);
        }
      } },
      null,
      { label: tt('全選'), run: () => {
        area.focus();
        area.select();
      } },
    ]);
  });
  area.addEventListener('input', refresh);
  win.onFocus = () => {
    if (!win.el.contains(document.activeElement)) area.focus();
  };
  win.onClose = async () => {
    if (!isDirty()) return true;
    win.focus();
    const choice = await dialog({
      title: tt('要儲存「{0}」的修改嗎？', note.path ? P.base(note.path) : tt(UNTITLED)),
      message: tt('不儲存的話，修改的內容會遺失。'),
      buttons: [
        { label: tt('不儲存'), value: 'discard', danger: true },
        { label: tt('取消'), value: 'cancel', cancel: true },
        { label: tt('儲存'), value: 'save', default: true },
      ],
    });
    if (choice === 'discard') return true;
    return choice === 'save' ? save() : false;
  };
  refresh();
  area.focus();
}

// A renamed or moved file (or a folder above it) takes its open notepads along.
on('fs:moved', (from, to) => {
  for (const note of notes) {
    const next = note.path === from ? to : note.path?.startsWith(from + '/') ? to + note.path.slice(from.length) : null;
    if (next) {
      note.path = next;
      note.refresh?.();
    }
  }
});

registerApp({
  id: 'notepad',
  order: 30,
  name: tm('記事本'),
  icon: notepadSvg,
  startMenu: true,
  extensions: 'all', // same as the editor: any text file
  launch: openNotepad,
  unsavedCount: () => [...notes].filter((n) => n.isDirty?.()).length,
});
