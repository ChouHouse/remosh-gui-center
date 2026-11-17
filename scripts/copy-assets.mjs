// Copies the prebuilt Monaco editor (the editor core of VS Code) into public/vs
// so the server can hand it out as static files.
import { cpSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readdirSync } from 'node:fs';
import { typesVersionsPath } from '../src/ops/procoder/types-versions.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const dst = join(root, 'public', 'vs');
if (!existsSync(src)) {
  console.error('monaco-editor is not installed; run `npm install` first.');
  process.exit(1);
}
rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log('Monaco copied to public/vs');

// xterm.js (terminal emulator) as ES modules + its stylesheet -> public/xterm
const xdst = join(root, 'public', 'xterm');
rmSync(xdst, { recursive: true, force: true });
cpSync(join(root, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.mjs'), join(xdst, 'xterm.mjs'));
cpSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), join(xdst, 'xterm.css'));
cpSync(join(root, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.mjs'), join(xdst, 'addon-fit.mjs'));
console.log('xterm copied to public/xterm');

// pyright (basedpyright's browser build), Procoder's Python checker -> public/pyright.
// It is large, so a gzipped copy is kept next to it for browsers that accept it.
const pdst = join(root, 'public', 'pyright');
rmSync(pdst, { recursive: true, force: true });
mkdirSync(pdst, { recursive: true });
const worker = readFileSync(join(root, 'node_modules', 'browser-basedpyright', 'dist', 'pyright.worker.js'));
writeFileSync(join(pdst, 'pyright.worker.js'), worker);
writeFileSync(join(pdst, 'pyright.worker.js.gz'), gzipSync(worker, { level: 9 }));
cpSync(join(root, 'node_modules', 'browser-basedpyright', 'LICENSE.txt'), join(pdst, 'LICENSE.txt'));
console.log('pyright copied to public/pyright');

// Node.js's own modules described for TypeScript (@types/node with undici-types),
// for Procoder's Node.js module to use when a project has no @types/node of its
// own -> public/types/node.json (+ .gz): { modules, files: { path: text } }.
// Only the files the browser's TypeScript version reads (typesVersions).
{
  const tsVersion = /typescriptVersion = "([\d.]+)"/.exec(readFileSync(join(root, 'node_modules', 'monaco-editor', 'esm', 'vs', 'language', 'typescript', 'monaco.contribution.js'), 'utf8'))?.[1];
  const nodeDir = join(root, 'node_modules', '@types', 'node');
  const pkg = JSON.parse(readFileSync(join(nodeDir, 'package.json'), 'utf8'));
  const files = {};
  const visit = (rel) => {
    const key = 'node_modules/@types/node/' + rel;
    if (key in files) return;
    const text = readFileSync(join(nodeDir, rel), 'utf8');
    files[key] = text;
    for (const m of text.matchAll(/\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]/g)) {
      const next = join(rel, '..', m[1]).replace(/\\/g, '/');
      visit(next);
    }
  };
  visit(typesVersionsPath(pkg, 'index.d.ts', tsVersion));
  const undici = join(root, 'node_modules', 'undici-types');
  for (const f of readdirSync(undici)) {
    if (f.endsWith('.d.ts') || f === 'package.json') files['node_modules/undici-types/' + f] = readFileSync(join(undici, f), 'utf8');
  }
  const modules = [...new Set(Object.values(files).flatMap((t) => [...t.matchAll(/declare module ['"]([^'"]+)['"]/g)].map((m) => m[1])))].sort();
  const tdst = join(root, 'public', 'types');
  rmSync(tdst, { recursive: true, force: true });
  mkdirSync(tdst, { recursive: true });
  const json = Buffer.from(JSON.stringify({ name: '@types/node', version: pkg.version, typescript: tsVersion, modules, files }));
  writeFileSync(join(tdst, 'node.json'), json);
  writeFileSync(join(tdst, 'node.json.gz'), gzipSync(json, { level: 9 }));
  cpSync(join(nodeDir, 'LICENSE'), join(tdst, 'LICENSE-types-node.txt'));
  console.log(`@types/node ${pkg.version} (${Object.keys(files).length} files, for TypeScript ${tsVersion}) -> public/types`);
}
