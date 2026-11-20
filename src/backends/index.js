// Backends: how the server reaches the machine behind the desktop.
//
//   ssh  an SSH server (ssh2: SFTP + exec + shell). The original and default.
//   mcp  a remote MCP server (Streamable HTTP) that offers the Remogui tools;
//        see docs/MCP.md, and agent/ for two servers (Node.js and Python).
//
// A backend is `connect(msg, env) -> { client, sftp, info, onClose(fn), end() }`:
// `client` has exec() and shell(), `sftp` the SFTP calls the ops make. The ops
// never know which backend is behind them.
import { codeError } from '../util.js';
import { connectSsh } from './ssh.js';
import { connectMcp } from './mcp.js';

export const backends = { ssh: connectSsh, mcp: connectMcp };

export function pickBackend(msg) {
  const mode = msg.mode == null || msg.mode === '' ? 'ssh' : String(msg.mode);
  if (!Object.hasOwn(backends, mode)) throw codeError('bad-request', `Unknown mode: ${mode}`);
  return backends[mode];
}
