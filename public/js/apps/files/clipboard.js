// File clipboard. Copy / cut put one line per file on the system clipboard:
//
//   remosh/file:<path><<<domain id>>>      e.g. remosh/file:/home/me/a.txt<<3f9c2a71b0de>>
//
// The domain id names the server and account the path belongs to (the server
// hands it out at login). Pasting lines with a different id is refused: a path
// from one machine means nothing on another.
// Whether it was a cut is remembered here, in this page only.
import { conn } from '../../core/rpc.js';

const LINE = /^remosh\/file:(.+)<<([0-9a-f]{6,64})>>$/;
const format = (path) => `remosh/file:${path}<<${conn.info.domain}>>`;

let own = null; // { mode: 'copy' | 'cut', paths, text } for the last copy/cut made here

export async function putFiles(mode, paths) {
  const text = paths.map(format).join('\n');
  own = { mode, paths, text };
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked: paste still works inside this page */
  }
}

// Resolves to { mode, paths }, { foreign: true } when the files were copied
// from another server or account, or null when the clipboard holds no files.
export async function takeFiles() {
  let text = null;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    /* not allowed to read: fall back to what was copied here */
  }
  if (text == null) return own && own.text.endsWith(`<<${conn.info.domain}>>`) ? { mode: own.mode, paths: own.paths } : null;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const parsed = lines.map((l) => LINE.exec(l));
  if (!lines.length || parsed.some((m) => !m)) return null; // something else was copied since
  if (parsed.some((m) => m[2] !== conn.info.domain)) return { foreign: true };
  return { mode: own && own.text === lines.join('\n') ? own.mode : 'copy', paths: parsed.map((m) => m[1]) };
}

// After a cut has been pasted the files are gone from their old place.
export async function clearFiles() {
  own = null;
  try {
    await navigator.clipboard.writeText('');
  } catch {
    /* clipboard blocked: nothing to clear */
  }
}

export const cutPaths = () => (own?.mode === 'cut' ? own.paths : []);
