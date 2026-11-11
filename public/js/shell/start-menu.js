// Start menu: tools (from the app registry) and the signed-in user with logout.
import { $, h } from '../core/dom.js';
import { conn } from '../core/rpc.js';
import { on } from '../core/events.js';
import { animationMs } from '../core/settings.js';
import { listApps, launchApp } from './apps.js';
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
  isOpen = true;
  clearTimeout(hideTimer);
  startMenu.inert = false;
  startMenu.hidden = false;
  void startMenu.offsetWidth; // start from the closed style so the transition runs
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

startBtn.addEventListener('click', () => (isOpen ? closeStart() : openStart()));
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
