// Opening files and folders with an app.
//
// An app says what it opens when it registers (shell/apps.js): `extensions`
// for files, `folders: true` for folders. The right-click menus then offer
// 「用 XXX 開啟」 for each app that fits (openWithItems). A double-click opens
// the only app that fits; with several it asks once, then keeps using the app
// that last opened that kind of file (system.openWith, kept without a page).
import { h } from '../core/dom.js';
import { P } from '../core/path.js';
import { errText } from '../core/errors.js';
import { toast } from '../core/ui.js';
import { rpc } from '../core/rpc.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { getApp, appsForExt, appsForFolders, launchApp } from './apps.js';
import { shortcutKind, displayName, readShortcut } from './shortcuts.js';
import { tt } from '../core/i18n.js';

// Right-click entries for a file or folder: one 「用 XXX 開啟」 per app that
// registered for it and that 設定 › 系統 has not switched off. `except` leaves
// an app out (the one showing the menu).
export function openWithItems(path, { isDir = false, size = 0, except = null } = {}) {
  const hidden = getSettings().system.hiddenOpenWith;
  const apps = (isDir ? appsForFolders() : appsForExt(P.ext(P.base(path)))).filter((app) => app.id !== except && !hidden.includes(app.id));
  return apps.map((app) => ({
    label: tt('用 {0} 開啟', tt(app.name)),
    run: () => {
      if (!isDir) remember(P.base(path), app);
      return app.launch(isDir ? { path, folder: true } : { path, size });
    },
  }));
}

// Notes which app opened this kind of file, so the next double-click uses it.
const extKey = (name) => P.ext(name).toLowerCase();
function remember(name, app) {
  const ext = extKey(name);
  if (!ext || appsForExt(P.ext(name)).length < 2 || getSettings().system.openWith[ext] === app.id) return;
  updateSettings((st) => { st.system.openWith = { ...st.system.openWith, [ext]: app.id }; }, { optimistic: true }).catch(() => {});
}

// Asks which app to use. Resolves to the app, or null when cancelled.
export function chooseApp(name) {
  const ext = P.ext(name);
  return new Promise((resolve) => {
    const done = (value) => {
      modal.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      done(null);
    };
    const choices = appsForExt(ext).map((app) =>
      h('button', { type: 'button', class: 'app-choice', 'data-app': app.id, onclick: () => done(app) },
        h('span', { class: 'ico', html: app.icon() }), tt(app.name)));
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'box' },
        h('h2', null, tt('要用什麼開啟「{0}」？', name)),
        h('p', null, tt('之後這類檔案會直接用它開啟；想換的話，在檔案上按右鍵選「用 … 開啟」。')),
        h('div', { class: 'app-choices' }, choices),
        h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => done(null) }, tt('取消')))));
    document.body.append(modal);
    document.addEventListener('keydown', onKey, true);
    choices[0]?.focus();
  });
}

// A .remosh_gui-app starts its app; a .remosh_gui-lnk opens what it points at.
export async function openShortcut(path) {
  let sc;
  try {
    sc = await readShortcut(path);
  } catch (err) {
    return toast(tt('無法開啟「{0}」：{1}', displayName(P.base(path)), errText(err)), true);
  }
  if (!sc) return toast(tt('「{0}」不是有效的捷徑', displayName(P.base(path))), true);
  if (sc.kind === 'app') {
    if (!getApp(sc.id)) return toast(tt('找不到這個應用程式'), true);
    return launchApp(sc.id);
  }
  try {
    const { entry } = await rpc('stat', { path: sc.target });
    if (entry.type === 'dir') return launchApp('files', { path: sc.target });
    return openFile(sc.target, entry.size);
  } catch (err) {
    return toast(tt('捷徑指向的「{0}」無法開啟：{1}', sc.target, errText(err)), true);
  }
}

// Double-click / 開啟: the only app that fits opens it; with several, the one
// that opened this kind of file last time, asking only when there is none.
export async function openFile(path, size) {
  const name = P.base(path);
  if (shortcutKind(name)) return openShortcut(path);
  const apps = appsForExt(P.ext(name));
  let app = apps.length === 1 ? apps[0] : apps.find((a) => a.id === getSettings().system.openWith[extKey(name)]);
  if (!app) {
    app = await chooseApp(name);
    if (app) remember(name, app);
  }
  return app?.launch({ path, size });
}
