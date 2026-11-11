// WebSocket connection to the Worker and the request/response helper.
import { appError, ERROR_TEXT } from './errors.js';
import { emit } from './events.js';

export const conn = { ws: null, seq: 0, pending: new Map(), info: null, pingTimer: null, closing: false };

export function rpc(op, args) {
  if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return Promise.reject(appError('not-connected'));
  return new Promise((resolve, reject) => {
    const id = ++conn.seq;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(appError('timeout'));
    }, 60000);
    conn.pending.set(id, { resolve, reject, timer });
    conn.ws.send(JSON.stringify({ id, op, ...args }));
  });
}

export function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(appError('connect-failed', '無法連上 Worker'));
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      // Pushed by the Worker (e.g. terminal output): re-emit as `remote:<event>`.
      if (msg.event) return emit('remote:' + msg.event, msg);
      const p = conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else {
        const e = appError(msg.error?.code || 'error', ERROR_TEXT[msg.error?.code] || msg.error?.message);
        e.detail = msg.error;
        p.reject(e);
      }
    };
    ws.onclose = () => {
      if (conn.ws !== ws) return;
      conn.ws = null;
      clearInterval(conn.pingTimer);
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(appError('disconnected'));
      }
      conn.pending.clear();
      if (conn.info && !conn.closing) emit('conn:lost');
    };
  });
}
