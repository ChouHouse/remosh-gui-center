// Procoder's file tree: the opened folder, shown down the left side. Folders
// load when they are first expanded.
import { h } from '../../core/dom.js';
import { P, freeName, isInvisible } from '../../core/path.js';
import { rpc } from '../../core/rpc.js';
import { errText } from '../../core/errors.js';
import { fileSvg, folderSvg, ICON, stroke } from '../../core/icons.js';
import { copyText } from '../../core/clipboard.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { makeDraggable, registerDropTarget } from '../../shell/drag.js';
import { acceptsDrop, dropAction, dropInto } from '../../shell/file-drop.js';
import { putFiles, takeFiles, clearFiles, cutPaths } from '../../shell/file-clipboard.js';
import { toast, dialog } from '../../core/ui.js';
import { writeFile } from '../../core/file-io.js';
import { emit } from '../../core/events.js';
import { tt } from '../../core/i18n.js';

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
  let selected = null; // path of the row clicked last: "new file / folder" in the header go there
  let focusNext = null; // path of the row to give the focus to at the next redraw
  const dirs = new Map(); // path -> { entries } | { error } | { loading: true }
  const title = h('span', { class: 'pc-side-title' });
  const body = h('div', { class: 'pc-tree', role: 'tree' });
  const bRefresh = h('button', { type: 'button', title: tt('重新整理'), 'aria-label': tt('重新整理'), html: ICON.refresh, onclick: () => refresh() });
  const bClose = h('button', { type: 'button', title: tt('關閉資料夾'), 'aria-label': tt('關閉資料夾'), html: CLOSE, onclick: () => actions.closeFolder() });
  const bNewFile = h('button', { type: 'button', title: tt('新增檔案'), 'aria-label': tt('新增檔案'), html: NEW_FILE, onclick: () => create(targetDir(), false) });
  const bNewDir = h('button', { type: 'button', title: tt('新增資料夾'), 'aria-label': tt('新增資料夾'), html: NEW_FOLDER, onclick: () => create(targetDir(), true) });
  const tools = h('span', { class: 'pc-side-tools' }, bNewFile, bNewDir, bRefresh, bClose);
  const label = (path) => (path === '/' ? '/' : P.base(path));
  const el = h('aside', { class: 'pc-side' }, h('div', { class: 'pc-side-head' }, title, tools), body);

  // Where the header's "new" buttons put things: the selected folder, or the
  // folder of the selected file; the opened folder when nothing is selected.
  function targetDir() {
    const row = selected && [...body.querySelectorAll('.pc-row')].find((r) => r.dataset.path === selected);
    if (!row) return root;
    return row.classList.contains('dir') ? selected : P.parent(selected);
  }
  function select(path) {
    if (selected === path) return;
    selected = path;
    for (const r of body.querySelectorAll('.pc-row')) r.classList.toggle('sel', r.dataset.path === selected);
  }

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
    if (!dir || (dir.loading && !dir.entries)) return out.push(h('div', { class: 'pc-row-note', style: pad }, tt('載入中…')));
    if (dir.error) return out.push(h('div', { class: 'pc-row-note err', style: pad, title: dir.error }, dir.error));
    if (!dir.entries.length) return out.push(h('div', { class: 'pc-row-note', style: pad }, tt('（空的）')));
    const cut = cutPaths();
    for (const entry of dir.entries) {
      const full = P.join(path, entry.name);
      const isDir = isFolder(entry);
      const open = isDir && expanded.has(full);
      const row = h('button', {
        type: 'button', role: 'treeitem', style: pad, title: full, 'data-path': full,
        class: 'pc-row' + (isDir ? ' dir' : '') + (open ? ' open' : '') + (full === current ? ' current' : '') + (cut.includes(full) ? ' cut' : '') + (full === selected ? ' sel' : ''),
        'aria-expanded': isDir ? String(open) : null,
        onclick: () => (isDir ? toggle(full) : actions.openFile(full, entry.size)),
        oncontextmenu: (ev) => {
          ev.stopPropagation();
          const into = isDir ? full : path; // where "new" puts things
          showContextMenu(ev, [
            isDir ? { label: open ? tt('收合') : tt('展開'), run: () => toggle(full) } : { label: tt('開啟'), run: () => actions.openFile(full, entry.size) },
            null,
            { label: tt('新增檔案'), run: () => create(into, false) },
            { label: tt('新增資料夾'), run: () => create(into, true) },
            null,
            { label: tt('複製'), run: () => copyOrCut('copy', full) },
            { label: tt('剪下'), run: () => copyOrCut('cut', full) },
            { label: tt('貼上'), run: () => paste(into) },
            null,
            { label: tt('重新命名（F2）'), run: () => rename(full, entry.name) },
            { label: tt('刪除'), danger: true, run: () => remove(full, entry.name, isDir) },
            null,
            { label: tt('複製路徑'), run: () => copyText(full) },
            { label: tt('重新整理'), run: () => refresh() },
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
    const answer = await dialog({
      title: isDir ? tt('新增資料夾') : tt('新增檔案'),
      message: isDir ? tt('在「{0}」裡新增資料夾，名稱：', label(dir)) : tt('在「{0}」裡新增檔案，名稱：', label(dir)),
      input: isDir ? tt('新資料夾') : tt('未命名.txt'),
      buttons: [{ label: tt('取消'), value: false, cancel: true }, { label: tt('新增'), value: true, default: true }],
    });
    if (!answer.value) return;
    const name = answer.text.trim();
    if (badName(name)) return toast(tt('名稱不能是空的，也不能包含 /'), true);
    const full = P.join(dir, name);
    try {
      const exists = await rpc('stat', { path: full }).then(() => true, (err) => {
        if (err.code === 'not-found') return false;
        throw err;
      });
      if (exists) return toast(tt('已經有「{0}」了', name), true);
      if (isDir) await rpc('mkdir', { path: full, mode: 0o755 });
      else await writeFile(full, new Uint8Array(0));
    } catch (err) {
      return toast(tt('無法建立「{0}」：{1}', name, errText(err)), true);
    }
    selected = full; // what was just made is the selected row
    await expand(dir);
    emit('fs:changed', dir);
    if (!isDir) actions.openFile(full, 0);
  }

  async function rename(full, oldName) {
    const answer = await dialog({
      title: tt('重新命名'),
      message: tt('「{0}」的新名稱：', oldName),
      input: oldName,
      buttons: [{ label: tt('取消'), value: false, cancel: true }, { label: tt('重新命名'), value: true, default: true }],
    });
    const name = answer.value ? answer.text.trim() : '';
    if (!answer.value || name === oldName) return;
    if (badName(name)) return toast(tt('名稱不能是空的，也不能包含 /'), true);
    const dir = P.parent(full);
    const to = P.join(dir, name);
    try {
      const exists = await rpc('stat', { path: to }).then(() => true, (err) => {
        if (err.code === 'not-found') return false;
        throw err;
      });
      if (exists) return toast(tt('已經有「{0}」了', name), true);
      await rpc('move', { from: full, to });
    } catch (err) {
      return toast(tt('無法重新命名「{0}」：{1}', oldName, errText(err)), true);
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
    if (selected === full) selected = to;
    emit('fs:moved', full, to); // open tabs follow the file
    emit('fs:changed', dir);
  }

  async function remove(full, name, isDir) {
    const sure = await dialog({
      title: tt('刪除「{0}」？', name),
      message: isDir ? tt('資料夾和裡面所有的東西都會從主機上刪除，無法復原。') : tt('這個檔案會從主機上刪除，無法復原。'),
      buttons: [{ label: tt('取消'), value: false, cancel: true, default: true }, { label: tt('刪除'), value: true, danger: true }],
    });
    if (!sure) return;
    try {
      await rpc('remove', { path: full });
    } catch (err) {
      return toast(tt('無法刪除「{0}」：{1}', name, errText(err)), true);
    }
    for (const p of [...expanded]) if (p === full || p.startsWith(full + '/')) expanded.delete(p);
    actions.removed(full);
    emit('fs:changed', P.parent(full));
  }

  // ---- copy / cut / paste, on the same clipboard as the file cabinet
  async function copyOrCut(mode, full) {
    await putFiles(mode, [full]);
    render(); // a cut row is dimmed
    toast(mode === 'cut' ? tt('已剪下{0}，到目的資料夾按貼上', `「${P.base(full)}」`) : tt('已複製{0}', `「${P.base(full)}」`));
  }

  async function paste(dir) {
    if (!root) return;
    const clip = await takeFiles();
    if (!clip) return toast(tt('剪貼簿裡沒有檔案'), true);
    if (clip.foreign) return toast(tt('不可跨域貼上：這些檔案是從另一台主機或另一個帳號複製的'), true);
    let taken;
    try {
      taken = new Set((await rpc('list', { path: dir })).entries.map((e) => e.name));
    } catch (err) {
      return toast(tt('無法貼上到「{0}」：{1}', label(dir), errText(err)), true);
    }
    const cutting = clip.mode === 'cut';
    let last = null;
    for (const from of clip.paths) {
      if (cutting && P.parent(from) === dir) continue; // already here
      if (dir === from || dir.startsWith(from + '/')) {
        toast(tt('不能把「{0}」貼到它自己裡面', P.base(from)), true);
        continue;
      }
      const to = P.join(dir, freeName(P.base(from), taken));
      try {
        await rpc(cutting ? 'move' : 'copy', { from, to });
      } catch (err) {
        toast(tt('無法貼上「{0}」：{1}', P.base(from), errText(err)), true);
        continue;
      }
      taken.add(P.base(to));
      last = to;
      if (cutting) {
        for (const p of [...expanded]) if (p === from || p.startsWith(from + '/')) expanded.delete(p);
        emit('fs:moved', from, to); // open tabs follow the file
        emit('fs:changed', P.parent(from));
      }
    }
    if (cutting) await clearFiles();
    if (!last) return render();
    focusNext = last;
    await expand(dir);
    emit('fs:changed', dir);
  }

  // Keyboard, on the row that has the focus (the one clicked last): F2 renames,
  // Delete deletes, the arrow keys walk up and down, Ctrl+C / X / V copy, cut
  // and paste (into the folder, or next to the file).
  body.addEventListener('keydown', (ev) => {
    const row = ev.target.closest?.('.pc-row');
    if (!row || ev.altKey) return;
    const full = row.dataset.path;
    if (ev.ctrlKey || ev.metaKey) {
      const k = ev.key.toLowerCase();
      if (k === 'c') copyOrCut('copy', full);
      else if (k === 'x') copyOrCut('cut', full);
      else if (k === 'v') paste(row.classList.contains('dir') ? full : P.parent(full));
      else return;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    if (ev.key === 'F2') rename(full, P.base(full));
    else if (ev.key === 'Delete') remove(full, P.base(full), row.classList.contains('dir'));
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const all = [...body.querySelectorAll('.pc-row')];
      all[all.indexOf(row) + (ev.key === 'ArrowDown' ? 1 : -1)]?.focus();
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  });

  // The row clicked (or reached with the keyboard) is the selected one; a click
  // on the empty part below the rows selects nothing.
  body.addEventListener('focusin', (ev) => {
    const row = ev.target.closest?.('.pc-row');
    if (row) select(row.dataset.path);
  });
  body.addEventListener('click', (ev) => {
    if (!ev.target.closest('.pc-row')) select(null);
  });

  // ---- drag rows to move them (Ctrl = copy, Alt = shortcut, like the file
  // cabinet); files dragged in from elsewhere land the same way. Dropping on a
  // folder goes into it, on a file next to it, on the empty part into the top.
  makeDraggable(body, (ev) => {
    const row = ev.target.closest('.pc-row');
    if (!row) return null;
    const path = row.dataset.path;
    const isDir = row.classList.contains('dir');
    return { type: 'file', name: P.base(path), icon: isDir ? folderSvg() : fileSvg(P.base(path)), data: { path, paths: [path], isDir, size: 0 } };
  });
  const dirAt = (target) => {
    const row = target?.closest?.('.pc-row');
    if (!row || !body.contains(row)) return root;
    return row.classList.contains('dir') ? row.dataset.path : P.parent(row.dataset.path);
  };
  const markDrop = (dir) => {
    for (const r of body.querySelectorAll('.pc-row.drop-into')) r.classList.remove('drop-into');
    if (dir && dir !== root) [...body.querySelectorAll('.pc-row')].find((r) => r.dataset.path === dir)?.classList.add('drop-into');
  };
  const offDrop = registerDropTarget(body, {
    accepts: (payload) => !!root && acceptsDrop(payload),
    action: dropAction,
    onOver: (_payload, at) => markDrop(dirAt(document.elementFromPoint(at.clientX, at.clientY))),
    onLeave: () => markDrop(null),
    async onDrop(payload, drop) {
      const dir = dirAt(drop.target);
      const paths = payload.type === 'file' ? payload.data.paths || [payload.data.path] : [];
      const inside = paths.find((from) => dir === from || dir.startsWith(from + '/'));
      if (inside) return toast(tt('不能把「{0}」放到它自己裡面', P.base(inside)), true);
      const made = await dropInto(dir, payload, drop);
      if (!made.length) return;
      if (!drop.ctrlKey && !drop.altKey) {
        // moved folders are no longer where they were open
        for (const from of paths) for (const p of [...expanded]) if (p === from || p.startsWith(from + '/')) expanded.delete(p);
      }
      focusNext = P.join(dir, made[made.length - 1]);
      await expand(dir);
    },
  });

  body.addEventListener('contextmenu', (ev) => {
    if (!root) return;
    showContextMenu(ev, [
      { label: tt('新增檔案'), run: () => create(root, false) },
      { label: tt('新增資料夾'), run: () => create(root, true) },
      null,
      { label: tt('貼上'), run: () => paste(root) },
      null,
      { label: tt('重新整理'), run: () => refresh() },
    ]);
  });

  function render() {
    el.classList.toggle('empty', !root);
    title.textContent = root ? (root === '/' ? '/' : P.base(root)) : tt('檔案');
    title.title = root || '';
    tools.style.display = root ? '' : 'none';
    if (!root) {
      body.replaceChildren(h('div', { class: 'pc-tree-empty' },
        h('p', null, tt('還沒有開啟資料夾')),
        h('button', { type: 'button', class: 'pc-tree-open', onclick: () => actions.openFolder() }, tt('開啟資料夾'))));
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
    selected = null;
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
  return { el, setRoot, setCurrent, refresh, destroy: offDrop, get root() { return root; } };
}
