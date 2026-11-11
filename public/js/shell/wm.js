// Window manager: draggable/resizable windows with a taskbar entry each.
import { $, h } from '../core/dom.js';
import { animationMs } from '../core/settings.js';

export const winLayer = $('#windows');
export const dockItems = $('#dock-items');
export const setActiveTitle = (t) => {
  document.title = t ? `${t} — SSH Desk` : 'SSH Desk';
};
export const wm = { wins: [], z: 10, focused: null, cascade: 0 };

// title is the short name (shown in the taskbar); the title bar shows
// "title — appName" so every window says which app it belongs to.
export function createWindow({ title, appName, iconHtml, width, height }) {
  const fullTitle = (t) => (appName && t !== appName ? `${t} — ${appName}` : t);
  const win = { title, minimized: false, maximized: false, onClose: null, onFocus: null };
  const titleEl = h('div', { class: 'title' }, fullTitle(title));
  const bar = h('div', { class: 'titlebar' },
    h('div', { class: 'traffic' },
      h('button', { type: 'button', class: 'close', title: '關閉', 'aria-label': '關閉', onclick: () => win.close() }),
      h('button', { type: 'button', class: 'min', title: '縮到工作列', 'aria-label': '縮到工作列', onclick: () => win.minimize() }),
      h('button', { type: 'button', class: 'max', title: '放大', 'aria-label': '放大', onclick: () => win.toggleMax() })),
    titleEl);
  win.body = h('div', { class: 'win-body' });
  win.el = h('section', { class: 'win', 'data-app': appName || null }, bar, win.body,
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => h('div', { class: 'rs ' + d, 'data-dir': d })));

  const area = winLayer.getBoundingClientRect();
  const w = Math.min(width, area.width - 16);
  const hgt = Math.min(height, area.height - 16);
  const off = (wm.cascade++ % 8) * 26;
  Object.assign(win.el.style, {
    width: w + 'px',
    height: hgt + 'px',
    left: Math.max(8, Math.min((area.width - w) / 2 - 90 + off, area.width - w - 8)) + 'px',
    top: Math.max(8, Math.min(24 + off, area.height - hgt - 8)) + 'px',
  });

  const lbl = h('span', { class: 'lbl' }, title);
  const ico = h('span', { class: 'ico', html: iconHtml });
  win.setIcon = (html) => {
    ico.innerHTML = html;
  };
  win.dockEl = h('button', { type: 'button', class: 'dock-item open', 'data-app': appName || null, title },
    ico, lbl, h('span', { class: 'dirty', title: '尚未儲存' }));
  win.dockEl.addEventListener('click', () => {
    if (win.minimized) win.focus();
    else if (wm.focused === win) win.minimize();
    else win.focus();
  });
  dockItems.append(win.dockEl);

  win.setTitle = (t) => {
    win.title = t;
    titleEl.textContent = fullTitle(t);
    lbl.textContent = t;
    win.dockEl.title = t;
    if (wm.focused === win) setActiveTitle(fullTitle(t));
  };
  win.setDirty = (d) => win.dockEl.classList.toggle('is-dirty', d);
  win.focus = () => {
    if (win.minimized) {
      win.minimized = false;
      win.el.classList.remove('minimized');
      win.dockEl.classList.remove('minimized');
    }
    win.el.style.zIndex = ++wm.z;
    if (wm.focused !== win) {
      wm.focused?.el.classList.remove('focused');
      wm.focused?.dockEl.classList.remove('active');
      wm.focused = win;
      win.el.classList.add('focused');
      win.dockEl.classList.add('active');
      setActiveTitle(fullTitle(win.title));
    }
    win.onFocus?.();
  };
  win.minimize = () => {
    win.minimized = true;
    win.el.classList.add('minimized');
    win.dockEl.classList.add('minimized');
    win.dockEl.classList.remove('active');
    win.el.classList.remove('focused');
    if (wm.focused === win) {
      wm.focused = null;
      setActiveTitle('');
      focusTop();
    }
  };
  let animTimer = null;
  win.toggleMax = () => {
    // Animate only this change of size; dragging and resizing must stay instant.
    const ms = animationMs(); // 0 when animations are off in the settings
    clearTimeout(animTimer);
    win.el.classList.toggle('animating', ms > 0);
    if (ms) animTimer = setTimeout(() => win.el.classList.remove('animating'), ms + 60);
    win.maximized = !win.maximized;
    win.el.classList.toggle('maximized', win.maximized);
    win.focus();
  };
  win.close = async (force) => {
    if (!force && win.onClose && (await win.onClose()) === false) return false;
    win.destroy?.();
    win.el.remove();
    win.dockEl.remove();
    wm.wins.splice(wm.wins.indexOf(win), 1);
    if (wm.focused === win) {
      wm.focused = null;
      setActiveTitle('');
      focusTop();
    }
    return true;
  };

  win.el.addEventListener('pointerdown', () => {
    if (wm.focused !== win) win.focus();
  }, true);
  bar.addEventListener('dblclick', (ev) => {
    if (!ev.target.closest('.traffic')) win.toggleMax();
  });
  bar.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.traffic') || win.maximized) return;
    dragRect(ev, win, 'move');
  });
  for (const handle of win.el.querySelectorAll('.rs')) {
    handle.addEventListener('pointerdown', (ev) => {
      if (ev.button === 0) dragRect(ev, win, handle.dataset.dir);
    });
  }

  winLayer.append(win.el);
  wm.wins.push(win);
  win.focus();
  return win;
}

export function focusTop() {
  const next = wm.wins.filter((w) => !w.minimized).sort((a, b) => b.el.style.zIndex - a.el.style.zIndex)[0];
  if (next) next.focus();
}

export function dragRect(ev, win, mode) {
  ev.preventDefault();
  const el = win.el;
  const area = winLayer.getBoundingClientRect();
  const start = { x: ev.clientX, y: ev.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  const MIN_W = 320;
  const MIN_H = 200;
  document.body.classList.add('dragging');
  const move = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    let { l, t, w, h: hh } = start;
    if (mode === 'move') {
      l += dx;
      t += dy;
      l = Math.max(80 - w, Math.min(l, area.width - 80));
      t = Math.max(0, Math.min(t, area.height - 34));
    } else {
      if (mode.includes('e')) w = Math.max(MIN_W, start.w + dx);
      if (mode.includes('s')) hh = Math.max(MIN_H, start.h + dy);
      if (mode.includes('w')) {
        w = Math.max(MIN_W, start.w - dx);
        l = start.l + start.w - w;
      }
      if (mode.includes('n')) {
        hh = Math.max(MIN_H, Math.min(start.h - dy, start.t + start.h));
        t = start.t + start.h - hh;
      }
    }
    Object.assign(el.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: hh + 'px' });
  };
  const up = () => {
    document.body.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
