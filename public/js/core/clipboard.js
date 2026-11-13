// Plain-text clipboard for every app. The browser only allows it on https or
// localhost; copying falls back to the old way, reading has no fallback.

// Resolves to true when the text is on the clipboard.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = Object.assign(document.createElement('textarea'), { value: text });
    Object.assign(box.style, { position: 'fixed', left: '-9999px', top: '0' });
    const before = document.activeElement;
    document.body.append(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch { /* not allowed */ }
    box.remove();
    before?.focus?.({ preventScroll: true });
    return ok;
  }
}

// Resolves to the clipboard text, or null when the browser does not allow reading it.
export async function readText() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
