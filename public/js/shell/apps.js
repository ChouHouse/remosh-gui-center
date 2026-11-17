// App registry. Every app registers itself here; the start menu, autostart and
// file associations all go through it, so adding an app never touches the shell.
//
// registerApp({
//   id,                 unique string
//   name,               shown in the start menu
//   order?: number,     place in the start menu, lowest first (apps without
//                       one come last, by name)
//   icon: () => svg,    start-menu icon
//   launch(args),       open (or focus) the app
//   startMenu?: bool,   list it under 工具
//   autostart?: bool,   open it right after login
//   extensions?:        files it can open: 'all', or a list of lower-case
//                       extensions without the dot ('' = no extension).
//                       launch({ path, size }) then opens that remote file.
//   folders?: bool      it can open a folder: launch({ path, folder: true })
//   unsavedCount?()     number of documents with unsaved changes
//   requires?: [...]    what the host must have for the app to work: command
//                       names, e.g. ['tmux'], or { command, install } with the
//                       way to get it (shown to the user)
// })
//
// After login the host is asked once for every required command
// (hasCommands). An app missing one stays in the start menu, dimmed, and says
// what is missing instead of opening.
import { rpc } from '../core/rpc.js';
import { on, emit } from '../core/events.js';
import { dialog } from '../core/ui.js';
import { tt } from '../core/i18n.js';

const apps = new Map();
const missing = new Map(); // app id -> requirements the host does not meet
const requirements = (app) => (app.requires || []).map((r) => (typeof r === 'string' ? { command: r } : r));

// An app's stylesheet sits next to its code; the app loads it with
// useAppStyle(import.meta.url), so nothing outside the app's folder lists it.
export function useAppStyle(moduleUrl, file = 'style.css') {
  const href = new URL(file, moduleUrl).href;
  if ([...document.styleSheets].some((s) => s.href === href) || document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
}

export function registerApp(app) {
  if (apps.has(app.id)) throw new Error(`App "${app.id}" is already registered`);
  const run = app.launch;
  app.launch = (args) => (missingFor(app).length ? explainMissing(app) : run(args));
  apps.set(app.id, app);
}

// What an app needs and the host does not have (empty until checked).
export const missingFor = (app) => missing.get(app.id) || [];

export async function checkRequirements() {
  const names = [...new Set([...apps.values()].flatMap((app) => requirements(app).map((r) => r.command)))];
  if (!names.length) return;
  let found;
  try {
    found = new Set((await rpc('hasCommands', { names })).found);
  } catch {
    return; // cannot tell: let the apps open
  }
  missing.clear();
  for (const app of apps.values()) {
    const lacking = requirements(app).filter((r) => !found.has(r.command));
    if (lacking.length) missing.set(app.id, lacking);
  }
  emit('apps:requirements');
}
on('session:start', checkRequirements);

function explainMissing(app) {
  const lacking = missingFor(app);
  const install = lacking.map((r) => r.install).filter(Boolean);
  return dialog({
    title: tt('無法開啟「{0}」', tt(app.name)),
    message: tt('這個應用程式需要主機上有：{0}', lacking.map((r) => r.command).join('、'))
      + (install.length ? '\n' + tt('可以在終端機執行：{0}', install.join('；')) : ''),
    buttons: [{ label: tt('知道了'), value: true, default: true, cancel: true }],
  });
}

export const listApps = () => [...apps.values()].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name));

export function launchApp(id, args) {
  const app = apps.get(id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  return app.launch(args);
}

export const getApp = (id) => apps.get(id) || null;

export function acceptsExt(app, ext) {
  return app.extensions === 'all' || (Array.isArray(app.extensions) && app.extensions.includes(ext));
}

export const appsForExt = (ext) => listApps().filter((app) => acceptsExt(app, ext));
export const appsForFolders = () => listApps().filter((app) => app.folders);

export const unsavedCount = () => listApps().reduce((n, a) => n + (a.unsavedCount?.() || 0), 0);
