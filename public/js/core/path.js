// POSIX path helpers for remote paths.
import { tt } from './i18n.js';
export const P = {
  norm(path) {
    const out = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return '/' + out.join('/');
  },
  join(dir, name) {
    return dir === '/' ? '/' + name : dir + '/' + name;
  },
  parent(path) {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '/' : path.slice(0, i);
  },
  base(path) {
    return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
  },
  ext(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  },
};

// A name that is not taken in a folder: "a.txt" -> "a 複本.txt" -> "a 複本 2.txt".
export function freeName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = tt('{0} 複本{1}{2}', stem, i > 1 ? ' ' + i : '', ext);
    if (!taken.has(candidate)) return candidate;
  }
}

// Files whose extension starts with "inv-" (e.g. config.inv-remosh_gui-config)
// are internal: no part of the GUI lists them. A terminal still does.
export const isInvisible = (name) => /\.inv-[^./]*$/.test(name);
