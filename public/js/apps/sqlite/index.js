// SQLite 檢視器: opens a SQLite database on the host and shows its tables and
// views, their rows (paged, sortable) and structure, and runs read-only
// queries. Nothing needs to be installed on the host: the server copies the
// file over SFTP and reads the copy, so what is shown is the file as it was
// when opened (重新讀取 takes a fresh copy) and nothing is ever written back.
// Server side: src/ops/sqlite.js.
import './i18n.js'; // this app's texts in the other languages
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { fmtSize } from '../../core/format.js';
import { P } from '../../core/path.js';
import { ICON, stroke } from '../../core/icons.js';
import { toast } from '../../core/ui.js';
import { rpc } from '../../core/rpc.js';
import { on } from '../../core/events.js';
import { copyText } from '../../core/clipboard.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { pickPath } from '../../shell/picker.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { tt, tm } from '../../core/i18n.js';
import { sqliteSvg } from './icon.js';

useAppStyle(import.meta.url);

const APP_NAME = tm('SQLite 檢視器');
export const SQLITE_EXTS = ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'];
const PAGE = 200;
const ERRORS = {
  'not-sqlite': tm('這不是 SQLite 資料庫'),
  'no-sqlite': tm('這台伺服器無法讀取 SQLite 檔案'),
  'sqlite-closed': tm('資料庫已經關閉，請重新讀取'),
  'sqlite-one': tm('一次只能執行一個查詢'),
  'sqlite-readonly': tm('這裡只能查詢資料（SELECT），不能修改'),
  'too-large': tm('檔案太大（上限 512 MB）'),
};
const err = (e) => (ERRORS[e?.code] ? tt(ERRORS[e.code]) : e?.code === 'sqlite-error' ? e.message : errText(e));
const I = {
  table: stroke('<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M6.5 6.5V13"/>'),
  view: stroke('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  open: ICON.folder,
};

// One cell's text: what the server sent (see cell() in src/ops/sqlite.js).
function cellText(v) {
  if (v === null) return null;
  if (typeof v !== 'object') return String(v);
  if ('int' in v) return v.int;
  if ('real' in v) return v.real;
  if ('text' in v) return v.text;
  if ('blob' in v) return null;
  return String(v);
}
function cellEl(v) {
  if (v === null) return h('td', { class: 'null' }, 'NULL');
  if (typeof v === 'object' && 'blob' in v) return h('td', { class: 'blob', title: v.hex }, tt('BLOB（{0}）', fmtSize(v.blob)));
  const text = cellText(v);
  const cut = typeof v === 'object' && 'len' in v;
  const td = h('td', { class: typeof v === 'number' || (typeof v === 'object' && ('int' in v || 'real' in v)) ? 'num' : null }, text.length > 300 ? text.slice(0, 300) + '…' : text);
  td.title = cut ? tt('{0}…（共 {1} 字）', text.slice(0, 600), v.len) : text.slice(0, 600);
  return td;
}
const copyValue = (v) => {
  const t = v !== null && typeof v === 'object' && 'blob' in v ? v.hex : cellText(v);
  copyText(t ?? 'NULL').then(() => toast(tt('已複製')));
};

// A results table; a click on a header asks for sorting (when sortable).
function grid(columns, rows, { order, desc, sort } = {}) {
  const head = h('tr', null, columns.map((c) => {
    const th = h('th', { title: c }, h('span', null, c), order === c ? h('i', null, desc ? '▼' : '▲') : null);
    if (sort) {
      th.classList.add('sortable');
      th.addEventListener('click', () => sort(c));
    }
    return th;
  }));
  const body = rows.map((r) => {
    const tr = h('tr', null, r.map((v) => cellEl(v)));
    tr.addEventListener('contextmenu', (ev) => {
      const i = [...tr.children].indexOf(ev.target.closest('td'));
      if (i < 0) return;
      showContextMenu(ev, [
        { label: tt('複製值'), run: () => copyValue(r[i]) },
        { label: tt('複製整列'), run: () => copyText(r.map((v) => cellText(v) ?? '').join('\t')).then(() => toast(tt('已複製'))) },
      ]);
    });
    return tr;
  });
  return h('table', { class: 'sq-grid' }, h('thead', null, head), h('tbody', null, body));
}

const viewers = new Set();

function openViewer({ path = null } = {}) {
  if (path) {
    const open = [...viewers].find((v) => v.path === path);
    if (open) return open.win.focus();
  }
  const win = createWindow({ title: path ? P.base(path) : tt(APP_NAME), appName: APP_NAME, iconHtml: sqliteSvg(), width: 960, height: 580 });
  const v = { win, path: null, db: null, tables: [], current: null, tab: 'data', token: 0 };
  viewers.add(v);

  const list = h('div', { class: 'sq-list' });
  const side = h('aside', { class: 'sq-side' }, list);
  const tabs = h('div', { class: 'sq-tabs', role: 'tablist' });
  const pane = h('div', { class: 'sq-pane' });
  const foot = h('div', { class: 'sq-foot' });
  const main = h('div', { class: 'sq-main' }, tabs, pane, foot);
  const blank = h('div', { class: 'sq-blank' });
  win.body.classList.add('sq-body');
  win.body.append(side, main, blank);
  const bOpen = h('button', { type: 'button', class: 'sq-tool-open', title: tt('開啟資料庫…'), 'aria-label': tt('開啟資料庫…'), html: I.open, onclick: () => choose() });
  const bReload = h('button', { type: 'button', class: 'sq-tool-reload', title: tt('重新讀取（顯示的是開啟當下的內容）'), 'aria-label': tt('重新讀取'), html: ICON.refresh, onclick: () => v.path && load(v.path) });
  win.setTools(bOpen, bReload);

  // the data tab's paging and sorting, per table
  let page = { offset: 0, order: null, desc: false };
  let sql = '';

  function showBlank(...content) {
    side.hidden = main.hidden = true;
    blank.hidden = false;
    blank.replaceChildren(h('div', null, ...content));
  }

  function empty() {
    bReload.disabled = true;
    showBlank(h('div', null, tt('開啟主機上的 SQLite 資料庫來查看裡面的資料。')),
      h('button', { type: 'button', class: 'sq-pick', onclick: () => choose() }, tt('開啟資料庫…')));
  }

  async function choose() {
    const p = await pickPath({ mode: 'file', title: tt('開啟 SQLite 資料庫'), start: v.path ? P.parent(v.path) : undefined });
    if (!p) return;
    const other = [...viewers].find((o) => o !== v && o.path === p);
    if (other) return other.win.focus();
    load(p);
  }

  function release() {
    if (v.db) rpc('sqliteClose', { db: v.db }).catch(() => {});
    v.db = null;
  }

  async function load(p) {
    const token = ++v.token;
    const again = v.path === p;
    release();
    v.path = p;
    win.setTitle(P.base(p));
    bReload.disabled = true;
    showBlank(h('div', { class: 'sq-loading' }, tt('正在讀取「{0}」…', P.base(p))));
    let res;
    try {
      res = await rpc('sqliteOpen', { path: p });
    } catch (e) {
      if (token !== v.token) return;
      bReload.disabled = false;
      return showBlank(h('div', null, tt('無法開啟「{0}」：', P.base(p))), h('div', { class: 'sq-err' }, err(e)),
        h('button', { type: 'button', class: 'sq-pick', onclick: () => choose() }, tt('開啟其他檔案…')));
    }
    if (token !== v.token || !viewers.has(v)) return rpc('sqliteClose', { db: res.db }).catch(() => {});
    v.db = res.db;
    v.size = res.size;
    v.tables = res.tables;
    bReload.disabled = false;
    side.hidden = main.hidden = false;
    blank.hidden = true;
    const keep = again && v.current && v.tables.find((t) => t.name === v.current.name);
    if (!keep) page = { offset: 0, order: null, desc: false };
    paintList();
    if (keep) select(keep.name, { keepPage: true });
    else if (v.tables.length) select((v.tables.find((t) => t.type === 'table') || v.tables[0]).name);
    else {
      v.current = null;
      paintTabs();
      if (v.tab !== 'sql') pane.replaceChildren(h('div', { class: 'sq-note' }, tt('這個資料庫裡沒有資料表。')));
      else showSql();
      paintFoot();
    }
  }

  function paintList() {
    const group = (type, title) => {
      const items = v.tables.filter((t) => t.type === type);
      if (!items.length) return null;
      return [h('div', { class: 'sq-group' }, title), items.map((t) => {
        const row = h('div', { class: 'sq-item' + (v.current?.name === t.name ? ' on' : ''), 'data-name': t.name, title: t.name },
          h('span', { class: 'ico', html: type === 'view' ? I.view : I.table }), h('span', { class: 'nm' }, t.name),
          t.rows != null ? h('small', null, t.rows.toLocaleString()) : null);
        row.addEventListener('click', () => select(t.name));
        row.addEventListener('contextmenu', (ev) => showContextMenu(ev, [
          { label: tt('查看資料'), run: () => select(t.name, { tab: 'data' }) },
          { label: tt('查看結構'), run: () => select(t.name, { tab: 'schema' }) },
          { label: tt('用 SQL 查詢'), run: () => { sql = `SELECT * FROM "${t.name.replace(/"/g, '""')}" LIMIT 100;`; select(t.name, { tab: 'sql' }); } },
          null,
          { label: tt('複製名稱'), run: () => copyText(t.name).then(() => toast(tt('已複製'))) },
        ]));
        return row;
      })];
    };
    list.replaceChildren(...[h('div', { class: 'sq-file', title: v.path }, P.base(v.path), h('small', null, fmtSize(v.size))),
      group('table', tt('資料表')), group('view', tt('檢視'))].flat(Infinity).filter(Boolean));
  }

  function paintTabs() {
    const tab = (id, label) => h('button', { type: 'button', role: 'tab', class: 'sq-tab' + (v.tab === id ? ' on' : ''), 'data-tab': id, 'aria-selected': String(v.tab === id),
      disabled: id !== 'sql' && !v.current ? '' : null, onclick: () => { v.tab = id; show(); } }, label);
    tabs.replaceChildren(tab('data', tt('資料')), tab('schema', tt('結構')), tab('sql', tt('SQL 查詢')));
  }

  function select(name, { tab, keepPage = false } = {}) {
    const t = v.tables.find((x) => x.name === name);
    if (!t) return;
    if (v.current?.name !== name && !keepPage) page = { offset: 0, order: null, desc: false };
    v.current = t;
    if (tab) v.tab = tab;
    else if (v.tab === 'sql' && !keepPage) v.tab = 'data';
    for (const el of list.querySelectorAll('.sq-item')) el.classList.toggle('on', el.dataset.name === name);
    show();
  }

  function show() {
    paintTabs();
    if (v.tab === 'sql') showSql();
    else if (!v.current) pane.replaceChildren();
    else if (v.tab === 'schema') showSchema();
    else showData();
    paintFoot();
  }

  // ---- 資料
  async function showData() {
    const t = v.current;
    const token = v.token;
    const at = { ...page };
    pane.classList.add('busy');
    let res;
    try {
      res = await rpc('sqliteRows', { db: v.db, table: t.name, offset: at.offset, limit: PAGE, order: at.order, desc: at.desc });
    } catch (e) {
      if (token === v.token && v.current === t) pane.replaceChildren(h('div', { class: 'sq-note sq-err' }, err(e)));
      return;
    } finally {
      pane.classList.remove('busy');
    }
    if (token !== v.token || v.current !== t || v.tab !== 'data') return;
    v.shown = res.rows.length;
    pane.replaceChildren(h('div', { class: 'sq-scroll' },
      res.columns.length ? grid(res.columns, res.rows, { order: at.order, desc: at.desc, sort }) : null,
      res.rows.length ? null : h('div', { class: 'sq-note' }, tt('沒有資料'))));
    paintFoot();
  }

  function sort(col) {
    // ▲ → ▼ → not sorted
    if (page.order !== col) page = { offset: 0, order: col, desc: false };
    else if (!page.desc) page = { offset: 0, order: col, desc: true };
    else page = { offset: 0, order: null, desc: false };
    showData();
  }

  function go(offset) {
    page.offset = Math.max(0, offset);
    showData();
  }

  function paintFoot() {
    const t = v.current;
    if (v.tab !== 'data' || !t) return foot.replaceChildren(h('span', { class: 'sq-ro' }, tt('唯讀：不會修改主機上的檔案')));
    const total = t.rows;
    const from = page.offset + 1;
    const to = page.offset + (v.shown ?? 0);
    const last = total != null ? Math.max(0, Math.floor((total - 1) / PAGE) * PAGE) : null;
    const btn = (label, title, offset, off) => h('button', { type: 'button', class: 'sq-page', title, 'aria-label': title, disabled: off ? '' : null, onclick: () => go(offset) }, label);
    foot.replaceChildren(
      h('span', { class: 'sq-range' }, total == null ? tt('第 {0}–{1} 列', from, to) : total === 0 ? tt('共 0 列') : tt('第 {0}–{1} 列，共 {2} 列', from.toLocaleString(), to.toLocaleString(), total.toLocaleString())),
      btn('«', tt('第一頁'), 0, page.offset === 0),
      btn('‹', tt('前一頁'), page.offset - PAGE, page.offset === 0),
      btn('›', tt('後一頁'), page.offset + PAGE, total != null ? to >= total : (v.shown ?? 0) < PAGE),
      btn('»', tt('最後一頁'), last ?? 0, last == null || page.offset >= last),
      h('span', { class: 'grow' }),
      h('span', { class: 'sq-ro' }, tt('唯讀')));
  }

  // ---- 結構
  function showSchema() {
    const t = v.current;
    const yes = '✓';
    pane.replaceChildren(h('div', { class: 'sq-scroll sq-schema' },
      h('table', { class: 'sq-grid sq-cols' },
        h('thead', null, h('tr', null, h('th', null, tt('欄位')), h('th', null, tt('類型')), h('th', null, tt('主鍵')), h('th', null, tt('不可為空')), h('th', null, tt('預設值')))),
        h('tbody', null, t.columns.map((c) => h('tr', null,
          h('td', { class: 'nm' }, c.name), h('td', null, c.type || ''), h('td', null, c.pk ? (t.columns.filter((x) => x.pk).length > 1 ? `${yes} ${c.pk}` : yes) : ''),
          h('td', null, c.notnull ? yes : ''), c.dflt == null ? h('td', { class: 'null' }, '') : h('td', null, String(c.dflt)))))),
      t.sql ? [h('div', { class: 'sq-h' }, t.type === 'view' ? tt('建立這個檢視的 SQL') : tt('建立這個資料表的 SQL')), h('pre', { class: 'sq-sql' }, t.sql)] : null,
      t.indexes.length ? [h('div', { class: 'sq-h' }, tt('索引')), t.indexes.map((i) => h('pre', { class: 'sq-sql' }, i.sql))] : null));
  }

  // ---- SQL 查詢
  let sqlBox = null;
  let sqlOut = null;
  function showSql() {
    if (!sqlBox) {
      sqlBox = h('textarea', { class: 'sq-input', spellcheck: 'false', autocapitalize: 'off', 'aria-label': tt('SQL 查詢'), placeholder: 'SELECT * FROM …' });
      sqlBox.addEventListener('input', () => { sql = sqlBox.value; });
      sqlBox.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          run();
        }
      });
      sqlOut = h('div', { class: 'sq-out' });
    }
    if (!sql && v.current) sql = `SELECT * FROM "${v.current.name.replace(/"/g, '""')}" LIMIT 100;`;
    sqlBox.value = sql;
    pane.replaceChildren(h('div', { class: 'sq-query' },
      sqlBox,
      h('div', { class: 'sq-run-bar' },
        h('button', { type: 'button', class: 'sq-run', onclick: () => run() }, tt('執行')),
        h('span', { class: 'sq-hint' }, tt('Ctrl+Enter 執行。只能查詢，不會修改主機上的檔案。'))),
      sqlOut));
    sqlBox.focus();
  }

  async function run() {
    const text = sqlBox.value.trim();
    if (!text || !v.db) return;
    const token = v.token;
    sqlOut.replaceChildren(h('div', { class: 'sq-note' }, tt('執行中…')));
    let res;
    try {
      res = await rpc('sqliteQuery', { db: v.db, sql: text });
    } catch (e) {
      if (token === v.token) sqlOut.replaceChildren(h('div', { class: 'sq-note sq-err' }, err(e)));
      return;
    }
    if (token !== v.token) return;
    const note = res.more ? tt('只顯示前 {0} 列', res.rows.length.toLocaleString()) : tt('{0} 列', res.rows.length.toLocaleString());
    sqlOut.replaceChildren(
      h('div', { class: 'sq-note sq-stat' }, `${note} · ${res.ms} ms`),
      res.columns.length ? h('div', { class: 'sq-scroll' }, grid(res.columns, res.rows)) : null);
  }

  // ---- the window
  win.destroy = () => {
    v.token++;
    release();
    viewers.delete(v);
  };
  v.relocate = (to) => {
    v.path = to;
    win.setTitle(P.base(to));
    if (v.db) paintList();
  };
  if (path) load(path);
  else empty();
}

// A renamed or moved database (or a folder above it) takes its window along.
on('fs:moved', (from, to) => {
  for (const v of viewers) {
    const next = v.path === from ? to : v.path?.startsWith(from + '/') ? to + v.path.slice(from.length) : null;
    if (next) v.relocate(next);
  }
});

registerApp({
  id: 'sqlite',
  order: 47,
  name: APP_NAME,
  icon: sqliteSvg,
  startMenu: true,
  extensions: SQLITE_EXTS,
  launch: openViewer,
});
