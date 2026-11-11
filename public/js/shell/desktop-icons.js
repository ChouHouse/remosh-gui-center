// The desktop: icons for whatever is in ~/.remosh-gui/desktop. New icons fill
// columns from the top left; an icon dragged somewhere stays in that grid cell,
// remembered in desktop/config.inv-remosh_gui-config as an array of
// { name, col, row } (an invisible file: the GUI never lists it). Files and folders can be dropped here (move,
// Ctrl = copy, Alt = shortcut) and apps become app shortcuts.
import { $, h } from '../core/dom.js';
import { P, isInvisible } from '../core/path.js';
import { fromBase64 } from '../core/text-codec.js';
import { errText } from '../core/errors.js';
import { toast, dialog } from '../core/ui.js';
import { folderSvg, fileSvg } from '../core/icons.js';
import { conn, rpc } from '../core/rpc.js';
import { on, emit } from '../core/events.js';
import { settingsDir, whenSettingsReady } from '../core/settings.js';
import { getApp, launchApp } from './apps.js';
import { showContextMenu } from './context-menu.js';
import { makeDraggable, registerDropTarget } from './drag.js';
import { attachMarquee } from './marquee.js';
import { acceptsDrop, dropAction, dropInto } from './file-drop.js';
import { openFile } from './file-open.js';
import { desktopDir, shortcutKind, displayName, readShortcut, writeText } from './shortcuts.js';
import { isPinned, pinApp } from './start-menu.js';

const layer = h('div', { id: 'desktop-icons', tabindex: '0', 'aria-label': '桌面' });
$('#windows').prepend(layer);

let items = []; // { entry, path, label, icon, kind, shortcut }

// ---- placement
const CONFIG_NAME = 'config.inv-remosh_gui-config';
const CELL = 96; // px per grid cell
const PAD = 12;
let placed = new Map(); // file name -> { col, row }, only icons the user has put somewhere
let configSeen = ''; // mtime|size of the config last read
let saveTimer = 0;
let savePending = false; // positions changed here and are not on the host yet
const gridSize = () => ({
  cols: Math.max(1, Math.floor((layer.clientWidth - PAD) / CELL)),
  rows: Math.max(1, Math.floor((layer.clientHeight - PAD) / CELL)),
});

// Where every icon goes: remembered cells first, the rest fill the free cells
// column by column from the top left.
function layout() {
  const { cols, rows } = gridSize();
  const used = new Set();
  const cells = new Map();
  for (const it of items) {
    const p = placed.get(it.entry.name);
    if (p && p.col < cols && p.row < rows && !used.has(`${p.col},${p.row}`)) {
      cells.set(it.entry.name, p);
      used.add(`${p.col},${p.row}`);
    }
  }
  let col = 0;
  let row = 0;
  for (const it of items) {
    if (cells.has(it.entry.name)) continue;
    while (used.has(`${col},${row}`)) {
      if (++row >= rows) {
        row = 0;
        col++;
      }
    }
    cells.set(it.entry.name, { col, row });
    used.add(`${col},${row}`);
  }
  return cells;
}

function saveConfig() {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const names = new Set(items.map((it) => it.entry.name));
    const list = [...placed].filter(([name]) => names.has(name)).map(([name, p]) => ({ name, col: p.col, row: p.row }));
    try {
      await writeText(P.join(desktopDir(), CONFIG_NAME), JSON.stringify(list, null, 2) + '\n');
    } catch (err) {
      toast(`無法記住圖示位置：${errText(err)}`, true);
    }
    savePending = false;
  }, 300);
}

async function readConfig(entry) {
  if (savePending) return; // what is in memory is newer than the file
  const stamp = entry ? `${entry.mtime}|${entry.size}` : '';
  if (stamp === configSeen) return;
  configSeen = stamp;
  if (!entry) return;
  try {
    const res = await rpc('read', { path: P.join(desktopDir(), CONFIG_NAME) });
    const list = JSON.parse(new TextDecoder().decode(fromBase64(res.data)));
    if (!Array.isArray(list)) return;
    placed = new Map(list
      .filter((x) => typeof x?.name === 'string' && Number.isInteger(x.col) && Number.isInteger(x.row) && x.col >= 0 && x.row >= 0)
      .map((x) => [x.name, { col: x.col, row: x.row }]));
  } catch {
    /* unreadable or not JSON: keep the positions already known */
  }
}

// Put `name` in the cell under a point; whatever was there takes its old place.
function placeAt(name, clientX, clientY) {
  const rect = layer.getBoundingClientRect();
  const { cols, rows } = gridSize();
  const col = Math.max(0, Math.min(cols - 1, Math.floor((clientX - rect.left - PAD) / CELL)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor((clientY - rect.top - PAD) / CELL)));
  const cells = layout();
  const from = cells.get(name);
  for (const [other, p] of cells) {
    if (other !== name && p.col === col && p.row === row) {
      if (from) placed.set(other, from);
      else placed.delete(other); // a newcomer took its cell: it goes back to automatic placement
    }
  }
  placed.set(name, { col, row });
  render();
  saveConfig();
}
let listed = ''; // signature of the last listing, to skip redraws
let sel = new Set(); // paths of the selected icons
let timer = 0;
let active = false;
const resolved = new Map(); // `${name}|${mtime}|${size}` -> { shortcut, icon }

const isDir = (e) => e.type === 'dir' || (e.type === 'link' && e.targetType === 'dir');
const badge = '<svg class="lnk-badge" viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3.5" fill="#ffffff" stroke="#8a93a0"/><path d="M5 11l6-6M6.5 5H11v4.5" fill="none" stroke="#1f2429" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Work out what a shortcut shows: the app's icon, or its target's.
async function resolve(entry, path) {
  const key = `${entry.name}|${entry.mtime}|${entry.size}`;
  if (resolved.has(key)) return resolved.get(key);
  let out = { shortcut: null, icon: fileSvg('') };
  try {
    const shortcut = await readShortcut(path);
    if (shortcut?.kind === 'app') out = { shortcut, icon: getApp(shortcut.id)?.icon() || fileSvg('') };
    else if (shortcut?.kind === 'lnk') {
      const target = await rpc('stat', { path: shortcut.target }).catch(() => null);
      out = { shortcut, icon: (target?.entry.type === 'dir' ? folderSvg() : fileSvg(P.base(shortcut.target))) + badge };
    }
  } catch {
    /* unreadable: shown as a plain file */
  }
  resolved.set(key, out);
  return out;
}

function render() {
  const cells = layout();
  layer.replaceChildren(...items.map((it, i) =>
    h('div', {
      class: 'desk-item' + (sel.has(it.path) ? ' selected' : ''),
      'data-i': i,
      title: it.label,
      style: `left:${PAD + cells.get(it.entry.name).col * CELL}px;top:${PAD + cells.get(it.entry.name).row * CELL}px`,
    },
      h('span', { class: 'ico', html: it.icon }), h('span', { class: 'name' }, it.label))));
}

async function load(force) {
  if (!active || !conn.ws) return;
  try {
    const dir = desktopDir();
    const { entries } = await rpc('list', { path: dir });
    const config = entries.find((e) => e.name === CONFIG_NAME);
    const stale = !savePending && (config ? `${config.mtime}|${config.size}` : '') !== configSeen;
    await readConfig(config);
    const shown = entries.filter((e) => !isInvisible(e.name) && !e.name.startsWith('.'));
    const signature = shown.map((e) => `${e.name}|${e.type}|${e.size}|${e.mtime}`).sort().join('\n');
    if (!force && !stale && signature === listed) return;
    const next = await Promise.all(shown
      .sort((a, b) => isDir(b) - isDir(a) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      .map(async (entry) => {
        const path = P.join(dir, entry.name);
        const kind = shortcutKind(entry.name);
        const base = { entry, path, kind, label: displayName(entry.name), shortcut: null };
        if (kind) return { ...base, ...(await resolve(entry, path)) };
        return { ...base, icon: isDir(entry) ? folderSvg() : fileSvg(entry.name) };
      }));
    if (!active) return;
    listed = signature;
    items = next;
    render();
  } catch {
    /* keep what is shown; the next round tries again */
  }
}

function open(it) {
  if (it.kind) return openFile(it.path, it.entry.size); // shortcuts resolve themselves
  if (isDir(it.entry)) return launchApp('files', { path: it.path });
  return openFile(it.path, it.entry.size);
}

async function openMany(list) {
  for (const it of list) await open(it); // one at a time, in case one asks which app to use
}

// Several newcomers: the first is already where it was dropped; the others
// take the next free cells after it, going down and then across.
function placeAfter(first, rest) {
  const { cols, rows } = gridSize();
  const cells = layout();
  const moving = new Set(rest);
  const used = new Set([...cells].filter(([name]) => !moving.has(name)).map(([, p]) => `${p.col},${p.row}`));
  let { col, row } = cells.get(first);
  for (const name of rest) {
    do {
      if (++row >= rows) {
        row = 0;
        col++;
      }
    } while (used.has(`${col},${row}`) && col < cols);
    if (col >= cols) break; // no room left on screen: those stay automatic
    placed.set(name, { col, row });
    used.add(`${col},${row}`);
  }
  render();
  saveConfig();
}

// Delete one icon or a list of them (asks once).
async function remove(what) {
  const list = [what].flat();
  if (!list.length) return;
  const one = list.length === 1 ? list[0] : null;
  const ok = await dialog({
    title: one ? `確定要刪除「${one.label}」嗎？` : `確定要刪除這 ${list.length} 個項目嗎？`,
    message: list.every((it) => it.kind) ? '只會刪除捷徑，不會影響它指向的東西。' : list.some((it) => isDir(it.entry)) ? '資料夾裡的所有內容都會一起刪除，而且無法復原。' : '刪除後無法復原。',
    buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '刪除', value: true, danger: true }],
  });
  if (!ok) return;
  for (const it of list) {
    try {
      await rpc('remove', { path: it.path });
    } catch (err) {
      toast(`無法刪除「${it.label}」：${errText(err)}`, true);
    }
  }
  emit('fs:changed', desktopDir());
}

const itemAt = (ev) => {
  const el = ev.target.closest?.('.desk-item');
  return el ? items[Number(el.dataset.i)] : null;
};
const paint = () => {
  for (const el of layer.querySelectorAll('.desk-item')) el.classList.toggle('selected', sel.has(items[Number(el.dataset.i)]?.path));
};
const setSel = (paths) => {
  sel = new Set(paths);
  paint();
};
const chosen = () => items.filter((it) => sel.has(it.path));
layer.addEventListener('click', (ev) => {
  const it = itemAt(ev);
  if (!it) return setSel([]);
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey) setSel(sel.has(it.path) ? [...sel].filter((p) => p !== it.path) : [...sel, it.path]);
  else setSel([it.path]);
});
layer.addEventListener('dblclick', (ev) => {
  const it = itemAt(ev);
  if (it) open(it);
});
layer.addEventListener('keydown', (ev) => {
  const list = chosen();
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
    ev.preventDefault();
    return setSel(items.map((it) => it.path));
  }
  if (!list.length) return;
  if (ev.key === 'Enter') openMany(list);
  else if (ev.key === 'Delete') remove(list);
});
layer.addEventListener('contextmenu', (ev) => {
  const it = itemAt(ev);
  // Right-click inside a multi-selection acts on all of it.
  if (it && sel.has(it.path) && sel.size > 1) {
    const list = chosen();
    return showContextMenu(ev, [
      { label: `開啟 ${list.length} 個項目`, run: () => openMany(list) },
      null,
      { label: `刪除 ${list.length} 個項目`, danger: true, run: () => remove(list) },
    ]);
  }
  setSel(it ? [it.path] : []);
  if (!it) {
    return showContextMenu(ev, [
      { label: '重新整理', run: () => load(true) },
      { label: '開啟桌面資料夾', run: () => launchApp('files', { path: desktopDir() }) },
    ]);
  }
  const appId = it.shortcut?.kind === 'app' ? it.shortcut.id : null;
  showContextMenu(ev, [
    { label: '開啟', run: () => open(it) },
    appId && getApp(appId) ? { label: '釘選到開始', enabled: !isPinned(appId), run: () => pinApp(appId) } : false,
    null,
    { label: '刪除', danger: true, run: () => remove(it) },
  ].filter((x) => x !== false));
});

makeDraggable(layer, (ev) => {
  const it = itemAt(ev);
  if (!it) return null;
  // Dragging one of several selected icons takes the whole selection along.
  const group = sel.has(it.path) && sel.size > 1 ? chosen() : [it];
  return {
    type: 'file',
    name: group.length > 1 ? `${group.length} 個項目` : it.label,
    icon: it.icon,
    data: { path: it.path, paths: group.map((g) => g.path), isDir: isDir(it.entry), size: it.entry.size },
  };
});
attachMarquee(layer, {
  itemSelector: '.desk-item',
  onChange(elements, { additive, first }) {
    if (first) marqueeBase = additive ? new Set(sel) : new Set();
    setSel([...marqueeBase, ...elements.map((el) => items[Number(el.dataset.i)].path)]);
  },
});

// Move a group of icons together: the dragged one goes to the cell under the
// pointer, the rest keep their distance from it.
function placeGroup(names, lead, clientX, clientY) {
  const rect = layer.getBoundingClientRect();
  const { cols, rows } = gridSize();
  const cells = layout();
  const from = cells.get(lead);
  const dc = Math.max(0, Math.min(cols - 1, Math.floor((clientX - rect.left - PAD) / CELL))) - from.col;
  const dr = Math.max(0, Math.min(rows - 1, Math.floor((clientY - rect.top - PAD) / CELL))) - from.row;
  const moving = new Set(names);
  const targets = new Map(names.map((n) => {
    const c = cells.get(n);
    return [n, { col: Math.max(0, Math.min(cols - 1, c.col + dc)), row: Math.max(0, Math.min(rows - 1, c.row + dr)) }];
  }));
  const wanted = new Set([...targets.values()].map((p) => `${p.col},${p.row}`));
  // Icons in the way give up their cell and are placed automatically again.
  for (const [other, p] of cells) if (!moving.has(other) && wanted.has(`${p.col},${p.row}`)) placed.delete(other);
  for (const [n, p] of targets) placed.set(n, p);
  render();
  saveConfig();
}
let marqueeBase = new Set();

registerDropTarget(layer, {
  accepts: acceptsDrop,
  action: dropAction,
  async onDrop(payload, drop) {
    // An icon already on the desktop is just being put somewhere else.
    const paths = payload.data?.paths || [];
    if (payload.type === 'file' && paths.every((p) => P.parent(p) === desktopDir()) && !drop.ctrlKey && !drop.altKey) {
      if (paths.length > 1) return placeGroup(paths.map((p) => P.base(p)), P.base(payload.data.path), drop.clientX, drop.clientY);
      return placeAt(P.base(payload.data.path), drop.clientX, drop.clientY);
    }
    const names = await dropInto(desktopDir(), payload, drop);
    if (!names.length) return;
    await load(true);
    // What was dropped lands where it was dropped (several: from that cell on).
    const present = names.filter((n) => items.some((it) => it.entry.name === n));
    if (!present.length) return;
    placeAt(present[0], drop.clientX, drop.clientY);
    if (present.length > 1) placeAfter(present[0], present.slice(1));
  },
});

// A renamed icon keeps its place.
on('fs:moved', (from, to) => {
  if (!active || P.parent(from) !== desktopDir() || P.parent(to) !== desktopDir()) return;
  const p = placed.get(P.base(from));
  if (!p) return;
  placed.delete(P.base(from));
  placed.set(P.base(to), p);
  saveConfig();
});
new ResizeObserver(() => active && render()).observe(layer);

on('fs:changed', (dir) => {
  if (active && dir === desktopDir()) load(true);
});
on('session:start', async () => {
  active = true;
  await whenSettingsReady();
  try {
    await rpc('mkdir', { path: settingsDir() });
    await rpc('mkdir', { path: desktopDir(), mode: 0o755 });
  } catch {
    /* read-only home: the desktop just stays empty */
  }
  load(true);
  clearInterval(timer);
  timer = setInterval(() => !document.hidden && load(false), 4000);
});
on('session:end', () => {
  active = false;
  clearInterval(timer);
  items = [];
  listed = '';
  sel = new Set();
  placed = new Map();
  configSeen = '';
  clearTimeout(saveTimer);
  resolved.clear();
  render();
});
