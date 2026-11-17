// Procoder's add-on modules. Each folder in ./modules with an index.js is one
// (the server lists them, like it lists the apps), so a module is added by
// adding its folder. Today they are the language analysers: Python and Node.js.
//
// A module's index.js exports by default:
//   {
//     id,                       its folder name
//     start(monaco, host),      begin (Monaco is loaded); host is below
//     stop(),                   end: undo everything start did
//     status(model) -> { text, title } | null    what the status bar shows for a file
//     rehome?()                 project folders changed (a folder opened or closed in a tree)
//   }
// host = {
//   rootOf(path)               the project folder a file belongs to
//   changed()                  call when status() would answer differently
// }
//
// They all run only while 效能 › 語言解析器 is on (Procoder's own setting).
import { data } from './prefs.js';

const mods = [];
const watchers = new Set();
let monaco = null;
let running = false;
let rootOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
let openAt = null;

const host = {
  rootOf: (path) => rootOf(path),
  changed: () => watchers.forEach((fn) => fn()),
};

export const analysisOn = () => data.get('analysis') !== false;
export const setAnalysis = (on) => data.set('analysis', !!on);

// Procoder (index.js) says how projects are found and how a file is opened.
export function initModules(options) {
  rootOf = options.rootOf;
  openAt = options.openAt;
}

export function moduleStatus(model) {
  if (!running || !model) return null;
  for (const m of mods) {
    const s = m.status(model);
    if (s) return s;
  }
  return null;
}
export function rehomeModules() {
  if (running) for (const m of mods) m.rehome?.();
}
export function onModuleStatus(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function sync() {
  const want = analysisOn() && !!monaco;
  if (want === running) return;
  running = want;
  for (const m of mods) {
    try {
      if (want) m.start(monaco, host);
      else m.stop();
    } catch (err) {
      console.error(`Procoder module ${m.id}:`, err);
    }
  }
  host.changed();
}

// Called once Monaco is loaded: loads the modules and starts them if wanted.
let loading = null;
export function loadModules(m) {
  if (loading) return loading;
  monaco = m;
  // "Go to definition" into a file on the host opens it in Procoder.
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selection) {
      if (resource.scheme !== 'sftp' || !openAt) return false;
      const pos = selection ? ('startLineNumber' in selection ? { lineNumber: selection.startLineNumber, column: selection.startColumn } : selection) : null;
      openAt(resource.path, pos, source);
      return true;
    },
  });
  loading = (async () => {
    const ids = await fetch('/api/apps/editor/modules').then((r) => (r.ok ? r.json() : []), () => []);
    for (const id of ids) {
      try {
        const mod = (await import(`./modules/${id}/index.js`)).default;
        if (mod && typeof mod.start === 'function') mods.push(mod);
      } catch (err) {
        console.error(`Procoder module ${id} failed to load:`, err);
      }
    }
    await data.ready();
    sync();
    data.onChange(sync);
  })();
  return loading;
}
