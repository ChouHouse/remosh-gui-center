// 樣式: the colour scheme (tint) of the windows and the desktop wallpaper.
// Both come from the user's settings and are applied here.
import { $ } from '../core/dom.js';
import { P } from '../core/path.js';
import { rpc } from '../core/rpc.js';
import { on } from '../core/events.js';
import { toBase64, fromBase64 } from '../core/text-codec.js';
import { getSettings, updateSettings, settingsDir, wallpaperDir, MAX_WALLPAPERS } from '../core/settings.js';

// ---- system colour and light/dark mode
// The system colour is the one accent of the desktop: buttons, switches, the
// taskbar indicator, folder icons, selections. System apps get it for free by
// using the CSS variables (--accent, --accent-text, --select, --folder);
// an app that wants the value itself calls systemColor() / effectiveMode() and
// listens for `settings:changed`. An app that does neither keeps its own look
// (the code editor does, apart from following light/dark).
const colour = (id, label, color, shade, ink) => ({ id, label, color, shade, ink });
const WHITE = '#ffffff';
export const COLORS = [
  { id: 'default', label: '預設', color: null, shade: null, ink: null },
  colour('pink-dark', '深桃紅', '#d6337f', '#a81f5f', WHITE),
  colour('pink-light', '淺桃紅', '#ff9cc4', '#f070a4', '#3a0f22'),
  colour('blue-dark', '深藍', '#1f5fbf', '#174a96', WHITE),
  colour('blue-light', '淺藍', '#7db8f5', '#4a9bea', '#0b2545'),
  colour('green-dark', '深綠', '#1f8a4c', '#166a39', WHITE),
  colour('green-light', '淺綠', '#8fdcae', '#5fc48a', '#0d3320'),
  colour('yellow', '黃', '#f5cc3d', '#dba91a', '#3a2c00'),
  colour('orange', '橘', '#f59a3d', '#db7a1a', '#3a1c00'),
  colour('gray-light', '淺灰', '#c3c9d1', '#a3abb5', '#1f2429'),
  colour('off-white', '稍深白', '#ece8dc', '#d3cdbb', '#2a2822'),
];
export const MODES = [['auto', '跟隨裝置'], ['light', '淺色'], ['dark', '深色']];

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
export const systemColor = () => COLORS.find((c) => c.id === getSettings().style.color) || COLORS[0];
export const effectiveMode = () => {
  const mode = getSettings().style.mode;
  return mode === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : mode;
};

function applyAppearance() {
  const root = document.documentElement;
  const mode = getSettings().style.mode;
  if (mode === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = mode;
  const c = systemColor();
  const vars = c.color
    ? {
      '--accent': c.color,
      '--accent-text': c.ink,
      '--folder': c.color,
      '--folder-dark': c.shade,
      '--select': `color-mix(in srgb, ${c.shade} 26%, var(--surface))`,
    }
    : { '--accent': null, '--accent-text': null, '--folder': null, '--folder-dark': null, '--select': null };
  for (const [name, value] of Object.entries(vars)) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  root.dataset.color = c.id;
}

export const setColor = (id) =>
  updateSettings((s) => {
    s.style.color = id;
  });
export const setMode = (mode) =>
  updateSettings((s) => {
    s.style.mode = mode;
  });
// Fires when the device switches between light and dark.
export const onDeviceModeChange = (fn) => darkQuery.addEventListener('change', fn);

// ---- wallpaper
const urls = new Map(); // file name -> object URL (kept for this session)
let shown = null;

export async function wallpaperUrl(name) {
  if (!urls.has(name)) {
    const res = await rpc('read', { path: P.join(wallpaperDir(), name) });
    const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
    urls.set(name, URL.createObjectURL(new Blob([fromBase64(res.data)], { type })));
  }
  return urls.get(name);
}

async function applyWallpaper() {
  const name = getSettings().style.wallpaper;
  if (name === shown) return;
  shown = name;
  const desktop = $('#desktop');
  if (!name) return desktop.style.removeProperty('background-image');
  try {
    const url = await wallpaperUrl(name);
    if (shown === name) desktop.style.backgroundImage = `url("${url}")`;
  } catch {
    if (shown === name) desktop.style.removeProperty('background-image'); // file is gone: plain background
  }
}

// Shrinks large pictures so they load quickly at every login.
async function toJpeg(file, maxSide = 2560) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('無法處理這張圖片');
  return new Uint8Array(await blob.arrayBuffer());
}

// Most-recently-used list: `name` moves to the front; anything past the limit
// is dropped and its file deleted.
async function promote(name) {
  let dropped = [];
  await updateSettings((s) => {
    const list = [name, ...s.style.wallpapers.filter((n) => n !== name)];
    dropped = list.slice(MAX_WALLPAPERS);
    s.style.wallpapers = list.slice(0, MAX_WALLPAPERS);
    s.style.wallpaper = name;
  });
  for (const old of dropped) {
    rpc('remove', { path: P.join(wallpaperDir(), old) }).catch(() => {});
    const url = urls.get(old);
    if (url) URL.revokeObjectURL(url);
    urls.delete(old);
  }
}

export async function uploadWallpaper(file) {
  if (!file.type.startsWith('image/')) throw new Error('請選擇圖片檔');
  const bytes = await toJpeg(file);
  const name = `wp-${Date.now()}.jpg`;
  await rpc('mkdir', { path: settingsDir() });
  await rpc('mkdir', { path: wallpaperDir() });
  await rpc('write', { path: P.join(wallpaperDir(), name), data: toBase64(bytes) });
  await promote(name);
  return name;
}

// Picking an older wallpaper makes it the newest again.
export const useWallpaper = (name) => promote(name);

export const clearWallpaper = () =>
  updateSettings((s) => {
    s.style.wallpaper = null;
  });

on('settings:changed', () => {
  applyAppearance();
  applyWallpaper();
});
on('session:end', () => {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
});
applyAppearance();
