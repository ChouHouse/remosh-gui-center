// 樣式: the colour scheme (tint) of the windows and the desktop wallpaper.
// Both come from the user's settings and are applied here.
import { $ } from '../core/dom.js';
import { P } from '../core/path.js';
import { rpc } from '../core/rpc.js';
import { on } from '../core/events.js';
import { toBase64, fromBase64 } from '../core/text-codec.js';
import { getSettings, updateSettings, settingsDir, wallpaperDir, MAX_WALLPAPERS } from '../core/settings.js';

// [surface, surface-2, surface-3, border, text, muted, accent, accent-text, select]
const scheme = (id, label, dark, c) => ({
  id, label, dark,
  vars: {
    '--surface': c[0], '--surface-2': c[1], '--surface-3': c[2], '--border': c[3], '--text': c[4], '--muted': c[5],
    '--accent': c[6], '--accent-text': c[7], '--select': c[8], '--file': dark ? c[2] : '#ffffff', '--file-edge': c[3],
  },
});
export const TINTS = [
  { id: 'default', label: '預設（跟隨系統）', dark: null, vars: null },
  scheme('pink-dark', '深桃紅', true, ['#2b1d26', '#241820', '#3a2733', '#55394b', '#f5e6ee', '#c79fb3', '#ff6fae', '#2a0f1c', '#5a2644']),
  scheme('pink-light', '淺桃紅', false, ['#fff3f8', '#ffe6f0', '#ffd6e6', '#f2b6cf', '#3a1d2a', '#875a6d', '#c92a74', '#ffffff', '#ffc9df']),
  scheme('blue-dark', '深藍', true, ['#1b2333', '#161d2b', '#263247', '#384a68', '#e6eefb', '#9db0cc', '#5aa2ff', '#0b1626', '#23406e']),
  scheme('blue-light', '淺藍', false, ['#f2f7ff', '#e3eefe', '#d3e4fd', '#b3cdf3', '#17263d', '#566d8b', '#1b63cc', '#ffffff', '#c6dcfb']),
  scheme('green-dark', '深綠', true, ['#1a2a22', '#15231c', '#24392e', '#375646', '#e4f5ec', '#96b8a6', '#4fd08a', '#0a2014', '#1f5238']),
  scheme('green-light', '淺綠', false, ['#f1fbf5', '#e1f5e9', '#cfecdb', '#a9d8bd', '#17301f', '#50735e', '#17804a', '#ffffff', '#c2ebd2']),
  scheme('yellow', '黃', false, ['#fffbe8', '#fff5c9', '#ffeea8', '#ecd77a', '#3a3210', '#7a6c30', '#8f6d00', '#ffffff', '#ffe98f']),
  scheme('orange', '橘', false, ['#fff5ec', '#ffe8d3', '#ffd9b8', '#f2bb8c', '#3d2410', '#85603f', '#bf5a09', '#ffffff', '#ffd2a8']),
  scheme('gray-light', '淺灰', false, ['#eef0f2', '#e3e6e9', '#d6dade', '#bfc5cc', '#1f2429', '#5d6670', '#44627f', '#ffffff', '#cfd9e3']),
  scheme('off-white', '稍深白', false, ['#f6f4ee', '#edeae1', '#e3dfd3', '#cfc9b9', '#2a2822', '#6b6659', '#6e5f32', '#ffffff', '#e4dcc3']),
];
const ALL_VARS = Object.keys(TINTS[1].vars);
export const currentTint = () => TINTS.find((t) => t.id === getSettings().style.tint) || TINTS[0];

function applyTint() {
  const tint = currentTint();
  const root = document.documentElement;
  for (const name of ALL_VARS) {
    if (tint.vars) root.style.setProperty(name, tint.vars[name]);
    else root.style.removeProperty(name);
  }
  // Native controls and scrollbars follow the scheme too.
  root.style.colorScheme = tint.dark == null ? '' : tint.dark ? 'dark' : 'light';
  root.dataset.tint = tint.id;
}

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

export const setTint = (id) =>
  updateSettings((s) => {
    s.style.tint = id;
  });

on('settings:changed', () => {
  applyTint();
  applyWallpaper();
});
on('session:end', () => {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
});
applyTint();
