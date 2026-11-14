// Opening files: which app handles which extension.
//
// Associations (extension -> app id) live in the user's settings. The first
// time an extension is opened the user is asked, and the answer is remembered.
import { h } from '../core/dom.js';
import { P } from '../core/path.js';
import { errText } from '../core/errors.js';
import { toast } from '../core/ui.js';
import { getSettings, updateSettings, whenSettingsReady } from '../core/settings.js';
import { rpc } from '../core/rpc.js';
import { getApp, acceptsExt, appsForExt, launchApp } from './apps.js';
import { shortcutKind, displayName, readShortcut } from './shortcuts.js';
import { tt } from '../core/i18n.js';

export const extLabel = (ext) => (ext ? tt('.{0} 檔', ext) : tt('沒有副檔名的檔案'));

// Asks which app to use. Resolves to { app, remember } or null when cancelled.
// The dialog has a 「以後都用這個程式開啟」 checkbox; `rememberDefault` is its
// initial state (ticked when the extension is unknown, so one click registers it).
export function chooseApp(name, { rememberDefault = false } = {}) {
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
    const remember = h('input', { type: 'checkbox', id: 'choose-remember', checked: rememberDefault });
    const choices = appsForExt(ext).map((app) =>
      h('button', { type: 'button', class: 'app-choice', 'data-app': app.id, onclick: () => done({ app, remember: remember.checked }) },
        h('span', { class: 'ico', html: app.icon() }), tt(app.name)));
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'box' },
        h('h2', null, tt('要用什麼開啟「{0}」？', name)),
        h('p', null, rememberDefault ? tt('還沒有設定{0}的開啟方式。', extLabel(ext)) : tt('選擇這次要用的程式。')),
        h('div', { class: 'app-choices' }, choices),
        h('label', { class: 'choose-remember' }, remember, tt('以後{0}都用這個程式開啟', extLabel(ext))),
        h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => done(null) }, tt('取消')))));
    document.body.append(modal);
    document.addEventListener('keydown', onKey, true);
    choices[0]?.focus();
  });
}

async function remember(ext, app) {
  try {
    await updateSettings((s) => {
      s.files.associations[ext] = app.id;
    });
  } catch (err) {
    toast(tt('無法記住開啟方式：{0}', errText(err)), true);
  }
}

// "開啟程式…": always ask; remember only if the user ticks the box.
export async function openWith(path, size, { rememberDefault = false } = {}) {
  const choice = await chooseApp(P.base(path), { rememberDefault });
  if (!choice) return;
  if (choice.remember) await remember(P.ext(P.base(path)), choice.app);
  return choice.app.launch({ path, size });
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

// Double-click / 開啟: use the remembered app, or ask when the extension is unknown.
export async function openFile(path, size) {
  if (shortcutKind(P.base(path))) return openShortcut(path);
  await whenSettingsReady();
  const ext = P.ext(P.base(path));
  const app = getApp(getSettings().files.associations[ext]);
  if (app && acceptsExt(app, ext)) return app.launch({ path, size });
  return openWith(path, size, { rememberDefault: true });
}
