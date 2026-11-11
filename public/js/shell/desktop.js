// Desktop lifecycle: show it after login, tear everything down on logout.
import { $ } from '../core/dom.js';
import { dialog } from '../core/ui.js';
import { conn } from '../core/rpc.js';
import { on, emit } from '../core/events.js';
import { wm } from './wm.js';
import { listApps, launchApp, unsavedCount } from './apps.js';

on('session:start', () => {
  $('#desktop').hidden = false; // must be visible before any window measures itself
  for (const app of listApps()) if (app.autostart) launchApp(app.id);
});

export async function logout() {
  const dirty = unsavedCount();
  if (dirty) {
    const ok = await dialog({
      title: '確定要登出嗎？',
      message: `還有 ${dirty} 個檔案尚未儲存，登出後修改會遺失。`,
      buttons: [{ label: '取消', value: false, cancel: true, default: true }, { label: '登出', value: true, danger: true }],
    });
    if (!ok) return;
  }
  conn.closing = true;
  conn.info = null;
  conn.ws?.close();
  for (const win of [...wm.wins]) await win.close(true);
  $('#dock-items').replaceChildren();
  wm.cascade = 0;
  $('#desktop').hidden = true;
  emit('session:end');
}

window.addEventListener('beforeunload', (ev) => {
  if (unsavedCount()) {
    ev.preventDefault();
    ev.returnValue = '';
  }
});
