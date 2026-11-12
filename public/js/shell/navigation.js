// Back / forward. The mouse side buttons and the keyboard shortcuts never
// reach the browser (which would leave the page and drop every connection);
// they go to the window in front instead. An app takes part by setting
// win.onNavigate = (delta) => …   with delta -1 for back and 1 for forward.
import { wm } from './wm.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor, .xterm';

export function navigate(delta) {
  const win = wm.focused;
  if (!win?.onNavigate) return false;
  win.onNavigate(delta);
  return true;
}

// Side buttons: 3 = back, 4 = forward.
const sideButton = (ev) => (ev.button === 3 ? -1 : ev.button === 4 ? 1 : 0);
for (const type of ['mousedown', 'mouseup', 'auxclick']) {
  window.addEventListener(type, (ev) => {
    const delta = sideButton(ev);
    if (!delta) return;
    ev.preventDefault();
    if (type === 'mouseup') navigate(delta);
  }, true);
}

function keyDelta(ev) {
  if (ev.key === 'BrowserBack') return -1;
  if (ev.key === 'BrowserForward') return 1;
  if (ev.shiftKey) return 0;
  if (isMac) {
    if (!ev.metaKey || ev.altKey || ev.ctrlKey) return 0;
    return ev.key === '[' ? -1 : ev.key === ']' ? 1 : 0;
  }
  if (!ev.altKey || ev.ctrlKey || ev.metaKey) return 0;
  return ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
}

window.addEventListener('keydown', (ev) => {
  const delta = keyDelta(ev);
  if (!delta) return;
  const typing = ev.target.closest?.(EDITABLE);
  if (typing) {
    // While typing the keys keep their own meaning (word movement, the
    // editor's and the terminal's shortcuts). Only the browser is held back,
    // and only where the key means nothing else to a text box.
    if (!isMac && ev.key.startsWith('Arrow') && typing.matches('input, textarea, select')) ev.preventDefault();
    return;
  }
  ev.preventDefault();
  navigate(delta);
}, true);
