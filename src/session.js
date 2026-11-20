// One Session per WebSocket: reaches the machine through a backend (SSH or
// MCP, see backends/), then dispatches the browser's JSON requests to the op
// registry.
import { ops } from './ops/index.js';
import { pickBackend } from './backends/index.js';
import { dropStreams } from './streams.js';
import { dropSqlite } from './ops/sqlite.js';
import { codeError, describeError } from './util.js';

export class Session {
  constructor(ws, env) {
    this.ws = ws;
    this.env = env;
    this.client = null;
    this.sftp = null;
    this.end = null; // closes the backend's connection
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
    dropStreams(this);
    dropSqlite(this);
    try {
      this.end?.();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.sftp = null;
    this.end = null;
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
    const connect = pickBackend(msg);
    this.busy = true;
    try {
      const be = await connect(msg, this.env);
      this.client = be.client;
      this.sftp = be.sftp;
      this.end = be.end;
      be.onClose(() => {
        this.sftp = null;
        this.client = null;
        this.send({ event: 'disconnected' });
        try {
          this.ws.close(1000, 'backend closed');
        } catch {
          /* ignore */
        }
      });
      return be.info;
    } finally {
      this.busy = false;
    }
  }
}
