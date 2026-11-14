// Procoder's language list: a small pop-up over the status bar to say what
// language a file is really written in, whatever its name ends with.
import { h } from '../../core/dom.js';

export const langName = (monaco, id) =>
  (id === 'plaintext' ? '純文字' : monaco.languages.getLanguages().find((l) => l.id === id)?.aliases?.[0] || id);

// Resolves to a language id, 'auto' (go by the file name again) or null (closed).
// autoId: what "auto" would pick, shown next to that choice.
export function pickLanguage(monaco, anchor, currentId, autoId) {
  return new Promise((resolve) => {
    const all = monaco.languages.getLanguages()
      .map((l) => ({ id: l.id, name: langName(monaco, l.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const input = h('input', { type: 'text', placeholder: '搜尋語言…', spellcheck: 'false', autocapitalize: 'off', 'aria-label': '搜尋語言' });
    const list = h('div', { class: 'pc-lang-list', role: 'listbox' });
    const box = h('div', { class: 'pc-lang', role: 'dialog', 'aria-label': '選擇語言' }, input, list);
    let rows = [];
    let at = 0;

    function done(value) {
      box.remove();
      document.removeEventListener('pointerdown', onOutside, true);
      resolve(value);
    }
    const onOutside = (ev) => {
      if (!box.contains(ev.target)) done(null);
    };
    function mark() {
      rows.forEach((row, i) => row.classList.toggle('at', i === at));
      rows[at]?.scrollIntoView({ block: 'nearest' });
    }
    function render() {
      const q = input.value.trim().toLowerCase();
      const items = [
        ...(q ? [] : [{ id: 'auto', name: '自動偵測', note: `依檔名：${langName(monaco, autoId)}` }]),
        ...all.filter((l) => !q || l.name.toLowerCase().includes(q) || l.id.includes(q)),
      ];
      rows = items.map((item) => h('button', {
        type: 'button', role: 'option', 'data-lang': item.id, class: item.id === currentId ? 'on' : '',
        onclick: () => done(item.id),
      }, h('span', null, item.name), h('span', { class: 'pc-lang-id' }, item.note || item.id)));
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'pc-lang-none' }, '找不到這個語言')]));
      at = Math.max(0, q ? 0 : items.findIndex((i) => i.id === currentId));
      mark();
    }
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') done(null);
      else if (ev.key === 'Enter') rows[at]?.click();
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        at = Math.max(0, Math.min(rows.length - 1, at + (ev.key === 'ArrowDown' ? 1 : -1)));
        mark();
      } else return;
      ev.preventDefault();
      ev.stopPropagation();
    });
    input.addEventListener('input', render);

    box.dataset.pcTheme = anchor.closest('[data-pc-theme]')?.dataset.pcTheme || ''; // dressed like its window
    document.body.append(box);
    const r = anchor.getBoundingClientRect();
    box.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    box.style.bottom = window.innerHeight - r.top + 6 + 'px';
    document.addEventListener('pointerdown', onOutside, true);
    render();
    input.focus();
  });
}
