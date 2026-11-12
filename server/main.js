// ssh-desk: Node entry, used by the Docker image (`node server/main.js`).
// Serves public/, /ws and /api/gate.
//
// Environment:
//   PORT           port to listen on (default 8080)
//   WEB_PASSWORD   access password asked before the SSH login screen
//   ALLOWED_HOSTS  optional comma-separated allowlist of SSH targets
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Session } from '../src/session.js';
import { createGate, handleGateApi } from '../src/gate.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8080;
const env = { ALLOWED_HOSTS: process.env.ALLOWED_HOSTS || '', WEB_PASSWORD: process.env.WEB_PASSWORD || '' };
const gate = createGate(env.WEB_PASSWORD);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
};

// Behind cloudflared the visitor's address and scheme arrive in headers.
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https';

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  } catch {
    rel = null;
  }
  let file = rel == null ? null : join(PUBLIC, rel || 'index.html');
  if (!file || (file !== PUBLIC && !file.startsWith(PUBLIC + sep))) return res.writeHead(400).end();
  let st;
  try {
    st = statSync(file);
    if (st.isDirectory()) st = statSync((file = join(file, 'index.html')));
  } catch {
    return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    ETag: etag,
    // The app's own files are revalidated every time; the vendored editor and terminal rarely change.
    'Cache-Control': /^(vs|xterm)[/\\]/.test(rel) ? 'public, max-age=86400' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

async function readBody(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/gate') {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      if (body === null) return res.writeHead(413).end();
      const response = await handleGateApi(new Request(url, { method: req.method, headers: req.headers, body }), gate, { ip: clientIp(req), secure: isHttps(req) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(await response.text());
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error('request failed:', err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
server.on('upgrade', async (req, socket, head) => {
  const refuse = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') return refuse(404, 'Not Found');
    // Only pages served by this same server may open the socket.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return refuse(403, 'Forbidden');
    if (!(await gate.check(req.headers.cookie))) return refuse(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => new Session(ws, env));
  } catch {
    refuse(400, 'Bad Request');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ssh-desk listening on :${PORT}`);
  console.log(gate.required ? 'Access password (WEB_PASSWORD) is required.' : 'WARNING: WEB_PASSWORD is not set; anyone who can reach this port can use it.');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
