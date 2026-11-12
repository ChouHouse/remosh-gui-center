// SSH plumbing: a helper that runs one command and captures its output.
import { Buffer } from 'node:buffer';
import { codeError } from './util.js';

export const CONNECT_TIMEOUT_MS = 20000;

// `stdin`, when given, is written to the command and closed (for secrets that
// must never appear on a command line).
export function execCapture(client, command, limit = 512 * 1024, timeoutMs = 15000, stdin = null) {
  return new Promise((resolve, reject) => {
    if (!client) return reject(codeError('not-connected', 'Not connected'));
    client.exec(command, (err, stream) => {
      if (err) return reject(codeError('exec-failed', err.message || 'Cannot run commands on this host'));
      const chunks = [];
      let size = 0;
      const timer = setTimeout(() => {
        stream.close();
        reject(codeError('timeout', 'Timed out'));
      }, timeoutMs);
      stream.on('data', (d) => {
        if (size < limit) chunks.push(d);
        size += d.length;
      });
      stream.stderr.on('data', () => {});
      if (stdin != null) stream.end(stdin);
      stream.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  });
}
