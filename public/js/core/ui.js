// Toasts and modal dialogs.
import { $, h } from './dom.js';

export function toast(text, isError) {
  const el = h('div', { class: 'toast' + (isError ? ' err' : '') }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 4000);
}

// buttons: [{ label, value, default, cancel, danger }]. With `input` (initial
// text) the dialog shows a text field and resolves to { value, text }.
export function dialog({ title, message, buttons, input }) {
  return new Promise((resolve) => {
    const field = input == null ? null : h('input', { type: 'text', value: input, spellcheck: 'false', autocapitalize: 'off' });
    const done = (value) => {
      modal.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(field ? { value, text: field.value } : value);
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        done(buttons.find((b) => b.cancel)?.value ?? null);
      } else if (ev.key === 'Enter' && ev.target === field) {
        ev.preventDefault();
        ev.stopPropagation();
        done(buttons.find((b) => b.default)?.value ?? null);
      }
    };
    const btns = buttons.map((b) =>
      h('button', { type: 'button', class: [b.default && 'default', b.danger && 'danger'].filter(Boolean).join(' '), onclick: () => done(b.value) }, b.label),
    );
    const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'box' }, h('h2', null, title), h('p', null, message), field, h('div', { class: 'btns' }, btns)));
    document.body.append(modal);
    document.addEventListener('keydown', onKey, true);
    if (field) {
      field.focus();
      // Preselect just the file name so typing replaces it and keeps the folder.
      field.setSelectionRange(field.value.lastIndexOf('/') + 1, field.value.length);
    } else (btns[buttons.findIndex((b) => b.default)] || btns[0]).focus();
  });
}
