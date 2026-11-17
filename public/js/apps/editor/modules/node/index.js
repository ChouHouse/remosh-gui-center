// Procoder module: Node.js (JavaScript and TypeScript) across files.
//
// Monaco already has TypeScript's language service, in the browser: it gives
// completion, hover, errors and "go to definition", but only knows the files it
// has been given. This module gives it the files a program imports, read from
// the host by the server's `jsCollect` op (src/ops/procoder/node.js): the
// project's own files, the type declarations of packages in node_modules
// (and @types), and @types/node for Node's own modules. They are added to the
// service as "extra libraries" under the same names as Procoder's files
// (sftp://remote/<path>), so imports resolve as they would on the host.
// Nothing is installed or run on the host.
//
// A project without @types/node of its own (plain JavaScript usually has none)
// still gets Node's own modules (os, fs, path ...) and globals (process,
// Buffer): Remogui carries a copy, /types/node.json, built from @types/node at
// build time and fetched only when a file uses Node.
import { rpc } from '../../../../core/rpc.js';
import { errText } from '../../../../core/errors.js';
import { tt, tm } from '../../../../core/i18n.js';

const LANGS = new Set(['javascript', 'typescript']);
const COLLECT_AFTER_MS = 1200;
const STATES = {
  loading: tm('Node.js：讀取中…'),
  ready: tm('Node.js：可提示'),
  error: tm('Node.js：無法讀取'),
};

let monaco = null;
let host = null;
const sessions = new Map(); // project folder -> { root, models, libs, imports, timer, state, note, busy, again }
let disposables = [];

// ---- Remogui's own @types/node, shared by every project that needs it
const BUNDLE = '/types/node.json';
let bundle = null; // promise of { modules, files }
let bundleLibs = null; // the extra libs while added
let bundleUsers = 0;
const loadBundle = () => (bundle ??= fetch(BUNDLE).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status)))).catch((err) => {
  bundle = null;
  throw err;
}));
async function useBundle() {
  const b = await loadBundle();
  bundleUsers++;
  if (!bundleLibs) {
    const ts = monaco.languages.typescript;
    bundleLibs = Object.entries(b.files).flatMap(([path, text]) => {
      const name = 'inmemory://remogui/' + path; // not a file on the host
      return [ts.typescriptDefaults.addExtraLib(text, name), ts.javascriptDefaults.addExtraLib(text, name)];
    });
  }
}
function releaseBundle() {
  if (--bundleUsers > 0 || !bundleLibs) return;
  bundleLibs.forEach((d) => d.dispose());
  bundleLibs = null;
}
// Does this code use Node? An import of one of its modules, or its globals.
const NODE_GLOBALS = /\b(?:process\.|__dirname|__filename|Buffer\.|require\s*\()/;
async function usesNode(texts) {
  if (texts.some((t) => NODE_GLOBALS.test(t) || /['"]node:[\w/]+['"]/.test(t))) return true;
  const { modules } = await loadBundle().catch(() => ({ modules: [] }));
  const names = new Set(modules);
  return texts.some((t) => [...t.matchAll(/(?:from|import|require\s*\()\s*['"]([^'"\n]+)['"]/g)].some((m) => names.has(m[1])));
}

// For the tests: what each project has been given.
export const nodeDebug = () => ({ sessions });

const isCode = (model) => model.uri.scheme === 'sftp' && !model.uri.path.startsWith('/untitled-') && LANGS.has(model.getLanguageId());
const sessionOf = (model) => [...sessions.values()].find((s) => s.models.has(model));
// What decides which files are needed: the imports, and whether Node's globals are used.
const importLines = (text) => (text.match(/(?:^|[^.\w$])(?:import|export|require)\b[^\n;]*['"][^'"\n]+['"]/g) || []).join('\n') + (NODE_GLOBALS.test(text) ? '\nnode' : '');
// The name TypeScript will look a file up by. It builds those names itself from
// the open file's (encoded) URI plus plain text such as "node_modules/@types/x",
// so the name is encoded as Monaco encodes, except for the @ of scoped packages.
const libName = (path) => monaco.Uri.from({ scheme: 'sftp', authority: 'remote', path }).toString().replace(/%40/g, '@');

function status(model) {
  const s = sessionOf(model);
  if (!s) return null;
  return { text: tt(STATES[s.state]), title: s.note };
}

async function collect(s) {
  const models = [...s.models];
  for (const m of models) s.imports.set(m, importLines(m.getValue()));
  try {
    const res = await rpc('jsCollect', { root: s.root, files: models.map((m) => m.uri.path), code: models.map((m) => m.getValue()), skip: [...s.libs.keys()], ts: monaco.languages.typescript.typescriptVersion });
    if (!sessions.has(s.root)) return; // closed meanwhile
    const ts = monaco.languages.typescript;
    for (const [path, text] of Object.entries(res.files || {})) {
      // an open file is already known to the service as itself
      if (s.libs.has(path) || monaco.editor.getModel(monaco.Uri.from({ scheme: 'sftp', authority: 'remote', path }))) continue;
      const name = libName(path);
      s.libs.set(path, [ts.typescriptDefaults.addExtraLib(text, name), ts.javascriptDefaults.addExtraLib(text, name)]);
    }
    // No @types/node in the project: Remogui's own, when the code uses Node.
    const hostTypes = [...s.libs.keys()].some((p) => p.includes('/node_modules/@types/node/'));
    const wantBundle = !hostTypes && (await usesNode(models.map((m) => m.getValue())));
    if (!sessions.has(s.root)) return;
    if (wantBundle && !s.bundled) {
      s.bundled = true;
      await useBundle().catch(() => {
        s.bundled = false;
      });
    } else if (!wantBundle && s.bundled) {
      s.bundled = false;
      releaseBundle();
    }
    s.state = 'ready';
    s.note = tt('已讀入 {0} 個檔案', s.libs.size)
      + (s.bundled ? ' — ' + tt('這個專案沒有 @types/node，Node.js 內建模組用 Remogui 附帶的型別說明') : '')
      + (res.more ? ' — ' + tt('這個專案用到的檔案太多，只讀了一部分，有些提示可能不完整') : '');
  } catch (err) {
    s.state = 'error';
    s.note = tt('讀取主機上的檔案失敗：{0}', errText(err));
  }
}

function refresh(s) {
  if (s.busy) {
    s.again = true;
    return;
  }
  s.busy = (async () => {
    do {
      s.again = false;
      await collect(s);
      host.changed();
    } while (s.again && sessions.has(s.root));
    s.busy = null;
  })();
}

function track(model) {
  if (!isCode(model) || sessionOf(model)) return;
  const root = host.rootOf(model.uri.path);
  let s = sessions.get(root);
  if (!s) {
    s = { root, models: new Set(), libs: new Map(), imports: new Map(), timer: 0, state: 'loading', note: '', busy: null, again: false };
    sessions.set(root, s);
  }
  s.models.add(model);
  // An open file may have been given as a library before (it was imported): it is itself now.
  const lib = s.libs.get(model.uri.path);
  if (lib) {
    lib.forEach((d) => d.dispose());
    s.libs.delete(model.uri.path);
  }
  host.changed();
  refresh(s);
}

function drop(s) {
  clearTimeout(s.timer);
  if (s.bundled) {
    s.bundled = false;
    releaseBundle();
  }
  for (const lib of s.libs.values()) lib.forEach((d) => d.dispose());
  s.libs.clear();
  sessions.delete(s.root);
}

function untrack(model) {
  const s = sessionOf(model);
  if (!s) return;
  s.models.delete(model);
  s.imports.delete(model);
  if (!s.models.size) drop(s);
  host.changed();
}

function edited(model) {
  const s = sessionOf(model);
  if (!s || importLines(model.getValue()) === s.imports.get(model)) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => refresh(s), COLLECT_AFTER_MS);
}

function start(m, h) {
  monaco = m;
  host = h;
  const watch = (model) => {
    disposables.push(
      model.onDidChangeContent(() => edited(model)),
      model.onDidChangeLanguage(() => (isCode(model) ? track(model) : untrack(model))),
    );
    track(model);
  };
  monaco.editor.getModels().forEach(watch);
  disposables.push(monaco.editor.onDidCreateModel(watch), monaco.editor.onWillDisposeModel(untrack));
}

function stop() {
  for (const d of disposables) d.dispose();
  disposables = [];
  for (const s of [...sessions.values()]) drop(s);
}

function rehome() {
  for (const s of [...sessions.values()]) {
    for (const model of [...s.models]) {
      if (host.rootOf(model.uri.path) === s.root) continue;
      untrack(model);
      track(model);
    }
  }
}

export default { id: 'node', start, stop, status, rehome };
