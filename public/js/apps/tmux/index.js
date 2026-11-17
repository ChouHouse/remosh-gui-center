// tmux 終端管理器: the tmux sessions on the host, with their windows, in a
// list on the left; the one chosen is attached on the right, in a terminal.
// tmux keeps the sessions running on the host: closing this window (or
// logging out) only detaches, and they are there again next time.
// Needs tmux on the host (requires). Server side: src/ops/tmux.js.
import './i18n.js'; // this app's texts in the other languages
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { conn, rpc } from '../../core/rpc.js';
import { stroke, ICON } from '../../core/icons.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { createTerminalView, shellQuote } from '../../shell/terminal-view.js';
import { tt, tm } from '../../core/i18n.js';
import { tmuxSvg } from './icon.js';

useAppStyle(import.meta.url);

const APP_NAME = tm('tmux 終端管理器');
const POLL_MS = 3000;
const PLUS = stroke('<path d="M8 3.5v9M3.5 8h9"/>');
const SES_ICON = stroke('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M8 3v10M8 8h6"/>');
const badName = (n) => !n || /[.:]/.test(n) || n.length > 64;

let instance = null; // one manager window

function openManager() {
  if (instance) return instance.win.focus();
  const win = createWindow({ title: tt(APP_NAME), appName: APP_NAME, iconHtml: tmuxSvg(), width: 920, height: 560 });
  const list = h('div', { class: 'tx-list' });
  const term = h('div', { class: 'tx-term' });
  const blank = h('div', { class: 'tx-blank' });
  const main = h('div', { class: 'tx-main' }, term, blank);
  win.body.classList.add('tx-body');
  win.body.append(
    h('aside', { class: 'tx-side' },
      h('div', { class: 'tx-head' }, h('span', { class: 'grow' }, tt('工作階段')),
        h('button', { type: 'button', class: 'tx-new', title: tt('新增工作階段'), 'aria-label': tt('新增工作階段'), html: PLUS, onclick: () => newSession() }),
        h('button', { type: 'button', class: 'tx-refresh', title: tt('重新整理'), 'aria-label': tt('重新整理'), html: ICON.refresh, onclick: () => load() })),
      list),
    main);

  let sessions = [];
  let attached = null; // { name, view }
  let alive = true;
  let timer = 0;

  // ---- the list
  async function load() {
    try {
      ({ sessions } = await rpc('tmuxList'));
    } catch (err) {
      sessions = [];
      list.replaceChildren(h('div', { class: 'tx-empty' }, tt('無法讀取 tmux 工作階段：{0}', errText(err))));
      return;
    }
    if (!alive) return;
    paint();
  }

  function paint() {
    if (!sessions.length) {
      list.replaceChildren(h('div', { class: 'tx-empty' },
        h('div', null, tt('還沒有 tmux 工作階段。')),
        h('div', null, tt('工作階段會一直在主機上執行：關掉這個視窗或登出，裡面的程式也不會停。')),
        h('button', { type: 'button', onclick: () => newSession() }, tt('新增工作階段'))));
    } else {
      list.replaceChildren(...sessions.map((s) => {
        const mine = attached?.name === s.name && attached.view?.running;
        const others = s.attached - (mine ? 1 : 0); // clients other than this window
        const row = h('div', { class: 'tx-row tx-ses-row' + (attached?.name === s.name ? ' on' : ''), 'data-session': s.name, title: s.name },
          h('span', { class: 'ico', html: SES_ICON }), h('span', { class: 'nm' }, s.name),
          others > 0 ? h('span', { class: 'badge', title: tt('還有其他地方連著這個工作階段') }, tt('使用中')) : null,
          h('small', null, tt('{0} 個視窗', s.windows.length)));
        row.addEventListener('click', () => attach(s.name));
        row.addEventListener('contextmenu', (ev) => showContextMenu(ev, [
          { label: tt('連上'), run: () => attach(s.name) },
          { label: tt('新增視窗'), run: () => act({ action: 'newWindow', name: s.name, cwd: conn.info.home }) },
          null,
          { label: tt('重新命名…'), run: () => renameSession(s.name) },
          { label: tt('結束工作階段…'), danger: true, run: () => killSession(s.name) },
        ]));
        const wins = s.windows.map((w) => {
          const r = h('div', { class: 'tx-row tx-win-row' + (w.active ? ' active-win' : ''), 'data-window': `${s.name}:${w.index}`, title: w.path },
            h('span', { class: 'idx' }, String(w.index)), h('span', { class: 'nm' }, w.name), w.active ? h('small', null, '●') : null);
          r.addEventListener('click', () => attach(s.name, w.index));
          r.addEventListener('contextmenu', (ev) => showContextMenu(ev, [
            { label: tt('切換到這個視窗'), run: () => attach(s.name, w.index) },
            { label: tt('重新命名…'), run: () => renameWindow(s.name, w) },
            null,
            { label: tt('關閉視窗'), danger: true, run: () => act({ action: 'killWindow', name: s.name, index: w.index }) },
          ]));
          return r;
        });
        return h('div', { class: 'tx-session' }, row, wins);
      }));
    }
    paintMain();
  }

  function paintMain() {
    const showing = attached?.view?.running;
    term.hidden = !attached;
    blank.hidden = !!showing;
    if (showing) return;
    if (attached) {
      blank.replaceChildren(h('div', null,
        h('div', null, tt('已離開「{0}」。', attached.name)),
        h('div', null, sessions.some((s) => s.name === attached.name) ? tt('工作階段仍在主機上執行。') : tt('這個工作階段已經結束。')),
        sessions.some((s) => s.name === attached.name) ? h('button', { type: 'button', onclick: () => attach(attached.name) }, tt('重新連上')) : null));
    } else {
      blank.replaceChildren(h('div', null, sessions.length ? tt('從左邊選一個工作階段連上去。') : tt('新增一個工作階段開始使用。')));
    }
  }

  // ---- attaching: a terminal that runs `tmux attach`
  async function attach(name, index) {
    if (attached?.name === name && attached.view?.running) {
      if (index != null) await act({ action: 'selectWindow', name, index });
      attached.view.focus();
      return;
    }
    attached?.view?.dispose();
    term.replaceChildren();
    const me = { name, view: null };
    attached = me;
    paint();
    try {
      if (index != null) await rpc('tmuxDo', { action: 'selectWindow', name, index }).catch(() => {});
      // exec: when tmux detaches (or the session ends) the terminal ends too
      me.view = await createTerminalView(term, {
        run: `exec tmux -u attach-session -t ${shellQuote('=' + name)}\n`,
        onExit: () => {
          if (attached === me) load();
        },
      });
      if (attached !== me || !alive) return me.view?.dispose();
      paint();
      me.view.focus();
    } catch (err) {
      toast(tt('無法連上「{0}」：{1}', name, errText(err)), true);
      if (attached === me) attached = null;
      paint();
    }
  }

  // ---- actions
  async function act(params) {
    try {
      await rpc('tmuxDo', params);
    } catch (err) {
      toast(tt('tmux：{0}', errText(err)), true);
    }
    await load();
  }

  async function askName(title, message, value) {
    const answer = await dialog({
      title,
      message,
      input: value,
      buttons: [{ label: tt('取消'), value: false, cancel: true }, { label: tt('確定'), value: true, default: true }],
    });
    if (!answer.value) return null;
    const name = answer.text.trim();
    if (badName(name)) {
      toast(tt('名稱不能是空的，也不能包含 . 或 :'), true);
      return null;
    }
    return name;
  }

  async function newSession() {
    let n = 1;
    while (sessions.some((s) => s.name === 'remogui-' + n)) n++;
    const name = await askName(tt('新增工作階段'), tt('工作階段的名稱：'), 'remogui-' + n);
    if (!name) return;
    if (sessions.some((s) => s.name === name)) return toast(tt('已經有「{0}」了', name), true);
    await act({ action: 'new', name, cwd: conn.info.home });
    attach(name);
  }

  async function renameSession(name) {
    const to = await askName(tt('重新命名'), tt('「{0}」的新名稱：', name), name);
    if (!to || to === name) return;
    if (attached?.name === name) attached.name = to;
    await act({ action: 'rename', name, to });
  }

  async function renameWindow(name, w) {
    const to = await askName(tt('重新命名'), tt('「{0}」的新名稱：', w.name), w.name);
    if (to && to !== w.name) await act({ action: 'renameWindow', name, index: w.index, to });
  }

  async function killSession(name) {
    const sure = await dialog({
      title: tt('結束「{0}」？', name),
      message: tt('這個工作階段裡所有視窗和正在執行的程式都會被關閉。'),
      buttons: [{ label: tt('取消'), value: false, cancel: true, default: true }, { label: tt('結束'), value: true, danger: true }],
    });
    if (sure) await act({ action: 'kill', name });
  }

  // ---- the window
  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!alive) return;
      if (!win.minimized) await load();
      poll();
    }, POLL_MS);
  };
  win.onFocus = () => attached?.view?.running && attached.view.focus();
  win.destroy = () => {
    alive = false;
    clearTimeout(timer);
    attached?.view?.dispose(); // detaches: the session keeps running on the host
    instance = null;
  };
  instance = { win };
  paint();
  load();
  poll();
}

registerApp({
  id: 'tmux',
  order: 61,
  name: APP_NAME,
  icon: tmuxSvg,
  startMenu: true,
  requires: [{ command: 'tmux', install: 'sudo apt install tmux' }],
  launch: openManager,
});
