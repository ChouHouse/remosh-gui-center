// Python code intelligence for Procoder. The type checker (pyright) runs in the
// browser; it needs the files a program imports, which live on the host. This
// op asks the host's own python3 to find them (py/collect.py: it reads and
// parses files, it never imports or runs them) and hands back their text.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCapture } from '../ssh.js';
import { codeError, reqPath } from '../util.js';

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'py', 'collect.py'), 'utf8');
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const MAX_BYTES = 24 * 1024 * 1024;

export async function pyCollect({ client }, msg) {
  const root = reqPath(msg.root);
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const input = JSON.stringify({
    root,
    files: strings(msg.files).slice(0, 50),
    code: strings(msg.code).slice(0, 50).map((t) => t.slice(0, 2 * 1024 * 1024)),
    skip: strings(msg.skip).slice(0, 20000),
    maxFiles: 1500,
    maxBytes: MAX_BYTES,
  });
  // `-I`: isolated mode, so nothing from the current folder or the environment is loaded.
  const out = await execCapture(client, `command -v python3 >/dev/null 2>&1 || exit 127; python3 -I -c ${quote(SCRIPT)}`, MAX_BYTES * 2, 90000, input);
  if (!out.trim()) throw codeError('no-python', 'python3 is not available on this host');
  try {
    return JSON.parse(out);
  } catch {
    throw codeError('failure', 'Unexpected answer from python3');
  }
}
