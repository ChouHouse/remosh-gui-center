// Reading and writing whole remote files of any size. Small ones go in one
// message; larger ones travel in pieces, so there is no fixed upper limit and
// the caller can show progress.
import { rpc } from './rpc.js';
import { toBase64, fromBase64 } from './text-codec.js';

const PIECE = 4 * 1024 * 1024;

// -> { bytes: Uint8Array, mtime, size }.  onProgress(done, total) is optional.
export async function readFile(path, { onProgress } = {}) {
  const first = await rpc('readChunk', { path, offset: 0, length: PIECE });
  const head = fromBase64(first.data);
  if (first.eof) return { bytes: head, mtime: first.mtime, size: head.length };
  const bytes = new Uint8Array(first.size);
  bytes.set(head.subarray(0, Math.min(head.length, bytes.length)));
  let done = head.length;
  onProgress?.(done, first.size);
  while (done < bytes.length) {
    const res = await rpc('readChunk', { path, offset: done, length: PIECE });
    const part = fromBase64(res.data);
    if (!part.length) break; // the file got shorter meanwhile
    bytes.set(part.subarray(0, bytes.length - done), done);
    done += part.length;
    onProgress?.(Math.min(done, bytes.length), bytes.length);
  }
  return { bytes: done < bytes.length ? bytes.subarray(0, done) : bytes, mtime: first.mtime, size: Math.min(done, bytes.length) };
}

// -> { size, mtime }.  expectMtime / force: the same lost-update guard as `write`.
export async function writeFile(path, bytes, { expectMtime, force, onProgress } = {}) {
  if (bytes.length <= PIECE) return rpc('write', { path, data: toBase64(bytes), expectMtime, force: !!force });
  let res;
  for (let offset = 0; offset < bytes.length; offset += PIECE) {
    const end = Math.min(offset + PIECE, bytes.length);
    res = await rpc('writeChunk', {
      path, offset, data: toBase64(bytes.subarray(offset, end)), last: end === bytes.length,
      ...(offset === 0 ? { expectMtime, force: !!force } : {}),
    });
    onProgress?.(end, bytes.length);
  }
  return res;
}
