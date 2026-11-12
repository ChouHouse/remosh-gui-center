// File operations over SFTP. Each export is one op: (ctx, msg) => result,
// where ctx = { client, sftp, env } and msg is the browser's request.
import { Buffer } from 'node:buffer';
import { call, codeError, reqPath, joinPath, baseName, typeOf, entry } from '../util.js';

const MAX_FILE_BYTES = 16 * 1024 * 1024; // largest file sent in one message; bigger ones go in pieces
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

export async function realpath({ sftp }, msg) {
  return { path: await call(sftp, 'realpath', reqPath(msg.path || '.')) };
}

// Creates one directory; succeeds quietly when it is already there.
export async function mkdir({ sftp }, msg) {
  const path = reqPath(msg.path);
  // Private by default (the settings folder); the page asks for 755 for ordinary folders.
  const mode = Number.isInteger(msg.mode) && msg.mode >= 0 && msg.mode <= 0o777 ? msg.mode : 0o700;
  try {
    await call(sftp, 'mkdir', path, { mode });
    return { path, created: true };
  } catch (err) {
    const st = await call(sftp, 'stat', path).catch(() => null);
    if (st) {
      if (typeOf(st) === 'dir') return { path, created: false };
      throw codeError('exists', 'A file with that name already exists');
    }
    throw err;
  }
}

export async function list({ sftp }, msg) {
  const path = reqPath(msg.path);
  const items = await call(sftp, 'readdir', path);
  const entries = await Promise.all(
    items.map(async (it) => {
      const e = entry(it.filename, it.attrs);
      if (e.type === 'link') {
        // Resolve what a symlink points at so the UI can open it.
        try {
          const target = await call(sftp, 'stat', joinPath(path, it.filename));
          e.targetType = typeOf(target);
          if (e.targetType === 'file') e.size = target.size;
        } catch {
          e.targetType = 'broken';
        }
      }
      return e;
    }),
  );
  return { path, entries };
}

export async function stat({ sftp }, msg) {
  const path = reqPath(msg.path);
  return { entry: entry(baseName(path), await call(sftp, 'stat', path)) };
}

export async function read({ sftp }, msg) {
  const path = reqPath(msg.path);
  const st = await call(sftp, 'stat', path);
  if (typeOf(st) !== 'file') throw codeError('not-a-file', 'Not a regular file');
  if (st.size > MAX_FILE_BYTES) {
    throw codeError('too-large', `File is larger than ${MAX_FILE_BYTES} bytes`);
  }
  const buf = await call(sftp, 'readFile', path);
  return { path, size: buf.length, mtime: st.mtime, mode: st.mode, data: buf.toString('base64') };
}

export async function write({ sftp }, msg) {
  const path = reqPath(msg.path);
  if (typeof msg.data !== 'string') throw codeError('bad-request', 'Missing data');
  const buf = Buffer.from(msg.data, 'base64');
  if (buf.length > MAX_FILE_BYTES) throw codeError('too-large', 'File too large');
  // Optional lost-update guard: refuse when the file changed on the server
  // since the editor loaded it, unless the client says to overwrite.
  if (msg.expectMtime != null && !msg.force) {
    try {
      const cur = await call(sftp, 'stat', path);
      if (cur.mtime !== msg.expectMtime) {
        throw codeError('changed-on-server', 'File changed on the server');
      }
    } catch (e) {
      if (e.code === 'changed-on-server') throw e;
      /* file vanished: fall through and recreate it */
    }
  }
  await call(sftp, 'writeFile', path, buf);
  const st = await call(sftp, 'stat', path);
  return { path, size: st.size, mtime: st.mtime };
}

// ---- large files, a piece at a time (the page loops; see public/js/core/file-io.js)

// { path, offset, length } -> { data, size, mtime, eof }
export async function readChunk({ sftp }, msg) {
  const path = reqPath(msg.path);
  const offset = Number(msg.offset) || 0;
  const length = Math.min(Number(msg.length) || MAX_CHUNK_BYTES, MAX_CHUNK_BYTES);
  if (offset < 0 || length < 1) throw codeError('bad-request', 'Bad range');
  const st = await call(sftp, 'stat', path);
  if (typeOf(st) !== 'file') throw codeError('not-a-file', 'Not a regular file');
  const handle = await call(sftp, 'open', path, 'r');
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    // One SFTP read may return less than asked for.
    while (got < length) {
      const n = await new Promise((resolve, reject) => {
        sftp.read(handle, buf, got, length - got, offset + got, (err, bytes) => (err ? reject(err) : resolve(bytes)));
      });
      if (!n) break;
      got += n;
    }
    return { path, size: st.size, mtime: st.mtime, eof: offset + got >= st.size || got < length, data: buf.subarray(0, got).toString('base64') };
  } finally {
    await call(sftp, 'close', handle).catch(() => {});
  }
}

// { path, offset, data, expectMtime?, force?, last? }. The piece at offset 0
// starts the file afresh (and may carry the lost-update guard); the last one
// answers with the file's new size and mtime.
export async function writeChunk({ sftp }, msg) {
  const path = reqPath(msg.path);
  const offset = Number(msg.offset) || 0;
  if (typeof msg.data !== 'string' || offset < 0) throw codeError('bad-request', 'Missing data');
  const buf = Buffer.from(msg.data, 'base64');
  if (buf.length > MAX_CHUNK_BYTES) throw codeError('too-large', 'Piece too large');
  if (offset === 0 && msg.expectMtime != null && !msg.force) {
    const cur = await call(sftp, 'stat', path).catch(() => null);
    if (cur && cur.mtime !== msg.expectMtime) throw codeError('changed-on-server', 'File changed on the server');
  }
  const handle = await call(sftp, 'open', path, offset === 0 ? 'w' : 'r+');
  try {
    if (buf.length) {
      await new Promise((resolve, reject) => {
        sftp.write(handle, buf, 0, buf.length, offset, (err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    await call(sftp, 'close', handle).catch(() => {});
  }
  if (!msg.last) return { path };
  const st = await call(sftp, 'stat', path);
  return { path, size: st.size, mtime: st.mtime };
}
