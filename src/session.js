// One Session per WebSocket: logs in to the SSH server, then dispatches the
// browser's JSON requests to the op registry.
//
// Runs unchanged on Cloudflare (inside a Durable Object) and on Node (Docker).
// What differs between the two is passed in as `platform`; see src/platform/.
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { ops } from './ops/index.js';
import { CONNECT_TIMEOUT_MS } from './ssh.js';
import { call, codeError, describeError, hostAllowed, isPrivateHost } from './util.js';

const { Client, utils } = ssh2;

const MAX_KEY_CHARS = 32 * 1024;

export class Session {
  constructor(ws, env, platform) {
    this.ws = ws;
    this.env = env;
    this.platform = platform;
    this.client = null;
    this.sftp = null;
    this.busy = false;
    this.terms = new Map(); // terminal id -> shell stream
    this.termSeq = 0;
    ws.addEventListener('message', (ev) => this.onMessage(ev));
    ws.addEventListener('close', () => this.dispose());
    ws.addEventListener('error', () => this.dispose());
  }

  send(obj) {
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* socket already closed */
    }
  }

  dispose() {
    try {
      this.client?.end();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.sftp = null;
    this.terms.clear();
  }

  async onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
    } catch {
      return this.send({ error: { code: 'bad-request', message: 'Invalid JSON' } });
    }
    const { id, op } = msg;
    try {
      const result = await this.handle(op, msg);
      this.send({ id, ok: true, ...result });
    } catch (err) {
      this.send({ id, ok: false, error: describeError(err) });
    }
  }

  async handle(op, msg) {
    if (op === 'ping') return {};
    if (op === 'connect') return this.login(msg);
    if (!this.sftp) throw codeError('not-connected', 'Not connected');
    if (!Object.hasOwn(ops, op)) throw codeError('bad-request', `Unknown op: ${op}`);
    return ops[op]({ client: this.client, sftp: this.sftp, env: this.env, session: this }, msg);
  }

  async login(msg) {
    if (this.client || this.busy) throw codeError('bad-request', 'Already connected');
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
    if (!hostAllowed(this.env?.ALLOWED_HOSTS, host, port)) {
      throw codeError('host-not-allowed', 'This host is not on the allowlist');
    }

    this.busy = true;
    let sock; // a Node Duplex stream connected to the SSH server
    try {
      sock = await this.platform.openSocket(host, port, CONNECT_TIMEOUT_MS);
    } catch (err) {
      this.busy = false;
      if (err?.code === 'connect-timeout') throw err;
      // Deployed Workers cannot reach loopback, private or Cloudflare addresses.
      if (this.platform.blocksPrivateHosts && isPrivateHost(host)) {
        throw codeError('private-address', 'Workers cannot connect to private or local addresses');
      }
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
          algorithms: this.platform.algorithms, // undefined = ssh2's defaults
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
      this.client = client;
      this.sftp = sftp;
      client.removeAllListeners('error');
      client.removeAllListeners('close');
      client.on('error', () => {});
      client.on('close', () => {
        this.sftp = null;
        this.client = null;
        this.send({ event: 'disconnected' });
        try {
          this.ws.close(1000, 'ssh closed');
        } catch {
          /* ignore */
        }
      });
      const home = await call(sftp, 'realpath', '.');
      // Same server and account -> same id, in every tab; used to refuse pasting
      // files copied from somewhere else.
      const domain = createHash('sha256').update(`${fingerprint}\0${username}`).digest('hex').slice(0, 12);
      return { home, fingerprint, username, host, port, domain };
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
    } finally {
      this.busy = false;
    }
  }
}
