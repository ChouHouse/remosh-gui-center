// The system's file chooser. It belongs to no app: any app asks it for a path.
//
//   pickPath({ mode, title, start, name }) -> Promise<path | null>
//
//   mode 'file'    only a file can be chosen; clicking a folder walks into it
//   mode 'folder'  only a folder can be chosen; files are shown but greyed out
//   mode 'save'    choose the folder and type a name; resolves to folder/name
//   start          folder to begin in (the home folder when left out)
//   name           'save' only: the name to begin with
//
// Two columns, like the macOS column view cut down to two: the left one lists
// a folder, the right one what is inside the folder picked on the left. Going
// into a folder on the right shifts everything one column over. Each column
// has a "back" button, and either one goes up one level.
import { h } from '../core/dom.js';
import { P, isInvisible } from '../core/path.js';
import { conn, rpc } from '../core/rpc.js';
import { errText } from '../core/errors.js';
import { fmtSize } from '../core/format.js';
import { fileSvg, folderSvg, ICON, stroke } from '../core/icons.js';
import { tt, tm } from '../core/i18n.js';

const CHEVRON = stroke('<path d="m6 3.5 4.5 4.5L6 12.5"/>');
const isFolder = (e) => e.type === 'dir' || e.targetType === 'dir';
const byName = (a, b) => isFolder(b) - isFolder(a) || a.name.localeCompare(b.name, undefined, { numeric: true });
const label = (path) => (path === '/' ? '/' : P.base(path));
const TITLES = { file: tm('開啟檔案'), folder: tm('開啟資料夾'), save: tm('另存新檔') };
let showHidden = false; // kept while the page is open

export function pickPath({ mode = 'file', title = tt(TITLES[mode]), start, name = '' } = {}) {
  return new Promise((resolve) => {
    const home = conn.info.home;
    const first = P.norm(start || home);
    let base = first === '/' ? '/' : P.parent(first); // folder in the left column
    let sub = first === '/' ? null : first; // folder in the right column (picked on the left)
    let file = null; // the chosen file: { path, entry }
    const lists = new Map(); // path -> { entries } | { error }
    const scroll = new Map();
    let closed = false;

    const cols = h('div', { class: 'pk-cols' });
    const where = h('span', { class: 'pk-where' });
    const nameField = mode === 'save' ? h('input', { type: 'text', value: name, spellcheck: 'false', autocapitalize: 'off', 'aria-label': tt('檔案名稱') }) : null;
    const ok = h('button', { type: 'button', class: 'default pk-ok', onclick: () => confirm() });
    const hidden = h('input', { type: 'checkbox', onchange: () => {
      showHidden = hidden.checked;
      render();
    } });
    hidden.checked = showHidden;
    const modal = h('div', { class: 'modal picker', role: 'dialog', 'aria-modal': 'true', 'data-mode': mode },
      h('div', { class: 'box pk-box' },
        h('div', { class: 'pk-head' }, h('h2', null, title),
          h('button', { type: 'button', class: 'pk-home', title: home, onclick: () => go(home) }, h('span', { html: ICON.home }), tt('家目錄'))),
        cols,
        nameField && h('label', { class: 'pk-name' }, h('span', null, tt('檔案名稱')), nameField),
        h('div', { class: 'pk-foot' },
          h('label', { class: 'pk-hidden' }, hidden, tt('顯示隱藏檔')), where,
          h('button', { type: 'button', class: 'pk-cancel', onclick: () => done(null) }, tt('取消')), ok)));

    const folder = () => sub || base; // where a saved file goes; the chosen folder in 'folder' mode
    const result = () => {
      if (mode === 'file') return file?.path || null;
      if (mode === 'folder') return folder();
      const typed = nameField.value.trim();
      if (!typed || typed.endsWith('/')) return null;
      return P.norm(typed.startsWith('/') ? typed : P.join(folder(), typed));
    };

    function done(value) {
      if (closed) return;
      closed = true;
      modal.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    }
    function confirm() {
      const value = result();
      if (value) done(value);
    }
    function onKey(ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        done(null);
      } else if (ev.key === 'Enter' && (ev.target === nameField || !ev.target.closest?.('button, input'))) {
        ev.preventDefault();
        ev.stopPropagation();
        confirm();
      } else if (!modal.contains(ev.target)) ev.stopPropagation(); // nothing behind the chooser reacts
    }

    async function load(path) {
      if (lists.has(path)) return;
      lists.set(path, { loading: true });
      try {
        const res = await rpc('list', { path });
        lists.set(path, { entries: res.entries.filter((e) => !isInvisible(e.name)).sort(byName) });
      } catch (err) {
        lists.set(path, { error: errText(err) });
      }
      if (!closed) render();
    }

    // Show `path` on the right, its parent on the left.
    function go(path) {
      base = path === '/' ? '/' : P.parent(path);
      sub = path === '/' ? null : path;
      file = null;
      render();
    }
    const up = () => base !== '/' && go(base);

    function pickFolder(path, side) {
      if (side === 'right') base = sub;
      sub = path;
      file = null;
      render();
    }
    function pickFile(path, entry, side) {
      if (mode === 'folder') return;
      if (side === 'left') sub = null; // the right column then describes the file
      file = { path, entry };
      if (nameField) nameField.value = entry.name;
      render();
    }

    function column(path, side) {
      const head = h('div', { class: 'pk-col-head' },
        h('button', { type: 'button', class: 'pk-back', title: tt('上一層'), 'aria-label': tt('上一層'), disabled: base === '/', html: ICON.back, onclick: up }),
        h('span', { class: 'pk-col-name', title: path }, label(path)));
      const list = h('div', { class: 'pk-list', 'data-path': path });
      list.addEventListener('scroll', () => scroll.set(path, list.scrollTop));
      const state = lists.get(path);
      if (!state) load(path);
      if (!state || state.loading) list.append(h('div', { class: 'pk-note' }, tt('載入中…')));
      else if (state.error) list.append(h('div', { class: 'pk-note err' }, state.error));
      else {
        const shown = state.entries.filter((e) => showHidden || !e.name.startsWith('.'));
        if (!shown.length) list.append(h('div', { class: 'pk-note' }, tt('（空的）')));
        for (const entry of shown) {
          const full = P.join(path, entry.name);
          const dir = isFolder(entry);
          const off = !dir && mode === 'folder';
          const on = dir ? full === sub : full === file?.path;
          list.append(h('button', {
            type: 'button', title: full, 'data-name': entry.name, disabled: off,
            class: 'pk-item' + (dir ? ' dir' : ' file') + (on ? ' on' : ''),
            onclick: () => (dir ? pickFolder(full, side) : pickFile(full, entry, side)),
            ondblclick: () => !dir && mode !== 'folder' && confirm(),
          },
          h('span', { class: 'pk-ico', html: dir ? folderSvg() : fileSvg(entry.name) }),
          h('span', { class: 'pk-item-name' }, entry.name),
          dir ? h('span', { class: 'pk-arrow', html: CHEVRON }) : null));
        }
      }
      return { el: h('div', { class: 'pk-col ' + side, 'data-side': side }, head, list), list, path };
    }

    function render() {
      const left = column(base, 'left');
      let rightEl;
      let right = null;
      if (sub) {
        right = column(sub, 'right');
        rightEl = right.el;
      } else {
        // Nothing picked on the left yet, or a file: say so in the right column.
        const head = h('div', { class: 'pk-col-head' },
          h('button', { type: 'button', class: 'pk-back', title: tt('上一層'), 'aria-label': tt('上一層'), disabled: base === '/', html: ICON.back, onclick: up }),
          h('span', { class: 'pk-col-name' }, file ? file.entry.name : ''));
        const info = file
          ? h('div', { class: 'pk-info' }, h('span', { class: 'pk-info-ico', html: fileSvg(file.entry.name) }), h('strong', null, file.entry.name), h('span', null, fmtSize(file.entry.size || 0)))
          : h('div', { class: 'pk-info' }, h('span', null, mode === 'file' ? tt('在左邊點資料夾看裡面的內容，點檔案來選它') : tt('在左邊點資料夾看裡面的內容')));
        rightEl = h('div', { class: 'pk-col right', 'data-side': 'right' }, head, info);
      }
      cols.replaceChildren(left.el, rightEl);
      for (const col of [left, right]) {
        if (!col) continue;
        if (scroll.has(col.path)) col.list.scrollTop = scroll.get(col.path);
        else col.list.querySelector('.pk-item.on')?.scrollIntoView({ block: 'center' });
      }
      const value = result();
      ok.textContent = mode === 'file' ? tt('開啟') : mode === 'save' ? tt('儲存') : tt('選擇「{0}」', label(folder()));
      ok.disabled = !value;
      where.textContent = mode === 'file' ? (file ? file.path : tt('請選擇一個檔案')) : mode === 'folder' ? folder() : tt('存到 {0}', folder());
      where.title = where.textContent;
    }

    nameField?.addEventListener('input', () => {
      ok.disabled = !result();
    });
    document.body.append(modal);
    document.addEventListener('keydown', onKey, true);
    render();
    if (nameField) {
      nameField.focus();
      const dot = name.lastIndexOf('.');
      nameField.setSelectionRange(0, dot > 0 ? dot : name.length);
    } else ok.focus();
  });
}
