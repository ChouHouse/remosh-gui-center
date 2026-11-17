// package.json "typesVersions": a package can point each TypeScript version at
// a different folder of declarations (@types/node 22 sends TypeScript 5.6 and
// older to ts5.6/). Used when reading packages from the host (node.js) and
// when building Remogui's own copy of @types/node (scripts/copy-assets.mjs).
const compare = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};
const OPS = { '<=': (c) => c <= 0, '>=': (c) => c >= 0, '<': (c) => c < 0, '>': (c) => c > 0, '=': (c) => c === 0, '': (c) => c === 0 };
const inRange = (range, version) => range.trim().split(/\s+/).every((part) => {
  if (part === '*') return true;
  const m = /^(<=|>=|<|>|=)?\s*v?([\d.]+)$/.exec(part);
  return !!m && OPS[m[1] || ''](compare(version, m[2]));
});

// The file TypeScript `ts` reads instead of `file` (relative to the package), or `file`.
export function typesVersionsPath(pkg, file, ts) {
  const table = pkg?.typesVersions;
  if (!table || typeof table !== 'object' || !ts) return file;
  for (const [range, map] of Object.entries(table)) {
    if (!inRange(range, ts)) continue;
    for (const [pattern, targets] of Object.entries(map || {})) {
      const target = Array.isArray(targets) ? targets[0] : null;
      if (typeof target !== 'string') continue;
      if (pattern === '*') return target.replace('*', file);
      if (pattern.endsWith('*') && file.startsWith(pattern.slice(0, -1))) return target.replace('*', file.slice(pattern.length - 1));
      if (pattern === file) return target;
    }
    return file; // the first range that matches decides
  }
  return file;
}
