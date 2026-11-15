// Mounds: a music player for the audio files on the host. Songs are dropped
// in (or opened) to build the playlist, which opens underneath the player.
import './i18n.js'; // this app's texts in the other languages
import { h } from '../../core/dom.js';
import { appStore } from '../../core/app-store.js';
import { errText } from '../../core/errors.js';
import { toast } from '../../core/ui.js';
import { P } from '../../core/path.js';
import { stroke } from '../../core/icons.js';
import { rpc } from '../../core/rpc.js';
import { readFile } from '../../core/file-io.js';
import { tt } from '../../core/i18n.js';
import { createWindow } from '../../shell/wm.js';
import { showContextMenu } from '../../shell/context-menu.js';
import { registerDropTarget } from '../../shell/drag.js';
import { pickPath } from '../../shell/picker.js';
import { registerApp, useAppStyle } from '../../shell/apps.js';
import { moundsSvg } from './icon.js';
import { readTags } from './tags.js';

useAppStyle(import.meta.url);

const APP_NAME = 'Mounds';
const TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm', weba: 'audio/webm' };
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const COLOURS = ['#1f2430', '#6c4bd8', '#1f6feb', '#1f8a4c', '#c9620e', '#b3261e', '#f3f4f6'];
const BASE_HEIGHT = 208;
const LIST_HEIGHT = 230;
// Saved in ~/.remosh-gui/app/mounds/.
const data = appStore('mounds', { defaults: { bg: null, volume: 0.8, rate: 1, shuffle: false, repeat: 'off' } });
const REPEATS = ['off', 'all', 'one'];

const ICON = {
  prev: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3 3h1.800v10H3zM13.500 3.300v9.400L6 8z"/></svg>',
  next: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.200 3H13v10h-1.800zM2.500 3.300v9.400L10 8z"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.500 2.600v10.800L13.500 8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>',
  quiet: stroke('<path d="M2.500 6.200h2.300L8 3.500v9L4.800 9.800H2.500z"/><path d="m10.500 6.500 3 3M13.500 6.500l-3 3"/>'),
  loud: stroke('<path d="M2.500 6.200h2.300L8 3.500v9L4.800 9.800H2.500z"/><path d="M10.300 6a3 3 0 0 1 0 4M12 4.300a5.500 5.500 0 0 1 0 7.400"/>'),
  menu: stroke('<path d="M3 4.500h10M3 8h10M3 11.500h10"/>'),
  shuffle: stroke('<path d="M2 4.500h2.500c3.500 0 3.500 7 7 7H14M2 11.500h2.500c1.200 0 2-.800 2.700-1.800M11.500 4.500H14M8.800 6.300c.700-1 1.500-1.800 2.700-1.800M12.200 2.700 14 4.500l-1.800 1.800M12.200 9.700 14 11.500l-1.800 1.800"/>'),
  repeat: stroke('<path d="M3 7.500V7a2.500 2.500 0 0 1 2.500-2.500H13M11.200 2.700 13 4.500l-1.800 1.800M13 8.500V9a2.500 2.500 0 0 1-2.500 2.500H3M4.800 13.300 3 11.500l1.800-1.800"/>'),
  list: stroke('<path d="M2.500 4h7M2.500 8h7M2.500 12h4.500M12 12.500V5l2.500-.8"/><circle cx="10.800" cy="12.300" r="1.300"/>'),
};
const clock = (sec) => (Number.isFinite(sec) ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : '0:00');
const stem = (name) => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name);
const isAudio = (path) => Object.hasOwn(TYPES, P.ext(P.base(path)));
// Light text on a dark background and the other way round.
function textOn(colour) {
  const n = parseInt(colour.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#1c2026' : '#ffffff';
}

let player = null; // the one Mounds window

function createPlayer() {
  const win = createWindow({ title: APP_NAME, appName: APP_NAME, iconHtml: moundsSvg(), width: 470, height: BASE_HEIGHT });
  const audio = new Audio();
  const songs = []; // { path, name, title, artist }
  let at = -1; // the song in the player
  let token = 0; // counts loads, so a slow one that was overtaken is dropped
  let url = null;
  let loading = '';
  let seeking = false;
  let listOpen = false;
  const heard = new Set(); // songs already played in this round of shuffle
  const trail = []; // songs in the order they were played, for "previous" while shuffling
  let justDragged = false;
  const repeatMode = () => (REPEATS.includes(data.get('repeat')) ? data.get('repeat') : 'off');

  const title = h('div', { class: 'md-title' });
  const artist = h('div', { class: 'md-artist' });
  const bPrev = h('button', { type: 'button', class: 'md-btn md-prev', title: tt('上一首'), 'aria-label': tt('上一首'), html: ICON.prev, onclick: () => step(-1) });
  const bPlay = h('button', { type: 'button', class: 'md-btn md-play', onclick: toggle });
  const bShuffle = h('button', { type: 'button', class: 'md-btn md-mode md-shuffle', html: ICON.shuffle, onclick: () => data.set('shuffle', !data.get('shuffle')) });
  const bRepeat = h('button', { type: 'button', class: 'md-btn md-mode md-repeat', html: ICON.repeat + '<i>1</i>', onclick: () => data.set('repeat', REPEATS[(REPEATS.indexOf(repeatMode()) + 1) % REPEATS.length]) });
  const bNext = h('button', { type: 'button', class: 'md-btn md-next', title: tt('下一首'), 'aria-label': tt('下一首'), html: ICON.next, onclick: () => step(1) });
  const now = h('span', { class: 'md-time' }, '0:00');
  const total = h('span', { class: 'md-time' }, '0:00');
  const seek = h('input', { type: 'range', class: 'md-seek', min: '0', max: '1000', value: '0', 'aria-label': tt('播放進度') });
  const volume = h('input', { type: 'range', class: 'md-volume', min: '0', max: '100', 'aria-label': tt('音量') });
  const bMenu = h('button', { type: 'button', class: 'md-corner md-menu', title: tt('選單'), 'aria-label': tt('選單'), html: ICON.menu, onclick: menu });
  const bList = h('button', { type: 'button', class: 'md-corner md-list-btn', title: tt('歌單'), 'aria-label': tt('歌單'), html: ICON.list, onclick: () => showList(!listOpen) });
  const list = h('div', { class: 'md-list', role: 'listbox', 'aria-label': tt('歌單') });
  const card = h('div', { class: 'md-player' },
    bMenu,
    h('div', { class: 'md-head' }, title, artist),
    h('div', { class: 'md-controls' }, bShuffle, bPrev, bPlay, bNext, bRepeat),
    h('div', { class: 'md-bars' },
      h('div', { class: 'md-progress' }, now, seek, total),
      h('div', { class: 'md-vol' }, h('span', { class: 'md-vol-ico', html: ICON.quiet }), volume, h('span', { class: 'md-vol-ico', html: ICON.loud })),
      bList));
  win.body.classList.add('md-body');
  win.body.append(card, list);

  // ---- looks
  function applyLook() {
    const bg = /^#[0-9a-f]{6}$/i.test(data.get('bg') || '') ? data.get('bg') : null;
    if (bg) {
      win.body.style.setProperty('--md-bg', bg);
      win.body.style.setProperty('--md-fg', textOn(bg));
    } else {
      win.body.style.removeProperty('--md-bg');
      win.body.style.removeProperty('--md-fg');
    }
    win.body.classList.toggle('md-tinted', !!bg);
    audio.volume = Math.max(0, Math.min(1, Number(data.get('volume')) || 0));
    volume.value = String(Math.round(audio.volume * 100));
    audio.playbackRate = RATES.includes(data.get('rate')) ? data.get('rate') : 1;
  }

  function paint() {
    const song = songs[at];
    title.textContent = song ? song.title || stem(song.name) : tt('還沒有歌曲');
    artist.textContent = loading || (song ? song.artist || '' : tt('把歌曲拖進來，或從選單開啟檔案'));
    win.setTitle(song ? song.title || stem(song.name) : APP_NAME);
    const playing = !audio.paused && !audio.ended;
    bPlay.innerHTML = playing ? ICON.pause : ICON.play;
    bPlay.title = playing ? tt('暫停') : tt('播放');
    bPlay.setAttribute('aria-label', bPlay.title);
    bPlay.dataset.state = playing ? 'playing' : 'paused';
    bPrev.disabled = bNext.disabled = songs.length < 2;
    const shuffle = !!data.get('shuffle');
    bShuffle.setAttribute('aria-pressed', String(shuffle));
    bShuffle.title = shuffle ? tt('隨機播放：開') : tt('隨機播放：關');
    bShuffle.setAttribute('aria-label', bShuffle.title);
    bRepeat.dataset.mode = repeatMode();
    bRepeat.setAttribute('aria-pressed', String(repeatMode() !== 'off'));
    bRepeat.title = { off: tt('循環：關'), all: tt('循環：整個歌單'), one: tt('循環：單曲') }[repeatMode()];
    bRepeat.setAttribute('aria-label', bRepeat.title);
    bPlay.disabled = !songs.length;
    seek.disabled = !song || !Number.isFinite(audio.duration);
    if (!seeking) {
      now.textContent = clock(audio.currentTime);
      seek.value = audio.duration ? String(Math.round((audio.currentTime / audio.duration) * 1000)) : '0';
    }
    total.textContent = clock(audio.duration);
  }

  function paintList() {
    list.replaceChildren(...(songs.length
      ? songs.map((song, i) => {
        const row = h('div', { class: 'md-song' + (i === at ? ' on' : ''), role: 'option', 'aria-selected': String(i === at), 'data-path': song.path },
          h('button', { type: 'button', class: 'md-song-main', title: song.path, onclick: () => !justDragged && play(songs.indexOf(song)) },
            h('span', { class: 'md-song-no' }, String(i + 1)),
            h('span', { class: 'md-song-name' }, song.title || stem(song.name)),
            h('span', { class: 'md-song-artist' }, song.artist || '')),
          h('button', { type: 'button', class: 'md-song-del', title: tt('從歌單移除'), 'aria-label': tt('從歌單移除'), onclick: () => removeSong(songs.indexOf(song)) }, '×'));
        row.firstChild.addEventListener('pointerdown', (ev) => dragSong(ev, song, row));
        return row;
      })
      : [h('div', { class: 'md-empty' }, tt('歌單是空的。把歌曲拖進來，或從選單開啟檔案'))]));
  }

  // Drag a song up or down to change the order.
  function dragSong(down, song, row) {
    if (down.button !== 0) return;
    const current = songs[at];
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientY - down.clientY) < 5) return;
      moved = true;
      row.classList.add('moving');
      const others = [...list.querySelectorAll('.md-song')].filter((r) => r !== row);
      const to = others.filter((r) => {
        const b = r.getBoundingClientRect();
        return b.top + b.height / 2 < ev.clientY;
      }).length;
      const from = songs.indexOf(song);
      if (to === from) return;
      songs.splice(from, 1);
      songs.splice(to, 0, song);
      if (to >= others.length) list.append(row);
      else others[to].before(row);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!moved) return;
      justDragged = true; // the click that ends the drag must not start the song
      setTimeout(() => {
        justDragged = false;
      });
      at = songs.indexOf(current);
      paintList();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // The playlist opens underneath the player; the window grows to hold it.
  function showList(open) {
    listOpen = open;
    win.body.classList.toggle('md-list-open', open);
    bList.setAttribute('aria-pressed', String(open));
    if (!win.maximized) win.el.style.height = (open ? BASE_HEIGHT + LIST_HEIGHT : BASE_HEIGHT) + 'px';
  }

  // ---- playing
  async function play(i, { back = false } = {}) {
    const song = songs[i];
    if (!song) return;
    heard.add(song);
    if (!back && trail[trail.length - 1] !== song) trail.push(song);
    const mine = ++token;
    at = i;
    audio.pause();
    loading = tt('載入中…');
    paint();
    paintList();
    let bytes;
    try {
      ({ bytes } = await readFile(song.path, {
        onProgress: (done, size) => {
          if (mine !== token) return;
          loading = tt('載入中… {0}%', Math.floor((done / size) * 100));
          artist.textContent = loading;
        },
      }));
    } catch (err) {
      if (mine !== token) return;
      loading = '';
      paint();
      return toast(tt('無法開啟「{0}」：{1}', song.name, errText(err)), true);
    }
    if (mine !== token || !player) return;
    Object.assign(song, readTags(bytes));
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([bytes], { type: TYPES[P.ext(song.name)] || 'audio/mpeg' }));
    audio.src = url;
    audio.playbackRate = RATES.includes(data.get('rate')) ? data.get('rate') : 1;
    loading = '';
    paint();
    paintList();
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: song.title || stem(song.name), artist: song.artist || '' });
    audio.play().catch(() => {}); // the browser may want a click first; the play button then starts it
  }

  function toggle() {
    if (at < 0) return songs.length ? play(0) : undefined;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  // The song after this one. `auto` = the song ended by itself: then the end
  // of the list (or of a shuffle round) stops, unless the list repeats.
  function nextIndex(auto) {
    const stop = auto && repeatMode() === 'off' ? -1 : null;
    if (data.get('shuffle') && songs.length > 1) {
      let pool = songs.filter((s) => !heard.has(s));
      if (!pool.length) {
        if (stop !== null) return stop;
        heard.clear();
        pool = songs.filter((s) => s !== songs[at]);
      }
      return songs.indexOf(pool[Math.floor(Math.random() * pool.length)]);
    }
    if (at < songs.length - 1) return at + 1;
    return stop ?? 0;
  }

  function step(by) {
    if (!songs.length) return;
    if (by > 0) return play(nextIndex(false));
    // "Previous" a few seconds into a song starts it over, like players do.
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (data.get('shuffle')) {
      // back along the songs that were actually played
      while (trail.length && (trail[trail.length - 1] === songs[at] || !songs.includes(trail[trail.length - 1]))) trail.pop();
      if (trail.length) return play(songs.indexOf(trail[trail.length - 1]), { back: true });
    }
    play((at - 1 + songs.length) % songs.length);
  }

  function removeSong(i) {
    heard.delete(songs[i]);
    songs.splice(i, 1);
    if (i === at) {
      token++;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      loading = '';
      at = -1;
      if (songs.length) play(Math.min(i, songs.length - 1));
    } else if (i < at) at--;
    paint();
    paintList();
  }

  // Adds audio files to the playlist; other files are left out, with a note.
  async function add(paths, { start = false } = {}) {
    let skipped = 0;
    let first = -1;
    for (const path of paths) {
      if (!isAudio(path)) {
        skipped++;
        continue;
      }
      const known = songs.findIndex((s) => s.path === path);
      if (known >= 0) {
        if (first < 0) first = known;
        continue;
      }
      try {
        const { entry } = await rpc('stat', { path });
        if (entry.type === 'dir') throw new Error('dir');
      } catch {
        skipped++;
        continue;
      }
      songs.push({ path, name: P.base(path), title: '', artist: '' });
      if (first < 0) first = songs.length - 1;
    }
    if (skipped) toast(skipped === paths.length ? tt('這些不是 Mounds 能播放的音樂檔') : tt('略過了 {0} 個不是音樂的項目', skipped));
    paint();
    paintList();
    if (first < 0) return;
    showList(true);
    if (start || at < 0) play(first);
  }

  // ---- menu and settings
  function menu(ev) {
    const rate = audio.playbackRate;
    showContextMenu(ev, [
      { label: tt('開啟檔案…'), run: openFile },
      null,
      ...RATES.map((r) => ({ label: (r === rate ? '✓ ' : '') + tt('速度 {0}×', r), run: () => data.set('rate', r) })),
      null,
      { label: tt('設定'), run: showSettings },
    ]);
  }

  async function openFile() {
    const path = await pickPath({ mode: 'file', title: tt('開啟音樂檔'), start: songs[at] ? P.parent(songs[at].path) : undefined });
    if (path && player) add([path], { start: true });
  }

  // Settings have a small window of their own.
  let setWin = null;
  function paintSettings() {
    if (!setWin) return;
    const current = (data.get('bg') || '').toLowerCase();
    const custom = h('input', { type: 'color', id: 'md-bg-custom', value: /^#[0-9a-f]{6}$/i.test(current) ? current : '#6c4bd8', title: tt('自訂顏色'), 'aria-label': tt('自訂顏色') });
    custom.addEventListener('change', () => data.set('bg', custom.value));
    setWin.body.replaceChildren(h('div', { class: 'md-settings-win' },
      h('div', { class: 'md-set-row' }, h('span', null, tt('背景顏色')),
        h('div', { class: 'md-swatches' },
          h('button', { type: 'button', class: 'md-swatch md-swatch-none' + (current ? '' : ' on'), title: tt('預設'), 'aria-label': tt('預設'), onclick: () => data.set('bg', null) }),
          COLOURS.map((c) => h('button', { type: 'button', class: 'md-swatch' + (c === current ? ' on' : ''), style: `background:${c}`, 'data-colour': c, title: c, 'aria-label': c, onclick: () => data.set('bg', c) })),
          custom))));
  }
  function showSettings() {
    if (setWin) return setWin.focus();
    setWin = createWindow({ title: tt('設定'), appName: APP_NAME, iconHtml: moundsSvg(), width: 420, height: 150 });
    setWin.destroy = () => {
      setWin = null;
    };
    paintSettings();
  }

  // ---- wiring
  for (const type of ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata']) audio.addEventListener(type, paint);
  audio.addEventListener('ended', () => {
    if (repeatMode() === 'one') {
      audio.currentTime = 0;
      return audio.play().catch(() => {});
    }
    const next = nextIndex(true);
    if (next >= 0) play(next);
    else {
      heard.clear();
      paint();
    }
  });
  audio.addEventListener('error', () => {
    if (!audio.src || !songs[at]) return;
    toast(tt('無法播放「{0}」：瀏覽器不支援這個檔案', songs[at].name), true);
    paint();
  });
  seek.addEventListener('input', () => {
    seeking = true;
    now.textContent = clock((seek.value / 1000) * (audio.duration || 0));
  });
  seek.addEventListener('change', () => {
    if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
    seeking = false;
  });
  volume.addEventListener('input', () => {
    audio.volume = volume.value / 100;
  });
  volume.addEventListener('change', () => data.set('volume', volume.value / 100));
  if ('mediaSession' in navigator) {
    for (const [name, run] of [['play', toggle], ['pause', toggle], ['previoustrack', () => step(-1)], ['nexttrack', () => step(1)]]) {
      try {
        navigator.mediaSession.setActionHandler(name, run);
      } catch { /* this browser does not know the action */ }
    }
  }
  // Saved choices changed (colour, speed, volume): follow them.
  const follow = () => {
    applyLook();
    paint();
    paintSettings();
  };
  // Songs dragged in from the file cabinet or the desktop, one or many.
  const offDrop = registerDropTarget(win.el, {
    accepts: (payload) => payload.type === 'file',
    action: () => tt('加入 Mounds 歌單'),
    onDrop: (payload) => add(payload.data.paths || [payload.data.path]),
  });
  win.destroy = () => {
    token++;
    setWin?.close(true);
    offDrop();
    audio.pause();
    audio.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
    player = null;
  };

  applyLook();
  paint();
  paintList();
  return { win, add, follow };
}

data.onChange(() => player?.follow());

function openMounds(args) {
  if (!player) player = createPlayer();
  else player.win.focus();
  if (args?.path && !args.folder) player.add([args.path], { start: true });
}

registerApp({ id: 'mounds', order: 45, name: APP_NAME, icon: moundsSvg, startMenu: true, extensions: Object.keys(TYPES), launch: openMounds });
