// Procoder's welcome page: where to start, and the files opened lately.
import { h } from '../../core/dom.js';
import { P } from '../../core/path.js';
import { fileSvg } from '../../core/icons.js';
import { procoderSvg } from './icon.js';

// actions: { newFile(), openFile(), openRecent(path), forget(path) }
export function buildWelcome(recent, actions) {
  const link = (label, run) => h('button', { type: 'button', class: 'pc-w-link', onclick: run }, label);
  const list = recent.length
    ? recent.map((path) => h('div', { class: 'pc-w-recent', 'data-path': path },
      h('button', { type: 'button', class: 'pc-w-link', title: path, onclick: () => actions.openRecent(path) },
        h('span', { class: 'pc-w-ico', html: fileSvg(P.base(path)) }),
        h('span', { class: 'pc-w-name' }, P.base(path)),
        h('span', { class: 'pc-w-dir' }, P.parent(path))),
      h('button', { type: 'button', class: 'pc-w-forget', title: '從清單移除', 'aria-label': '從清單移除', onclick: () => actions.forget(path) }, '×')))
    : h('p', { class: 'pc-w-empty' }, '還沒有開啟過檔案');
  return h('div', { class: 'pc-welcome' },
    h('div', { class: 'pc-w-in' },
      h('div', { class: 'pc-w-head' },
        h('span', { class: 'pc-w-logo', html: procoderSvg() }),
        h('div', null, h('h1', null, 'Procoder'), h('p', null, '直接編輯主機上的檔案'))),
      h('div', { class: 'pc-w-cols' },
        h('section', { class: 'pc-w-start' }, h('h2', null, '開始'),
          link('新增檔案', actions.newFile),
          link('開啟檔案…', actions.openFile)),
        h('section', { class: 'pc-w-recents' }, h('h2', null, '最近開啟'), list)),
      h('p', { class: 'pc-w-tip' }, '也可以從檔案櫃把檔案拖進這個視窗來開啟。')));
}
