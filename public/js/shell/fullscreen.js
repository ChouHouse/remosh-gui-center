// Full screen: entered right after a successful login, left on logout, and
// switchable from the start menu.
import { $ } from '../core/dom.js';
import { on } from '../core/events.js';

const root = document.documentElement;
const request = root.requestFullscreen || root.webkitRequestFullscreen;
const exit = document.exitFullscreen || document.webkitExitFullscreen;
export const canFullscreen = typeof request === 'function';
export const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

// Browsers only allow this shortly after a click or key press. Logging in is
// one, but a slow login can outlast it; the start menu item is the fallback.
export async function enterFullscreen() {
  if (!canFullscreen || isFullscreen()) return false;
  try {
    await request.call(root, { navigationUI: 'hide' });
  } catch {
    return false;
  }
  // Where supported (Chrome, Edge), keep Esc for the app: it closes menus and
  // dialogs instead of leaving full screen (hold Esc to leave).
  navigator.keyboard?.lock?.(['Escape']).catch(() => {});
  return true;
}

export async function leaveFullscreen() {
  if (!isFullscreen()) return;
  navigator.keyboard?.unlock?.();
  try {
    await exit.call(document);
  } catch {
    /* already left */
  }
}

const button = $('#sm-fullscreen');
const sync = () => {
  $('#sm-fullscreen-label').textContent = isFullscreen() ? '離開全螢幕' : '全螢幕';
};
if (canFullscreen) {
  button.hidden = false;
  $('#sm-fullscreen-ico').innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>';
  button.addEventListener('click', () => (isFullscreen() ? leaveFullscreen() : enterFullscreen()));
  for (const name of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(name, sync);
  sync();
}

on('session:start', enterFullscreen);
on('session:end', leaveFullscreen);
