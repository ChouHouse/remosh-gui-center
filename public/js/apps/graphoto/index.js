// Graphoto: the image viewer. Zoom (wheel, buttons, keys), drag to move,
// rotate, and step through the other pictures in the same folder.
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { fmtSize } from '../../core/format.js';
import { P } from '../../core/path.js';
import { ICON, stroke } from '../../core/icons.js';
import { graphotoSvg } from './icon.js';
import { rpc } from '../../core/rpc.js';
import { on } from '../../core/events.js';
import { readFile } from '../../core/file-io.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, launchApp, useAppStyle } from '../../shell/apps.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { registerDropTarget } from '../../shell/drag.js';

useAppStyle(import.meta.url);

const APP_NAME = 'Graphoto';
const TYPES = {
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};
export const IMAGE_EXTS = Object.keys(TYPES);
const isImage = (name) => Object.hasOwn(TYPES, P.ext(name));
const MIN_SCALE = 0.02;
const MAX_SCALE = 32;
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const I = {
  prev: ICON.back,
  next: ICON.fwd,
  zoomOut: stroke('<circle cx="7" cy="7" r="4.5"/><path d="M5 7h4M10.5 10.5 14 14"/>'),
  zoomIn: stroke('<circle cx="7" cy="7" r="4.5"/><path d="M5 7h4M7 5v4M10.5 10.5 14 14"/>'),
  fit: stroke('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  actual: stroke('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M6 6.5v3M10 6.5v3M8 7v.01M8 9v.01"/>'),
  rotL: stroke('<path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.2h2.2"/>'),
  rotR: stroke('<path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v2.2h-2.2"/>'),
};

const viewers = new Set();

function openViewer({ path = null } = {}) {
  if (path) {
    const open = [...viewers].find((v) => v.path === path);
    if (open) return open.win.focus();
  }
  const win = createWindow({ title: path ? P.base(path) : APP_NAME, appName: APP_NAME, iconHtml: graphotoSvg(), width: 760, height: 540 });
  const v = { win, path: null, list: [], url: null, token: 0, scale: 1, rot: 0, tx: 0, ty: 0, fitted: true, natural: { w: 0, h: 0 } };
  viewers.add(v);

  const btn = (icon, title, run) => h('button', { type: 'button', class: 'gp-btn', title, 'aria-label': title, html: icon, onclick: run });
  const bPrev = btn(I.prev, '上一張（←）', () => step(-1));
  const bNext = btn(I.next, '下一張（→）', () => step(1));
  const zoomLabel = h('button', { type: 'button', class: 'gp-zoom', title: '點一下符合視窗' }, '—');
  zoomLabel.addEventListener('click', () => fit());
  const img = h('img', { class: 'gp-img', alt: '', draggable: 'false' });
  const empty = h('div', { class: 'gp-empty' }, '從檔案櫃開啟圖片，或把圖片拖到這裡');
  const stage = h('div', { class: 'gp-stage', tabindex: '0' }, img, empty);
  const sIndex = h('span');
  const sDims = h('span');
  const sSize = h('span');
  const sPath = h('span', { class: 'path' });
  win.body.append(
    h('div', { class: 'gp-toolbar' },
      bPrev, bNext, h('span', { class: 'gp-sep' }),
      btn(I.zoomOut, '縮小（-）', () => zoomBy(1 / 1.25)), zoomLabel, btn(I.zoomIn, '放大（+）', () => zoomBy(1.25)),
      btn(I.fit, '符合視窗（0）', () => fit()), btn(I.actual, '實際大小（1）', () => actual()), h('span', { class: 'gp-sep' }),
      btn(I.rotL, '向左旋轉（Shift+R）', () => rotate(-90)), btn(I.rotR, '向右旋轉（R）', () => rotate(90))),
    stage,
    h('div', { class: 'statusbar' }, sIndex, sDims, sSize, h('span', { class: 'spacer' }), sPath));

  // ---- drawing
  const turned = () => v.rot % 180 !== 0;
  const fitScale = () => {
    const { w, h: hh } = v.natural;
    if (!w || !hh) return 1;
    const [iw, ih] = turned() ? [hh, w] : [w, hh];
    return Math.min(1, (stage.clientWidth - 24) / iw, (stage.clientHeight - 24) / ih);
  };
  const apply = () => {
    img.style.transform = `translate(${v.tx}px, ${v.ty}px) translate(-50%, -50%) rotate(${v.rot}deg) scale(${v.scale})`;
    img.classList.toggle('pixelated', v.scale >= 3);
    zoomLabel.textContent = v.natural.w ? `${Math.round(v.scale * 100)}%` : '—';
  };
  const fit = () => {
    v.fitted = true;
    v.scale = fitScale();
    v.tx = v.ty = 0;
    apply();
  };
  const actual = () => {
    v.fitted = false;
    v.scale = 1;
    v.tx = v.ty = 0;
    apply();
  };
  // Zoom keeping the point under (x, y) (stage coordinates from its centre) still.
  const zoomTo = (scale, x = 0, y = 0) => {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    v.tx = x - (x - v.tx) * (next / v.scale);
    v.ty = y - (y - v.ty) * (next / v.scale);
    v.scale = next;
    v.fitted = false;
    apply();
  };
  const zoomBy = (factor) => zoomTo(v.scale * factor);
  const rotate = (deg) => {
    v.rot = (v.rot + deg + 360) % 360;
    if (v.fitted) fit();
    else apply();
  };
  const resize = new ResizeObserver(() => v.fitted && fit());
  resize.observe(stage);

  // ---- loading
  function status() {
    const i = v.list.indexOf(P.base(v.path || ''));
    sIndex.textContent = v.list.length > 1 && i >= 0 ? `${i + 1} / ${v.list.length}` : '';
    bPrev.disabled = bNext.disabled = !(v.list.length > 1 && i >= 0);
    sDims.textContent = v.natural.w ? `${v.natural.w} × ${v.natural.h}` : '';
    sPath.textContent = sPath.title = v.path || '';
  }

  async function loadList() {
    if (!v.path) return;
    const dir = P.parent(v.path);
    try {
      const { entries } = await rpc('list', { path: dir });
      if (P.parent(v.path) !== dir) return;
      v.list = entries.filter((e) => (e.type === 'file' || e.targetType === 'file') && isImage(e.name)).map((e) => e.name).sort(byName.compare);
    } catch {
      v.list = [P.base(v.path)];
    }
    status();
  }

  async function show(path, { relist = true } = {}) {
    const token = ++v.token;
    v.path = path;
    win.setTitle(P.base(path));
    empty.hidden = false;
    empty.textContent = '開啟中…';
    stage.classList.add('loading');
    if (relist) loadList();
    status();
    let bytes;
    try {
      ({ bytes } = await readFile(path, {
        onProgress: (done, total) => {
          if (token === v.token) empty.textContent = `開啟中… ${Math.floor((done / total) * 100)}%`;
        },
      }));
    } catch (err) {
      if (token !== v.token) return;
      empty.textContent = `無法開啟「${P.base(path)}」：${errText(err)}`;
      img.hidden = true;
      return;
    }
    if (token !== v.token) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: TYPES[P.ext(P.base(path))] || 'application/octet-stream' }));
    const probe = new Image();
    probe.src = url;
    try {
      await probe.decode();
    } catch {
      URL.revokeObjectURL(url);
      if (token !== v.token) return;
      empty.textContent = `「${P.base(path)}」不是可以顯示的圖片`;
      img.hidden = true;
      v.natural = { w: 0, h: 0 };
      status();
      return;
    }
    if (token !== v.token) return URL.revokeObjectURL(url);
    if (v.url) URL.revokeObjectURL(v.url);
    v.url = url;
    img.src = url;
    img.hidden = false;
    empty.hidden = true;
    stage.classList.remove('loading');
    v.natural = { w: probe.naturalWidth, h: probe.naturalHeight };
    sSize.textContent = fmtSize(bytes.length);
    v.rot = 0;
    fit();
    status();
  }

  function step(delta) {
    if (v.list.length < 2 || !v.path) return;
    const i = v.list.indexOf(P.base(v.path));
    if (i < 0) return;
    const name = v.list[(i + delta + v.list.length) % v.list.length];
    show(P.join(P.parent(v.path), name), { relist: false });
  }
  win.onNavigate = step; // mouse side buttons, Alt+←/→

  // ---- pointer: wheel zooms, drag moves, double-click switches fit / 100%
  const fromCentre = (ev) => {
    const r = stage.getBoundingClientRect();
    return [ev.clientX - r.left - r.width / 2, ev.clientY - r.top - r.height / 2];
  };
  stage.addEventListener('wheel', (ev) => {
    if (!v.natural.w) return;
    ev.preventDefault();
    zoomTo(v.scale * Math.pow(1.0015, -ev.deltaY), ...fromCentre(ev));
  }, { passive: false });
  stage.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || !v.natural.w) return;
    stage.focus({ preventScroll: true });
    const start = { x: down.clientX, y: down.clientY, tx: v.tx, ty: v.ty };
    stage.classList.add('panning');
    const move = (ev) => {
      v.tx = start.tx + ev.clientX - start.x;
      v.ty = start.ty + ev.clientY - start.y;
      v.fitted = false;
      apply();
    };
    const up = () => {
      stage.classList.remove('panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  stage.addEventListener('dblclick', (ev) => {
    if (!v.natural.w) return;
    if (v.fitted && fitScale() < 1) zoomTo(1, ...fromCentre(ev));
    else fit();
  });
  stage.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key;
    if (k === 'ArrowLeft' || k === 'PageUp') step(-1);
    else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') step(1);
    else if (k === 'Home' && v.list.length) show(P.join(P.parent(v.path), v.list[0]), { relist: false });
    else if (k === 'End' && v.list.length) show(P.join(P.parent(v.path), v.list[v.list.length - 1]), { relist: false });
    else if (k === '+' || k === '=') zoomBy(1.25);
    else if (k === '-') zoomBy(1 / 1.25);
    else if (k === '0') fit();
    else if (k === '1') actual();
    else if (k === 'r' || k === 'R') rotate(ev.shiftKey ? -90 : 90);
    else return;
    ev.preventDefault();
  });
  stage.addEventListener('contextmenu', (ev) => {
    const has = !!v.natural.w;
    showContextMenu(ev, [
      { label: '上一張', enabled: v.list.length > 1, run: () => step(-1) },
      { label: '下一張', enabled: v.list.length > 1, run: () => step(1) },
      null,
      { label: '放大', enabled: has, run: () => zoomBy(1.25) },
      { label: '縮小', enabled: has, run: () => zoomBy(1 / 1.25) },
      { label: '符合視窗', enabled: has, run: fit },
      { label: '實際大小', enabled: has, run: actual },
      { label: '向左旋轉', enabled: has, run: () => rotate(-90) },
      { label: '向右旋轉', enabled: has, run: () => rotate(90) },
      null,
      { label: '在檔案櫃中顯示', enabled: !!v.path, run: () => launchApp('files', { path: P.parent(v.path) }) },
      { label: '下載到這台電腦', enabled: has, run: () => h('a', { href: v.url, download: P.base(v.path) }).click() },
    ]);
  });

  // Pictures dragged in from the file cabinet or the desktop.
  const offDrop = registerDropTarget(win.el, {
    accepts: (payload) => payload.type === 'file' && !payload.data.isDir && (payload.data.paths || [payload.data.path]).some((p) => isImage(P.base(p))),
    action: () => '用 Graphoto 開啟',
    onDrop: (payload) => {
      const pics = (payload.data.paths || [payload.data.path]).filter((p) => isImage(P.base(p)));
      show(pics[0]);
      for (const p of pics.slice(1)) openViewer({ path: p });
    },
  });
  // The folder changed (a picture added, renamed or deleted): list it again.
  const offChanged = on('fs:changed', (dir) => {
    if (v.path && dir === P.parent(v.path)) loadList();
  });

  v.relocate = (next) => {
    v.path = next;
    win.setTitle(P.base(next));
    loadList();
  };
  win.onFocus = () => {
    if (!win.el.contains(document.activeElement)) stage.focus({ preventScroll: true });
  };
  win.destroy = () => {
    v.token++;
    resize.disconnect();
    offDrop();
    offChanged();
    if (v.url) URL.revokeObjectURL(v.url);
    viewers.delete(v);
  };

  if (path) show(path);
  else status();
  stage.focus({ preventScroll: true });
}

// A renamed or moved picture (or a folder above it) takes its window along.
on('fs:moved', (from, to) => {
  for (const v of viewers) {
    const next = v.path === from ? to : v.path?.startsWith(from + '/') ? to + v.path.slice(from.length) : null;
    if (next) v.relocate(next);
  }
});

registerApp({
  id: 'graphoto',
  name: APP_NAME,
  icon: graphotoSvg,
  startMenu: true,
  extensions: IMAGE_EXTS,
  launch: openViewer,
});
