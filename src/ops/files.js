// File operations over SFTP. Each export is one op: (ctx, msg) => result,
// where ctx = { client, sftp, env } and msg is the browser's request.
import { Buffer } from 'node:buffer';
import { call, codeError, reqPath, joinPath, baseName, typeOf, entry } from '../util.js';

const MAX_FILE_BYTES = 5 * 1024 * 1024; // largest file the editor will load/save

export async function realpath({ sftp }, msg) {
  return { path: await call(sftp, 'realpath', reqPath(msg.path || '.')) };
}

// Creates one directory; succeeds quietly when it is already there.
export async function mkdir({ sftp }, msg) {
  const path = reqPath(msg.path);
  try {
    await call(sftp, 'mkdir', path, { mode: 0o700 });
    return { path, created: true };
  } catch (err) {
    const st = await call(sftp, 'stat', path).catch(() => null);
    if (st && typeOf(st) === 'dir') return { path, created: false };
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
