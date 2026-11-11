// Copies the prebuilt Monaco editor (the editor core of VS Code) into public/vs
// so it is served as a static asset next to the Worker.
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
