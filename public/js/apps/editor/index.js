// Procoder: a code editor built on Monaco. A window holds tabs and a file tree
// (window.js); this file keeps track of the windows and decides which one a
// file opens in.
import './i18n.js'; // this app's texts in the other languages
import { on } from '../../core/events.js';
import { wm } from '../../shell/wm.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { procoderSvg } from './icon.js';
import { loadMonaco } from './monaco.js';
import { APP_NAME, data, toggleSide, themePref, setTheme } from './prefs.js';
import { dialog } from '../../core/ui.js';
import { effectiveMode, onDeviceModeChange } from '../../shell/style.js';
import { createProcoder } from './window.js';
import { tt } from '../../core/i18n.js';

useAppStyle(import.meta.url);

// Open Procoder windows, least recently used first: a file opened from outside
// (the file cabinet, the desktop) goes to the last one that was used.
const windows = [];
let untitledSeq = 0;

const hub = {
  owner(path) {
    for (const inst of windows) {
      const doc = inst.findDoc(path);
      if (doc) return { inst, doc };
    }
    return null;
  },
  newWindow: () => openWindow().openWelcome(),
  nextUntitled: () => ++untitledSeq,
  used(inst) {
    const at = windows.indexOf(inst);
    if (at >= 0 && at !== windows.length - 1) windows.push(...windows.splice(at, 1));
  },
  closed(inst) {
    const at = windows.indexOf(inst);
    if (at >= 0) windows.splice(at, 1);
    if (!windows.length) untitledSeq = 0;
  },
};

// The first time Procoder is started it asks which look it should have. The
// answer is kept with Procoder's data (~/.remosh-gui/app/editor/); the 介面
// menu changes it later. Closing the question without answering asks again
// next time.
let asking = false;
async function askThemeOnce() {
  await data.ready();
  if (themePref() || asking) return;
  asking = true;
  const dark = effectiveMode() === 'dark';
  const choice = await dialog({
    title: tt('Procoder 要用亮色還是暗色？'),
    message: tt('之後可以從 Procoder 的「介面」選單更改。'),
    buttons: [{ label: tt('亮色'), value: 'light', default: !dark }, { label: tt('暗色'), value: 'dark', default: dark }],
  });
  asking = false;
  if (choice) setTheme(choice);
}

function openWindow(options) {
  askThemeOnce();
  const inst = createProcoder(hub, options);
  windows.push(inst);
  return inst;
}
const lastUsed = () => windows[windows.length - 1] || null;

const followPrefs = () => {
  for (const inst of windows) inst.onPrefs();
};
data.onChange(followPrefs);
// Until a look has been chosen Procoder goes by the desktop's light / dark.
onDeviceModeChange(followPrefs);
on('settings:changed', followPrefs);

// Ctrl/Cmd+S saves the active tab instead of the browser's "save page"; Alt+W
// closes it and Ctrl/Cmd+B shows or hides the file tree, also when the focus
// is outside the editor (e.g. on the welcome page).
window.addEventListener('keydown', (ev) => {
  const inst = document.querySelector('.modal') ? null : windows.find((w) => w.win === wm.focused);
  const inEditor = !!ev.target.closest?.('.monaco-editor'); // Monaco's own keybindings handle it there
  const cmd = (ev.ctrlKey || ev.metaKey) && !ev.altKey;
  if (cmd && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    if (!inEditor) inst?.save(ev.shiftKey);
  } else if (inst && cmd && !ev.shiftKey && ev.code === 'KeyB' && !inEditor && !ev.target.closest?.('input, textarea')) {
    ev.preventDefault();
    toggleSide();
  } else if (inst && ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.code === 'KeyW' && !inEditor) {
    ev.preventDefault();
    inst.closeActive();
  }
});

// Monaco rejects in-flight language-service requests with "Canceled" when a
// model is closed; that is expected, so keep it out of the console.
window.addEventListener('unhandledrejection', (ev) => {
  if (ev.reason?.name === 'Canceled') ev.preventDefault();
});

// A renamed or moved file (or a folder above it) takes its open tab along.
on('fs:moved', (from, to) => {
  for (const inst of windows) inst.moved(from, to);
});
on('fs:changed', (dir) => {
  for (const inst of windows) inst.refreshTree(dir);
});

on('session:start', () => loadMonaco().catch(() => {})); // warm up so the first file opens quickly

registerApp({
  id: 'editor',
  order: 20,
  name: APP_NAME,
  icon: procoderSvg,
  startMenu: true,
  extensions: 'all',
  // Starting Procoder while it is open brings its window forward; another
  // window comes from its own 檔案 › 開新視窗. A file from outside opens as a
  // tab in the Procoder that was used last. The first window shows the
  // welcome page and the folder from last time.
  launch: (args) => {
    if (args?.path) return (lastUsed() || openWindow()).openFile(args.path, args.size);
    const inst = lastUsed();
    if (inst) inst.win.focus();
    else openWindow({ folder: data.get('folder') || null }).openWelcome();
  },
  unsavedCount: () => windows.reduce((n, inst) => n + inst.dirtyCount(), 0),
});
