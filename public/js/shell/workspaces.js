// Workspaces: up to five desktops, each with its own windows. The button left
// of the clock (or Tab pressed twice) shows them side by side with a preview;
// right-click the button to jump straight to one.
import { $, h } from '../core/dom.js';
import { on } from '../core/events.js';
import { errText } from '../core/errors.js';
import { toast } from '../core/ui.js';
import { wm, winLayer, onWindowsChange, switchWorkspace, addWorkspace, removeWorkspace, resetWorkspaces, MAX_WORKSPACES } from './wm.js';
import { cloneWindow, copyScroll, windowRect } from './preview.js';
import { showContextMenu } from './context-menu.js';
import { setTaskbar } from './taskbar.js';

const btn = $('#ws-btn');
const num = btn.querySelector('.ws-num');
const CARD_W = 200;
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor, .xterm';

export const workspaceName = (id) => `工作區 ${wm.workspaces.indexOf(id) + 1}`;

// The number of the current workspace sits inside the screen icon once there are several.
function renderButton() {
  const many = wm.workspaces.length > 1;
  num.hidden = !many;
  num.textContent = many ? wm.workspaces.indexOf(wm.ws) + 1 : '';
  btn.title = many ? `${workspaceName(wm.ws)}（連按兩下 Tab 切換）` : '工作區（連按兩下 Tab）';
}
onWindowsChange(renderButton);
renderButton();

// ---- the panel
let panel = null;
let cards = [];
let sel = 0;
let opener = null; // the key press that opened the panel must not also move the selection

// The desktop of one workspace in miniature: wallpaper and its windows.
function stage(id) {
  const area = winLayer.getBoundingClientRect();
  const scale = CARD_W / area.width;
  const box = h('div', { class: 'ws-stage' });
  const desk = getComputedStyle($('#desktop'));
  Object.assign(box.style, { width: CARD_W + 'px', height: Math.round(area.height * scale) + 'px' });
  if (desk.backgroundImage !== 'none') box.style.backgroundImage = desk.backgroundImage;
  const inner = h('div', { class: 'ws-stage-inner' });
  Object.assign(inner.style, { width: area.width + 'px', height: area.height + 'px', transform: `scale(${scale})` });
  const wins = wm.wins.filter((w) => w.workspace === id && !w.minimized).sort((a, b) => a.el.style.zIndex - b.el.style.zIndex);
  const copies = wins.map((w) => [w, cloneWindow(w, windowRect(w))]);
  inner.append(...copies.map(([, c]) => c));
  box.append(inner);
  return { box, copies };
}

function close() {
  if (!panel) return;
  panel.remove();
  panel = null;
  cards = [];
  btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', close);
  window.removeEventListener('resize', close);
}

function choose(card) {
  if (card.dataset.ws === 'new') {
    const id = addWorkspace();
    if (id == null) return toast(`最多 ${MAX_WORKSPACES} 個工作區`);
    render(wm.workspaces.length - 1);
    return;
  }
  close();
  switchWorkspace(Number(card.dataset.ws));
}

function render(selected) {
  const copies = [];
  cards = wm.workspaces.map((id) => {
    const st = stage(id);
    copies.push(...st.copies);
    const card = h('div', { class: 'ws-card' + (id === wm.ws ? ' current' : ''), role: 'button', tabindex: '-1', 'data-ws': String(id), 'aria-label': workspaceName(id) },
      h('div', { class: 'ws-card-head' },
        h('span', { class: 'nm' }, workspaceName(id)),
        wm.workspaces.length > 1 && h('button', {
          type: 'button', class: 'ws-close', title: `關閉${workspaceName(id)}（視窗會移到旁邊的工作區）`, 'aria-label': `關閉${workspaceName(id)}`,
          onclick: (ev) => {
            ev.stopPropagation();
            removeWorkspace(id);
            render(Math.min(sel, wm.workspaces.length - 1));
          },
        }, '×')),
      st.box);
    card.addEventListener('click', () => choose(card));
    return card;
  });
  if (wm.workspaces.length < MAX_WORKSPACES) {
    const area = winLayer.getBoundingClientRect();
    const box = h('div', { class: 'ws-stage' }, '+');
    Object.assign(box.style, { width: CARD_W + 'px', height: Math.round((area.height * CARD_W) / area.width) + 'px' });
    const card = h('div', { class: 'ws-card new', role: 'button', tabindex: '-1', 'data-ws': 'new', 'aria-label': '新增工作區' },
      h('div', { class: 'ws-card-head' }, h('span', { class: 'nm' }, '新增工作區')), box);
    card.addEventListener('click', () => choose(card));
    cards.push(card);
  }
  panel.replaceChildren(...cards);
  for (const [w, c] of copies) copyScroll(w, c);
  select(selected ?? wm.workspaces.indexOf(wm.ws));
  place();
}

function select(i) {
  sel = (i + cards.length) % cards.length;
  cards.forEach((c, k) => c.classList.toggle('sel', k === sel));
  cards[sel]?.focus({ preventScroll: false });
}

function place() {
  const dock = $('#dock').getBoundingClientRect();
  const pw = panel.offsetWidth;
  Object.assign(panel.style, {
    left: Math.max(8, (window.innerWidth - pw) / 2) + 'px',
    bottom: Math.max(8, window.innerHeight - dock.top + 8) + 'px',
  });
}

function onOutside(ev) {
  if (!panel.contains(ev.target) && !btn.contains(ev.target)) close();
}

function onKey(ev) {
  if (ev === opener) return;
  if (ev.key === 'Escape') close();
  else if (ev.key === 'ArrowRight' || (ev.key === 'Tab' && !ev.shiftKey)) select(sel + 1);
  else if (ev.key === 'ArrowLeft' || (ev.key === 'Tab' && ev.shiftKey)) select(sel - 1);
  else if (ev.key === 'Enter' || ev.key === ' ') choose(cards[sel]);
  else if (ev.key === 'Delete' && cards[sel]?.dataset.ws !== 'new' && wm.workspaces.length > 1) {
    removeWorkspace(Number(cards[sel].dataset.ws));
    render(Math.min(sel, wm.workspaces.length - 1));
  } else return;
  ev.preventDefault();
  ev.stopPropagation();
}

export function openWorkspaces(ev = null) {
  if (panel) return close();
  opener = ev;
  if ($('#desktop').hidden) return;
  panel = h('div', { id: 'ws-panel', role: 'dialog', 'aria-label': '工作區' });
  document.body.append(panel);
  btn.setAttribute('aria-expanded', 'true');
  render();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
}

btn.addEventListener('click', () => openWorkspaces());
btn.addEventListener('contextmenu', (ev) => {
  close();
  showContextMenu(ev, [
    ...wm.workspaces.map((id) => (id === wm.ws
      ? { label: `${workspaceName(id)}（目前）`, enabled: false, run: () => {} }
      : { label: workspaceName(id), run: () => switchWorkspace(id) })),
    { label: '新增工作區', enabled: wm.workspaces.length < MAX_WORKSPACES, run: () => switchWorkspace(addWorkspace()) },
    null,
    { label: '隱藏這個小工具', run: () => setTaskbar({ workspaces: false }).catch((err) => toast(`無法儲存：${errText(err)}`, true)) },
  ]);
});

// Tab pressed twice in a row opens the panel. Not while typing: there Tab
// belongs to the text (indenting in Procoder, completion in the terminal).
const DOUBLE_TAB_MS = 400;
let lastTab = 0;
window.addEventListener('keydown', (ev) => {
  if (panel) return;
  if (ev.key !== 'Tab' || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey || ev.repeat || ev.target.closest?.(EDITABLE)) {
    lastTab = 0;
    return;
  }
  const now = performance.now();
  if (now - lastTab < DOUBLE_TAB_MS) {
    ev.preventDefault();
    lastTab = 0;
    openWorkspaces(ev);
  } else lastTab = now;
}, true);

on('session:end', () => {
  close();
  resetWorkspaces();
});
