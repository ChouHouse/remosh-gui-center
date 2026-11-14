// 終端機: an interactive shell on the SSH host (xterm.js in the page, an SSH
// PTY channel on the server). Opening a file with it makes the file executable
// (chmod 777) and runs it as ./name from its own folder.
import './i18n.js'; // this app's texts in the other languages
import { h } from '../../core/dom.js';
import { errText } from '../../core/errors.js';
import { toast } from '../../core/ui.js';
import { P } from '../../core/path.js';
import { terminalSvg } from './icon.js';
import { rpc } from '../../core/rpc.js';
import { on } from '../../core/events.js';
import { fromBase64 } from '../../core/text-codec.js';
import { createWindow } from '../../shell/wm.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { copyText, readText } from '../../core/clipboard.js';
import { tt, tm } from '../../core/i18n.js';

useAppStyle(import.meta.url);

const RUN_MODE = 0o777; // permissions given to a file before it is run
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
// Copy and paste keys: ⌘C / ⌘V on a Mac, Ctrl+Shift+C / V elsewhere as in a
// Linux terminal. Ctrl+C stays "interrupt" everywhere.
const COPY_KEY = isMac ? '⌘C' : 'Ctrl+Shift+C';
const PASTE_KEY = isMac ? '⌘V' : 'Ctrl+Shift+V';
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
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

async function openTerminal({ path = null, cwd = null } = {}) {
  const win = createWindow({ title: path ? P.base(path) : cwd ? P.base(cwd) : tt('終端機'), appName: tm('終端機'), iconHtml: terminalSvg(), width: 720, height: 440 });
  const host = h('div', { class: 'term-host' });
  win.body.append(host);
  let tid = null;
  let term = null;
  let observer = null;
  let alive = true;
  const early = []; // output that arrives before we know our terminal id
  const offs = [];
  win.destroy = () => {
    alive = false;
    offs.forEach((off) => off());
    observer?.disconnect();
    if (tid != null) rpc('termClose', { tid }).catch(() => {});
    term?.dispose();
  };

  try {
    if (path) await rpc('chmod', { path, mode: RUN_MODE });
    const { Terminal, FitAddon } = await loadXterm();
    if (!alive) return;
    term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#1b1e25', foreground: '#d7dbe3', cursor: '#d7dbe3' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    offs.push(on('remote:term:data', (m) => {
      if (tid == null) early.push(m);
      else if (m.tid === tid) term.write(fromBase64(m.data));
    }));
    offs.push(on('remote:term:exit', (m) => {
      if (m.tid !== tid) return;
      tid = null;
      term.write(tt('\r\n\u001b[90m[工作階段已結束]\u001b[0m\r\n'));
    }));
    offs.push(on('conn:lost', () => {
      tid = null;
      term.write(tt('\r\n\u001b[90m[連線已中斷]\u001b[0m\r\n'));
    }));

    const res = await rpc('termOpen', { cols: term.cols, rows: term.rows });
    if (!alive) return rpc('termClose', { tid: res.tid }).catch(() => {});
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
      if (ev.type !== 'keydown') return !(isCopy(ev) || isPaste(ev));
      if (isCopy(ev)) {
        ev.preventDefault();
        copy();
        return false;
      }
      if (isPaste(ev)) {
        // Both are the browser's own paste (⌘V, and Ctrl+Shift+V "paste as
        // plain text"): let that through, it needs no permission, and keep
        // the key itself from the shell.
        return false;
      }
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
      frame = requestAnimationFrame(() => host.clientWidth && fit.fit());
    });
    observer.observe(host);
    win.onFocus = () => term.focus();
    term.focus();
    // Opened on a file: run it from its own folder, like typing ./name.
    if (path) send(`cd -- ${quote(P.parent(path))} && ${quote('./' + P.base(path))}\n`);
    // Opened from a folder in the file cabinet: start there.
    else if (cwd) send(`cd -- ${quote(cwd)} && clear\n`);
  } catch (err) {
    await win.close(true);
    toast(tt('無法開啟終端機：{0}', errText(err)), true);
  }
}

registerApp({
  id: 'terminal',
  order: 60,
  name: tm('終端機'),
  icon: terminalSvg,
  startMenu: true,
  extensions: ['', 'sh', 'bash', 'out', 'run', 'bin', 'elf', 'py', 'pl', 'rb'],
  launch: openTerminal,
});
