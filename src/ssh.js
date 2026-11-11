// SSH plumbing: the TCP socket adapter, the algorithms workerd can run, and a
// helper that runs one command and captures its output.
import { Duplex } from 'node:stream';
import { Buffer } from 'node:buffer';
import { codeError } from './util.js';

export const CONNECT_TIMEOUT_MS = 20000;

// workerd's node:crypto cannot run ssh2's AEAD paths (AES-GCM needs the auth
// tag before update(); chacha20-poly1305 needs the native addon), so negotiate
// AES-CTR + HMAC-SHA2, which every OpenSSH server offers by default.
export const ALGORITHMS = {
  cipher: ['aes256-ctr', 'aes192-ctr', 'aes128-ctr'],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ],
  compress: ['none'],
};

export function socketToDuplex(socket) {
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const duplex = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      writer.write(chunk).then(() => cb(), cb);
    },
    final(cb) {
      writer.close().then(() => cb(), () => cb());
    },
    destroy(err, cb) {
      socket.close().catch(() => {});
      cb(err);
    },
  });
  duplex.setNoDelay = () => duplex;
  duplex.setKeepAlive = () => duplex;
  duplex.setTimeout = () => duplex;
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        duplex.push(Buffer.from(value));
      }
      duplex.push(null);
    } catch (err) {
      duplex.destroy(err);
    }
  })();
  return duplex;
}

export function execCapture(client, command, limit = 512 * 1024, timeoutMs = 15000) {
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
      stream.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
  });
}
