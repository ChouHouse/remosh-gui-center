// Taskbar previews: rest the pointer on an entry and a small picture of that
// window comes up above it, also for a window that is minimised. The picture
// is a copy of the window taken at that moment; it does not keep updating.
import { h } from '../core/dom.js';
import { wm, winLayer, dockItems } from './wm.js';
import { groupOf, grouping } from './dock.js';

const SHOW_AFTER_MS = 450;
const MAX_W = 240;
const MAX_H = 160;

let timer = 0;
let popup = null;
let shownFor = null;
let muted = null; // entry that was just clicked: nothing until the pointer has left it

let hideTimer = 0;
let peeked = null;

// Peek: while the pointer is on the picture only that window is shown on the
// desktop (also when it is minimised); everything comes back afterwards.
function peek(win) {
  if (peeked === win) return;
  peeked?.el.classList.remove('peek-target');
  peeked = win;
  win?.el.classList.add('peek-target');
  document.documentElement.classList.toggle('peeking', !!win);
}

// Leaving the entry or the picture: a moment to cross the gap between them.
function hideSoon() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, 220);
}

function hide() {
  clearTimeout(timer);
  clearTimeout(hideTimer);
  peek(null);
  popup?.remove();
  popup = null;
  shownFor = null;
}

// Size the window has, or would have once it is brought back.
function windowSize(win) {
  const area = winLayer.getBoundingClientRect();
  if (win.maximized) return { w: area.width, h: area.height };
  if (win.snapped) return { w: area.width / 2, h: area.height };
  return { w: parseFloat(win.el.style.width) || win.el.offsetWidth, h: parseFloat(win.el.style.height) || win.el.offsetHeight };
}

function snapshot(win, w, hgt, scale) {
  const copy = win.el.cloneNode(true);
  copy.classList.remove('minimized', 'maximized', 'snapped', 'animating');
  copy.inert = true;
  copy.setAttribute('aria-hidden', 'true');
  for (const el of [copy, ...copy.querySelectorAll('[id]')]) el.removeAttribute('id');
  Object.assign(copy.style, {
    left: '0', top: '0', width: w + 'px', height: hgt + 'px', zIndex: 'auto',
    transform: `scale(${scale})`, transformOrigin: '0 0', boxShadow: 'none', border: '0', borderRadius: '0',
  });
  // What cloning leaves out: drawn canvases and what has been typed.
  const pair = (sel, fn) => {
    const from = win.el.querySelectorAll(sel);
    const to = copy.querySelectorAll(sel);
    from.forEach((el, i) => to[i] && fn(el, to[i]));
  };
  pair('canvas', (a, b) => {
    try {
      if (a.width && a.height) b.getContext('2d').drawImage(a, 0, 0);
    } catch { /* a canvas that cannot be read stays empty */ }
  });
  pair('input, textarea, select', (a, b) => {
    if (a.type === 'checkbox' || a.type === 'radio') b.checked = a.checked;
    else if (a.type !== 'file') b.value = a.value;
  });
  return copy;
}

// Scroll positions only exist once the copy is in the page.
function copyScroll(win, copy) {
  const from = win.el.querySelectorAll('*');
  const to = copy.querySelectorAll('*');
  if (from.length !== to.length) return;
  from.forEach((el, i) => {
    if (el.scrollTop) to[i].scrollTop = el.scrollTop;
    if (el.scrollLeft) to[i].scrollLeft = el.scrollLeft;
  });
}

// The windows an entry stands for: itself, or its whole app when entries are merged.
const membersOf = (win) => (grouping() ? groupOf(win) : [win]);

function card(win) {
  const { w, h: hgt } = windowSize(win);
  if (!w || !hgt) return null;
  const scale = Math.min(MAX_W / w, MAX_H / hgt);
  const copy = snapshot(win, w, hgt, scale);
  const stage = h('div', { class: 'win-preview-stage' }, copy);
  Object.assign(stage.style, { width: Math.round(w * scale) + 'px', height: Math.round(hgt * scale) + 'px' });
  const el = h('div', { class: 'win-preview-card' },
    h('div', { class: 'win-preview-title' },
      h('span', { class: 'ico', html: win.dockEl.querySelector('.ico').innerHTML }),
      h('span', { class: 'lbl' }, win.title)),
    stage);
  el.addEventListener('pointerenter', () => peek(win));
  el.addEventListener('click', () => {
    hide();
    win.focus();
  });
  return { el, win, copy };
}

function show(win) {
  hide();
  if (!wm.wins.includes(win) || document.body.classList.contains('dragging')) return;
  const cards = membersOf(win).map(card).filter(Boolean);
  if (!cards.length) return;
  popup = h('div', { class: 'win-preview' }, cards.map((c) => c.el));
  popup.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  popup.addEventListener('pointerleave', () => {
    peek(null);
    hideSoon();
  });
  document.body.append(popup);
  for (const c of cards) copyScroll(c.win, c.copy);
  const item = win.dockEl.getBoundingClientRect();
  const dock = document.getElementById('dock').getBoundingClientRect();
  const pw = popup.offsetWidth;
  const left = Math.max(6, Math.min(item.left + item.width / 2 - pw / 2, window.innerWidth - pw - 6));
  Object.assign(popup.style, { left: left + 'px', bottom: window.innerHeight - dock.top + 8 + 'px' });
  shownFor = win;
}

const winOf = (target) => {
  const el = target.closest?.('.dock-item');
  return el ? wm.wins.find((w) => w.dockEl === el) : null;
};

dockItems.addEventListener('pointerover', (ev) => {
  if (ev.pointerType === 'touch') return;
  const win = winOf(ev.target);
  if (!win || win.dockEl === muted) return;
  clearTimeout(hideTimer);
  if (win === shownFor) return;
  clearTimeout(timer);
  // Moving along the bar with a preview already up: the next one comes at once.
  timer = setTimeout(() => show(win), shownFor ? 80 : SHOW_AFTER_MS);
});
dockItems.addEventListener('pointerout', (ev) => {
  const el = ev.target.closest?.('.dock-item');
  if (!el || el.contains(ev.relatedTarget)) return;
  if (el === muted) muted = null;
  clearTimeout(timer);
  if (!ev.relatedTarget?.closest?.('.dock-item')) hideSoon();
});
// A click acts on the window itself; the picture gets out of the way. An
// entry that stands for several windows cannot know which one is meant, so
// its click brings up the pictures to choose from.
dockItems.addEventListener('pointerdown', (ev) => {
  const win = winOf(ev.target);
  if (win && membersOf(win).length > 1) return;
  muted = ev.target.closest?.('.dock-item') || null;
  hide();
}, true);
dockItems.addEventListener('click', (ev) => {
  const win = winOf(ev.target);
  if (!win || membersOf(win).length < 2) return;
  ev.stopPropagation();
  clearTimeout(timer);
  if (shownFor !== win) show(win);
}, true);
dockItems.addEventListener('wheel', hide, { passive: true });
window.addEventListener('blur', hide);
