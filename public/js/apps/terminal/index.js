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
import { createWindow } from '../../shell/wm.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { createTerminalView, shellQuote } from '../../shell/terminal-view.js';
import { tt, tm } from '../../core/i18n.js';

useAppStyle(import.meta.url);

const RUN_MODE = 0o777; // permissions given to a file before it is run

async function openTerminal({ path = null, cwd = null } = {}) {
  const win = createWindow({ title: path ? P.base(path) : cwd ? P.base(cwd) : tt('終端機'), appName: tm('終端機'), iconHtml: terminalSvg(), width: 720, height: 440 });
  const host = h('div', { class: 'term-host' });
  win.body.append(host);
  let view = null;
  let alive = true;
  win.destroy = () => {
    alive = false;
    view?.dispose();
  };
  try {
    if (path) await rpc('chmod', { path, mode: RUN_MODE });
    if (!alive) return;
    // Opened on a file: run it from its own folder, like typing ./name.
    // Opened from a folder in the file cabinet: start there.
    const run = path ? `cd -- ${shellQuote(P.parent(path))} && ${shellQuote('./' + P.base(path))}\n` : null;
    view = await createTerminalView(host, { cwd, run });
    if (!alive) return view?.dispose();
    win.onFocus = () => view.focus();
    view.focus();
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
  folders: true, // 「用 終端機 開啟」 on a folder starts a shell there
  launch: (args) => openTerminal(args?.folder ? { cwd: args.path } : args),
});
