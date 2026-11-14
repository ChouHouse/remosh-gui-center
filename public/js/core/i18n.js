// Languages. The source text is Traditional Chinese: code writes tt('開啟') and
// the dictionaries (keyed by that text) give the other languages.
//
//   tt('已另存為 {0}', path)   translated, {0} {1}… filled in
//   tm('歡迎')                  only marks a text kept in a constant; call
//                              tt() on it where it is shown
//   addStrings({ en: {…}, ja: {…} })   an app adds its own texts (apps/<x>/i18n.js)
//
// The language is a system setting (設定 › 系統); the choice is also kept in
// the browser so the login screen, before any account is known, uses it too.
import { store } from './store.js';
import { emit } from './events.js';
import en from './i18n/en.js';
import ja from './i18n/ja.js';

export const LANGS = [
  { id: 'zh-TW', name: '繁體中文' },
  { id: 'en', name: 'English' },
  { id: 'ja', name: '日本語' },
];
const dicts = { en: { ...en }, ja: { ...ja } };
const known = (id) => LANGS.some((l) => l.id === id);

// 'auto' follows the browser: Chinese and Japanese get their own, the rest English.
function fromBrowser() {
  const want = (navigator.languages?.[0] || navigator.language || 'zh-TW').toLowerCase();
  return want.startsWith('zh') ? 'zh-TW' : want.startsWith('ja') ? 'ja' : 'en';
}
let choice = store.get('lang', 'auto'); // 'auto' | a language id
let lang = known(choice) ? choice : fromBrowser();

export const getLang = () => lang;
export const getLangChoice = () => (known(choice) ? choice : 'auto');

export function addStrings(byLang) {
  for (const [id, map] of Object.entries(byLang)) Object.assign((dicts[id] ||= {}), map);
}

export function tt(text, ...args) {
  const found = dicts[lang]?.[text] ?? text;
  return args.length ? String(found).replace(/\{(\d+)\}/g, (m, i) => (i in args ? args[i] : m)) : found;
}
export const tm = (text) => text;

// Static page text: <span data-i18n>文字</span>, and data-i18n-title /
// -placeholder / -aria-label holding the Chinese text of that attribute.
export function translateDom(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.dataset.i18n ||= el.textContent;
    el.textContent = tt(el.dataset.i18n);
  }
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, tt(el.getAttribute(`data-i18n-${attr}`)));
  }
}

export function setLang(next) {
  choice = known(next) ? next : 'auto';
  store.set('lang', choice);
  const now = known(choice) ? choice : fromBrowser();
  if (now === lang) return;
  lang = now;
  document.documentElement.lang = lang;
  translateDom();
  emit('lang:changed', lang);
}
document.documentElement.lang = lang;
