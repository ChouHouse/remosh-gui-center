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

export async function dropInto(dir, payload, mods) {
  try {
    const taken = new Set((await rpc('list', { path: dir })).entries.map((e) => e.name));
    if (payload.type === 'app') {
      const file = appFile(getApp(payload.data.id));
      if (taken.has(file.name)) return toast(`這裡已經有「${payload.name}」了`);
      await writeText(P.join(dir, file.name), file.text);
    } else {
      const from = payload.data.path;
      if (mods.altKey) {
        const file = linkFile(from);
        await writeText(P.join(dir, freeName(file.name, taken)), file.text);
      } else if (mods.ctrlKey) {
        await rpc('copy', { from, to: P.join(dir, freeName(P.base(from), taken)) });
      } else {
        if (P.parent(from) === dir) return; // already here
        const to = P.join(dir, freeName(P.base(from), taken));
        await rpc('move', { from, to });
        emit('fs:moved', from, to);
        emit('fs:changed', P.parent(from));
      }
    }
    emit('fs:changed', dir);
  } catch (err) {
    toast(`無法放到這裡：${errText(err)}`, true);
  }
}
