// Which commands the host has: apps say what they need (registerApp's
// `requires`), the page asks once after login. A command found only by a login
// shell (installed with nvm, pyenv, ~/.local/bin ...) counts too.
import { execCapture } from '../ssh.js';
import { codeError } from '../util.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export async function hasCommands({ client }, msg) {
  const names = Array.isArray(msg.names) ? [...new Set(msg.names)] : [];
  if (!names.length) return { found: [] };
  if (names.length > 50 || !names.every((n) => typeof n === 'string' && NAME.test(n))) throw codeError('bad-request', 'Invalid command name');
  const list = names.join(' ');
  const script = `missing=''
for c in ${list}; do if command -v "$c" >/dev/null 2>&1; then echo "$c"; else missing="$missing $c"; fi; done
if [ -n "$missing" ]; then "\${SHELL:-/bin/sh}" -lc 'for c in '"$missing"'; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done' </dev/null 2>/dev/null; fi`;
  const out = await execCapture(client, script, 64 * 1024, 15000);
  // a login shell may print a greeting: only exact names count
  const found = new Set(out.split('\n').map((l) => l.trim()).filter((l) => names.includes(l)));
  return { found: [...found] };
}
