// ssh-desk: Cloudflare Worker entry (`wrangler deploy`). The Docker image uses
// server/main.js instead; both run the same Session and ops.
//
// The browser opens one WebSocket to /ws. For that WebSocket the Worker opens a
// TCP socket to the SSH server, logs in (password or private key), starts an
// SFTP session and then answers small JSON requests (list / read / write ...).
// Nothing is stored: credentials live only in memory for the login.
import { DurableObject } from 'cloudflare:workers';
import { Session } from './session.js';
import { workerPlatform } from './platform/worker.js';
import { createGate, handleGateApi } from './gate.js';

// Each browser connection gets its own Durable Object, which holds the SSH
// session for as long as the WebSocket is open. A Durable Object is used
// instead of the plain Worker because of how CPU time is counted: a Worker
// gets one budget for the whole connection (10 ms on the Free plan), while a
// Durable Object's budget (30 s) is renewed by every incoming message.
// Nothing is written to its storage.
export class SessionDO extends DurableObject {
  async fetch() {
    const pair = new WebSocketPair();
    pair[1].accept();
    new Session(pair[1], this.env, workerPlatform);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

// Optional access password: `wrangler secret put WEB_PASSWORD`.
let gate = null;
let gateFor;
function gateOf(env) {
  if (!gate || gateFor !== env.WEB_PASSWORD) {
    gateFor = env.WEB_PASSWORD;
    gate = createGate(env.WEB_PASSWORD);
  }
  return gate;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const g = gateOf(env);
    const api = await handleGateApi(request, g, {
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
      secure: url.protocol === 'https:',
    });
    if (api) return api;
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket', { status: 426 });
      }
      // Only pages served by this same Worker may open the socket.
      const origin = request.headers.get('Origin');
      if (origin && new URL(origin).host !== url.host) {
        return new Response('Forbidden origin', { status: 403 });
      }
      if (!(await g.check(request.headers.get('Cookie')))) return new Response('Access password required', { status: 401 });
      return env.SESSIONS.get(env.SESSIONS.newUniqueId()).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
