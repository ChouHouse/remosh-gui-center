// POSIX path helpers for remote paths.
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
