// A shell on the SSH host, drawn in an element: xterm.js in the page, an SSH
// PTY channel on the server. Shared by the 終端機 app and Procoder's terminal
// panel; each owns where it is shown.
//
//   const view = await createTerminalView(el, { cwd, run, onExit, keys })
//     cwd    folder to start in
//     run    a command to type in at the start (e.g. "./script.sh")
//     onExit called when the shell ends (or the connection drops)
//     keys   (keydown event) -> true when the caller handled the key; the shell does not get it
//   view.focus(), view.fit(), view.dispose(), view.term (the xterm Terminal)
// Throws when the terminal cannot be opened.
import { toast } from '../core/ui.js';
import { rpc } from '../core/rpc.js';
import { on } from '../core/events.js';
import { fromBase64 } from '../core/text-codec.js';
import { showContextMenu } from './context-menu.js';
import { copyText, readText } from '../core/clipboard.js';
import { tt } from '../core/i18n.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
// Copy and paste keys: ⌘C / ⌘V on a Mac, Ctrl+Shift+C / V elsewhere as in a
// Linux terminal. Ctrl+C stays "interrupt" everywhere.
export const COPY_KEY = isMac ? '⌘C' : 'Ctrl+Shift+C';
export const PASTE_KEY = isMac ? '⌘V' : 'Ctrl+Shift+V';
const keyOf = (ev, code) => ev.code === code && (isMac
  ? ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey
  : ev.ctrlKey && ev.shiftKey && !ev.altKey && !ev.metaKey);
const isCopy = (ev) => keyOf(ev, 'KeyC');
const isPaste = (ev) => keyOf(ev, 'KeyV');

let xtermPromise = null;
function loadXterm() {
  xtermPromise ??= Promise.all([import('/xterm/xterm.mjs'), import('/xterm/addon-fit.mjs')])
    .then(([x, f]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon }));
  xtermPromise.catch(() => {
    xtermPromise = null;
  });
  return xtermPromise;
}

// Single-quote a string for a POSIX shell.
export const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function createTerminalView(host, { cwd = null, run = null, onExit = null, keys = null } = {}) {
  let tid = null;
  let alive = true;
  let observer = null;
  const early = []; // output that arrives before the terminal id is known
  const offs = [];
  const { Terminal, FitAddon } = await loadXterm();
  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#1b1e25', foreground: '#d7dbe3', cursor: '#d7dbe3' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  if (host.clientWidth) fit.fit();
  const dispose = () => {
    if (!alive) return;
    alive = false;
    offs.forEach((off) => off());
    observer?.disconnect();
    if (tid != null) rpc('termClose', { tid }).catch(() => {});
    tid = null;
    term.dispose();
  };
  const ended = (text) => {
    tid = null;
    term.write(text);
    onExit?.();
  };

  offs.push(on('remote:term:data', (m) => {
    if (tid == null) early.push(m);
    else if (m.tid === tid) term.write(fromBase64(m.data));
  }));
  offs.push(on('remote:term:exit', (m) => {
    if (m.tid === tid) ended(tt('\r\n\u001b[90m[工作階段已結束]\u001b[0m\r\n'));
  }));
  offs.push(on('conn:lost', () => {
    if (tid != null) ended(tt('\r\n\u001b[90m[連線已中斷]\u001b[0m\r\n'));
  }));

  let res;
  try {
    res = await rpc('termOpen', { cols: term.cols, rows: term.rows });
  } catch (err) {
    dispose();
    throw err;
  }
  if (!alive) {
    rpc('termClose', { tid: res.tid }).catch(() => {});
    return null;
  }
  tid = res.tid;
  for (const m of early.splice(0)) if (m.tid === tid) term.write(fromBase64(m.data));

  const send = (data) => {
    if (tid != null) rpc('termInput', { tid, data }).catch(() => {});
  };
  term.onData(send);

  // ---- copy and paste
  const copy = async () => {
    const text = term.getSelection();
    if (!text) return;
    if (!(await copyText(text))) toast(tt('瀏覽器不允許寫入剪貼簿'), true);
    term.focus();
  };
  const paste = async () => {
    const text = await readText();
    if (text == null) return toast(tt('瀏覽器不允許讀取剪貼簿（需要 https），請改用 {0}', PASTE_KEY), true);
    term.paste(text);
    term.focus();
  };
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === 'keydown' && keys?.(ev)) {
      ev.preventDefault();
      return false;
    }
    if (ev.type !== 'keydown') return !(isCopy(ev) || isPaste(ev));
    if (isCopy(ev)) {
      ev.preventDefault();
      copy();
      return false;
    }
    // Both are the browser's own paste (⌘V, and Ctrl+Shift+V "paste as plain
    // text"): let that through, it needs no permission, and keep the key
    // itself from the shell.
    if (isPaste(ev)) return false;
    return true;
  });
  host.addEventListener('contextmenu', (ev) => {
    showContextMenu(ev, [
      { label: tt('複製（{0}）', COPY_KEY), enabled: term.hasSelection(), run: copy },
      { label: tt('貼上（{0}）', PASTE_KEY), run: paste },
      null,
      { label: tt('全選'), run: () => term.selectAll() },
      { label: tt('清除畫面'), run: () => {
        term.clear();
        term.focus();
      } },
    ]);
  });
  term.onResize(({ cols, rows }) => {
    if (tid != null) rpc('termResize', { tid, cols, rows }).catch(() => {});
  });
  let frame = 0;
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => alive && host.clientWidth && fit.fit());
  });
  observer.observe(host);
  if (run) send(run);
  else if (cwd) send(`cd -- ${shellQuote(cwd)} && clear\n`);
  return {
    term,
    focus: () => term.focus(),
    fit: () => host.clientWidth && fit.fit(),
    dispose,
    get running() {
      return tid != null;
    },
  };
}
