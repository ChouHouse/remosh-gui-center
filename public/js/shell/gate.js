// Access-password screen (server env WEB_PASSWORD). Shown before the SSH login
// when the server requires it; the server enforces it on /ws with a cookie.
import { $ } from '../core/dom.js';
import { tt } from '../core/i18n.js';

const gateEl = $('#gate');
const form = $('#gate-form');
const pass = $('#gate-pass');
const error = $('#gate-error');
const btn = $('#gate-btn');

async function status() {
  try {
    const res = await fetch('/api/gate', { cache: 'no-store' });
    if (!res.ok) return { required: false, ok: true }; // older server without a gate
    return await res.json();
  } catch {
    return { required: false, ok: true }; // unreachable: let the login report it
  }
}

function ask() {
  return new Promise((resolve) => {
    gateEl.hidden = false;
    error.hidden = true;
    pass.value = '';
    pass.focus();
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      btn.disabled = true;
      error.hidden = true;
      try {
        const res = await fetch('/api/gate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pass.value }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.ok) {
          gateEl.hidden = true;
          pass.value = '';
          form.onsubmit = null;
          return resolve();
        }
        error.textContent = body.locked ? tt('嘗試太多次，請 {0} 秒後再試', body.locked) : tt('存取密碼不正確');
      } catch {
        error.textContent = tt('無法連上伺服器');
      } finally {
        btn.disabled = false;
      }
      error.hidden = false;
      pass.select();
    };
  });
}

// Resolves once the visitor may use the site (immediately when no password is set).
export async function ensureGate() {
  const s = await status();
  if (s.required && !s.ok) await ask();
}
