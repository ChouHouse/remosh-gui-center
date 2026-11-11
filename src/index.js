// ssh-desk Worker entry.
//
// The browser opens one WebSocket to /ws. For that WebSocket the Worker opens a
// TCP socket to the SSH server, logs in (password or private key), starts an
// SFTP session and then answers small JSON requests (list / read / write ...).
// Nothing is stored: credentials live only in memory for the login.
import { Session } from './session.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket', { status: 426 });
      }
      // Only pages served by this same Worker may open the socket.
      const origin = request.headers.get('Origin');
      if (origin && new URL(origin).host !== url.host) {
        return new Response('Forbidden origin', { status: 403 });
      }
      const pair = new WebSocketPair();
      pair[1].accept();
      new Session(pair[1], env);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return env.ASSETS.fetch(request);
  },
};
