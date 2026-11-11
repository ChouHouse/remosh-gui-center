// 設定: categories on the left, their options on the right. 儲存 writes
// ~/.remosh-gui/setting.json on the SSH host (see core/settings.js).
//
// To add a category, push another entry to CATEGORIES: { id, label, render }.
// render(draft, changed) returns the pane's element; it edits `draft` in place
// and calls changed() after every edit.
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { toast } from '../../core/ui.js';
import { fmtTime } from '../../core/format.js';
import { settingsSvg } from '../../core/icons.js';
import { on } from '../../core/events.js';
import { getSettings, saveSettings } from '../../core/settings.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, getApp, appsForExt } from '../../shell/apps.js';
import { COLORS, MODES, setColor, setMode, uploadWallpaper, useWallpaper, clearWallpaper, wallpaperUrl } from '../../shell/style.js';

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
        h('p', { class: 'set-desc' }, '每種檔案要用哪個程式開啟。'),
        list);
    },
  },
  {
    id: 'style',
    label: '樣式',
    // Unlike the other categories, changes here take effect and are saved at
    // once (a wallpaper is a file on the host, not just a value).
    render(draft) {
      const fail = (what) => (err) => toast(`${what}：${errText(err)}`, true);
      const modes = h('div', { class: 'mode-seg', role: 'group', 'aria-label': '外觀' }, MODES.map(([id, label]) =>
        h('button', {
          type: 'button',
          class: draft.style.mode === id ? 'current' : '',
          'data-mode': id,
          'aria-pressed': String(draft.style.mode === id),
          onclick: () => setMode(id).catch(fail('無法儲存外觀')),
        }, label)));
      const colours = h('div', { class: 'tint-grid' }, COLORS.map((c) =>
        h('button', {
          type: 'button',
          class: 'tint' + (draft.style.color === c.id ? ' current' : ''),
          'data-tint': c.id,
          'aria-pressed': String(draft.style.color === c.id),
          onclick: () => setColor(c.id).catch(fail('無法儲存顏色')),
        },
        h('span', { class: 'chip', style: `background:${c.color || '#0a64d6'};border-color:${c.shade || '#0a4ea8'}` }),
        c.label)));

      const picker = h('input', { type: 'file', accept: 'image/*', id: 'wp-file', hidden: true });
      const upload = h('button', { type: 'button', id: 'wp-upload', onclick: () => picker.click() }, '上傳壁紙…');
      picker.addEventListener('change', async () => {
        const file = picker.files[0];
        picker.value = '';
        if (!file) return;
        upload.disabled = true;
        upload.textContent = '上傳中…';
        try {
          await uploadWallpaper(file);
        } catch (err) {
          fail('無法上傳壁紙')(err);
          upload.disabled = false;
          upload.textContent = '上傳壁紙…';
        }
      });
      // One row per wallpaper, newest first.
      const uploadedAt = (name) => fmtTime(Number(/^wp-(\d+)/.exec(name)?.[1]) / 1000) || name;
      const thumbs = draft.style.wallpapers.length
        ? h('div', { class: 'wp-list' }, draft.style.wallpapers.map((name) => {
          const using = draft.style.wallpaper === name;
          const pic = h('span', { class: 'wp-pic' });
          wallpaperUrl(name).then((url) => {
            pic.style.backgroundImage = `url("${url}")`;
          }, () => {
            pic.textContent = '檔案不見了';
          });
          return h('div', { class: 'wp' + (using ? ' current' : ''), 'data-name': name },
            pic,
            h('span', { class: 'wp-info' }, h('b', null, using ? '使用中' : '之前的壁紙'), h('small', null, `上傳於 ${uploadedAt(name)}`)),
            h('button', { type: 'button', class: 'wp-use', disabled: using, title: '改用這張，它會排到最前面', onclick: () => useWallpaper(name).catch(fail('無法切換壁紙')) }, using ? '使用中' : '使用'));
        }))
        : h('p', { class: 'wp-empty' }, '還沒有上傳過壁紙。');
      return h('div', null,
        h('h2', null, '樣式'),
        h('p', { class: 'set-desc' }, '變更會立即套用。'),
        h('h3', null, '外觀'),
        modes,
        h('h3', null, '顏色'),
        colours,
        h('h3', null, '壁紙'),
        h('p', { class: 'set-desc' }, '最多保留 5 張。'),
        thumbs,
        h('div', { class: 'wp-actions' }, picker, upload,
          h('button', { type: 'button', id: 'wp-none', disabled: !draft.style.wallpaper, onclick: () => clearWallpaper().catch(fail('無法儲存')) }, '不使用壁紙')));
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
      h('span', { class: 'set-fill' }), status, saveBtn));

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
    if (saving) return;
    if (JSON.stringify(draft) !== saved) {
      // Unsaved edits in another category: keep them, but 樣式 saves on its
      // own, so take its new values into both the draft and the baseline.
      draft.style = next.style;
      saved = JSON.stringify({ ...JSON.parse(saved), style: next.style });
      if (active.id === 'style') show(active);
      return;
    }
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
