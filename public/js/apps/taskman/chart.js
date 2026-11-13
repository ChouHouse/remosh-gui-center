// A small line chart: the last values of one or two series, newest on the right.
import { h } from '../../core/dom.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// slots: how many samples fit across. Returns { el, draw(series, max) } where
// series = [{ values, cls }] and max is the value at the top edge.
export function lineChart(slots) {
  const W = slots - 1;
  const H = 100;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'tm-chart-svg', 'aria-hidden': 'true' });
  const grid = svgEl('g', { class: 'grid' });
  for (const y of [25, 50, 75]) grid.append(svgEl('line', { x1: 0, x2: W, y1: y, y2: y }));
  svg.append(grid);
  const layers = [];
  const el = h('div', { class: 'tm-chart' }, svg);
  return {
    el,
    draw(series, max) {
      series.forEach((s, i) => {
        if (!layers[i]) {
          const area = svgEl('polygon', { class: 'area ' + (s.cls || '') });
          const line = svgEl('polyline', { class: 'line ' + (s.cls || '') });
          svg.append(area, line);
          layers[i] = { area, line };
        }
        const vals = s.values.slice(-slots);
        const start = W - (vals.length - 1);
        const pts = vals.map((v, k) => `${start + k},${(H - Math.min(1, Math.max(0, v / (max || 1))) * H).toFixed(2)}`);
        layers[i].line.setAttribute('points', pts.join(' '));
        layers[i].area.setAttribute('points', pts.length ? `${start},${H} ${pts.join(' ')} ${W},${H}` : '');
      });
    },
  };
}
