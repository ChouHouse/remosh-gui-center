// Procoder's file tree: the opened folder, shown down the left side. Folders
// load when they are first expanded.
import { h } from '../../core/dom.js';
import { P, isInvisible } from '../../core/path.js';
import { rpc } from '../../core/rpc.js';
import { errText } from '../../core/errors.js';
import { fileSvg, folderSvg, ICON, stroke } from '../../core/icons.js';
import { copyText } from '../../core/clipboard.js';
import { showContextMenu } from '../../shell/context-menu.js';

const CHEVRON = stroke('<path d="m6 3.5 4.5 4.5L6 12.5"/>');
const CLOSE = stroke('<path d="m4 4 8 8M12 4l-8 8"/>');
const isFolder = (e) => e.type === 'dir' || e.targetType === 'dir';
const byName = (a, b) => isFolder(b) - isFolder(a) || a.name.localeCompare(b.name, undefined, { numeric: true });

// actions: { openFile(path, size), openFolder(), closeFolder() }
export function createTree(actions) {
  let root = null;
  let current = null; // path of the file in the active tab
  const expanded = new Set();
  const dirs = new Map(); // path -> { entries } | { error } | { loading: true }
  const title = h('span', { class: 'pc-side-title' });
  const body = h('div', { class: 'pc-tree', role: 'tree' });
  const bRefresh = h('button', { type: 'button', title: '重新整理', 'aria-label': '重新整理', html: ICON.refresh, onclick: () => refresh() });
  const bClose = h('button', { type: 'button', title: '關閉資料夾', 'aria-label': '關閉資料夾', html: CLOSE, onclick: () => actions.closeFolder() });
  const tools = h('span', { class: 'pc-side-tools' }, bRefresh, bClose);
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
        oncontextmenu: (ev) => showContextMenu(ev, [
          isDir ? { label: open ? '收合' : '展開', run: () => toggle(full) } : { label: '開啟', run: () => actions.openFile(full, entry.size) },
          null,
          { label: '複製路徑', run: () => copyText(full) },
          { label: '重新整理', run: () => refresh() },
        ]),
      },
      h('span', { class: 'pc-row-arrow', html: isDir ? CHEVRON : '' }),
      h('span', { class: 'pc-row-ico', html: isDir ? folderSvg() : fileSvg(entry.name) }),
      h('span', { class: 'pc-row-name' }, entry.name));
      out.push(row);
      if (open) rows(full, depth + 1, out);
    }
  }

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
    const out = [];
    rows(root, 0, out);
    body.replaceChildren(...out);
    body.scrollTop = top;
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
