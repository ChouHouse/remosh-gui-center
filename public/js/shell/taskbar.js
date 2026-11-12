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
  root.dataset.taskbarAutohide = t.autoHide ? 'on' : 'off';
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

on('settings:changed', apply);
apply();
