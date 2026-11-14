// Taskbar clock; clicking it opens a month calendar.
import { $, h } from '../core/dom.js';
import { on } from '../core/events.js';
import { tt, tm } from '../core/i18n.js';

const clock = $('#clock');
const p = (x) => String(x).padStart(2, '0');

function tickClock() {
  const d = new Date();
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if ($('#clock-time').textContent !== time) {
    $('#clock-time').textContent = time;
    $('#clock-date').textContent = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
    clock.title = d.toLocaleDateString('zh-Hant', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
}
tickClock();
setInterval(tickClock, 1000);

// ---- calendar
const panel = h('div', { id: 'calendar', role: 'dialog', 'aria-label': tm('日曆'), 'data-i18n-aria-label': tm('日曆'), hidden: true });
$('#desktop').append(panel);
let shown = null; // first day of the month on display

function render() {
  const today = new Date();
  const year = shown.getFullYear();
  const month = shown.getMonth();
  const first = new Date(year, month, 1 - new Date(year, month, 1).getDay()); // the Sunday on or before the 1st
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    const isToday = d.toDateString() === today.toDateString();
    days.push(h('span', {
      class: 'day' + (d.getMonth() === month ? '' : ' other') + (isToday ? ' today' : ''),
      'aria-current': isToday ? 'date' : null,
    }, d.getDate()));
  }
  const go = (delta) => () => {
    shown = new Date(year, month + delta, 1);
    render();
  };
  panel.replaceChildren(
    h('div', { class: 'cal-head' },
      h('button', { type: 'button', class: 'cal-nav', 'aria-label': tt('上個月'), onclick: go(-1) }, '‹'),
      h('b', { id: 'cal-title' }, tt('{0} 年 {1} 月', year, month + 1)),
      h('button', { type: 'button', class: 'cal-nav', 'aria-label': tt('下個月'), onclick: go(1) }, '›')),
    h('div', { class: 'cal-grid' }, [tt('日'), tt('一'), tt('二'), tt('三'), tt('四'), tt('五'), tt('六')].map((w) => h('span', { class: 'wd' }, w)), days),
    h('button', { type: 'button', id: 'cal-today', onclick: () => {
      shown = new Date(today.getFullYear(), today.getMonth(), 1);
      render();
    } }, tt('今天：{0}/{1}/{2}', today.getFullYear(), p(today.getMonth() + 1), p(today.getDate()))));
}

function close() {
  if (panel.hidden) return;
  panel.hidden = true;
  clock.setAttribute('aria-expanded', 'false');
  document.documentElement.classList.remove('cal-open');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}
function onOutside(ev) {
  if (!panel.contains(ev.target) && !clock.contains(ev.target)) close();
}
function onKey(ev) {
  if (ev.key !== 'Escape') return;
  ev.preventDefault();
  ev.stopPropagation();
  close();
}
function open() {
  const now = new Date();
  shown = new Date(now.getFullYear(), now.getMonth(), 1);
  render();
  panel.hidden = false;
  clock.setAttribute('aria-expanded', 'true');
  document.documentElement.classList.add('cal-open'); // keeps an auto-hiding taskbar up
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}
clock.setAttribute('role', 'button');
clock.setAttribute('tabindex', '0');
clock.setAttribute('aria-haspopup', 'dialog');
clock.setAttribute('aria-expanded', 'false');
clock.addEventListener('click', () => (panel.hidden ? open() : close()));
clock.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    clock.click();
  }
});
on('session:end', close);
