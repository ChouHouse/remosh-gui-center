// Start menu: pinned apps, a view of all apps, and the signed-in user with
// full screen and logout.
import { $, h } from '../core/dom.js';
import { conn } from '../core/rpc.js';
import { on } from '../core/events.js';
import { errText } from '../core/errors.js';
import { toast } from '../core/ui.js';
import { getSettings, updateSettings, animationMs } from '../core/settings.js';
import { listApps, launchApp, getApp } from './apps.js';
import { showContextMenu } from './context-menu.js';
import { makeDraggable } from './drag.js';
import { host, otherSessions, onSessionsChange } from './sessions.js';
import { logout } from './desktop.js';

const startBtn = $('#start-btn');
const startMenu = $('#start-menu');

// Open/closed is tracked here rather than read from the element, because the
// menu stays in the page for a moment while it animates out.
let isOpen = false;
let hideTimer = 0;

function closeStart() {
  if (!isOpen) return;
  isOpen = false;
  document.documentElement.classList.remove('start-open');
  startMenu.classList.remove('open');
  startMenu.inert = true; // not clickable while it fades out
  clearTimeout(hideTimer);
  const ms = animationMs();
  if (ms) hideTimer = setTimeout(() => (startMenu.hidden = true), ms);
  else startMenu.hidden = true;
  startBtn.classList.remove('open');
  startBtn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
function onOutside(ev) {
  // Its own right-click menu is drawn outside the panel but belongs to it.
  if (!startMenu.contains(ev.target) && !startBtn.contains(ev.target) && !ev.target.closest?.('.ctx-menu')) closeStart();
}
function onKey(ev) {
  if (ev.key !== 'Escape') return;
  ev.preventDefault();
  ev.stopPropagation();
  closeStart();
  startBtn.focus();
}
function openStart() {
  $('#sm-logout-row').hidden = true;
  $('#sm-user').setAttribute('aria-expanded', 'false');
  $('#sm-home').hidden = false;
  $('#sm-all').hidden = true;
  isOpen = true;
  clearTimeout(hideTimer);
  startMenu.inert = false;
  startMenu.hidden = false;
  void startMenu.offsetWidth; // start from the closed style so the transition runs
  document.documentElement.classList.add('start-open'); // keeps an auto-hiding taskbar up
  startMenu.classList.add('open');
  startBtn.classList.add('open');
  startBtn.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  $('#sm-apps button')?.focus();
}

function showUser() {
  const { username, host, port } = conn.info;
  $('#sm-username').textContent = username;
  $('#sm-avatar').textContent = [...username][0] || '?';
  $('#conn-label').textContent = `${username}@${host}${port === 22 ? '' : ':' + port}`;
}

// ---- pinned apps and "all apps"
const pinnedIds = () => getSettings().start.pinned ?? listApps().map((app) => app.id);
const setPinned = (ids) =>
  updateSettings((s) => {
    s.start.pinned = ids;
  }, { optimistic: true }).catch((err) => toast(`無法儲存釘選：${errText(err)}`, true));
export const isPinned = (id) => pinnedIds().includes(id);
export const pinApp = (id) => (isPinned(id) ? null : setPinned([...pinnedIds(), id]));
export const unpinApp = (id) => setPinned(pinnedIds().filter((x) => x !== id));

const appButton = (app, prefix) =>
  h('button', {
    type: 'button',
    id: prefix + app.id,
    role: 'menuitem',
    'data-app-id': app.id,
    onclick: () => {
      closeStart();
      launchApp(app.id);
    },
  }, h('span', { class: 'sm-ico', html: app.icon() }), app.name);

function showView(all) {
  $('#sm-home').hidden = all;
  $('#sm-all').hidden = !all;
  (all ? $('#sm-all-list button') : $('#sm-apps button') || $('#sm-all-btn'))?.focus();
}

function renderApps() {
  const pinned = pinnedIds().map(getApp).filter(Boolean);
  $('#sm-apps').replaceChildren(...(pinned.length
    ? pinned.map((app) => appButton(app, 'sm-'))
    : [h('p', { class: 'sm-empty' }, '還沒有釘選的應用程式')]));
  $('#sm-all-list').replaceChildren(...listApps().map((app) => appButton(app, 'sma-')));
}

// Call once, after every app module has registered itself.
export function initStartMenu() {
  renderApps();
  for (const list of [$('#sm-apps'), $('#sm-all-list')]) {
    // Right-click: open, pin or unpin.
    list.addEventListener('contextmenu', (ev) => {
      const app = getApp(ev.target.closest('button[data-app-id]')?.dataset.appId);
      if (!app) return;
      showContextMenu(ev, [
        { label: '開啟', run: () => {
          closeStart();
          launchApp(app.id);
        } },
        null,
        isPinned(app.id) ? { label: '從開始取消釘選', run: () => unpinApp(app.id) } : { label: '釘選到開始', run: () => pinApp(app.id) },
      ]);
    });
    // Apps can be dragged out, e.g. onto the desktop.
    makeDraggable(list, (ev) => {
      const app = getApp(ev.target.closest('button[data-app-id]')?.dataset.appId);
      return app && { type: 'app', name: app.name, icon: app.icon(), data: { id: app.id } };
    });
  }
  $('#sm-all-btn').addEventListener('click', () => showView(true));
  $('#sm-back').addEventListener('click', () => showView(false));
}
on('settings:changed', renderApps);

startBtn.addEventListener('click', () => (isOpen ? closeStart() : openStart()));
$('#sm-user').addEventListener('click', () => {
  const row = $('#sm-logout-row');
  row.hidden = !row.hidden;
  $('#sm-user').setAttribute('aria-expanded', String(!row.hidden));
  if (!row.hidden) $('#disconnect').focus();
});
// The account card closes as soon as anything else in the menu is used.
startMenu.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('#sm-user, #sm-logout-row')) return;
  $('#sm-logout-row').hidden = true;
  $('#sm-user').setAttribute('aria-expanded', 'false');
}, true);
// Right-click the start button: the usual tools and the account actions.
startBtn.addEventListener('contextmenu', (ev) => {
  closeStart();
  showContextMenu(ev, [
    ...['tasks', 'terminal', 'settings'].map(getApp).filter(Boolean).map((app) => ({ label: app.name, run: () => launchApp(app.id) })),
    null,
    { label: '切換使用者', run: () => host.add() },
    { label: '登出', danger: true, run: () => logout() },
  ]);
});
// Other signed-in users: one click switches to them, no password needed.
function renderSessions() {
  $('#sm-sessions').replaceChildren(...otherSessions().map((s) =>
    h('button', {
      type: 'button',
      class: 'sm-session',
      role: 'menuitem',
      'data-session': s.id,
      title: `切換到 ${s.label}`,
      onclick: () => {
        closeStart();
        host.switchTo(s.id);
      },
    }, h('span', { class: 'avatar' }, [...s.label][0]), h('span', null, s.label))));
}
onSessionsChange(renderSessions);
renderSessions();
$('#sm-switch').addEventListener('click', () => {
  closeStart();
  host.add();
});
$('#disconnect').addEventListener('click', () => {
  closeStart();
  logout();
});
on('session:start', showUser);
on('session:resume', showUser);
on('session:end', closeStart);
