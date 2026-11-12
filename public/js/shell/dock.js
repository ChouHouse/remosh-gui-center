// The taskbar's own behaviour: right-click menus, launchers pinned to it,
// focus mode, and dragging the entries into another order.
import { $, h } from '../core/dom.js';
import { on } from '../core/events.js';
import { errText } from '../core/errors.js';
import { toast } from '../core/ui.js';
import { getSettings } from '../core/settings.js';
import { wm, dockItems } from './wm.js';
import { listApps, getApp, launchApp } from './apps.js';
import { showContextMenu } from './context-menu.js';
import { setTaskbar } from './taskbar.js';

const dock = $('#dock');
const pins = h('div', { id: 'dock-pins' });
dockItems.before(pins);

const save = (change) => setTaskbar(change).catch((err) => toast(`無法儲存：${errText(err)}`, true));
const winOf = (el) => wm.wins.find((w) => w.dockEl === el) || null;
// A window says which app it is by that app's name.
const appOf = (win) => listApps().find((app) => app.name === win.el.dataset.app) || null;

// ---- pinned launchers
const pinnedIds = () => getSettings().taskbar.pinned;
const pin = (id) => save({ pinned: [...pinnedIds().filter((x) => x !== id), id] });
const unpin = (id) => save({ pinned: pinnedIds().filter((x) => x !== id) });

function renderPins() {
  pins.replaceChildren(...pinnedIds().map(getApp).filter(Boolean).map((app) =>
    h('button', { type: 'button', class: 'dock-item dock-pin', 'data-pin': app.id, title: app.name, 'aria-label': `開啟 ${app.name}`, onclick: () => launchApp(app.id) },
      h('span', { class: 'ico', html: app.icon() }))));
}
on('settings:changed', renderPins);
renderPins();

// ---- focus mode: this window alone, as large as it goes
function focusMode(win) {
  for (const other of wm.wins) if (other !== win && !other.minimized) other.minimize();
  win.focus();
  if (!win.maximized) win.toggleMax();
}

// ---- right-click menus
dock.addEventListener('contextmenu', (ev) => {
  if (ev.target.closest('#start-btn')) return; // has its own (shell/start-menu.js)
  const pinEl = ev.target.closest('.dock-pin');
  const win = winOf(ev.target.closest('#dock-items .dock-item'));
  if (pinEl) {
    const app = getApp(pinEl.dataset.pin);
    return showContextMenu(ev, [
      { label: '開啟', run: () => launchApp(app.id) },
      null,
      { label: '從工作列取消釘選', run: () => unpin(app.id) },
    ]);
  }
  if (win) {
    const app = appOf(win);
    return showContextMenu(ev, [
      { label: '專注模式', run: () => focusMode(win) },
      null,
      app && (pinnedIds().includes(app.id)
        ? { label: '從工作列取消釘選', run: () => unpin(app.id) }
        : { label: '釘選到工作列', run: () => pin(app.id) }),
      { label: '關閉應用程式', danger: true, run: () => win.close() },
    ].filter((item) => item !== false && item !== undefined));
  }
  if (ev.target.closest('#clock')) {
    return showContextMenu(ev, [{ label: '移除這個時鐘', run: () => save({ clock: false }) }]);
  }
  showContextMenu(ev, [{ label: '工作列設定', run: () => launchApp('settings', { category: 'taskbar' }) }]);
});

// ---- drag an entry left or right to move it
dockItems.addEventListener('pointerdown', (ev) => {
  const item = ev.target.closest('.dock-item');
  if (ev.button !== 0 || !item) return;
  const startX = ev.clientX;
  let moving = false;
  const move = (e) => {
    if (!moving) {
      if (Math.abs(e.clientX - startX) < 6) return;
      moving = true;
      item.classList.add('reordering');
    }
    const prev = item.previousElementSibling;
    const next = item.nextElementSibling;
    const mid = (el) => {
      const r = el.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    if (prev && e.clientX < mid(prev)) prev.before(item);
    else if (next && e.clientX > mid(next)) next.after(item);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!moving) return;
    item.classList.remove('reordering');
    // The release must not count as a click on the entry.
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
});
