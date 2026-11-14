// Saved data that belongs to one app. Each app has its own folder on the SSH
// host, ~/.remosh-gui/app/<app id>/, and its values live in
// config.inv-remosh_gui-config (JSON) inside it, so they follow the account.
// Only the system's own settings sit directly in ~/.remosh-gui/.
//
//   const data = appStore('files', {
//     defaults: { view: 'grid' },
//     migrate: () => ({ ... }),   // optional: values saved elsewhere by older versions
//   });
//   data.get('view');  data.set('view', 'list');  data.remove('view');
//   data.onChange(fn)  (after loading at login, and after every change)
//   data.folder()      the app's folder, for apps that keep more files there
import { rpc } from './rpc.js';
import { P } from './path.js';
import { on } from './events.js';
import { toast } from './ui.js';
import { errText } from './errors.js';
import { toBase64, fromBase64 } from './text-codec.js';
import { settingsDir, whenSettingsReady } from './settings.js';
import { tt } from './i18n.js';

export const APPS_DIR = 'app';
const FILE = 'config.inv-remosh_gui-config';
const SAVE_DELAY_MS = 300;
const APP_ID = /^[a-z0-9-]{1,32}$/;
const stores = new Map();

export function appStore(appId, { defaults = {}, migrate = null } = {}) {
  if (!APP_ID.test(appId)) throw new Error(`Bad app id: ${appId}`);
  if (stores.has(appId)) return stores.get(appId);
  let data = {};
  let ready = Promise.resolve();
  let timer = 0;
  let writing = Promise.resolve();
  const listeners = new Set();
  const folder = () => P.join(P.join(settingsDir(), APPS_DIR), appId);
  const file = () => P.join(folder(), FILE);
  const changed = () => {
    for (const fn of listeners) fn();
  };

  const write = () => {
    writing = writing.then(async () => {
      await ready; // never write over the file before it has been read
      await rpc('mkdir', { path: settingsDir() });
      await rpc('mkdir', { path: P.join(settingsDir(), APPS_DIR) });
      await rpc('mkdir', { path: folder() });
      await rpc('write', { path: file(), data: toBase64(new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n')) });
    }).catch((err) => toast(tt('無法儲存 {0} 的資料：{1}', appId, errText(err)), true));
  };
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(write, SAVE_DELAY_MS);
  };

  async function load() {
    data = {};
    let found = false;
    try {
      const res = await rpc('read', { path: file() });
      const parsed = JSON.parse(new TextDecoder().decode(fromBase64(res.data)));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      found = true;
    } catch (err) {
      if (err.code !== 'not-found') found = true; // unreadable: do not migrate over it
    }
    if (!found && migrate) {
      await whenSettingsReady();
      try {
        const moved = (await migrate()) || {};
        const keys = Object.keys(moved).filter((k) => moved[k] !== undefined);
        for (const k of keys) data[k] = moved[k];
        if (keys.length) setTimeout(write, 0);
      } catch {
        /* nothing to bring over */
      }
    }
    changed();
  }

  const store = {
    get: (key) => structuredClone(Object.hasOwn(data, key) ? data[key] : defaults[key]),
    set(key, value) {
      data[key] = structuredClone(value);
      changed();
      save();
    },
    remove(key) {
      if (!Object.hasOwn(data, key)) return;
      delete data[key];
      changed();
      save();
    },
    has: (key) => Object.hasOwn(data, key),
    ready: () => ready,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    folder,
  };
  on('session:start', () => {
    ready = load();
  });
  on('session:end', () => {
    clearTimeout(timer);
    data = {};
    changed();
  });
  stores.set(appId, store);
  return store;
}
