// Drag and drop between apps. One API for everything that can be dragged:
//
//   makeDraggable(element, (ev) => payload | null)
//     payload = { type, name, icon, data }
//       type  'file' (data: { path, isDir, size }) or 'app' (data: { id }); apps may add their own
//       name  text shown on the card that follows the pointer
//       icon  SVG markup shown next to it
//     The callback gets the pointerdown event, so one listener on a list can
//     serve all its items (return null when the press is not on an item).
//
//   registerDropTarget(element, {
//     accepts(payload) -> boolean,
//     action?(payload, { ctrlKey, altKey }) -> label shown on the card ('移動', '複製', ...),
//     onDrop(payload, { ctrlKey, altKey, clientX, clientY, target }),
//   })
//
// The innermost registered target under the pointer that accepts the payload
// wins. Esc cancels. Returns a function that unregisters.
import { h } from '../core/dom.js';

const targets = new Map(); // element -> spec
const THRESHOLD = 5; // px the pointer must travel before a press becomes a drag

export function registerDropTarget(element, spec) {
  targets.set(element, spec);
  return () => targets.delete(element);
}

function targetAt(x, y, payload) {
  for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
    const spec = targets.get(el);
    if (spec && spec.accepts(payload)) return { el, spec };
  }
  return null;
}

export function makeDraggable(element, getPayload) {
  element.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    const payload = getPayload(down);
    if (!payload) return;
    let ghost = null;
    let over = null;
    let last = down;
    const mods = { ctrlKey: down.ctrlKey || down.metaKey, altKey: down.altKey };

    const update = () => {
      const hit = targetAt(last.clientX, last.clientY, payload);
      if (over?.el !== hit?.el) {
        over?.el.classList.remove('drop-over');
        hit?.el.classList.add('drop-over');
        over = hit;
      }
      ghost.style.left = last.clientX + 14 + 'px';
      ghost.style.top = last.clientY + 12 + 'px';
      ghost.classList.toggle('no-drop', !over);
      ghost.querySelector('.act').textContent = over?.spec.action?.(payload, mods) || '';
    };
    const start = () => {
      ghost = h('div', { class: 'drag-ghost', role: 'presentation' },
        h('span', { class: 'ico', html: payload.icon }), h('span', { class: 'nm' }, payload.name), h('span', { class: 'act' }));
      document.body.append(ghost);
      document.body.classList.add('dragging-item');
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('keyup', onKey, true);
    };
    const move = (ev) => {
      last = ev;
      if (!ghost) {
        if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < THRESHOLD) return;
        start();
      }
      mods.ctrlKey = ev.ctrlKey || ev.metaKey;
      mods.altKey = ev.altKey;
      update();
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        return finish(false);
      }
      mods.ctrlKey = ev.ctrlKey || ev.metaKey;
      mods.altKey = ev.altKey;
      if (ev.key === 'Alt') ev.preventDefault(); // keep the browser menu from taking focus
      update();
    };
    const finish = (drop) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (!ghost) return; // it was a plain click
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKey, true);
      document.body.classList.remove('dragging-item');
      over?.el.classList.remove('drop-over');
      ghost.remove();
      // The press ended a drag, not a click: swallow the click that follows.
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      if (drop && over) {
        over.spec.onDrop(payload, { ...mods, clientX: last.clientX, clientY: last.clientY, target: document.elementFromPoint(last.clientX, last.clientY) });
      }
    };
    const up = (ev) => {
      last = ev;
      finish(true);
    };
    const cancel = () => finish(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });
}
