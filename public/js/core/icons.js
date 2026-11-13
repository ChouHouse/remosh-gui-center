// Inline SVG icons the system shares: files and folders, and the small
// toolbar icons. An app's own icon lives in its folder (apps/<name>/icon.js).
import { P } from './path.js';

export const EXT_COLORS = ['#d9534f', '#e08a1e', '#2e9e5b', '#1f8fd6', '#7a5bd6', '#c2409a', '#4f7a8a'];
export function folderSvg() {
  return '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M4 12a4 4 0 0 1 4-4h10l5 5h17a4 4 0 0 1 4 4v19a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="var(--folder-dark)"/><path d="M4 18h40v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="var(--folder)"/></svg>';
}
export function fileSvg(name) {
  const ext = P.ext(name).replace(/[^a-z0-9]/g, '').slice(0, 4).toUpperCase();
  let hash = 0;
  for (const ch of ext) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const label = ext
    ? `<text x="24" y="35" text-anchor="middle" font-size="${ext.length > 3 ? 8 : 9.5}" font-weight="700" font-family="system-ui,sans-serif" fill="${EXT_COLORS[hash % EXT_COLORS.length]}">${ext}</text>`
    : '<path d="M16 24h16M16 30h16M16 36h10" stroke="var(--file-edge)" stroke-width="1.6" stroke-linecap="round"/>';
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M11 4h18l10 10v28a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="var(--file)" stroke="var(--file-edge)" stroke-width="1.5"/><path d="M29 4v10h10" fill="none" stroke="var(--file-edge)" stroke-width="1.5"/>${label}</svg>`;
}
export const stroke = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON = {
  back: stroke('<path d="M10 3 5 8l5 5"/>'),
  fwd: stroke('<path d="m6 3 5 5-5 5"/>'),
  up: stroke('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>'),
  refresh: stroke('<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/>'),
  grid: stroke('<rect x="2.5" y="2.5" width="4" height="4"/><rect x="9.5" y="2.5" width="4" height="4"/><rect x="2.5" y="9.5" width="4" height="4"/><rect x="9.5" y="9.5" width="4" height="4"/>'),
  list: stroke('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
  eye: stroke('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  home: stroke('<path d="M2.5 7.5 8 3l5.5 4.5V13h-4v-3.5h-3V13h-4z"/>'),
  disk: stroke('<rect x="2.5" y="4" width="11" height="8" rx="1.5"/><path d="M5 9.5h.01M7.5 9.5h3.5"/>'),
  folder: stroke('<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>'),
};
