// Drop-down menu bar for an app window.
//
// menus: [{ label, items: [item | null] }]  (null = separator)
// item:  { label: string | () => string, key?, enabled?: () => bool,
//          checked?: () => bool, run: () => void }
// onClose runs after a menu closes by choice or Escape (e.g. refocus the editor).
import { h } from '../core/dom.js';

export function attachMenuBar(menubar, menus, onClose) {
  let openState = null; // { menu, el, btn }
  const closeMenu = (refocus) => {
    if (!openState) return;
    openState.el.remove();
    openState.btn.classList.remove('open');
    openState.btn.setAttribute('aria-expanded', 'false');
    openState = null;
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) onClose?.();
  };
  const onOutside = (ev) => {
    if (!menubar.contains(ev.target)) closeMenu(false);
  };
  const openMenu = (menu) => {
    closeMenu(false);
    const buttons = [];
    const el = h('div', { class: 'menu', role: 'menu', 'aria-label': menu.label }, menu.items.map((item) => {
      if (!item) return h('div', { class: 'menu-sep', role: 'separator' });
      const checkable = !!item.checked;
      const on = checkable && item.checked();
      const b = h('button', {
        type: 'button',
        role: checkable ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': checkable ? String(on) : null,
        disabled: item.enabled && !item.enabled(),
        onclick: () => {
          closeMenu(true);
          item.run();
        },
      }, h('span', { class: 'tick' }, on ? '✓' : ''), h('span', { class: 'lbl' }, typeof item.label === 'function' ? item.label() : item.label), h('span', { class: 'key' }, item.key || ''));
      buttons.push(b);
      return b;
    }));
    el.addEventListener('keydown', (ev) => {
      const live = buttons.filter((b) => !b.disabled);
      const at = live.indexOf(document.activeElement);
      const side = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (ev.key === 'Escape') closeMenu(true);
      else if (ev.key === 'ArrowDown') live[(at + 1) % live.length].focus();
      else if (ev.key === 'ArrowUp') live[(at - 1 + live.length) % live.length].focus();
      else if (side) openMenu(menus[(menus.indexOf(menu) + side + menus.length) % menus.length]);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    });
    el.style.left = menu.btn.offsetLeft + 'px';
    menubar.append(el);
    menu.btn.classList.add('open');
    menu.btn.setAttribute('aria-expanded', 'true');
    openState = { menu, el, btn: menu.btn };
    document.addEventListener('pointerdown', onOutside, true);
    buttons.find((b) => !b.disabled)?.focus();
  };
  for (const menu of menus) {
    menu.btn = h('button', { type: 'button', class: 'menu-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, menu.label);
    menu.btn.addEventListener('click', () => (openState?.menu === menu ? closeMenu(true) : openMenu(menu)));
    // With one menu open, moving onto the other title switches to it.
    menu.btn.addEventListener('pointerenter', () => {
      if (openState && openState.menu !== menu) openMenu(menu);
    });
    menubar.append(menu.btn);
  }
}
