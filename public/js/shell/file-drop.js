// What dropping something into a folder does, shared by the file cabinet and
// the desktop:  plain drag = move,  Ctrl = copy,  Alt = make a shortcut.
// An app dropped into a folder always becomes an app shortcut.
import { P, freeName } from '../core/path.js';
import { errText } from '../core/errors.js';
import { toast } from '../core/ui.js';
import { rpc } from '../core/rpc.js';
import { emit } from '../core/events.js';
import { getApp } from './apps.js';
import { appFile, linkFile, writeText } from './shortcuts.js';

export const acceptsDrop = (payload) => payload.type === 'file' || payload.type === 'app';

export function dropAction(payload, mods) {
  if (payload.type === 'app' || mods.altKey) return '建立捷徑';
  return mods.ctrlKey ? '複製' : '移動';
}

// Resolves to the name of what now sits in `dir`, or null if nothing was added.
export async function dropInto(dir, payload, mods) {
  let made = null;
  try {
    const taken = new Set((await rpc('list', { path: dir })).entries.map((e) => e.name));
    if (payload.type === 'app') {
      const file = appFile(getApp(payload.data.id));
      if (taken.has(file.name)) {
        toast(`這裡已經有「${payload.name}」了`);
        return null;
      }
      await writeText(P.join(dir, file.name), file.text);
      made = file.name;
    } else {
      const from = payload.data.path;
      if (mods.altKey) {
        const file = linkFile(from);
        made = freeName(file.name, taken);
        await writeText(P.join(dir, made), file.text);
      } else if (mods.ctrlKey) {
        made = freeName(P.base(from), taken);
        await rpc('copy', { from, to: P.join(dir, made) });
      } else {
        if (P.parent(from) === dir) return null; // already here
        made = freeName(P.base(from), taken);
        const to = P.join(dir, made);
        await rpc('move', { from, to });
        emit('fs:moved', from, to);
        emit('fs:changed', P.parent(from));
      }
    }
    emit('fs:changed', dir);
    return made;
  } catch (err) {
    toast(`無法放到這裡：${errText(err)}`, true);
    return null;
  }
}
