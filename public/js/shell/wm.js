// Window manager: draggable/resizable windows with a taskbar entry each.
import { $, h } from '../core/dom.js';
import { animationMs } from '../core/settings.js';

export const winLayer = $('#windows');
export const dockItems = $('#dock-items');
export const setActiveTitle = (t) => {
  document.title = t ? `${t} — Remosh GUI` : 'Remosh GUI';
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
  // Fill the left or right half of the desktop; the previous size comes back
  // when the window is dragged away again.
  win.snap = (side) => {
    if (!win.snapped) {
      const el = win.el;
      win.restoreRect = { w: el.offsetWidth, h: el.offsetHeight };
    }
    const ms = animationMs();
    clearTimeout(animTimer);
    win.el.classList.toggle('animating', ms > 0);
    if (ms) animTimer = setTimeout(() => win.el.classList.remove('animating'), ms + 60);
    win.snapped = side;
    win.el.classList.add('snapped');
    Object.assign(win.el.style, { left: side === 'left' ? '0' : '50%', top: '0', width: '50%', height: '100%' });
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
    if (ev.button !== 0 || ev.target.closest('.traffic')) return;
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

const SNAP_EDGE = 6; // px from an edge of the desktop that counts as "at the edge"

function snapZone(e, area) {
  const x = e.clientX - area.left;
  const y = e.clientY - area.top;
  if (y <= SNAP_EDGE) return 'max';
  if (x <= SNAP_EDGE) return 'left';
  if (x >= area.width - SNAP_EDGE) return 'right';
  return null;
}

export function dragRect(ev, win, mode) {
  ev.preventDefault();
  const el = win.el;
  const area = winLayer.getBoundingClientRect();
  let start = { x: ev.clientX, y: ev.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  const MIN_W = 320;
  const MIN_H = 200;
  let zone = null;
  let preview = null;
  let lifted = false; // a maximised or snapped window has been pulled back to its normal size
  if (mode !== 'move' && win.snapped) {
    // Resizing a snapped window makes it an ordinary window of that size.
    win.snapped = null;
    el.classList.remove('snapped');
    Object.assign(el.style, { left: start.l + 'px', top: start.t + 'px', width: start.w + 'px', height: start.h + 'px' });
  }
  document.body.classList.add('dragging');
  const showPreview = (z) => {
    if (z === zone) return;
    zone = z;
    if (!z) {
      preview?.remove();
      preview = null;
      return;
    }
    if (!preview) {
      // Grow out of the window's own outline.
      preview = document.createElement('div');
      preview.className = 'snap-preview';
      Object.assign(preview.style, { left: el.offsetLeft + 'px', top: el.offsetTop + 'px', width: el.offsetWidth + 'px', height: el.offsetHeight + 'px' });
      winLayer.append(preview);
      void preview.offsetWidth;
    }
    Object.assign(preview.style, { left: z === 'right' ? '50%' : '0', top: '0', width: z === 'max' ? '100%' : '50%', height: '100%' });
  };
  const move = (e) => {
    if (mode === 'move' && !lifted && (win.maximized || win.snapped)) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
      // Pull it off the edge: back to its normal size, kept under the pointer.
      const ratio = (start.x - area.left - el.offsetLeft) / el.offsetWidth;
      const w = win.snapped ? win.restoreRect.w : parseFloat(el.style.width) || 640;
      const hgt = win.snapped ? win.restoreRect.h : parseFloat(el.style.height) || 420;
      win.maximized = false;
      win.snapped = null;
      el.classList.remove('maximized', 'snapped', 'animating');
      const l = e.clientX - area.left - ratio * w;
      const t = Math.max(0, e.clientY - area.top - 17);
      Object.assign(el.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: hgt + 'px' });
      start = { x: e.clientX, y: e.clientY, l, t, w, h: hgt };
      lifted = true;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    let { l, t, w, h: hh } = start;
    if (mode === 'move') {
      l += dx;
      t += dy;
      l = Math.max(80 - w, Math.min(l, area.width - 80));
      t = Math.max(0, Math.min(t, area.height - 34));
      if (dx || dy) showPreview(snapZone(e, area));
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
    const z = zone;
    showPreview(null);
    if (z === 'max') {
      // Keep a sensible size to come back to, then maximise.
      Object.assign(el.style, { left: Math.max(8, start.l) + 'px', top: '24px', width: start.w + 'px', height: start.h + 'px' });
      if (!win.maximized) win.toggleMax();
    } else if (z) {
      Object.assign(el.style, { width: start.w + 'px', height: start.h + 'px' });
      win.snap(z);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// "Show desktop": minimise everything, or bring back what was minimised that way.
let tuckedAway = [];
export function toggleShowDesktop() {
  const visible = wm.wins.filter((w) => !w.minimized);
  if (visible.length) {
    tuckedAway = visible.sort((a, b) => a.el.style.zIndex - b.el.style.zIndex);
    for (const w of tuckedAway) w.minimize();
  } else {
    for (const w of tuckedAway) if (wm.wins.includes(w)) w.focus();
    tuckedAway = [];
  }
}
$('#show-desktop').addEventListener('click', toggleShowDesktop);
