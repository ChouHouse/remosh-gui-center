// Streaming a file on the host to the browser over plain HTTP, so a player can
// start at once and jump around instead of fetching the whole file first.
//
// The page asks for a stream over its session (op `streamOpen`) and gets an
// address with a random ticket in it; the browser's own media loader then
// fetches /api/stream/<ticket>, with Range requests, straight from SFTP.
// A ticket works only while its session is connected.
import { randomBytes } from 'node:crypto';
import { call, codeError, reqPath, typeOf } from './util.js';

const PER_SESSION = 6; // older tickets of a session are dropped beyond this
const tickets = new Map(); // ticket -> { session, path, type }

export async function streamOpen({ sftp, session }, msg) {
  const path = reqPath(msg.path);
  const type = typeof msg.type === 'string' && /^(audio|video)\/[a-z0-9.+-]{1,40}$/.test(msg.type) ? msg.type : 'application/octet-stream';
  const st = await call(sftp, 'stat', path);
  if (typeOf(st) !== 'file') throw codeError('bad-request', 'Not a file');
  const mine = [...tickets].filter(([, t]) => t.session === session);
  for (const [old] of mine.slice(0, Math.max(0, mine.length - PER_SESSION + 1))) tickets.delete(old);
  const ticket = randomBytes(24).toString('hex');
  tickets.set(ticket, { session, path, type });
  return { url: '/api/stream/' + ticket, size: st.size };
}

export async function streamClose({ session }, msg) {
  const ticket = String(msg.url || '').split('/').pop();
  if (tickets.get(ticket)?.session === session) tickets.delete(ticket);
  return {};
}

export function dropStreams(session) {
  for (const [ticket, t] of tickets) if (t.session === session) tickets.delete(ticket);
}

// GET /api/stream/<ticket>, whole or a byte range.
export async function serveStream(req, res, ticket) {
  const t = tickets.get(ticket);
  const sftp = t?.session.sftp;
  if (!sftp) return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  let st;
  try {
    st = await call(sftp, 'stat', t.path);
  } catch {
    return res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
  const size = st.size;
  const headers = { 'Content-Type': t.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (!(start <= end) || start >= size) return res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !size) return res.end();
  const file = sftp.createReadStream(t.path, { start, end });
  file.on('error', () => res.destroy());
  res.on('close', () => file.destroy());
  file.pipe(res);
}
