// File clipboard. Copy / cut put "remosh/file:<path>" (one line per file) on
// the system clipboard, so pasted text can be recognised as files from this
// app. Whether it was a cut is remembered here, in this page only.
const PREFIX = 'remosh/file:';

let own = null; // { mode: 'copy' | 'cut', paths, text } for the last copy/cut made here

export async function putFiles(mode, paths) {
  const text = paths.map((p) => PREFIX + p).join('\n');
  own = { mode, paths, text };
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard blocked: paste still works inside this page */
  }
}

// Resolves to { mode, paths } or null when the clipboard holds no files.
export async function takeFiles() {
  let text = null;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    /* not allowed to read: fall back to what was copied here */
  }
  if (text == null) return own && { mode: own.mode, paths: own.paths };
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length || !lines.every((l) => l.startsWith(PREFIX))) return null; // something else was copied since
  const paths = lines.map((l) => l.slice(PREFIX.length));
  return { mode: own && own.text === lines.join('\n') ? own.mode : 'copy', paths };
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
