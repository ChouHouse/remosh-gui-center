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
import { tt } from '../core/i18n.js';

export const acceptsDrop = (payload) => payload.type === 'file' || payload.type === 'app';

export function dropAction(payload, mods) {
  if (payload.type === 'app' || mods.altKey) return tt('建立捷徑');
  return mods.ctrlKey ? tt('複製') : tt('移動');
}

// payload.data.paths lists every file being dragged (data.path is the first).
// Resolves to the names that now sit in `dir` (empty if nothing was added).
export async function dropInto(dir, payload, mods) {
  const made = [];
  try {
    const taken = new Set((await rpc('list', { path: dir })).entries.map((e) => e.name));
    if (payload.type === 'app') {
      const file = appFile(getApp(payload.data.id));
      if (taken.has(file.name)) {
        toast(tt('這裡已經有「{0}」了', payload.name));
        return made;
      }
      await writeText(P.join(dir, file.name), file.text);
      made.push(file.name);
    } else {
      for (const from of payload.data.paths || [payload.data.path]) {
        try {
          let name;
          if (mods.altKey) {
            const file = linkFile(from);
            name = freeName(file.name, taken);
            await writeText(P.join(dir, name), file.text);
          } else if (mods.ctrlKey) {
            name = freeName(P.base(from), taken);
            await rpc('copy', { from, to: P.join(dir, name) });
          } else {
            if (P.parent(from) === dir) continue; // already here
            name = freeName(P.base(from), taken);
            const to = P.join(dir, name);
            await rpc('move', { from, to });
            emit('fs:moved', from, to);
            emit('fs:changed', P.parent(from));
          }
          taken.add(name);
          made.push(name);
        } catch (err) {
          toast(tt('無法把「{0}」放到這裡：{1}', P.base(from), errText(err)), true);
        }
      }
    }
    if (made.length) emit('fs:changed', dir);
  } catch (err) {
    toast(tt('無法放到這裡：{0}', errText(err)), true);
  }
  return made;
}
