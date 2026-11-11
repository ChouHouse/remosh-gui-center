// The desktop: icons for whatever is in ~/.remosh-gui/desktop, laid out in
// columns from the top left. Files and folders can be dropped here (move,
// Ctrl = copy, Alt = shortcut) and apps become app shortcuts.
import { $, h } from '../core/dom.js';
import { P } from '../core/path.js';
import { errText } from '../core/errors.js';
import { toast, dialog } from '../core/ui.js';
import { folderSvg, fileSvg } from '../core/icons.js';
import { conn, rpc } from '../core/rpc.js';
import { on, emit } from '../core/events.js';
import { settingsDir, whenSettingsReady } from '../core/settings.js';
import { getApp, launchApp } from './apps.js';
import { showContextMenu } from './context-menu.js';
import { makeDraggable, registerDropTarget } from './drag.js';
import { acceptsDrop, dropAction, dropInto } from './file-drop.js';
import { openFile } from './file-open.js';
import { desktopDir, shortcutKind, displayName, readShortcut } from './shortcuts.js';
import { isPinned, pinApp } from './start-menu.js';

const layer = h('div', { id: 'desktop-icons', tabindex: '0', 'aria-label': '桌面' });
$('#windows').prepend(layer);

let items = []; // { entry, path, label, icon, kind, shortcut }
let listed = ''; // signature of the last listing, to skip redraws
let selected = null;
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
  layer.replaceChildren(...items.map((it, i) =>
    h('div', { class: 'desk-item' + (it.path === selected ? ' selected' : ''), 'data-i': i, title: it.label },
      h('span', { class: 'ico', html: it.icon }), h('span', { class: 'name' }, it.label))));
}

async function load(force) {
  if (!active || !conn.ws) return;
  try {
    const dir = desktopDir();
    const { entries } = await rpc('list', { path: dir });
    const signature = entries.map((e) => `${e.name}|${e.type}|${e.size}|${e.mtime}`).sort().join('\n');
    if (!force && signature === listed) return;
    const next = await Promise.all(entries
      .filter((e) => !e.name.startsWith('.'))
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

async function remove(it) {
  const ok = await dialog({
    title: `確定要刪除「${it.label}」嗎？`,
    message: it.kind ? '只會刪除這個捷徑，不會影響它指向的東西。' : isDir(it.entry) ? '資料夾裡的所有內容都會一起刪除，而且無法復原。' : '刪除後無法復原。',
    buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '刪除', value: true, danger: true }],
  });
  if (!ok) return;
  try {
    await rpc('remove', { path: it.path });
  } catch (err) {
    toast(`無法刪除「${it.label}」：${errText(err)}`, true);
  }
  emit('fs:changed', desktopDir());
}

const itemAt = (ev) => {
  const el = ev.target.closest?.('.desk-item');
  return el ? items[Number(el.dataset.i)] : null;
};
const select = (it) => {
  selected = it?.path || null;
  for (const el of layer.children) el.classList.toggle('selected', items[Number(el.dataset.i)]?.path === selected);
};
layer.addEventListener('click', (ev) => select(itemAt(ev)));
layer.addEventListener('dblclick', (ev) => {
  const it = itemAt(ev);
  if (it) open(it);
});
layer.addEventListener('keydown', (ev) => {
  const it = items.find((x) => x.path === selected);
  if (!it) return;
  if (ev.key === 'Enter') open(it);
  else if (ev.key === 'Delete') remove(it);
});
layer.addEventListener('contextmenu', (ev) => {
  const it = itemAt(ev);
  select(it);
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
  return it && { type: 'file', name: it.label, icon: it.icon, data: { path: it.path, isDir: isDir(it.entry), size: it.entry.size } };
});
registerDropTarget(layer, {
  accepts: acceptsDrop,
  action: dropAction,
  onDrop: (payload, drop) => dropInto(desktopDir(), payload, drop),
});

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
  selected = null;
  resolved.clear();
  render();
});
