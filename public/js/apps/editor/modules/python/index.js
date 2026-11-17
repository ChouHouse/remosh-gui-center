// Procoder module: Python code intelligence. Completion, hover, signature
// help, errors and "go to definition", also into the modules a file imports.
// Server side: src/ops/procoder/python.js.
//
// The type checker is pyright (basedpyright's browser build, /pyright/). It
// runs in this browser, in Web Workers; nothing is installed on the host. What
// it needs from the host is the text of the files a program imports. The
// server's `pyCollect` op asks the host's own python3 for them: it finds and
// reads the files and parses their imports, it never imports or runs anything.
// Those files are given to pyright as its (in-memory) file system.
//
// pyright takes its files once, when it starts. When an edit brings in an
// import that needs files it does not have, they are fetched and pyright is
// started again with the larger set.
import { rpc } from '../../../../core/rpc.js';
import { P } from '../../../../core/path.js';
import { errText } from '../../../../core/errors.js';
import { tt, tm } from '../../../../core/i18n.js';

const WORKER = '/pyright/pyright.worker.js';
const COLLECT_AFTER_MS = 1200; // pause after an edit to the imports before fetching more files

let monaco = null;
let host = null; // from Procoder: rootOf(path), changed()
const sessions = new Map(); // project folder -> session
let disposables = [];

// For the tests: the running checkers and a way to ask them directly.
export const pyDebug = () => ({ sessions, request });

// What the status bar shows for a file: null when it is not Python.
const STATES = {
  loading: tm('Python：分析中…'),
  ready: tm('Python：可提示'),
  error: tm('Python：無法分析'),
};
function status(model) {
  const s = [...sessions.values()].find((x) => x.models.has(model));
  if (!s || s.state === 'off') return null;
  return { text: tt(STATES[s.state]), title: s.note || '' };
}
const changed = () => host?.changed();

const fileUri = (path) => 'file://' + path.split('/').map(encodeURIComponent).join('/');
const pathOfUri = (uri) => decodeURIComponent(new URL(uri).pathname);
const pathOfModel = (model) => model.uri.path;
const modelOfPath = (path) => monaco?.editor.getModel(monaco.Uri.from({ scheme: 'sftp', authority: 'remote', path }));
const isPython = (model) => model.uri.scheme === 'sftp' && !model.uri.path.startsWith('/untitled-') && model.getLanguageId() === 'python';
const importLines = (text) => text.split('\n').filter((l) => /^\s*(import|from)\s/.test(l)).join('\n');

// ---- one pyright per project folder
function sessionFor(root) {
  let s = sessions.get(root);
  if (!s) {
    s = { root, models: new Set(), files: {}, paths: [], python: null, state: 'loading', note: '', workers: [], send: null, pending: new Map(), seq: 0, versions: new Map(), imports: new Map(), timer: 0, gen: 0, booting: null };
    sessions.set(root, s);
  }
  return s;
}

function halt(s) {
  s.gen++;
  for (const w of s.workers) w.terminate();
  s.workers = [];
  s.send = null;
  for (const [, p] of s.pending) p.reject(new Error('stopped'));
  s.pending.clear();
}

// Fetches the files the open models import (beyond those already here).
// Resolves to true when new files came in.
async function collect(s) {
  const models = [...s.models];
  for (const m of models) s.imports.set(m, importLines(m.getValue()));
  try {
    const res = await rpc('pyCollect', {
      root: s.root,
      code: models.map((m) => m.getValue()),
      skip: Object.keys(s.files),
    });
    s.paths = res.paths || [];
    s.python = res.python || null;
    const fresh = Object.keys(res.files || {}).filter((f) => !(f in s.files));
    Object.assign(s.files, res.files || {});
    s.note = res.more ? tt('這個專案用到的檔案太多，只讀了一部分，有些提示可能不完整') : '';
    if (s.state === 'off') s.state = 'loading';
    return fresh.length > 0;
  } catch (err) {
    if (err.code === 'no-python') {
      // No Python on the host: no analysis at all, and nothing in the status bar.
      s.state = 'off';
      s.note = '';
      halt(s);
      for (const m of s.models) monaco.editor.setModelMarkers(m, 'pyright', []);
    } else {
      s.note = tt('讀取主機上的 Python 檔案失敗：{0}', errText(err));
    }
    return false;
  }
}

// Starts (or restarts) pyright with the files collected so far.
async function boot(s) {
  halt(s);
  const gen = s.gen;
  const config = {
    extraPaths: s.paths.filter((p) => p !== s.root),
    typeCheckingMode: 'standard',
    reportMissingModuleSource: false,
    ...(s.python ? { pythonVersion: s.python } : {}),
  };
  const files = { ...s.files, [P.join(s.root, 'pyrightconfig.json')]: JSON.stringify(config) };
  for (const m of s.models) files[pathOfModel(m)] = m.getValue();

  const fg = new Worker(WORKER, { name: 'pyright' });
  s.workers.push(fg);
  fg.postMessage({ type: 'browser/boot', mode: 'foreground' });
  fg.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m?.type === 'browser/newWorker') {
      // pyright asks for a background worker; it sends the channel to talk over
      const bg = new Worker(WORKER, { name: 'pyright-background' });
      s.workers.push(bg);
      bg.postMessage({ type: 'browser/boot', mode: 'background', initialData: m.initialData, port: m.port }, [m.port]);
      return;
    }
    if (!m || m.jsonrpc !== '2.0' || gen !== s.gen) return;
    if (m.method === undefined && s.pending.has(m.id)) {
      const p = s.pending.get(m.id);
      s.pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.id !== undefined && m.method) {
      // requests from pyright: configuration comes from pyrightconfig.json, the rest is not needed
      fg.postMessage({ jsonrpc: '2.0', id: m.id, result: m.method === 'workspace/configuration' ? m.params.items.map(() => ({})) : null });
      return;
    }
    if (m.method === 'textDocument/publishDiagnostics') showDiagnostics(m.params);
  });
  fg.addEventListener('error', () => {
    if (gen !== s.gen) return;
    s.state = 'error';
    s.note = tt('Python 分析器無法啟動');
    changed();
  });
  s.send = (msg) => fg.postMessage({ jsonrpc: '2.0', ...msg });
  const root = fileUri(s.root);
  await request(s, 'initialize', {
    processId: null,
    rootUri: root,
    workspaceFolders: [{ name: P.base(s.root) || '/', uri: root }],
    initializationOptions: { files },
    capabilities: {
      workspace: { configuration: true },
      textDocument: {
        completion: { completionItem: { documentationFormat: ['markdown', 'plaintext'], snippetSupport: false }, contextSupport: true },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
        definition: { linkSupport: false },
        publishDiagnostics: { tagSupport: { valueSet: [1, 2] } },
      },
    },
  });
  if (gen !== s.gen) return;
  s.send({ method: 'initialized', params: {} });
  for (const m of s.models) open(s, m);
  s.state = 'ready';
  changed();
}

function request(s, method, params) {
  if (!s.send) return Promise.reject(new Error('not running'));
  const id = ++s.seq;
  return new Promise((resolve, reject) => {
    s.pending.set(id, { resolve, reject });
    s.send({ id, method, params });
  });
}

function open(s, model) {
  const v = (s.versions.get(model) || 0) + 1;
  s.versions.set(model, v);
  s.send?.({ method: 'textDocument/didOpen', params: { textDocument: { uri: fileUri(pathOfModel(model)), languageId: 'python', version: v, text: model.getValue() } } });
}

// Fetch what is missing, then (re)start. Runs one at a time per project.
function refresh(s) {
  if (s.booting) {
    s.again = true;
    return s.booting;
  }
  s.booting = (async () => {
    do {
      s.again = false;
      const fresh = await collect(s);
      if (s.state !== 'off' && (fresh || !s.send)) {
        await boot(s).catch((err) => {
          if (err.message === 'stopped') return; // started again meanwhile
          s.state = 'error';
          s.note = errText(err);
        });
      }
      changed();
    } while (s.again);
    s.booting = null;
  })();
  return s.booting;
}

function track(model) {
  if (!isPython(model) || [...sessions.values()].some((x) => x.models.has(model))) return;
  const s = sessionFor(host.rootOf(pathOfModel(model)));
  s.models.add(model);
  changed();
  if (s.send) open(s, model);
  refresh(s);
}

function untrack(model) {
  for (const s of sessions.values()) {
    if (!s.models.delete(model)) continue;
    monaco.editor.setModelMarkers(model, 'pyright', []);
    s.send?.({ method: 'textDocument/didClose', params: { textDocument: { uri: fileUri(pathOfModel(model)) } } });
    s.versions.delete(model);
    s.imports.delete(model);
    if (!s.models.size) {
      halt(s);
      clearTimeout(s.timer);
      sessions.delete(s.root);
    }
    changed();
  }
}

function edited(model) {
  const s = [...sessions.values()].find((x) => x.models.has(model));
  if (!s) return;
  if (s.send) {
    const v = (s.versions.get(model) || 0) + 1;
    s.versions.set(model, v);
    s.send({ method: 'textDocument/didChange', params: { textDocument: { uri: fileUri(pathOfModel(model)), version: v }, contentChanges: [{ text: model.getValue() }] } });
  }
  // A changed import may need files pyright does not have yet.
  if (importLines(model.getValue()) !== s.imports.get(model)) {
    clearTimeout(s.timer);
    s.timer = setTimeout(() => refresh(s), COLLECT_AFTER_MS);
  }
}

function showDiagnostics({ uri, diagnostics }) {
  const model = modelOfPath(pathOfUri(uri));
  if (!model || model.isDisposed()) return;
  const S = monaco.MarkerSeverity;
  const severity = { 1: S.Error, 2: S.Warning, 3: S.Info, 4: S.Hint };
  monaco.editor.setModelMarkers(model, 'pyright', diagnostics.map((d) => ({
    severity: severity[d.severity] || S.Info,
    message: d.message,
    source: 'Python',
    code: typeof d.code === 'object' ? String(d.code.value) : d.code === undefined ? undefined : String(d.code),
    tags: d.tags,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
  })));
}

// ---- Monaco providers, for every Python model
const ready = (model) => {
  const s = [...sessions.values()].find((x) => x.models.has(model));
  return s?.send ? s : null;
};
const at = (model, position) => ({ textDocument: { uri: fileUri(pathOfModel(model)) }, position: { line: position.lineNumber - 1, character: position.column - 1 } });
const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const markdown = (doc) => (doc == null ? undefined : typeof doc === 'string' ? { value: doc } : { value: doc.value });
// LSP CompletionItemKind (1-based) -> Monaco's
const KINDS = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];

function register() {
  const L = monaco.languages;
  return [L.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    async provideCompletionItems(model, position) {
      const s = ready(model);
      if (!s) return { suggestions: [] };
      let res;
      try {
        res = await request(s, 'textDocument/completion', at(model, position));
      } catch {
        return { suggestions: [] };
      }
      const items = Array.isArray(res) ? res : res?.items || [];
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        incomplete: !!res?.isIncomplete,
        suggestions: items.map((it) => ({
          label: it.label,
          kind: L.CompletionItemKind[KINDS[(it.kind || 1) - 1]] ?? L.CompletionItemKind.Text,
          detail: it.detail,
          documentation: markdown(it.documentation),
          insertText: it.textEdit?.newText ?? it.insertText ?? it.label,
          range: it.textEdit ? toRange(it.textEdit.range || it.textEdit.replace) : range,
          sortText: it.sortText,
          filterText: it.filterText,
          lsp: it,
          session: s,
        })),
      };
    },
    async resolveCompletionItem(item) {
      if (item.documentation || !item.session?.send) return item;
      try {
        const full = await request(item.session, 'completionItem/resolve', item.lsp);
        item.documentation = markdown(full?.documentation);
        item.detail = full?.detail || item.detail;
      } catch { /* keep what there is */ }
      return item;
    },
  }),
  L.registerHoverProvider('python', {
    async provideHover(model, position) {
      const s = ready(model);
      if (!s) return null;
      const res = await request(s, 'textDocument/hover', at(model, position)).catch(() => null);
      if (!res?.contents) return null;
      const list = Array.isArray(res.contents) ? res.contents : [res.contents];
      return { contents: list.map((c) => (typeof c === 'string' ? { value: c } : c.language ? { value: '```' + c.language + '\n' + c.value + '\n```' } : { value: c.value })), range: res.range ? toRange(res.range) : undefined };
    },
  }),
  L.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [','],
    async provideSignatureHelp(model, position) {
      const s = ready(model);
      if (!s) return null;
      const res = await request(s, 'textDocument/signatureHelp', at(model, position)).catch(() => null);
      if (!res?.signatures?.length) return null;
      return {
        value: {
          activeSignature: res.activeSignature || 0,
          activeParameter: res.activeParameter || 0,
          signatures: res.signatures.map((sig) => ({
            label: sig.label,
            documentation: markdown(sig.documentation),
            activeParameter: sig.activeParameter,
            parameters: (sig.parameters || []).map((p) => ({ label: p.label, documentation: markdown(p.documentation) })),
          })),
        },
        dispose() {},
      };
    },
  }),
  // Go to definition: into the project's files and the installed packages on
  // the host (not into pyright's own copy of the standard library, which is
  // not on the host). Procoder opens the file.
  L.registerDefinitionProvider('python', {
    async provideDefinition(model, position) {
      const s = ready(model);
      if (!s) return null;
      const res = await request(s, 'textDocument/definition', at(model, position)).catch(() => null);
      const list = (Array.isArray(res) ? res : res ? [res] : []).map((l) => ({ uri: l.targetUri || l.uri, range: l.targetSelectionRange || l.range }));
      return list
        .filter((l) => !pathOfUri(l.uri).startsWith('/typeshed-fallback/'))
        .map((l) => ({ uri: monaco.Uri.from({ scheme: 'sftp', authority: 'remote', path: pathOfUri(l.uri) }), range: toRange(l.range) }));
    },
  })];
}

function start(m, h) {
  monaco = m;
  host = h;
  disposables = register();
  const watch = (model) => {
    disposables.push(
      model.onDidChangeContent(() => edited(model)),
      model.onDidChangeLanguage(() => (isPython(model) ? track(model) : untrack(model))),
    );
    track(model);
  };
  monaco.editor.getModels().forEach(watch);
  disposables.push(monaco.editor.onDidCreateModel(watch), monaco.editor.onWillDisposeModel(untrack));
}

function stop() {
  for (const d of disposables) d.dispose();
  disposables = [];
  for (const s of [...sessions.values()]) for (const model of [...s.models]) untrack(model);
}

// The project folder of a file changed (a folder was opened or closed in the
// tree): files move to the right pyright.
function rehome() {
  for (const s of [...sessions.values()]) {
    for (const model of [...s.models]) {
      if (host.rootOf(pathOfModel(model)) === s.root) continue;
      untrack(model);
      track(model);
    }
  }
}

export default { id: 'python', start, stop, status, rehome };
