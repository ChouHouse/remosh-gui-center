// Interactive terminals: an SSH shell channel with a PTY per terminal window.
// Output is pushed to the page as { event: 'term:data', tid, data } messages.
import { Buffer } from 'node:buffer';
import { codeError } from '../util.js';

const MAX_TERMINALS = 8;
const size = (v, fallback, max) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 2 ? Math.min(n, max) : fallback;
};

function get(session, msg) {
  const term = session.terms.get(msg.tid);
  if (!term) throw codeError('no-terminal', 'Terminal is closed');
  return term;
}

export function termOpen({ client, session }, msg) {
  if (session.terms.size >= MAX_TERMINALS) throw codeError('too-many', 'Too many terminals');
  const cols = size(msg.cols, 80, 500);
  const rows = size(msg.rows, 24, 300);
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) return reject(codeError('exec-failed', err.message || 'Cannot open a shell on this host'));
      const tid = ++session.termSeq;
      session.terms.set(tid, stream);
      const push = (chunk) => session.send({ event: 'term:data', tid, data: Buffer.from(chunk).toString('base64') });
      stream.on('data', push);
      stream.stderr.on('data', push);
      stream.on('close', () => {
        session.terms.delete(tid);
        session.send({ event: 'term:exit', tid });
      });
      resolve({ tid, cols, rows });
    });
  });
}

export function termInput({ session }, msg) {
  if (typeof msg.data !== 'string' || msg.data.length > 256 * 1024) throw codeError('bad-request', 'Invalid input');
  get(session, msg).write(msg.data);
  return {};
}

export function termResize({ session }, msg) {
  get(session, msg).setWindow(size(msg.rows, 24, 300), size(msg.cols, 80, 500), 0, 0);
  return {};
}

export function termClose({ session }, msg) {
  session.terms.get(msg.tid)?.close();
  return {};
}
