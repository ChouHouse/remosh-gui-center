// SSH backend: logs in to an SSH server and returns what the ops use, an ssh2
// `client` (exec / shell) and its `sftp` channel. Every backend has the same
// shape; see src/backends/index.js.
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { CONNECT_TIMEOUT_MS } from '../ssh.js';
import { openSocket } from '../net.js';
import { call, codeError, hostAllowed } from '../util.js';

const { Client, utils } = ssh2;

const MAX_KEY_CHARS = 32 * 1024;

export async function connectSsh(msg, env) {
  const host = String(msg.host || '').trim();
  const port = Number(msg.port || 22);
  const username = String(msg.username || '');
  const password = String(msg.password ?? '');
  if (!host || !/^[A-Za-z0-9.\-:_]+$/.test(host)) throw codeError('bad-request', 'Invalid host');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw codeError('bad-request', 'Invalid port');
  if (!username) throw codeError('bad-request', 'Username is required');
  // Optional private key (OpenSSH / PEM / PPK text). Parse it up front so a
  // wrong passphrase or unsupported file is reported before any network I/O.
  let privateKey;
  if (msg.privateKey != null && msg.privateKey !== '') {
    if (typeof msg.privateKey !== 'string' || msg.privateKey.length > MAX_KEY_CHARS) {
      throw codeError('bad-key', 'Invalid private key');
    }
    const passphrase = msg.passphrase ? String(msg.passphrase) : undefined;
    let parsed;
    try {
      parsed = utils.parseKey(msg.privateKey, passphrase);
    } catch (e) {
      parsed = e;
    }
    if (parsed instanceof Error) {
      const text = String(parsed.message || '');
      if (/no passphrase given/i.test(text)) throw codeError('key-needs-passphrase', text);
      if (passphrase && /passphrase|decrypt|integrity|MAC|bad/i.test(text)) throw codeError('key-bad-passphrase', text);
      throw codeError('bad-key', text || 'Cannot read private key');
    }
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key.isPrivateKey()) throw codeError('bad-key', 'This is a public key, not a private key');
    privateKey = { key: msg.privateKey, passphrase };
  }
  if (!hostAllowed(env?.ALLOWED_HOSTS, host, port)) {
    throw codeError('host-not-allowed', 'This host is not on the allowlist');
  }

  let sock; // a Node Duplex stream connected to the SSH server
  try {
    sock = await openSocket(host, port, CONNECT_TIMEOUT_MS);
  } catch (err) {
    if (err?.code === 'connect-timeout') throw err;
    throw codeError('connect-failed', err?.message || 'Could not reach the host');
  }

  const client = new Client();
  let fingerprint = null;
  try {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.once('close', () => reject(codeError('closed', 'Connection closed')));
      client.connect({
        sock,
        username,
        ...(privateKey
          ? { privateKey: privateKey.key, passphrase: privateKey.passphrase }
          : { password, tryKeyboard: true }),
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: 20000,
        keepaliveCountMax: 3,
        hostVerifier: (key) => {
          fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          // Trust-on-first-use: the browser remembers the fingerprint and
          // sends it back on later logins.
          return !msg.expectedFingerprint || msg.expectedFingerprint === fingerprint;
        },
      });
      // Servers that only offer keyboard-interactive: answer prompts with the password.
      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => password));
      });
    });
    const sftp = await new Promise((resolve, reject) => {
      client.sftp((err, s) => (err ? reject(err) : resolve(s)));
    });
    client.removeAllListeners('error');
    client.removeAllListeners('close');
    client.on('error', () => {});
    const home = await call(sftp, 'realpath', '.');
    // Same server and account -> same id, in every tab; used to refuse pasting
    // files copied from somewhere else.
    const domain = createHash('sha256').update(`${fingerprint}\0${username}`).digest('hex').slice(0, 12);
    return {
      client,
      sftp,
      info: { mode: 'ssh', home, fingerprint, username, host, port, domain },
      onClose: (fn) => client.on('close', fn),
      end: () => client.end(),
    };
  } catch (err) {
    try {
      client.end();
    } catch {
      /* ignore */
    }
    if (fingerprint && msg.expectedFingerprint && msg.expectedFingerprint !== fingerprint) {
      const e = codeError('hostkey-changed', 'Host key does not match the remembered one');
      e.fingerprint = fingerprint;
      throw e;
    }
    throw err;
  }
}
