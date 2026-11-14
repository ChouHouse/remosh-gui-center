// Procoder's file tree: the opened folder, shown down the left side. Folders
// load when they are first expanded.
import { h } from '../../core/dom.js';
import { P, isInvisible } from '../../core/path.js';
import { rpc } from '../../core/rpc.js';
import { errText } from '../../core/errors.js';
import { fileSvg, folderSvg, ICON, stroke } from '../../core/icons.js';
import { copyText } from '../../core/clipboard.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { toast, dialog } from '../../core/ui.js';
import { writeFile } from '../../core/file-io.js';
import { emit } from '../../core/events.js';

const CHEVRON = stroke('<path d="m6 3.5 4.5 4.5L6 12.5"/>');
const NEW_FILE = stroke('<path d="M9 2.5H4.5v11h7V5zM9 2.5V5h2.5M8 7.5v4M6 9.5h4"/>');
const NEW_FOLDER = stroke('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5zM8 7v4M6 9h4"/>');
const badName = (name) => !name || name === '.' || name === '..' || name.includes('/');
const CLOSE = stroke('<path d="m4 4 8 8M12 4l-8 8"/>');
const isFolder = (e) => e.type === 'dir' || e.targetType === 'dir';
const byName = (a, b) => isFolder(b) - isFolder(a) || a.name.localeCompare(b.name, undefined, { numeric: true });

// actions: { openFile(path, size), openFolder(), closeFolder(), removed(path) }
export function createTree(actions) {
  let root = null;
  let current = null; // path of the file in the active tab
  const expanded = new Set();
  let focusNext = null; // path of the row to give the focus to at the next redraw
  const dirs = new Map(); // path -> { entries } | { error } | { loading: true }
  const title = h('span', { class: 'pc-side-title' });
  const body = h('div', { class: 'pc-tree', role: 'tree' });
  const bRefresh = h('button', { type: 'button', title: '重新整理', 'aria-label': '重新整理', html: ICON.refresh, onclick: () => refresh() });
  const bClose = h('button', { type: 'button', title: '關閉資料夾', 'aria-label': '關閉資料夾', html: CLOSE, onclick: () => actions.closeFolder() });
  const bNewFile = h('button', { type: 'button', title: '新增檔案', 'aria-label': '新增檔案', html: NEW_FILE, onclick: () => create(root, false) });
  const bNewDir = h('button', { type: 'button', title: '新增資料夾', 'aria-label': '新增資料夾', html: NEW_FOLDER, onclick: () => create(root, true) });
  const tools = h('span', { class: 'pc-side-tools' }, bNewFile, bNewDir, bRefresh, bClose);
  const label = (path) => (path === '/' ? '/' : P.base(path));
  const el = h('aside', { class: 'pc-side' }, h('div', { class: 'pc-side-head' }, title, tools), body);

  async function load(path, quiet) {
    const mine = root;
    if (!quiet || !dirs.has(path)) dirs.set(path, { loading: true, entries: dirs.get(path)?.entries });
    try {
      const res = await rpc('list', { path });
      if (root !== mine) return;
      dirs.set(path, { entries: res.entries.filter((e) => !isInvisible(e.name)).sort(byName) });
    } catch (err) {
      if (root !== mine) return;
      dirs.set(path, { error: errText(err) });
    }
    render();
  }

  function toggle(path) {
    if (expanded.has(path)) expanded.delete(path);
    else {
      expanded.add(path);
      if (!dirs.get(path)?.entries) load(path);
    }
    render();
  }

  function rows(path, depth, out) {
    const dir = dirs.get(path);
    const pad = `padding-left:${8 + depth * 14}px`;
    if (!dir || (dir.loading && !dir.entries)) return out.push(h('div', { class: 'pc-row-note', style: pad }, '載入中…'));
    if (dir.error) return out.push(h('div', { class: 'pc-row-note err', style: pad, title: dir.error }, dir.error));
    if (!dir.entries.length) return out.push(h('div', { class: 'pc-row-note', style: pad }, '（空的）'));
    for (const entry of dir.entries) {
      const full = P.join(path, entry.name);
      const isDir = isFolder(entry);
      const open = isDir && expanded.has(full);
      const row = h('button', {
        type: 'button', role: 'treeitem', style: pad, title: full, 'data-path': full,
        class: 'pc-row' + (isDir ? ' dir' : '') + (open ? ' open' : '') + (full === current ? ' current' : ''),
        'aria-expanded': isDir ? String(open) : null,
        onclick: () => (isDir ? toggle(full) : actions.openFile(full, entry.size)),
        oncontextmenu: (ev) => {
          ev.stopPropagation();
          const into = isDir ? full : path; // where "new" puts things
          showContextMenu(ev, [
            isDir ? { label: open ? '收合' : '展開', run: () => toggle(full) } : { label: '開啟', run: () => actions.openFile(full, entry.size) },
            null,
            { label: '新增檔案', run: () => create(into, false) },
            { label: '新增資料夾', run: () => create(into, true) },
            null,
            { label: '重新命名（F2）', run: () => rename(full, entry.name) },
            { label: '刪除', danger: true, run: () => remove(full, entry.name, isDir) },
            null,
            { label: '複製路徑', run: () => copyText(full) },
            { label: '重新整理', run: () => refresh() },
          ]);
        },
      },
      h('span', { class: 'pc-row-arrow', html: isDir ? CHEVRON : '' }),
      h('span', { class: 'pc-row-ico', html: isDir ? folderSvg() : fileSvg(entry.name) }),
      h('span', { class: 'pc-row-name' }, entry.name));
      out.push(row);
      if (open) rows(full, depth + 1, out);
    }
  }

  // ---- new file / new folder / rename / delete
  function expand(dir) {
    if (dir !== root) expanded.add(dir);
    return load(dir, true);
  }

  async function create(dir, isDir) {
    if (!root) return;
    const kind = isDir ? '資料夾' : '檔案';
    const answer = await dialog({
      title: '新增' + kind,
      message: `在「${label(dir)}」裡新增${kind}，名稱：`,
      input: isDir ? '新資料夾' : '未命名.txt',
      buttons: [{ label: '取消', value: false, cancel: true }, { label: '新增', value: true, default: true }],
    });
    if (!answer.value) return;
    const name = answer.text.trim();
    if (badName(name)) return toast('名稱不能是空的，也不能包含 /', true);
    const full = P.join(dir, name);
    try {
      const exists = await rpc('stat', { path: full }).then(() => true, (err) => {
        if (err.code === 'not-found') return false;
        throw err;
      });
      if (exists) return toast(`已經有「${name}」了`, true);
      if (isDir) await rpc('mkdir', { path: full, mode: 0o755 });
      else await writeFile(full, new Uint8Array(0));
    } catch (err) {
      return toast(`無法建立「${name}」：${errText(err)}`, true);
    }
    await expand(dir);
    emit('fs:changed', dir);
    if (!isDir) actions.openFile(full, 0);
  }

  async function rename(full, oldName) {
    const answer = await dialog({
      title: '重新命名',
      message: `「${oldName}」的新名稱：`,
      input: oldName,
      buttons: [{ label: '取消', value: false, cancel: true }, { label: '重新命名', value: true, default: true }],
    });
    const name = answer.value ? answer.text.trim() : '';
    if (!answer.value || name === oldName) return;
    if (badName(name)) return toast('名稱不能是空的，也不能包含 /', true);
    const dir = P.parent(full);
    const to = P.join(dir, name);
    try {
      const exists = await rpc('stat', { path: to }).then(() => true, (err) => {
        if (err.code === 'not-found') return false;
        throw err;
      });
      if (exists) return toast(`已經有「${name}」了`, true);
      await rpc('move', { from: full, to });
    } catch (err) {
      return toast(`無法重新命名「${oldName}」：${errText(err)}`, true);
    }
    // What was open below the old name stays open below the new one.
    for (const p of [...expanded]) {
      if (p === full || p.startsWith(full + '/')) {
        expanded.delete(p);
        expanded.add(to + p.slice(full.length));
      }
    }
    for (const p of [...dirs.keys()]) if (p === full || p.startsWith(full + '/')) dirs.delete(p);
    for (const p of expanded) if (!dirs.has(p)) load(p, true);
    focusNext = to;
    emit('fs:moved', full, to); // open tabs follow the file
    emit('fs:changed', dir);
  }

  async function remove(full, name, isDir) {
    const sure = await dialog({
      title: `刪除「${name}」？`,
      message: isDir ? '資料夾和裡面所有的東西都會從主機上刪除，無法復原。' : '這個檔案會從主機上刪除，無法復原。',
      buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '刪除', value: true, danger: true }],
    });
    if (!sure) return;
    try {
      await rpc('remove', { path: full });
    } catch (err) {
      return toast(`無法刪除「${name}」：${errText(err)}`, true);
    }
    for (const p of [...expanded]) if (p === full || p.startsWith(full + '/')) expanded.delete(p);
    actions.removed(full);
    emit('fs:changed', P.parent(full));
  }

  // Keyboard, on the row that has the focus (the one clicked last): F2 renames,
  // Delete deletes, the arrow keys walk up and down.
  body.addEventListener('keydown', (ev) => {
    const row = ev.target.closest?.('.pc-row');
    if (!row || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const full = row.dataset.path;
    if (ev.key === 'F2') rename(full, P.base(full));
    else if (ev.key === 'Delete') remove(full, P.base(full), row.classList.contains('dir'));
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const all = [...body.querySelectorAll('.pc-row')];
      all[all.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  });

  body.addEventListener('contextmenu', (ev) => {
    if (!root) return;
    showContextMenu(ev, [
      { label: '新增檔案', run: () => create(root, false) },
      { label: '新增資料夾', run: () => create(root, true) },
      null,
      { label: '重新整理', run: () => refresh() },
    ]);
  });

  function render() {
    el.classList.toggle('empty', !root);
    title.textContent = root ? (root === '/' ? '/' : P.base(root)) : '檔案';
    title.title = root || '';
    tools.style.display = root ? '' : 'none';
    if (!root) {
      body.replaceChildren(h('div', { class: 'pc-tree-empty' },
        h('p', null, '還沒有開啟資料夾'),
        h('button', { type: 'button', class: 'pc-tree-open', onclick: () => actions.openFolder() }, '開啟資料夾')));
      return;
    }
    const top = body.scrollTop;
    // The row with the keyboard focus keeps it across a redraw.
    const focused = focusNext || (body.contains(document.activeElement) ? document.activeElement.dataset.path : null);
    const out = [];
    rows(root, 0, out);
    body.replaceChildren(...out);
    body.scrollTop = top;
    const again = focused && out.find((row) => row.dataset?.path === focused);
    if (again) {
      again.focus({ preventScroll: true });
      focusNext = null;
    }
  }

  // Reload what is on screen: one folder (when it changed), or all the open ones.
  function refresh(dir) {
    if (!root) return;
    const shown = [root, ...expanded].filter((p) => dirs.has(p));
    for (const path of dir ? shown.filter((p) => p === dir) : shown) load(path, true);
  }

  function setRoot(path) {
    root = path || null;
    expanded.clear();
    dirs.clear();
    if (root) load(root);
    render();
    if (current) setCurrent(current);
  }

  // Mark the active tab's file; folders above it open so it can be seen.
  function setCurrent(path) {
    current = path || null;
    if (root && current && (root === '/' ? current.startsWith('/') : current.startsWith(root + '/'))) {
      for (let dir = P.parent(current); dir.length > root.length; dir = P.parent(dir)) {
        if (!expanded.has(dir)) {
          expanded.add(dir);
          if (!dirs.get(dir)?.entries) load(dir);
        }
      }
    }
    render();
    body.querySelector('.pc-row.current')?.scrollIntoView({ block: 'nearest' });
  }

  render();
  return { el, setRoot, setCurrent, refresh, get root() { return root; } };
}
