// Right-click menu. items: [{ label, run, enabled?: bool, danger?: bool } | null]
// (null = separator). Opens at the pointer and stays inside the viewport.
import { h } from '../core/dom.js';

let closeCurrent = null;

export function showContextMenu(ev, items) {
  ev.preventDefault();
  closeCurrent?.();
  if (!items.some(Boolean)) return;
  const buttons = [];
  const menu = h('div', { class: 'menu ctx-menu', role: 'menu' }, items.map((item) => {
    if (!item) return h('div', { class: 'menu-sep', role: 'separator' });
    const b = h('button', {
      type: 'button',
      role: 'menuitem',
      class: item.danger ? 'danger' : '',
      disabled: item.enabled === false,
      onclick: () => {
        close();
        item.run();
      },
    }, h('span', { class: 'lbl' }, item.label));
    buttons.push(b);
    return b;
  }));
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    closeCurrent = null;
  };
  const onOutside = (e) => {
    if (!menu.contains(e.target)) close();
  };
  const onKey = (e) => {
    const live = buttons.filter((b) => !b.disabled);
    const at = live.indexOf(document.activeElement);
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') live[(at + 1) % live.length]?.focus();
    else if (e.key === 'ArrowUp') live[(at - 1 + live.length) % live.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(ev.clientX, innerWidth - width - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(ev.clientY, innerHeight - height - 4)) + 'px';
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  closeCurrent = close;
}
