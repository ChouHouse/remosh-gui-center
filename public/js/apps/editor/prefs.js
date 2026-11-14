// Procoder's preferences and its recent list, shared by every Procoder window
// and saved in ~/.remosh-gui/app/editor/.
import { store } from '../../core/store.js';
import { appStore } from '../../core/app-store.js';

export const APP_NAME = 'Procoder';
export const UNTITLED = '未命名';
export const WELCOME = '歡迎';
export const LARGE_FILE_BYTES = 200 * 1024 * 1024; // above this the user is asked first
export const RECENT_MAX = 10;

// ---- preferences and the recent list, saved in ~/.remosh-gui/app/editor/
export const FONT_DEFAULT = 13;
export const FONT_MIN = 9;
export const FONT_MAX = 32;
export const SIDE_DEFAULT = 200;
export const SIDE_MIN = 120;
export const SIDE_MAX = 480;
export const clampSide = (n) => Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(Number(n)) || SIDE_DEFAULT));
export const clampFont = (n) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(Number(n)) || FONT_DEFAULT));
export const data = appStore('editor', {
  defaults: { fontSize: FONT_DEFAULT, minimap: true, wordWrap: 'off', recent: [], langs: {}, folder: null, sideWidth: SIDE_DEFAULT, sideShown: true },
  migrate() {
    const out = {};
    for (const key of ['fontSize', 'minimap', 'wordWrap']) {
      const v = store.get(key, undefined);
      if (v !== undefined) out[key] = v;
      store.remove(key);
    }
    return out;
  },
});
export const prefs = {
  get fontSize() {
    return clampFont(data.get('fontSize'));
  },
  get minimap() {
    return data.get('minimap') !== false;
  },
  get wordWrap() {
    return data.get('wordWrap') === 'on' ? 'on' : 'off';
  },
};
export const setFontSize = (n) => data.set('fontSize', clampFont(n));
export const setMinimap = (v) => data.set('minimap', !!v);
export const toggleWrap = () => data.set('wordWrap', prefs.wordWrap === 'on' ? 'off' : 'on');
export const recentList = () => (Array.isArray(data.get('recent')) ? data.get('recent').filter((p) => typeof p === 'string') : []);
export const remember = (path) => data.set('recent', [path, ...recentList().filter((p) => p !== path)].slice(0, RECENT_MAX));
export const forget = (path) => data.set('recent', recentList().filter((p) => p !== path));
export const sideShown = () => data.get('sideShown') !== false;
export const toggleSide = () => data.set('sideShown', !sideShown());
export const isFolderRef = (ref) => ref.length > 1 && ref.endsWith('/'); // folders are remembered with a trailing slash

// Languages the user chose by hand, per file path (the newest LANGS_MAX are kept).
const LANGS_MAX = 200;
const langs = () => (data.get('langs') && typeof data.get('langs') === 'object' ? data.get('langs') : {});
export const chosenLang = (path) => (typeof langs()[path] === 'string' ? langs()[path] : null);
export function setChosenLang(path, lang) {
  if ((chosenLang(path) || null) === (lang || null)) return;
  const next = Object.fromEntries(Object.entries(langs()).filter(([p]) => p !== path));
  if (lang) next[path] = lang;
  data.set('langs', Object.fromEntries(Object.entries(next).slice(-LANGS_MAX)));
}
