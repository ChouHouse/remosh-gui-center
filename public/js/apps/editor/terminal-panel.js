// Procoder's terminal panel: under the editor, shown and hidden with Ctrl+`
// (also from 介面 and the title bar). It holds several terminals; the list on
// its left switches between them. Each Procoder window has its own.
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { toast } from '../../core/ui.js';
import { P } from '../../core/path.js';
import { stroke } from '../../core/icons.js';
import { createTerminalView } from '../../shell/terminal-view.js';
import { data } from './prefs.js';
import { tt } from '../../core/i18n.js';

export const PANEL_DEFAULT = 220;
const PANEL_MIN = 90;
const TERM_ICON = stroke('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3"/>');

// Ctrl+` (the key left of 1), on every system
export const isPanelKey = (ev) => ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey && ev.code === 'Backquote';

// options: { startDir() -> folder for a new terminal, changed() -> shown/hidden or the list changed, focusBack() }
export function createTerminalPanel({ startDir, changed, focusBack }) {
  const terms = []; // { item, host, view, n }
  let current = null;
  let shown = false;
  let seq = 0;
  const list = h('div', { class: 'pc-term-list', role: 'tablist', 'aria-label': tt('終端機') });
  const addBtn = h('button', { type: 'button', class: 'pc-term-add', title: tt('新增終端機'), 'aria-label': tt('新增終端機'), onclick: () => add() }, '+');
  const stack = h('div', { class: 'pc-term-stack' });
  const grip = h('div', { class: 'pc-panel-grip', title: tt('拖曳調整高度，點兩下還原') });
  const el = h('div', { class: 'pc-panel', hidden: true }, grip,
    h('div', { class: 'pc-panel-body' }, h('div', { class: 'pc-term-side' }, h('div', { class: 'pc-term-head' }, h('span', null, tt('終端機')), addBtn), list), stack));
  const height = () => Math.max(PANEL_MIN, Math.round(Number(data.get('panelHeight')) || PANEL_DEFAULT));
  const applyHeight = () => {
    el.style.height = height() + 'px';
  };
  applyHeight();

  // ---- drag the top edge to change the height
  grip.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const start = el.offsetHeight;
    const room = el.parentElement.offsetHeight - 80; // leave the editor some room
    let hgt = start;
    document.body.classList.add('dragging', 'row-resizing');
    const move = (ev) => {
      hgt = Math.max(PANEL_MIN, Math.min(room, start - (ev.clientY - down.clientY)));
      el.style.height = hgt + 'px';
    };
    const up = () => {
      document.body.classList.remove('dragging', 'row-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (hgt !== start) data.set('panelHeight', hgt);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  grip.addEventListener('dblclick', () => data.set('panelHeight', PANEL_DEFAULT));

  function select(t) {
    current = t;
    for (const x of terms) {
      x.host.hidden = x !== t;
      x.item.classList.toggle('on', x === t);
      x.item.setAttribute('aria-selected', String(x === t));
    }
    t?.view?.focus();
  }

  async function add() {
    const cwd = startDir();
    const n = ++seq;
    const host = h('div', { class: 'pc-term-host' });
    const name = h('span', { class: 'pc-term-name' }, tt('終端機 {0}', n));
    const t = { host, view: null, n };
    t.item = h('div', { class: 'pc-term-item', role: 'tab', title: cwd, 'data-n': String(n), onclick: (ev) => !ev.target.closest('.pc-term-close') && select(t) },
      h('span', { class: 'pc-term-ico', html: TERM_ICON }), name,
      h('button', { type: 'button', class: 'pc-term-close', title: tt('關閉終端機'), 'aria-label': tt('關閉終端機'), onclick: () => close(t) }, '×'));
    terms.push(t);
    list.append(t.item);
    stack.append(host);
    select(t);
    changed();
    try {
      t.view = await createTerminalView(host, {
        cwd,
        keys: (ev) => {
          if (!isPanelKey(ev)) return false;
          toggle(false);
          return true;
        },
        onExit: () => t.item.classList.add('ended'),
      });
      if (!terms.includes(t)) return t.view?.dispose();
      if (current === t && shown) t.view.focus();
    } catch (err) {
      toast(tt('無法開啟終端機：{0}', errText(err)), true);
      close(t);
    }
    return t;
  }

  function close(t) {
    const at = terms.indexOf(t);
    if (at < 0) return;
    terms.splice(at, 1);
    t.view?.dispose();
    t.item.remove();
    t.host.remove();
    if (current === t) select(terms[at] || terms[at - 1] || null);
    if (!terms.length) toggle(false);
    changed();
  }

  // Show or hide; the first time it is shown a terminal starts in the project folder.
  function toggle(show = !shown) {
    if (show === shown) {
      if (show) current?.view?.focus();
      return;
    }
    shown = show;
    el.hidden = !show;
    if (show) {
      applyHeight();
      if (!terms.length) add();
      else current?.view?.focus();
    } else focusBack();
    changed();
  }

  return {
    el,
    toggle,
    add,
    applyHeight,
    get shown() {
      return shown;
    },
    get count() {
      return terms.length;
    },
    dispose() {
      for (const t of [...terms]) t.view?.dispose();
      terms.length = 0;
    },
  };
}

export const panelStartDir = (root, activePath, home) => root || (activePath ? P.parent(activePath) : home);
