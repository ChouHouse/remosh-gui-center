// Taskbar behaviour chosen in 設定 → 工作列 (size, labels, alignment, auto-hide),
// and sideways scrolling with the wheel when the entries do not fit.
import { $ } from '../core/dom.js';
import { on } from '../core/events.js';
import { getSettings, updateSettings } from '../core/settings.js';

function apply() {
  const t = getSettings().taskbar;
  const root = document.documentElement;
  root.dataset.taskbarSize = t.size;
  root.dataset.taskbarLabels = t.labels ? 'on' : 'off';
  root.dataset.taskbarAlign = t.align;
  root.dataset.taskbarFloat = t.float ? 'on' : 'off';
  root.dataset.taskbarAutohide = t.autoHide ? 'on' : 'off';
  root.dataset.taskbarClock = t.clock ? 'on' : 'off';
}

// Shows at once and is saved in the background.
export const setTaskbar = (change) =>
  updateSettings((s) => {
    Object.assign(s.taskbar, change);
  }, { optimistic: true });

// No scroll bar on the taskbar: the wheel moves it left and right instead.
// The listener is passive on purpose. Nothing here scrolls vertically, so
// there is no default to cancel, and in full screen Chromium did not deliver
// wheel events to a cancelling (non-passive) listener at all.
const items = $('#dock-items');
window.addEventListener('wheel', (ev) => {
  if (!ev.target.closest?.('#dock-items') || items.scrollWidth <= items.clientWidth) return;
  // Either direction moves the strip (its own scrolling is off in the CSS, so nothing moves twice).
  items.scrollLeft += Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
}, { capture: true, passive: true });

// Auto-hide: the bar comes up when the pointer reaches it (a sliver stays at
// the bottom edge) and goes away again 3 seconds after the pointer has left.
const HIDE_AFTER_MS = 3000;
const dock = $('#dock');
let hideTimer = 0;
const showDock = () => {
  clearTimeout(hideTimer);
  document.documentElement.classList.add('dock-shown');
};
const hideDockLater = () => {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => document.documentElement.classList.remove('dock-shown'), HIDE_AFTER_MS);
};
dock.addEventListener('pointerenter', showDock);
dock.addEventListener('pointerleave', hideDockLater);
// The floating dock does not span the bottom edge, so the edge itself counts too.
window.addEventListener('pointermove', (ev) => {
  if (ev.clientY < window.innerHeight - 3 || document.documentElement.dataset.taskbarAutohide !== 'on') return;
  if (document.documentElement.classList.contains('dock-shown')) return;
  showDock();
  hideDockLater();
}, { passive: true });

let wasAutoHide = false;
on('settings:changed', () => {
  apply();
  // Just switched on: show it once, so it is seen sliding away.
  const now = getSettings().taskbar.autoHide;
  if (now && !wasAutoHide) {
    showDock();
    if (!dock.matches(':hover')) hideDockLater();
  }
  wasAutoHide = now;
});
apply();
