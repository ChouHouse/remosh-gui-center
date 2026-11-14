// 設定: categories on the left, their options on the right. 儲存 writes
// ~/.remosh-gui/setting.inv-remosh_gui-config on the SSH host (see core/settings.js).
//
// To add a category, push another entry to CATEGORIES: { id, label, render }.
// render(draft, changed) returns the pane's element; it edits `draft` in place
// and calls changed() after every edit.
import './i18n.js'; // this app's texts in the other languages
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { toast, dialog } from '../../core/ui.js';
import { rpc } from '../../core/rpc.js';
import { settingsSvg } from './icon.js';
import { on } from '../../core/events.js';
import { getSettings, saveSettings, updateSettings } from '../../core/settings.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, getApp, appsForExt, useAppStyle } from '../../shell/apps.js';
import { setTaskbar } from '../../shell/taskbar.js';
import { COLORS, systemColor, MODES, setColor, setMode, setControls, uploadWallpaper, useWallpaper, clearWallpaper, wallpaperUrl } from '../../shell/style.js';
import { tt, tm, LANGS } from '../../core/i18n.js';

useAppStyle(import.meta.url);

const row = (title, desc, control) =>
  h('div', { class: 'set-row' }, h('div', { class: 'set-text' }, h('b', null, title), h('small', null, desc)), control);

// A row of mutually exclusive buttons. onPick(key) returns a promise.
const segmented = (id, label, options, value, onPick) =>
  h('div', { class: 'mode-seg', id, role: 'group', 'aria-label': label }, options.map(([key, text]) =>
    h('button', {
      type: 'button',
      class: value === key ? 'current' : '',
      'data-value': String(key),
      'aria-pressed': String(value === key),
      onclick: () => onPick(key).catch((err) => toast(tt('無法儲存：{0}', errText(err)), true)),
    }, tt(text))));

// Categories whose changes apply and save at once (the others wait for 儲存).
const LIVE = ['system', 'style', 'taskbar'];

const CATEGORIES = [
  {
    id: 'system',
    label: tm('系統'),
    render(draft) {
      const lang = h('select', { id: 'set-lang', 'aria-label': tt('語言') },
        [['auto', tt('跟隨瀏覽器')], ...LANGS.map((l) => [l.id, l.name])].map(([value, label]) =>
          h('option', { value, selected: draft.system.lang === value }, label)));
      lang.addEventListener('change', () => {
        updateSettings((s) => {
          s.system.lang = lang.value;
        }).catch((err) => toast(tt('無法儲存：{0}', errText(err)), true));
      });
      return h('div', null,
        h('h2', null, tt('系統')),
        row(tt('語言'), tt('介面使用的語言。已經開著的視窗要重新開啟才會換過去'), lang));
    },
  },
  {
    id: 'animation',
    label: tm('動畫'),
    render(draft, changed) {
      const speed = h('select', { id: 'set-anim-speed', 'aria-label': tt('動畫速度') },
        [['fast', tt('快')], ['normal', tt('一般')], ['slow', tt('慢')]].map(([value, label]) =>
          h('option', { value, selected: draft.animation.speed === value }, label)));
      const enabled = h('input', { type: 'checkbox', id: 'set-anim-enabled', class: 'switch', role: 'switch', 'aria-label': tt('啟用動畫'), checked: draft.animation.enabled });
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
        h('h2', null, tt('動畫')),
        row(tt('啟用動畫'), tt('視窗放大、還原，以及介面元件的過渡效果'), enabled),
        row(tt('速度'), tt('過渡效果播放的快慢'), speed));
    },
  },
  {
    id: 'associations',
    label: tm('檔案關聯'),
    render(draft, changed) {
      const table = draft.files.associations;
      const list = h('div', { class: 'assoc-list' });
      const appSelect = (ext, current) => {
        const options = appsForExt(ext);
        const stale = current && !options.some((a) => a.id === current); // app gone or no longer accepts it
        return h('select', { 'aria-label': tt('開啟程式') },
          stale && h('option', { value: current, selected: true }, tt('{0}（不適用）', getApp(current)?.name || current)),
          options.map((a) => h('option', { value: a.id, selected: a.id === current }, tt(a.name))));
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
              h('code', null, ext ? '.' + ext : tt('（無副檔名）')), select,
              h('button', { type: 'button', class: 'assoc-del', title: tt('移除這個關聯'), onclick: () => {
                delete table[ext];
                draw();
                changed();
              } }, tt('移除')));
          })
          : [h('p', { class: 'assoc-empty' }, tt('還沒有任何關聯。'))]));
      };
      draw();
      return h('div', null,
        h('h2', null, tt('檔案關聯')),
        h('p', { class: 'set-desc' }, tt('每種檔案要用哪個程式開啟。')),
        list);
    },
  },
  {
    id: 'style',
    label: tm('樣式'),
    // Unlike the other categories, changes here take effect and are saved at
    // once (a wallpaper is a file on the host, not just a value).
    render(draft) {
      const fail = (what) => (err) => toast(`${what}：${errText(err)}`, true);
      const modes = segmented('set-mode', tt('模式'), MODES, draft.style.mode, setMode);
      const controls = segmented('set-controls', tt('視窗按鈕'), [['left', tt('左上')], ['right', tt('右上')]], draft.style.controls, setControls);
      const now = systemColor();
      const colourPick = h('select', { id: 'set-color', 'aria-label': tt('顏色') },
        COLORS.map((c) => h('option', { value: c.id, selected: c.id === now.id }, tt(c.label))));
      colourPick.addEventListener('change', () => setColor(colourPick.value).catch(fail(tt('無法儲存顏色'))));
      const colours = h('div', { class: 'look-row colour-row' },
        h('span', { class: 'chip', style: `background:${now.color || 'var(--accent)'}` }), colourPick);

      const picker = h('input', { type: 'file', accept: 'image/*', id: 'wp-file', hidden: true });
      const upload = h('button', { type: 'button', id: 'wp-upload', onclick: () => picker.click() }, tt('上傳壁紙…'));
      picker.addEventListener('change', async () => {
        const file = picker.files[0];
        picker.value = '';
        if (!file) return;
        upload.disabled = true;
        upload.textContent = tt('上傳中…');
        try {
          await uploadWallpaper(file);
        } catch (err) {
          fail(tt('無法上傳壁紙'))(err);
          upload.disabled = false;
          upload.textContent = tt('上傳壁紙…');
        }
      });
      // Thumbnails side by side, newest first; click one to use it.
      const thumbs = h('div', { class: 'wp-list' }, draft.style.wallpapers.map((name) => {
        const using = draft.style.wallpaper === name;
        const b = h('button', {
          type: 'button',
          class: 'wp' + (using ? ' current' : ''),
          'data-name': name,
          'aria-label': using ? tt('使用中的壁紙') : tt('改用這張壁紙'),
          'aria-pressed': String(using),
          onclick: () => useWallpaper(name).catch(fail(tt('無法切換壁紙'))),
        });
        wallpaperUrl(name).then((url) => {
          b.style.backgroundImage = `url("${url}")`;
        }, () => b.classList.add('missing'));
        return b;
      }));
      return h('div', null,
        h('h2', null, tt('樣式')),
        h('p', { class: 'set-desc' }, tt('變更會立即套用。')),
        h('h3', null, tt('外觀')),
        h('div', { class: 'look-row' }, h('span', null, tt('模式')), modes),
        h('div', { class: 'look-row' }, h('span', null, tt('視窗按鈕')), controls),
        h('h3', null, tt('顏色')),
        colours,
        h('h3', null, tt('壁紙')),
        thumbs,
        h('div', { class: 'wp-actions' }, picker, upload,
          h('button', { type: 'button', id: 'wp-none', disabled: !draft.style.wallpaper, onclick: () => clearWallpaper().catch(fail(tt('無法儲存'))) }, tt('不使用壁紙'))));
    },
  },
  {
    id: 'taskbar',
    label: tm('工作列'),
    render(draft) {
      const t = draft.taskbar;
      const autoHide = h('input', { type: 'checkbox', id: 'tb-autohide', class: 'switch', role: 'switch', 'aria-label': tt('自動隱藏'), checked: t.autoHide });
      autoHide.addEventListener('change', () => setTaskbar({ autoHide: autoHide.checked }).catch((err) => toast(tt('無法儲存：{0}', errText(err)), true)));
      return h('div', null,
        h('h2', null, tt('工作列')),
        h('p', { class: 'set-desc' }, tt('變更會立即套用。')),
        row(tt('自動隱藏'), tt('滑鼠移到畫面底部才出現'), autoHide),
        row(tt('大小'), '', segmented('tb-size', tt('大小'), [['small', tt('小')], ['medium', tt('中')], ['large', tt('大')]], t.size, (size) => setTaskbar({ size }))),
        row(tt('項目顯示'), '', segmented('tb-labels', tt('項目顯示'), [[true, tt('圖示與文字')], [false, tt('只顯示圖示')]], t.labels, (labels) => setTaskbar({ labels }))),
        row(tt('樣式'), '', segmented('tb-float', tt('樣式'), [[false, tt('貼齊底部')], [true, tt('懸浮')]], t.float, (float) => setTaskbar({ float }))),
        row(tt('對齊'), '', segmented('tb-align', tt('對齊'), [['left', tt('靠左')], ['center', tt('置中')]], t.align, (align) => setTaskbar({ align }))),
        row(tt('合併視窗'), tt('同一個應用程式的視窗合成一個項目'), segmented('tb-group', tt('合併視窗'), [[false, tt('不合併')], [true, tt('合併')]], t.group, (group) => setTaskbar({ group }))),
        row(tt('工作區按鈕'), tt('也可以連按兩下 Tab 叫出工作區'), segmented('tb-ws', tt('工作區按鈕'), [[true, tt('顯示')], [false, tt('隱藏')]], t.workspaces, (workspaces) => setTaskbar({ workspaces }))),
        row(tt('時間'), '', segmented('tb-clock', tt('時間'), [[true, tt('顯示')], [false, tt('隱藏')]], t.clock, (clock) => setTaskbar({ clock }))));
    },
  },
  {
    id: 'account',
    label: tm('帳號'),
    render() {
      const box = h('div', null, h('h2', null, tt('帳號')), h('p', { class: 'set-desc' }, tt('讀取中…')));
      const field = (id, label, type = 'password') => {
        const input = h('input', { id, type, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
        return { input, el: h('label', { class: 'acc-field' }, h('span', null, label), input) };
      };
      const fill = (info) => {
        const isRoot = info.sudo === 'root';
        // -- change my password
        const old = field('acc-old', tt('目前的密碼'));
        const next = field('acc-new', tt('新密碼'));
        const again = field('acc-new2', tt('再輸入一次新密碼'));
        const change = h('button', { type: 'button', id: 'acc-change', class: 'set-save' }, tt('變更密碼'));
        change.addEventListener('click', async () => {
          if (!next.input.value) return toast(tt('請輸入新密碼'), true);
          if (next.input.value !== again.input.value) return toast(tt('兩次輸入的新密碼不一樣'), true);
          change.disabled = true;
          try {
            await rpc('changePassword', { oldPassword: old.input.value, newPassword: next.input.value });
            for (const f of [old, next, again]) f.input.value = '';
            toast(tt('密碼已變更'));
          } catch (err) {
            toast(errText(err), true);
          } finally {
            change.disabled = false;
          }
        });
        // -- create a user (root, or through sudo)
        const parts = [
          h('h2', null, tt('帳號')),
          h('div', { class: 'acc-me' }, h('span', { class: 'avatar' }, [...info.user][0]), h('span', null, h('b', { id: 'acc-user' }, info.user), h('small', null, `UID ${info.uid}`))),
          h('h3', null, tt('變更密碼')),
          h('div', { class: 'acc-form' }, !isRoot && old.el, next.el, again.el, change),
        ];
        if (info.sudo !== 'none') {
          const name = field('acc-name', tt('帳號名稱'), 'text');
          const pass = field('acc-pass', tt('密碼'));
          const pass2 = field('acc-pass2', tt('再輸入一次密碼'));
          const sudoPw = field('acc-sudo', tt('你的密碼（sudo 驗證用）'));
          const create = h('button', { type: 'button', id: 'acc-create', class: 'set-save' }, tt('建立帳號'));
          const users = h('div', { id: 'acc-users', class: 'acc-users' });
          const listUsers = (list) => users.replaceChildren(...list.map((u) => h('span', { class: 'acc-user', title: u.home }, u.name)));
          listUsers(info.users);
          create.addEventListener('click', async () => {
            const username = name.input.value.trim();
            if (!username) return toast(tt('請輸入帳號名稱'), true);
            if (!pass.input.value) return toast(tt('請輸入密碼'), true);
            if (pass.input.value !== pass2.input.value) return toast(tt('兩次輸入的密碼不一樣'), true);
            const ok = await dialog({
              title: tt('要建立帳號「{0}」嗎？', username),
              message: tt('會在這台主機上新增一個可以登入的使用者，並建立它的家目錄。'),
              buttons: [{ label: tt('取消'), value: false, cancel: true }, { label: tt('建立'), value: true, default: true }],
            });
            if (!ok) return;
            create.disabled = true;
            try {
              await rpc('createUser', { username, password: pass.input.value, sudoPassword: sudoPw.input.value });
              for (const f of [name, pass, pass2, sudoPw]) f.input.value = '';
              toast(tt('已建立帳號「{0}」', username));
              listUsers((await rpc('accountInfo')).users);
            } catch (err) {
              toast(tt('無法建立帳號：{0}', errText(err)), true);
            } finally {
              create.disabled = false;
            }
          });
          parts.push(h('h3', null, tt('建立帳號')),
            h('div', { class: 'acc-form' }, name.el, pass.el, pass2.el, info.sudo === 'password' && sudoPw.el, create),
            h('h3', null, tt('這台主機上的帳號')), users);
        }
        box.replaceChildren(...parts.filter(Boolean));
      };
      rpc('accountInfo').then(fill, (err) => box.replaceChildren(h('h2', null, tt('帳號')), h('p', { class: 'set-desc' }, tt('無法讀取帳號資訊：{0}', errText(err)))));
      return box;
    },
  },
];

let win = null;

let showCategory = null;

// args.category opens on that page (e.g. 'taskbar').
function openSettings(args) {
  if (win) {
    win.focus();
    if (args?.category) showCategory(args.category);
    return;
  }
  win = createWindow({ title: tt('設定'), appName: tm('設定'), iconHtml: settingsSvg(), width: 660, height: 440 });
  const draft = getSettings();
  let saved = JSON.stringify(draft);
  let saving = false;
  let active = CATEGORIES[0];

  const nav = h('nav', { class: 'set-nav', 'aria-label': tt('設定分類') });
  const pane = h('section', { class: 'set-pane' });
  const status = h('span', { class: 'set-status' });
  const saveBtn = h('button', { type: 'button', class: 'set-save', id: 'set-save' }, tt('儲存'));
  win.body.append(
    h('div', { class: 'set-main' }, nav, pane),
    h('div', { class: 'set-foot' },
      h('span', { class: 'set-fill' }), status, saveBtn));

  const refresh = () => {
    const dirty = JSON.stringify(draft) !== saved;
    saveBtn.disabled = !dirty || saving;
    saveBtn.textContent = saving ? tt('儲存中…') : tt('儲存');
    if (dirty) status.textContent = tt('有未儲存的變更');
    else if (status.textContent === tt('有未儲存的變更')) status.textContent = '';
  };
  const show = (cat) => {
    active = cat;
    nav.replaceChildren(...CATEGORIES.map((c) =>
      h('button', { type: 'button', class: c === active ? 'current' : '', 'aria-current': c === active ? 'page' : null, onclick: () => show(c) }, tt(c.label))));
    pane.replaceChildren(cat.render(draft, refresh));
  };
  saveBtn.addEventListener('click', async () => {
    saving = true;
    refresh();
    try {
      await saveSettings(draft);
      saved = JSON.stringify(draft); // keep the same draft object: the controls edit it in place
      status.textContent = tt('已儲存');
    } catch (err) {
      toast(tt('無法儲存設定：{0}', errText(err)), true);
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
      // Unsaved edits in another category: keep them, but the live categories
      // save on their own, so take their new values into both the draft and the baseline.
      const base = JSON.parse(saved);
      for (const key of LIVE) {
        draft[key] = next[key];
        base[key] = next[key];
      }
      saved = JSON.stringify(base);
      if (LIVE.includes(active.id)) show(active);
      return;
    }
    Object.assign(draft, next);
    saved = JSON.stringify(draft);
    show(active);
  });
  win.destroy = () => {
    off();
    win = null;
    showCategory = null;
  };
  showCategory = (id) => {
    const cat = CATEGORIES.find((c) => c.id === id);
    if (cat && cat !== active) show(cat);
  };
  show(CATEGORIES.find((c) => c.id === args?.category) || active);
  refresh();
}

registerApp({ id: 'settings', order: 900, name: tm('設定'), icon: settingsSvg, startMenu: true, launch: openSettings });
