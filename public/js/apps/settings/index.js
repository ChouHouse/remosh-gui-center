// 設定: categories on the left, their options on the right. 儲存 writes
// ~/.remosh-gui/setting.json on the SSH host (see core/settings.js).
//
// To add a category, push another entry to CATEGORIES: { id, label, render }.
// render(draft, changed) returns the pane's element; it edits `draft` in place
// and calls changed() after every edit.
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { toast } from '../../core/ui.js';
import { settingsSvg } from '../../core/icons.js';
import { on } from '../../core/events.js';
import { getSettings, saveSettings, SETTINGS_DIR, SETTINGS_FILE } from '../../core/settings.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, getApp, appsForExt } from '../../shell/apps.js';

const row = (title, desc, control) =>
  h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('b', null, title), h('small', null, desc)), control);

const CATEGORIES = [
  {
    id: 'animation',
    label: '動畫',
    render(draft, changed) {
      const speed = h('select', { id: 'set-anim-speed', 'aria-label': '動畫速度' },
        [['fast', '快'], ['normal', '一般'], ['slow', '慢']].map(([value, label]) =>
          h('option', { value, selected: draft.animation.speed === value }, label)));
      const enabled = h('input', { type: 'checkbox', id: 'set-anim-enabled', class: 'switch', role: 'switch', 'aria-label': '啟用動畫', checked: draft.animation.enabled });
      speed.disabled = !draft.animation.enabled;
      enabled.addEventListener('change', () => {
        draft.animation.enabled = enabled.checked;
        speed.disabled = !enabled.checked;
        changed();
      });
      speed.addEventListener('change', () => {
        draft.animation.speed = speed.value;
        changed();
      });
      return h('div', null,
        h('h2', null, '動畫'),
        row('啟用動畫', '視窗放大、還原，以及介面元件的過渡效果', enabled),
        row('速度', '過渡效果播放的快慢', speed));
    },
  },
  {
    id: 'associations',
    label: '檔案關聯',
    render(draft, changed) {
      const table = draft.files.associations;
      const list = h('div', { class: 'assoc-list' });
      const appSelect = (ext, current) => {
        const options = appsForExt(ext);
        const stale = current && !options.some((a) => a.id === current); // app gone or no longer accepts it
        return h('select', { 'aria-label': '開啟程式' },
          stale && h('option', { value: current, selected: true }, `${getApp(current)?.name || current}（不適用）`),
          options.map((a) => h('option', { value: a.id, selected: a.id === current }, a.name)));
      };
      const draw = () => {
        const exts = Object.keys(table).sort();
        list.replaceChildren(...(exts.length
          ? exts.map((ext) => {
            const select = appSelect(ext, table[ext]);
            select.addEventListener('change', () => {
              table[ext] = select.value;
              changed();
            });
            return h('div', { class: 'assoc-row', 'data-ext': ext },
              h('code', null, ext ? '.' + ext : '（無副檔名）'), select,
              h('button', { type: 'button', class: 'assoc-del', title: '移除這個關聯', onclick: () => {
                delete table[ext];
                draw();
                changed();
              } }, '移除'));
          })
          : [h('p', { class: 'assoc-empty' }, '還沒有任何關聯。')]));
      };
      draw();
      return h('div', null,
        h('h2', null, '檔案關聯'),
        h('p', { class: 'set-desc' }, '副檔名在第一次開啟該類檔案時才會登記到這裡；這裡只能修改或移除。'),
        list);
    },
  },
];

let win = null;

function openSettings() {
  if (win) return win.focus();
  win = createWindow({ title: '設定', appName: '設定', iconHtml: settingsSvg(), width: 660, height: 440 });
  const draft = getSettings();
  let saved = JSON.stringify(draft);
  let saving = false;
  let active = CATEGORIES[0];

  const nav = h('nav', { class: 'set-nav', 'aria-label': '設定分類' });
  const pane = h('section', { class: 'set-pane' });
  const status = h('span', { class: 'set-status' });
  const saveBtn = h('button', { type: 'button', class: 'set-save', id: 'set-save' }, '儲存');
  win.body.append(
    h('div', { class: 'set-main' }, nav, pane),
    h('div', { class: 'set-foot' },
      h('span', { class: 'set-path', title: '設定存放在這台主機上你的家目錄' }, `~/${SETTINGS_DIR}/${SETTINGS_FILE}`),
      status, saveBtn));

  const refresh = () => {
    const dirty = JSON.stringify(draft) !== saved;
    saveBtn.disabled = !dirty || saving;
    saveBtn.textContent = saving ? '儲存中…' : '儲存';
    if (dirty) status.textContent = '有未儲存的變更';
    else if (status.textContent === '有未儲存的變更') status.textContent = '';
  };
  const show = (cat) => {
    active = cat;
    nav.replaceChildren(...CATEGORIES.map((c) =>
      h('button', { type: 'button', class: c === active ? 'current' : '', 'aria-current': c === active ? 'page' : null, onclick: () => show(c) }, c.label)));
    pane.replaceChildren(cat.render(draft, refresh));
  };
  saveBtn.addEventListener('click', async () => {
    saving = true;
    refresh();
    try {
      await saveSettings(draft);
      saved = JSON.stringify(draft); // keep the same draft object: the controls edit it in place
      status.textContent = '已儲存';
    } catch (err) {
      toast(`無法儲存設定：${errText(err)}`, true);
    } finally {
      saving = false;
      refresh();
    }
  });
  // Settings can change behind this window (e.g. a new file association is
  // remembered); follow along unless the user has unsaved edits here.
  const off = on('settings:changed', (next) => {
    if (saving || JSON.stringify(draft) !== saved) return;
    Object.assign(draft, next);
    saved = JSON.stringify(draft);
    show(active);
  });
  win.destroy = () => {
    off();
    win = null;
  };
  show(active);
  refresh();
}

registerApp({ id: 'settings', name: '設定', icon: settingsSvg, startMenu: true, launch: openSettings });
