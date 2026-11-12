// Copies the prebuilt Monaco editor (the editor core of VS Code) into public/vs
// so the server can hand it out as static files.
import { cpSync, rmSync, existsSync } from 'node:fs';
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
