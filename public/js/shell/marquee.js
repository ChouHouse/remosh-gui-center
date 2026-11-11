// Rubber-band selection: press on empty space and drag out a box.
//
//   attachMarquee(container, {
//     itemSelector,                         what can be selected, e.g. '.item'
//     onChange(elements, { additive, first })   called while dragging with the items the box touches;
//   })                                      additive = Ctrl/Shift was held (add to the selection),
//                                           first = this is the first call of this drag
// The container must be positioned (relative/absolute). A plain click on empty
// space is left alone, so the owner can still clear its selection on click.
export function attachMarquee(container, { itemSelector, onChange }) {
  container.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || down.target.closest(itemSelector)) return;
    const frame = container.getBoundingClientRect();
    // Not when the press is on a scroll bar.
    if (down.clientX - frame.left > container.clientWidth || down.clientY - frame.top > container.clientHeight) return;
    const additive = down.ctrlKey || down.metaKey || down.shiftKey;
    let box = null;
    let first = true;
    const move = (ev) => {
      if (!box) {
        if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 4) return;
        box = document.createElement('div');
        box.className = 'marquee';
        container.append(box);
        document.body.classList.add('dragging');
      }
      // The owner may redraw its content mid-drag (e.g. a refresh) and drop the box with it.
      if (!box.isConnected) container.append(box);
      const r = container.getBoundingClientRect();
      const clampX = (x) => Math.max(r.left, Math.min(x, r.left + container.clientWidth));
      const clampY = (y) => Math.max(r.top, Math.min(y, r.top + container.clientHeight));
      const x1 = clampX(Math.min(down.clientX, ev.clientX));
      const x2 = clampX(Math.max(down.clientX, ev.clientX));
      const y1 = clampY(Math.min(down.clientY, ev.clientY));
      const y2 = clampY(Math.max(down.clientY, ev.clientY));
      Object.assign(box.style, {
        left: x1 - r.left + container.scrollLeft + 'px',
        top: y1 - r.top + container.scrollTop + 'px',
        width: x2 - x1 + 'px',
        height: y2 - y1 + 'px',
      });
      const hit = [...container.querySelectorAll(itemSelector)].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.left < x2 && b.right > x1 && b.top < y2 && b.bottom > y1;
      });
      onChange(hit, { additive, first });
      first = false;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!box) return; // a plain click
      box.remove();
      document.body.classList.remove('dragging');
      // The release ends a box selection: do not let it count as a click on empty space.
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}
