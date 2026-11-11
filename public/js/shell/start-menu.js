// Start menu: tools (from the app registry) and the signed-in user with logout.
import { $, h } from '../core/dom.js';
import { conn } from '../core/rpc.js';
import { on } from '../core/events.js';
import { listApps, launchApp } from './apps.js';
import { logout } from './desktop.js';

const startBtn = $('#start-btn');
const startMenu = $('#start-menu');

function closeStart() {
  if (startMenu.hidden) return;
  startMenu.hidden = true;
  startBtn.classList.remove('open');
  startBtn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
function onOutside(ev) {
  if (!startMenu.contains(ev.target) && !startBtn.contains(ev.target)) closeStart();
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
  startMenu.hidden = false;
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

// Call once, after every app module has registered itself.
export function initStartMenu() {
  $('#sm-apps').replaceChildren(...listApps().filter((app) => app.startMenu).map((app) =>
    h('button', {
      type: 'button',
      id: 'sm-' + app.id,
      role: 'menuitem',
      onclick: () => {
        closeStart();
        launchApp(app.id);
      },
    }, h('span', { class: 'sm-ico', html: app.icon() }), app.name)));
}

startBtn.addEventListener('click', () => (startMenu.hidden ? openStart() : closeStart()));
$('#sm-user').addEventListener('click', () => {
  const row = $('#sm-logout-row');
  row.hidden = !row.hidden;
  $('#sm-user').setAttribute('aria-expanded', String(!row.hidden));
  if (!row.hidden) $('#disconnect').focus();
});
$('#disconnect').addEventListener('click', () => {
  closeStart();
  logout();
});
on('session:start', showUser);
on('session:resume', showUser);
on('session:end', closeStart);
