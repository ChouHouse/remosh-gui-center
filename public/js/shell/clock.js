// Taskbar clock.
import { $ } from '../core/dom.js';

function tickClock() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if ($('#clock-time').textContent !== time) {
    $('#clock-time').textContent = time;
    $('#clock-date').textContent = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
    $('#clock').title = d.toLocaleDateString('zh-Hant', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }
}
tickClock();
setInterval(tickClock, 1000);
