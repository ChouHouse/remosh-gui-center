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
    // The box is kept in the container's content coordinates, so it stays put
    // while the content scrolls underneath the pointer.
    const start = { x: down.clientX - frame.left + container.scrollLeft, y: down.clientY - frame.top + container.scrollTop };
    const EDGE = 28; // px from the top/bottom edge where scrolling starts
    let box = null;
    let first = true;
    let last = down;
    let scroller = 0;
    const update = () => {
      // The owner may redraw its content mid-drag (e.g. a refresh) and drop the box with it.
      if (!box.isConnected) container.append(box);
      const r = container.getBoundingClientRect();
      const px = Math.max(0, Math.min(last.clientX - r.left, container.clientWidth)) + container.scrollLeft;
      const py = Math.max(0, Math.min(last.clientY - r.top, container.clientHeight)) + container.scrollTop;
      const x1 = Math.min(start.x, px);
      const x2 = Math.max(start.x, px);
      const y1 = Math.min(start.y, py);
      const y2 = Math.max(start.y, py);
      Object.assign(box.style, { left: x1 + 'px', top: y1 + 'px', width: x2 - x1 + 'px', height: y2 - y1 + 'px' });
      const hit = [...container.querySelectorAll(itemSelector)].filter((el) => {
        const b = el.getBoundingClientRect();
        const left = b.left - r.left + container.scrollLeft;
        const top = b.top - r.top + container.scrollTop;
        return left < x2 && left + b.width > x1 && top < y2 && top + b.height > y1;
      });
      onChange(hit, { additive, first });
      first = false;
    };
    const autoScroll = () => {
      const r = container.getBoundingClientRect();
      const y = last.clientY - r.top;
      const step = y > container.clientHeight - EDGE ? 14 : y < EDGE ? -14 : 0;
      if (!step) return;
      const before = container.scrollTop;
      container.scrollTop += step;
      if (container.scrollTop !== before) update();
    };
    const move = (ev) => {
      last = ev;
      if (!box) {
        if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 4) return;
        box = document.createElement('div');
        box.className = 'marquee';
        container.append(box);
        document.body.classList.add('dragging');
        scroller = setInterval(autoScroll, 30);
      }
      update();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!box) return; // a plain click
      clearInterval(scroller);
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
