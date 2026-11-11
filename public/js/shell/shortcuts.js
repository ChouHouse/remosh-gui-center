// Shortcut files. Both kinds are one-line text files:
//   <name>.remosh_gui-app   "app:<app id>"       opens that app
//   <name>.remosh_gui-lnk   "lnk:<remote path>"  opens that file or folder
// The desktop is the folder ~/.remosh-gui/desktop; whatever is in it is shown.
import { P } from '../core/path.js';
import { rpc } from '../core/rpc.js';
import { settingsDir } from '../core/settings.js';
import { toBase64, fromBase64 } from '../core/text-codec.js';

export const APP_EXT = 'remosh_gui-app';
export const LNK_EXT = 'remosh_gui-lnk';

export const desktopDir = () => P.join(settingsDir(), 'desktop');
export const shortcutKind = (name) => (name.endsWith('.' + APP_EXT) ? 'app' : name.endsWith('.' + LNK_EXT) ? 'lnk' : null);
// File name without the shortcut extension, for display.
export const displayName = (name) => (shortcutKind(name) ? name.slice(0, name.lastIndexOf('.')) : name);
export const appFile = (app) => ({ name: `${app.name}.${APP_EXT}`, text: `app:${app.id}\n` });
export const linkFile = (target) => ({ name: `${P.base(target) === '/' ? 'root' : P.base(target)}.${LNK_EXT}`, text: `lnk:${target}\n` });

export const writeText = (path, text) => rpc('write', { path, data: toBase64(new TextEncoder().encode(text)) });

// Resolves to { kind: 'app', id } | { kind: 'lnk', target } | null (not a valid shortcut).
export async function readShortcut(path) {
  const res = await rpc('read', { path });
  const line = new TextDecoder().decode(fromBase64(res.data)).split(/\r?\n/)[0].trim();
  if (line.startsWith('app:') && line.length > 4) return { kind: 'app', id: line.slice(4).trim() };
  if (line.startsWith('lnk:') && line.slice(4).trim().startsWith('/')) return { kind: 'lnk', target: line.slice(4).trim() };
  return null;
}
