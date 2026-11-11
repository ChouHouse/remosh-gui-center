// File management over SFTP: delete, copy, move, chmod. Recursive work is done
// here with SFTP primitives (no shell), so it also works on SFTP-only accounts.
import { call, codeError, reqPath, joinPath, typeOf } from '../util.js';

const MAX_ENTRIES = 5000; // per copy/delete, so one request cannot run away
const MAX_DEPTH = 40;

function normal(p) {
  const out = [];
  for (const part of reqPath(p).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

const exists = (sftp, path) => call(sftp, 'lstat', path).then(() => true, (err) => {
  if (err.code === 2) return false;
  throw err;
});

function budget() {
  let left = MAX_ENTRIES;
  return () => {
    if (--left < 0) throw codeError('too-many', `More than ${MAX_ENTRIES} items`);
  };
}

async function removeTree(sftp, path, count, depth = 0) {
  if (depth > MAX_DEPTH) throw codeError('too-deep', 'Folder nesting is too deep');
  count();
  const st = await call(sftp, 'lstat', path); // lstat: never follow a symlink out of the tree
  if (typeOf(st) !== 'dir') return call(sftp, 'unlink', path);
  for (const it of await call(sftp, 'readdir', path)) await removeTree(sftp, joinPath(path, it.filename), count, depth + 1);
  return call(sftp, 'rmdir', path);
}

function copyFile(sftp, from, to, mode) {
  return new Promise((resolve, reject) => {
    const rs = sftp.createReadStream(from);
    const ws = sftp.createWriteStream(to, { mode });
    const fail = (err) => {
      rs.destroy();
      ws.destroy();
      reject(err);
    };
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('close', resolve);
    rs.pipe(ws);
  });
}

async function copyTree(sftp, from, to, count, depth = 0) {
  if (depth > MAX_DEPTH) throw codeError('too-deep', 'Folder nesting is too deep');
  count();
  const st = await call(sftp, 'lstat', from);
  const mode = st.mode & 0o7777;
  switch (typeOf(st)) {
    case 'dir':
      await call(sftp, 'mkdir', to, { mode });
      for (const it of await call(sftp, 'readdir', from)) {
        await copyTree(sftp, joinPath(from, it.filename), joinPath(to, it.filename), count, depth + 1);
      }
      return;
    case 'file':
      return copyFile(sftp, from, to, mode);
    case 'link':
      return call(sftp, 'symlink', await call(sftp, 'readlink', from), to);
    default:
      throw codeError('not-a-file', 'Special files cannot be copied');
  }
}

function pair(msg) {
  const from = normal(msg.from);
  const to = normal(msg.to);
  if (from === '/' || to === '/') throw codeError('bad-request', 'Invalid path');
  if (to === from || to.startsWith(from + '/')) throw codeError('into-itself', 'Cannot put a folder inside itself');
  return { from, to };
}

export async function remove({ sftp }, msg) {
  const path = normal(msg.path);
  if (path === '/') throw codeError('bad-request', 'Refusing to delete /');
  await removeTree(sftp, path, budget());
  return { path };
}

// Never overwrites: the page picks a free name first.
export async function copy({ sftp }, msg) {
  const { from, to } = pair(msg);
  if (await exists(sftp, to)) throw codeError('exists', 'Target already exists');
  await copyTree(sftp, from, to, budget());
  return { from, to };
}

export async function move({ sftp }, msg) {
  const { from, to } = pair(msg);
  if (await exists(sftp, to)) throw codeError('exists', 'Target already exists');
  await call(sftp, 'rename', from, to);
  return { from, to };
}

export async function chmod({ sftp }, msg) {
  const path = reqPath(msg.path);
  const mode = Number(msg.mode);
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw codeError('bad-request', 'Invalid mode');
  await call(sftp, 'chmod', path, mode);
  return { path, mode };
}
