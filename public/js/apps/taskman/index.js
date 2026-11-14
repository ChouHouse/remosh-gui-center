// 工作管理員: the SSH host's processes, and charts of CPU, memory, storage and
// network (read-only). Two pages: 進程 and 圖表.
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { fmtSize, fmtDuration } from '../../core/format.js';
import { gaugeSvg } from './icon.js';
import { conn, rpc } from '../../core/rpc.js';
import { store } from '../../core/store.js';
import { appStore } from '../../core/app-store.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { parseStats } from './stats.js';
import { openProcessWindow } from './process.js';
import { lineChart } from './chart.js';

useAppStyle(import.meta.url);

// Saved in ~/.remosh-gui/app/tasks/: which page was open last.
const data = appStore('tasks', {
  defaults: { tab: 'procs' },
  migrate() {
    const tab = store.get('tmTab', undefined);
    store.remove('tmTab');
    return tab === undefined ? {} : { tab };
  },
});

const HISTORY = 60; // samples kept for the charts (3 s apart: three minutes)

let taskman = null;
function openTaskManager() {
  if (taskman) return taskman.focus();
  const win = (taskman = createWindow({ title: '工作管理員', appName: '工作管理員', iconHtml: gaugeSvg(), width: 640, height: 520 }));
  const meta = h('div', { class: 'tm-meta' });
  // One card on the 圖表 page: a figure, a line under it, a bar, and a chart.
  const meter = (key, title, withChart = true) => {
    const m = { val: h('div', { class: 'val' }, '—'), sub: h('div', { class: 'sub' }), extra: h('div', { class: 'extra' }), bar: h('i'), barBox: null };
    m.barBox = h('div', { class: 'tm-bar none' }, m.bar);
    m.chart = withChart ? lineChart(HISTORY) : null;
    m.el = h('div', { class: 'tm-meter', 'data-k': key }, h('h4', null, title), m.val, m.sub, m.extra, m.barBox, m.chart?.el);
    m.set = (value, sub, ratio) => {
      m.val.textContent = value;
      m.sub.textContent = sub;
      m.barBox.className = 'tm-bar' + (ratio == null ? ' none' : ratio > 0.9 ? ' hot' : '');
      m.bar.style.width = ratio == null ? '0' : Math.max(0, Math.min(100, ratio * 100)).toFixed(1) + '%';
    };
    return m;
  };
  const mCpu = meter('cpu', 'CPU');
  const mMem = meter('mem', '記憶體');
  const mDisk = meter('disk', '儲存空間', false);
  const mNet = meter('net', '網路');
  const perf = h('div', { class: 'tm-perf', role: 'tabpanel', 'aria-label': '圖表' }, mCpu.el, mMem.el, mDisk.el, mNet.el);
  const hist = { cpu: [], mem: [], rx: [], tx: [] };
  const push = (arr, v) => {
    arr.push(v);
    if (arr.length > HISTORY) arr.shift();
  };
  const note = h('div', { class: 'tm-note' });
  const tbody = h('tbody');
  const cols = [
    { key: 'name', label: '名稱' },
    { key: 'pid', label: 'PID', num: true },
    { key: 'user', label: '使用者' },
    { key: 'cpu', label: 'CPU', num: true },
    { key: 'rss', label: '記憶體', num: true },
  ];
  const sort = { key: 'cpu', dir: -1 };
  const headRow = h('tr');
  const table = h('table', null, h('thead', null, headRow), tbody);
  const list = h('div', { class: 'tm-list', role: 'tabpanel', 'aria-label': '進程' }, table);
  const state = h('div', { class: 'state' }, '讀取中…');
  list.append(state);
  // ---- the two pages
  const tabBtns = {};
  const showTab = (key) => {
    data.set('tab', key);
    list.hidden = key !== 'procs';
    perf.hidden = key !== 'perf';
    for (const [k, b] of Object.entries(tabBtns)) {
      b.classList.toggle('current', k === key);
      b.setAttribute('aria-selected', String(k === key));
    }
  };
  const tabs = h('div', { class: 'tm-tabs', role: 'tablist' }, [['procs', '進程'], ['perf', '圖表']].map(([k, label]) =>
    (tabBtns[k] = h('button', { type: 'button', role: 'tab', 'data-tab': k, onclick: () => showTab(k) }, label))));
  win.body.append(h('div', { class: 'tm-top' }, meta, tabs, note), list, perf);
  showTab(data.get('tab') === 'perf' ? 'perf' : 'procs');

  let prev = null;
  let last = null;
  let rows = [];
  let timer = null;
  let alive = true;

  const cores = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));
  function renderHead() {
    headRow.replaceChildren(...cols.map((c) => h('th', { class: c.num ? 'num' : '' }, h('button', {
      type: 'button',
      class: sort.key === c.key ? 'sorted' : '',
      onclick: () => {
        if (sort.key === c.key) sort.dir = -sort.dir;
        else Object.assign(sort, { key: c.key, dir: c.key === 'name' || c.key === 'user' ? 1 : -1 });
        renderHead();
        renderRows();
      },
    }, c.label + (sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : '')))));
  }
  function renderRows() {
    const k = sort.key;
    const sorted = [...rows].sort((a, b) => {
      const r = typeof a[k] === 'string' ? a[k].localeCompare(b[k]) : (a[k] ?? -1) - (b[k] ?? -1);
      return (r || a.pid - b.pid) * sort.dir;
    });
    tbody.replaceChildren(...sorted.map((p) => h('tr', { 'data-pid': p.pid, 'data-name': p.name, title: '點兩下查看詳細資料' },
      h('td', { title: p.name }, p.name),
      h('td', { class: 'num' }, p.pid),
      h('td', null, p.user),
      h('td', { class: 'num' }, p.cpu == null ? '—' : p.cpu.toFixed(1) + '%'),
      h('td', { class: 'num' }, fmtSize(p.rss)))));
  }

  function render(s) {
    const dt = prev ? s.time - prev.time : 0;
    const src = s.useCgroup ? s.cg : s.sys;
    let used = null; // cores in use over the last interval
    let limit = null;
    if (s.useCgroup) {
      limit = s.cg.cpuLimit;
      if (dt > 0.2 && prev.cg?.cpuSec != null && s.cg.cpuSec != null) used = Math.max(0, (s.cg.cpuSec - prev.cg.cpuSec) / dt);
    } else if (s.sys) {
      limit = s.nproc;
      if (prev?.sys) {
        const total = s.sys.cpuTotal - prev.sys.cpuTotal;
        if (total > 0) used = Math.max(0, ((total - (s.sys.cpuIdle - prev.sys.cpuIdle)) / total) * s.nproc);
      }
    }
    if (used == null) mCpu.set('計算中…', limit ? `上限 ${cores(limit)} 核` : '', null);
    else if (limit) mCpu.set(`${((used / limit) * 100).toFixed(1)}%`, `${used.toFixed(2)} / ${cores(limit)} 核`, used / limit);
    else mCpu.set(`${used.toFixed(2)} 核`, '這個容器沒有設定 CPU 上限', null);
    mCpu.extra.textContent = s.cpuModel;
    mCpu.extra.title = s.cpuModel;
    if (used != null) push(hist.cpu, limit ? used / limit : Math.min(1, used / s.nproc));
    mCpu.chart.draw([{ values: hist.cpu }], 1);

    if (!src) mMem.set('—', '讀不到記憶體資訊', null);
    else if (src.memLimit) mMem.set(`${((src.memUsed / src.memLimit) * 100).toFixed(1)}%`, `${fmtSize(src.memUsed)} / ${fmtSize(src.memLimit)}`, src.memUsed / src.memLimit);
    else mMem.set(fmtSize(src.memUsed), '這個容器沒有設定記憶體上限', null);
    const memTop = src?.memLimit || s.sys?.memLimit;
    if (src && memTop) push(hist.mem, src.memUsed / memTop);
    mMem.extra.textContent = src && !src.memLimit && memTop ? `圖表以整台主機的 ${fmtSize(memTop)} 為上限` : '';
    mMem.chart.draw([{ values: hist.mem }], 1);

    const disk = s.disks[0];
    if (!disk) mDisk.set('—', '讀不到儲存空間資訊（找不到 df）', null);
    else mDisk.set(`${((disk.used / disk.size) * 100).toFixed(1)}%`, `${fmtSize(disk.used)} / ${fmtSize(disk.size)}，剩 ${fmtSize(disk.avail)}`, disk.used / disk.size);
    mDisk.extra.replaceChildren(...s.disks.slice(1).map((d) =>
      h('div', null, `${d.mount}：${fmtSize(d.used)} / ${fmtSize(d.size)}，剩 ${fmtSize(d.avail)}`)));

    if (!s.net) mNet.set('—', '讀不到網路資訊', null);
    else if (dt > 0.2 && prev?.net) {
      const rx = Math.max(0, (s.net.rx - prev.net.rx) / dt);
      const tx = Math.max(0, (s.net.tx - prev.net.tx) / dt);
      push(hist.rx, rx);
      push(hist.tx, tx);
      mNet.set(`↓ ${fmtSize(Math.round(rx))}/s`, `↑ ${fmtSize(Math.round(tx))}/s`, null);
    } else mNet.set('計算中…', '', null);
    if (s.net) {
      const top = Math.max(1024, ...hist.rx, ...hist.tx) * 1.15;
      mNet.extra.textContent = `接收（藍）與傳送（橘），圖表上限 ${fmtSize(top)}/s`;
      mNet.chart.draw([{ values: hist.rx, cls: 'rx' }, { values: hist.tx, cls: 'tx' }], top);
    }

    const before = new Map((prev?.procs || []).map((p) => [p.pid, p.ticks]));
    rows = s.procs.map((p) => {
      const was = before.get(p.pid);
      const cpu = dt > 0.2 && was != null && p.ticks != null ? Math.max(0, ((p.ticks - was) / s.clk / dt) * 100) : null;
      return { ...p, cpu };
    });
    const count = s.useCgroup && s.cg.pids != null ? s.cg.pids : s.procs.length;
    const age = s.useCgroup ? s.pid1Age : s.uptime;
    meta.replaceChildren(
      h('span', null, '範圍 ', h('b', { id: 'tm-scope' }, s.useCgroup ? '容器' : '整台主機')),
      h('span', null, '主機名稱 ', h('b', null, s.host || '—')),
      h('span', null, s.useCgroup ? '工作數 ' : '行程數 ', h('b', null, count)),
      age != null && h('span', null, '已運作 ', h('b', null, fmtDuration(age))));
    note.hidden = true;
    state.hidden = rows.length > 0;
    state.className = 'state';
    state.textContent = rows.length ? '' : '這台主機沒有提供行程清單（找不到 ps）';
    renderRows();
  }

  async function tick() {
    if (!alive) return;
    let delay = 3000;
    if (!win.minimized && conn.ws) {
      try {
        const res = await rpc('stats');
        if (!alive) return;
        const s = parseStats(res.out);
        if (last) prev = last;
        last = s;
        render(s);
        if (!prev) delay = 1000; // second sample quickly so CPU figures appear
      } catch (err) {
        if (!alive) return;
        if (!last) {
          state.hidden = false;
          state.className = 'state err';
          state.textContent = `無法讀取資源資訊：${errText(err)}`;
        }
        if (err.code === 'exec-failed') return; // will not start working by retrying
      }
    }
    timer = setTimeout(tick, delay);
  }
  win.destroy = () => {
    alive = false;
    clearTimeout(timer);
    if (taskman === win) taskman = null;
  };
  tbody.addEventListener('dblclick', (ev) => {
    const tr = ev.target.closest('tr[data-pid]');
    if (tr) openProcessWindow(Number(tr.dataset.pid), tr.dataset.name);
  });
  renderHead();
  tick();
  return win;
}

registerApp({ id: 'tasks', name: '工作管理員', icon: gaugeSvg, startMenu: true, launch: openTaskManager });
