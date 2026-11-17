// Server side of the tmux app (public/js/apps/tmux): list, create, rename and
// close tmux sessions and windows on the host. Only these fixed tmux commands
// run; names are checked and quoted. Attaching is done in a terminal (the page
// types `tmux attach`), not here.
import { execCapture } from '../ssh.js';
import { codeError, reqPath } from '../util.js';

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// tmux does not allow . or : in session names; nothing invisible either
const NAME = /^[^\0-\x1f.:]{1,64}$/u;
const name = (v) => {
  if (typeof v !== 'string' || !NAME.test(v)) throw codeError('bad-request', 'Invalid name');
  return v;
};
const index = (v) => {
  if (!Number.isInteger(v) || v < 0 || v > 99999) throw codeError('bad-request', 'Invalid window');
  return v;
};
const session = (v) => quote('=' + name(v)); // = : exactly this name, not a prefix
const win = (s, i) => quote('=' + name(s) + ':' + index(i));

// Runs tmux; resolves to its output, or throws its error message.
async function tmux(client, args) {
  // -u: UTF-8 even without a UTF-8 locale (otherwise tabs and non-ASCII names come out as _)
  const out = await execCapture(client, `tmux -u ${args} 2>&1; echo "__exit=$?"`, 512 * 1024, 15000);
  const m = /__exit=(\d+)\s*$/.exec(out);
  const text = m ? out.slice(0, m.index) : out;
  if (!m || m[1] !== '0') throw codeError('tmux', text.trim().split('\n').pop() || 'tmux failed');
  return text;
}

export async function tmuxList({ client }) {
  const sep = '\t';
  let text;
  try {
    text = await tmux(client, `list-windows -a -F ${quote(['#{session_name}', '#{session_attached}', '#{session_created}', '#{window_index}', '#{window_name}', '#{window_active}', '#{pane_current_path}', '#{window_panes}'].join(sep))}`);
  } catch (err) {
    // no tmux server running yet = no sessions
    if (/no server running|error connecting|no sessions/i.test(err.message)) return { sessions: [] };
    throw err;
  }
  const sessions = new Map();
  for (const line of text.split('\n')) {
    const f = line.split(sep);
    if (f.length < 8) continue;
    const [sname, attached, created, idx, wname, active, path, panes] = f;
    if (!sessions.has(sname)) sessions.set(sname, { name: sname, attached: Number(attached) || 0, created: Number(created) || 0, windows: [] });
    sessions.get(sname).windows.push({ index: Number(idx), name: wname, active: active === '1', path, panes: Number(panes) || 1 });
  }
  return { sessions: [...sessions.values()].sort((a, b) => a.created - b.created) };
}

export async function tmuxDo({ client }, msg) {
  switch (msg.action) {
    case 'new':
      await tmux(client, `new-session -d -s ${quote(name(msg.name))}${msg.cwd ? ' -c ' + quote(reqPath(msg.cwd)) : ''}`);
      break;
    case 'rename':
      await tmux(client, `rename-session -t ${session(msg.name)} ${quote(name(msg.to))}`);
      break;
    case 'kill':
      await tmux(client, `kill-session -t ${session(msg.name)}`);
      break;
    case 'newWindow':
      await tmux(client, `new-window -t ${quote('=' + name(msg.name) + ':')}${msg.cwd ? ' -c ' + quote(reqPath(msg.cwd)) : ''}`);
      break;
    case 'selectWindow':
      await tmux(client, `select-window -t ${win(msg.name, msg.index)}`);
      break;
    case 'renameWindow':
      await tmux(client, `rename-window -t ${win(msg.name, msg.index)} ${quote(name(msg.to))}`);
      break;
    case 'killWindow':
      await tmux(client, `kill-window -t ${win(msg.name, msg.index)}`);
      break;
    default:
      throw codeError('bad-request', 'Unknown tmux action');
  }
  return {};
}
