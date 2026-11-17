// Server side of Procoder's Node.js module (public/js/apps/editor/modules/node).
// The browser's TypeScript service (part of Monaco) does the analysing; it
// needs the files a program imports. This op finds and reads them over SFTP,
// following Node's lookup rules: relative files of the project, then packages in
// node_modules (their type declarations: package.json "types"/"typings", or
// @types/<name>), and @types/node for Node's own modules. Nothing runs on the
// host, so it does not need node installed.
import { builtinModules } from 'node:module';
import { call, reqPath } from '../../util.js';

const MAX_FILES = 1500;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const BUILTIN = new Set(builtinModules);
const SOURCE_EXT = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

const IMPORTS = [
  // import x from 'y' / import 'y' / export * from 'y' / import type { a } from 'y'
  /(?:^|[^.\w$])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
  // require('y') / import('y') / import x = require('y')
  /(?:^|[^.\w$])(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const REFERENCE = /\/\/\/\s*<reference\s+(path|types)\s*=\s*['"]([^'"]+)['"]/g;

const parent = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const join = (dir, rel) => {
  const out = dir === '/' ? [] : dir.split('/').slice(1);
  for (const part of rel.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
};

export async function jsCollect({ sftp }, msg) {
  const root = reqPath(msg.root);
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const skip = new Set(strings(msg.skip));
  const files = {};
  let bytes = 0;
  let more = false;
  const stats = new Map();
  const stat = (p) => {
    if (!stats.has(p)) stats.set(p, call(sftp, 'stat', p).then((s) => ((s.mode & 0o170000) === 0o040000 ? 'dir' : 'file'), () => null));
    return stats.get(p);
  };
  const isFile = async (p) => (await stat(p)) === 'file';
  // Every SFTP request is a round trip to the host: ask about all the
  // candidates at once and take the first that exists, in order.
  const firstFile = async (cands) => {
    const found = await Promise.all(cands.map((c) => (c ? isFile(c) : false)));
    const i = found.indexOf(true);
    return i < 0 ? null : cands[i];
  };
  const read = async (p) => {
    if (p in files) return files[p];
    if (skip.has(p)) return null;
    if (Object.keys(files).length >= MAX_FILES || bytes >= MAX_BYTES) {
      more = true;
      return null;
    }
    try {
      const buf = await call(sftp, 'readFile', p);
      if (buf.length > MAX_FILE) return null;
      const text = buf.toString('utf8');
      files[p] = text;
      bytes += text.length;
      return text;
    } catch {
      return null;
    }
  };

  // A file (or folder) of the project: the file itself, with an extension, or an index.
  async function sourceFile(base) {
    const tries = [base, ...SOURCE_EXT.map((e) => base + e), ...SOURCE_EXT.map((e) => base + '/index' + e)];
    // TypeScript written for ES modules imports './x.js' meaning x.ts
    if (/\.(m|c)?js$/.test(base)) tries.unshift(base.replace(/\.(m|c)?js$/, '.ts'), base.replace(/\.(m|c)?js$/, '.d.ts'), base.replace(/\.(m|c)?js$/, '.tsx'));
    return firstFile(tries);
  }
  // The declaration file of a module path in a package (no extension, a .js, or a folder).
  async function declFile(base) {
    const stem = base.replace(/\.(m|c)?js$/, '').replace(/\.d\.ts$/, '');
    const f = await firstFile([stem + '.d.ts', stem + '.d.mts', stem + '.d.cts', stem + '/index.d.ts', base.endsWith('.ts') ? base : null, stem + '/package.json']);
    if (f && f.endsWith('/package.json')) return typesOf(stem);
    return f;
  }
  // A package's own declarations, from its package.json.
  async function typesOf(dir) {
    const text = await read(dir + '/package.json');
    let pkg = {};
    try {
      pkg = JSON.parse(text || '{}');
    } catch { /* not JSON */ }
    const named = pkg.types || pkg.typings;
    const [a, b, c] = await Promise.all([
      typeof named === 'string' ? declFile(join(dir, named)) : null,
      typeof pkg.main === 'string' ? declFile(join(dir, pkg.main)) : null,
      declFile(dir + '/index'),
    ]);
    return a || b || c;
  }
  // Walks up from `from` to the first node_modules/<name>.
  async function packageDir(name, from) {
    const cands = [];
    for (let dir = from; ; dir = parent(dir)) {
      cands.push((dir === '/' ? '' : dir) + '/node_modules/' + name + '/package.json');
      if (dir === '/') break;
    }
    const f = await firstFile(cands);
    return f ? parent(f) : null;
  }
  async function resolvePackage(spec, from) {
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
    // the package's own declarations, else DefinitelyTyped's @types/<name>
    const typesName = '@types/' + (name.startsWith('@') ? name.slice(1).replace('/', '__') : name);
    const [dir, tdir] = await Promise.all([packageDir(name, from), packageDir(typesName, from)]);
    const own = dir ? (sub ? declFile(join(dir, sub)) : typesOf(dir)) : null;
    const typed = tdir ? (sub ? declFile(join(tdir, sub)) : typesOf(tdir)) : null;
    return (await own) || (await typed);
  }

  const queue = [];
  const queued = new Set();
  const want = (spec, from, kind = 'import') => {
    const key = kind + '\0' + spec + '\0' + from;
    if (!queued.has(key)) {
      queued.add(key);
      queue.push({ spec, from, kind });
    }
  };
  const scan = (text, from) => {
    for (const re of IMPORTS) for (const m of text.matchAll(re)) want(m[1], from);
    for (const m of text.matchAll(REFERENCE)) want(m[2], from, m[1]);
  };
  for (const text of strings(msg.code)) scan(text.slice(0, MAX_FILE), root);
  for (const p of strings(msg.files)) {
    const text = await read(p);
    if (text != null) scan(text, parent(p));
  }

  const done = new Set();
  const step = async ({ spec, from, kind }) => {
    let file = null;
    if (kind === 'path') file = await sourceFile(join(from, spec));
    else if (kind === 'types' || spec.startsWith('node:') || BUILTIN.has(spec.split('/')[0])) {
      // Node's own modules are described by @types/node
      file = await resolvePackage(kind === 'types' ? spec : 'node', from === root ? root : from);
      if (!file && from !== root) file = await resolvePackage(kind === 'types' ? spec : 'node', root);
    } else if (spec.startsWith('.') || spec.startsWith('/')) file = await sourceFile(spec.startsWith('/') ? spec : join(from, spec));
    else file = await resolvePackage(spec, from);
    if (!file || done.has(file)) return;
    done.add(file);
    const text = await read(file);
    if (text != null) scan(text, parent(file));
  };
  while (queue.length && !more) await Promise.all(queue.splice(0, 48).map(step));
  return { files, more };
}
