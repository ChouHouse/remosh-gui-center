// App registry. Every app registers itself here; the start menu, autostart and
// file associations all go through it, so adding an app never touches the shell.
//
// registerApp({
//   id,                 unique string
//   name,               shown in the start menu
//   icon: () => svg,    start-menu icon
//   launch(args),       open (or focus) the app
//   startMenu?: bool,   list it under 工具
//   autostart?: bool,   open it right after login
//   extensions?:        files it can open: 'all', or a list of lower-case
//                       extensions without the dot ('' = no extension).
//                       launch({ path, size }) then opens that remote file.
//   unsavedCount?()     number of documents with unsaved changes
// })
const apps = new Map();

// An app's stylesheet sits next to its code; the app loads it with
// useAppStyle(import.meta.url), so nothing outside the app's folder lists it.
export function useAppStyle(moduleUrl, file = 'style.css') {
  const href = new URL(file, moduleUrl).href;
  if ([...document.styleSheets].some((s) => s.href === href) || document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href }));
}

export function registerApp(app) {
  if (apps.has(app.id)) throw new Error(`App "${app.id}" is already registered`);
  apps.set(app.id, app);
}

export const listApps = () => [...apps.values()];

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

export const unsavedCount = () => listApps().reduce((n, a) => n + (a.unsavedCount?.() || 0), 0);
