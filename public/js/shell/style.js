// 樣式: the colour scheme (tint) of the windows and the desktop wallpaper.
// Both come from the user's settings and are applied here.
import { $ } from '../core/dom.js';
import { P } from '../core/path.js';
import { rpc } from '../core/rpc.js';
import { on } from '../core/events.js';
import { toBase64, fromBase64 } from '../core/text-codec.js';
import { getSettings, updateSettings, settingsDir, wallpaperDir, MAX_WALLPAPERS } from '../core/settings.js';

// ---- tints
// A tint is a colour, not a light/dark scheme. Each app that can be tinted
// registers a target and decides what the colour means for it:
//
//   registerTintTarget({
//     id: 'files',                 key in settings (style.tints.files)
//     label: '檔案櫃',              shown in 設定 → 樣式
//     description: '…',            what the colour changes
//     apply(tint) { … },           called now and whenever the choice changes;
//   });                            tint = { id, label, color, shade } (color null = default)
//
// Read the current choice with tintOf(id); change it with setTint(id, tintId).
const tint = (id, label, color, shade) => ({ id, label, color, shade });
export const TINTS = [
  { id: 'default', label: '預設', color: null, shade: null },
  tint('pink-dark', '深桃紅', '#d6337f', '#a81f5f'),
  tint('pink-light', '淺桃紅', '#ff9cc4', '#f070a4'),
  tint('blue-dark', '深藍', '#1f5fbf', '#174a96'),
  tint('blue-light', '淺藍', '#7db8f5', '#4a9bea'),
  tint('green-dark', '深綠', '#1f8a4c', '#166a39'),
  tint('green-light', '淺綠', '#8fdcae', '#5fc48a'),
  tint('yellow', '黃', '#f5cc3d', '#dba91a'),
  tint('orange', '橘', '#f59a3d', '#db7a1a'),
  tint('gray-light', '淺灰', '#c3c9d1', '#a3abb5'),
  tint('off-white', '稍深白', '#ece8dc', '#d3cdbb'),
];

const targets = new Map();
const applied = new Map(); // target id -> tint id last applied, to skip no-op calls

export const tintTargets = () => [...targets.values()];
export const tintOf = (targetId) => TINTS.find((t) => t.id === getSettings().style.tints[targetId]) || TINTS[0];

function applyTarget(target) {
  const t = tintOf(target.id);
  if (applied.get(target.id) === t.id) return;
  applied.set(target.id, t.id);
  try {
    target.apply(t);
  } catch (err) {
    console.error(`tint target "${target.id}" failed`, err);
  }
}

export function registerTintTarget(target) {
  if (targets.has(target.id)) throw new Error(`Tint target "${target.id}" is already registered`);
  targets.set(target.id, target);
  applyTarget(target);
}

// Call when a target becomes able to apply (e.g. the editor finished loading).
export function reapplyTint(targetId) {
  applied.delete(targetId);
  const target = targets.get(targetId);
  if (target) applyTarget(target);
}

export const setTint = (targetId, tintId) =>
  updateSettings((s) => {
    s.style.tints[targetId] = tintId;
  });

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
  for (const target of targets.values()) applyTarget(target);
  applyWallpaper();
});
on('session:end', () => {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
});
