// Filex: sends files from this computer up to the host. Pick any number of
// files (or drop them on the window); they go, one after another, into the
// folder chosen at the top.
import './i18n.js'; // this app's texts in the other languages
import { h } from '../../core/dom.js';
import { appStore } from '../../core/app-store.js';
import { errText } from '../../core/errors.js';
import { dialog } from '../../core/ui.js';
import { fmtSize } from '../../core/format.js';
import { P, freeName } from '../../core/path.js';
import { fileSvg, ICON } from '../../core/icons.js';
import { conn, rpc } from '../../core/rpc.js';
import { emit, on } from '../../core/events.js';
import { toBase64 } from '../../core/text-codec.js';
import { createWindow } from '../../shell/wm.js';
import { pickPath } from '../../shell/picker.js';
import { registerApp, launchApp, useAppStyle } from '../../shell/apps.js';
import { filexSvg } from './icon.js';
import { tt } from '../../core/i18n.js';

useAppStyle(import.meta.url);

const APP_NAME = 'Filex';
const PIECE = 4 * 1024 * 1024; // bytes sent per request
const data = appStore('filex', { defaults: { dest: null } }); // the folder used last
let open = null; // the one Filex window

function openFilex() {
  if (open) return open.win.focus();
  const win = createWindow({ title: APP_NAME, appName: APP_NAME, iconHtml: filexSvg(), width: 560, height: 480 });
  let dest = data.get('dest') || conn.info.home;
  const items = []; // { file, name, state: 'wait' | 'run' | 'done' | 'fail' | 'skip', sent, note, row… }
  let running = false;
  let closed = false;

  const destText = h('span', { class: 'fx-dest-path' });
  const input = h('input', { type: 'file', multiple: true, hidden: true });
  const list = h('div', { class: 'fx-list' });
  const summary = h('span');
  const bClear = h('button', { type: 'button', class: 'fx-clear', onclick: clearDone }, tt('清除已完成'));
  const drop = h('div', { class: 'fx-drop' },
    h('span', { class: 'fx-drop-ico', html: filexSvg() }),
    h('p', null, tt('把電腦裡的檔案拖到這裡，或')),
    h('button', { type: 'button', class: 'fx-pick', onclick: () => input.click() }, tt('選擇檔案…')),
    h('p', { class: 'fx-hint' }, tt('可以一次選很多個')));
  win.body.append(
    h('div', { class: 'fx-dest' }, h('span', { class: 'fx-dest-label' }, tt('上傳到')), h('span', { class: 'fx-dest-ico', html: ICON.folder }), destText,
      h('button', { type: 'button', class: 'fx-change', onclick: changeDest }, tt('更改…')),
      h('button', { type: 'button', class: 'fx-show', title: tt('在檔案櫃開啟這個資料夾'), onclick: () => launchApp('files', { path: dest }) }, tt('開啟'))),
    h('div', { class: 'fx-main' }, drop, list, input),
    h('div', { class: 'statusbar' }, summary, h('span', { class: 'spacer' }), bClear));

  function paintDest() {
    destText.textContent = destText.title = dest;
  }
  async function changeDest() {
    const path = await pickPath({ mode: 'folder', title: tt('上傳到哪個資料夾'), start: dest });
    if (!path || closed) return;
    dest = path;
    data.set('dest', dest);
    paintDest();
  }

  function paint(item) {
    const pct = item.file.size ? Math.floor((item.sent / item.file.size) * 100) : item.state === 'done' ? 100 : 0;
    item.row.dataset.state = item.state;
    item.bar.style.width = (item.state === 'done' ? 100 : pct) + '%';
    item.status.textContent = item.state === 'wait' ? tt('等待中') : item.state === 'run' ? tt('上傳中 {0}%', pct) : item.state === 'done' ? tt('完成') : item.state === 'skip' ? tt('已略過') : tt('失敗：{0}', item.note);
    item.status.title = item.state === 'fail' ? item.note : '';
    item.nameEl.textContent = item.name;
    item.where.textContent = item.state === 'done' ? P.parent(item.path) : '';
    item.remove.hidden = item.state === 'run';
  }
  function paintAll() {
    const done = items.filter((i) => i.state === 'done').length;
    const left = items.filter((i) => i.state === 'wait' || i.state === 'run').length;
    const failed = items.filter((i) => i.state === 'fail').length;
    summary.textContent = !items.length ? tt('還沒有要上傳的檔案') : left ? tt('上傳中，還有 {0} 個', left) : tt('完成 {0} 個', done) + (failed ? tt('，失敗 {0} 個', failed) : '');
    bClear.hidden = !items.some((i) => i.state !== 'wait' && i.state !== 'run');
    win.body.classList.toggle('fx-has-items', items.length > 0);
    win.setTitle(left ? `${APP_NAME}（${left}）` : APP_NAME);
  }

  function add(files) {
    for (const file of files) {
      const item = { file, name: file.name, state: 'wait', sent: 0, note: '', dest };
      item.nameEl = h('span', { class: 'fx-name' });
      item.status = h('span', { class: 'fx-status' });
      item.where = h('span', { class: 'fx-where' });
      item.bar = h('i');
      item.remove = h('button', { type: 'button', class: 'fx-remove', title: tt('從清單移除'), 'aria-label': tt('從清單移除'), onclick: () => {
        items.splice(items.indexOf(item), 1);
        item.row.remove();
        paintAll();
      } }, '×');
      item.row = h('div', { class: 'fx-item', 'data-name': file.name },
        h('span', { class: 'fx-ico', html: fileSvg(file.name) }),
        h('div', { class: 'fx-body' },
          h('div', { class: 'fx-line' }, item.nameEl, h('span', { class: 'fx-size' }, fmtSize(file.size))),
          h('div', { class: 'fx-bar' }, item.bar),
          h('div', { class: 'fx-line' }, item.status, item.where)),
        item.remove);
      items.push(item);
      list.append(item.row);
      paint(item);
    }
    paintAll();
    run();
  }

  // A name that is already there: replace it, keep both, or leave this one out.
  async function settleName(item, taken) {
    if (!taken.has(item.name)) return true;
    const choice = await dialog({
      title: tt('「{0}」已經存在', item.name),
      message: tt('{0} 裡已經有同名的檔案。', item.dest),
      buttons: [
        { label: tt('略過'), value: 'skip', cancel: true },
        { label: tt('保留兩者'), value: 'both' },
        { label: tt('取代'), value: 'replace', danger: true, default: true },
      ],
    });
    if (choice === 'both') item.name = freeName(item.name, taken);
    return choice === 'both' || choice === 'replace';
  }

  async function send(item) {
    const { file } = item;
    item.path = P.join(item.dest, item.name);
    if (file.size <= PIECE) {
      await rpc('write', { path: item.path, data: toBase64(new Uint8Array(await file.arrayBuffer())), force: true });
      item.sent = file.size;
      return;
    }
    for (let offset = 0; offset < file.size; offset += PIECE) {
      const end = Math.min(offset + PIECE, file.size);
      const piece = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      await rpc('writeChunk', { path: item.path, offset, data: toBase64(piece), last: end === file.size, ...(offset === 0 ? { force: true } : {}) });
      if (closed) throw new Error(tt('已取消'));
      item.sent = end;
      paint(item);
    }
  }

  async function run() {
    if (running) return;
    running = true;
    const names = new Map(); // folder -> names in it
    const changed = new Set();
    for (let item; !closed && (item = items.find((i) => i.state === 'wait'));) {
      try {
        if (!names.has(item.dest)) names.set(item.dest, new Set((await rpc('list', { path: item.dest })).entries.map((e) => e.name)));
        const taken = names.get(item.dest);
        if (!(await settleName(item, taken))) {
          item.state = 'skip';
        } else if (items.includes(item)) {
          item.state = 'run';
          paint(item);
          paintAll();
          await send(item);
          taken.add(item.name);
          changed.add(item.dest);
          item.state = 'done';
        }
      } catch (err) {
        item.state = 'fail';
        item.note = errText(err);
      }
      if (closed) break;
      paint(item);
      paintAll();
    }
    running = false;
    for (const dir of changed) emit('fs:changed', dir);
  }

  function clearDone() {
    for (const item of [...items]) {
      if (item.state === 'wait' || item.state === 'run') continue;
      items.splice(items.indexOf(item), 1);
      item.row.remove();
    }
    paintAll();
  }

  input.addEventListener('change', () => {
    add([...input.files]);
    input.value = '';
  });
  // Files dragged in from the computer (not the desktop's own drag and drop).
  const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');
  win.el.addEventListener('dragover', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    win.body.classList.add('fx-over');
  });
  win.el.addEventListener('dragleave', (ev) => {
    if (!win.el.contains(ev.relatedTarget)) win.body.classList.remove('fx-over');
  });
  win.el.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    win.body.classList.remove('fx-over');
    add([...ev.dataTransfer.files].filter((f) => f.size || f.type)); // a dragged folder has neither
  });

  win.onClose = async () => {
    if (!items.some((i) => i.state === 'wait' || i.state === 'run')) return true;
    win.focus();
    return dialog({
      title: tt('還有檔案沒上傳完'),
      message: tt('現在關閉的話，還沒傳完的檔案不會出現在主機上。'),
      buttons: [{ label: tt('繼續上傳'), value: false, cancel: true, default: true }, { label: tt('關閉'), value: true, danger: true }],
    });
  };
  win.destroy = () => {
    closed = true;
    open = null;
  };
  open = { win };
  paintDest();
  paintAll();
}

on('session:end', () => {
  open = null;
});

registerApp({ id: 'filex', order: 50, name: APP_NAME, icon: filexSvg, startMenu: true, launch: openFilex });
