// User settings, stored on the SSH host in ~/.remosh-gui/setting.json so they
// follow the account rather than the browser.
//
// To add a setting: give it a default in DEFAULTS, validate it in normalise(),
// and react to it in apply() or by listening for the `settings:changed` event.
import { conn, rpc } from './rpc.js';
import { P } from './path.js';
import { on, emit } from './events.js';
import { toast } from './ui.js';
import { toBase64, fromBase64 } from './text-codec.js';

export const SETTINGS_DIR = '.remosh-gui';
export const SETTINGS_FILE = 'setting.json';
export const ANIMATION_SPEEDS = { fast: 120, normal: 200, slow: 350 }; // milliseconds

const DEFAULTS = {
  animation: { enabled: true, speed: 'normal' },
  files: {
    associations: {}, // extension ('' = no extension) -> app id
    sidebar: null, // file cabinet sidebar folders; null = the built-in list
  },
  style: {
    tint: 'default', // colour scheme of the windows; see shell/style.js
    wallpaper: null, // file name in ~/.remosh-gui/wallpaper currently shown, or null
    wallpapers: [], // the last few uploads, most recently used first
  },
};

export const WALLPAPER_DIR = 'wallpaper';
export const MAX_WALLPAPERS = 5;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const EXT_PATTERN = /^[a-z0-9_+-]{0,16}$/;

let raw = {}; // the file as last read, so keys this version does not know survive a save
let current = structuredClone(DEFAULTS);

function normalise(obj) {
  const a = obj?.animation;
  const associations = {};
  for (const [ext, app] of Object.entries(obj?.files?.associations || {})) {
    if (EXT_PATTERN.test(ext) && typeof app === 'string' && app) associations[ext] = app;
  }
  const side = obj?.files?.sidebar;
  const sidebar = Array.isArray(side) ? [...new Set(side.filter((p) => typeof p === 'string' && p.startsWith('/')))] : null;
  return {
    animation: {
      enabled: typeof a?.enabled === 'boolean' ? a.enabled : DEFAULTS.animation.enabled,
      speed: Object.hasOwn(ANIMATION_SPEEDS, a?.speed) ? a.speed : DEFAULTS.animation.speed,
    },
    files: { associations, sidebar },
    style: normaliseStyle(obj?.style),
  };
}

function normaliseStyle(st) {
  const wallpapers = [...new Set((Array.isArray(st?.wallpapers) ? st.wallpapers : []).filter((n) => typeof n === 'string' && FILE_NAME.test(n)))].slice(0, MAX_WALLPAPERS);
  return {
    tint: typeof st?.tint === 'string' && /^[a-z-]{1,24}$/.test(st.tint) ? st.tint : DEFAULTS.style.tint,
    wallpaper: wallpapers.includes(st?.wallpaper) ? st.wallpaper : null,
    wallpapers,
  };
}

function apply() {
  const root = document.documentElement;
  root.classList.toggle('no-anim', !current.animation.enabled);
  root.style.setProperty('--anim', animationMs() + 'ms');
  emit('settings:changed', getSettings());
}

export const getSettings = () => structuredClone(current);
export const settingsDir = () => P.join(conn.info.home, SETTINGS_DIR);
export const settingsPath = () => P.join(settingsDir(), SETTINGS_FILE);
export const wallpaperDir = () => P.join(settingsDir(), WALLPAPER_DIR);
// Duration of UI transitions; 0 when animations are switched off.
export const animationMs = () => (current.animation.enabled ? ANIMATION_SPEEDS[current.animation.speed] : 0);

export async function loadSettings() {
  raw = {};
  try {
    const res = await rpc('read', { path: settingsPath() });
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64(res.data)));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    else throw new SyntaxError('not an object');
  } catch (err) {
    if (err instanceof SyntaxError) toast(`~/${SETTINGS_DIR}/${SETTINGS_FILE} 的格式不正確，先使用預設設定`, true);
    else if (err.code !== 'not-found') toast(`無法讀取設定檔：${err.message}`, true);
  }
  current = normalise(raw);
  apply();
}

// Writes the file first; the new values take effect only if that succeeded.
export async function saveSettings(next) {
  await ready; // never write before the file on the host has been read
  const clean = normalise(next);
  const file = { ...raw, version: 1, ...clean };
  await rpc('mkdir', { path: settingsDir() });
  await rpc('write', { path: settingsPath(), data: toBase64(new TextEncoder().encode(JSON.stringify(file, null, 2) + '\n')) });
  raw = file;
  current = clean;
  apply();
  emit('fs:changed', settingsDir());
}

// Change one thing and save, e.g. updateSettings((s) => { s.files.associations.txt = 'notepad'; }).
export async function updateSettings(mutate) {
  await ready;
  const next = getSettings();
  mutate(next);
  await saveSettings(next);
}

let ready = Promise.resolve();
export const whenSettingsReady = () => ready;
on('session:start', () => {
  ready = loadSettings();
});
on('session:end', () => {
  raw = {};
  current = structuredClone(DEFAULTS);
  apply();
});
apply();
