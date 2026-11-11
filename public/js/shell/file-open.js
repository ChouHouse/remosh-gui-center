// Opening files: which app handles which extension.
//
// Associations (extension -> app id) live in the user's settings. The first
// time an extension is opened the user is asked, and the answer is remembered.
import { h } from '../core/dom.js';
import { P } from '../core/path.js';
import { errText } from '../core/errors.js';
import { toast } from '../core/ui.js';
import { getSettings, updateSettings, whenSettingsReady } from '../core/settings.js';
import { getApp, acceptsExt, appsForExt } from './apps.js';

export const extLabel = (ext) => (ext ? `.${ext} 檔` : '沒有副檔名的檔案');

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
        h('span', { class: 'ico', html: app.icon() }), app.name));
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'box' },
        h('h2', null, `要用什麼開啟「${name}」？`),
        h('p', null, rememberDefault ? `還沒有設定${extLabel(ext)}的開啟方式。` : '選擇這次要用的程式。'),
        h('div', { class: 'app-choices' }, choices),
        h('label', { class: 'choose-remember' }, remember, `以後${extLabel(ext)}都用這個程式開啟`),
        h('div', { class: 'btns' }, h('button', { type: 'button', onclick: () => done(null) }, '取消'))));
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
    toast(`無法記住開啟方式：${errText(err)}`, true);
  }
}

// "開啟程式…": always ask; remember only if the user ticks the box.
export async function openWith(path, size, { rememberDefault = false } = {}) {
  const choice = await chooseApp(P.base(path), { rememberDefault });
  if (!choice) return;
  if (choice.remember) await remember(P.ext(P.base(path)), choice.app);
  return choice.app.launch({ path, size });
}

// Double-click / 開啟: use the remembered app, or ask when the extension is unknown.
export async function openFile(path, size) {
  await whenSettingsReady();
  const ext = P.ext(P.base(path));
  const app = getApp(getSettings().files.associations[ext]);
  if (app && acceptsExt(app, ext)) return app.launch({ path, size });
  return openWith(path, size, { rememberDefault: true });
}
