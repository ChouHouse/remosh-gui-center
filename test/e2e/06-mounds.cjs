// e2e area "mounds": Mounds. Run alone with --only=mounds (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  async run(shared) {
    const { check, fs, give, home, menuLabels, page, pick, sleep, waitApp } = shared;
    // ---- Mounds: the music player
    {
      // two short WAV files (a sine tone) for it to play
      const wav = (seconds, hz) => {
        const rate = 8000; const n = Math.floor(rate * seconds); const b = Buffer.alloc(44 + n * 2);
        b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
        b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
        for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((i / rate) * hz * 2 * Math.PI) * 3000), 44 + i * 2);
        return b;
      };
      fs.rmSync(home + '/music', { recursive: true, force: true });
      fs.mkdirSync(home + '/music');
      fs.writeFileSync(home + '/music/first song.wav', wav(65, 440));
      fs.writeFileSync(home + '/music/second.wav', wav(2, 660));
      fs.writeFileSync(home + '/music/notes.txt', 'x');
      for (const f of ['', '/first song.wav', '/second.wav', '/notes.txt']) give(home + '/music' + f);
      const launch = (path) => page.evaluate((p) => import('/js/shell/apps.js').then((m) => { m.launchApp('mounds', p ? { path: p } : undefined); }), path);
      await launch();
      const md = page.locator('.win[data-app="Mounds"]', { has: page.locator('.md-player') });
      await md.locator('.md-player').waitFor();
      check((await md.locator('.md-title').textContent()) === '還沒有歌曲' && await md.locator('.md-list').isHidden() && await md.locator('.md-play').isDisabled(), 'Mounds opens with an empty playlist, closed');
      check((await md.locator('.md-controls .md-btn').allTextContents()).length === 5 && (await md.locator('.md-controls .md-btn').evaluateAll((els) => els.map((e) => e.className.split(' ').pop()).join())) === 'md-shuffle,md-prev,md-play,md-next,md-repeat' && (await md.locator('.md-menu').count()) === 1 && (await md.locator('.md-list-btn').count()) === 1
        && (await md.locator('.md-progress .md-time').count()) === 2 && (await md.locator('.md-vol .md-vol-ico').count()) === 2, 'the player: name, previous / play / next, time and volume bars, menu and playlist buttons');
      {
        const p = await md.locator('.md-progress').boundingBox();
        const v = await md.locator('.md-vol').boundingBox();
        check(Math.abs(p.width / (p.width + v.width) - 0.7) < 0.03, 'the time bar takes 70% of the row, the volume 30%', (p.width / (p.width + v.width)).toFixed(2));
      }
      const before = (await md.boundingBox()).height;
      await launch(home + '/music/first song.wav');
      await page.waitForFunction(() => document.querySelector('.md-time:last-child')?.textContent === '1:05');
      check((await md.locator('.md-title').textContent()) === 'first song' && (await md.locator('.titlebar .ttext').textContent()) === 'first song — Mounds', 'a song shows its name (without the extension) and its length');
      check(await md.locator('.md-list').isVisible() && (await md.boundingBox()).height > before + 150 && (await md.locator('.md-song').count()) === 1 && await md.locator('.md-song.on').count() === 1,
        'adding a song opens the playlist underneath the player');
      await page.evaluate((paths) => import('/js/shell/apps.js').then((m) => { for (const p of paths) m.launchApp('mounds', { path: p }); }), [home + '/music/second.wav']);
      await page.waitForFunction(() => document.querySelector('.md-title').textContent === 'second' && document.querySelector('.md-time:last-child')?.textContent === '0:02');
      check((await md.locator('.md-song .md-song-name').allTextContents()).join() === 'first song,second' && (await md.locator('.md-song.on .md-song-name').textContent()) === 'second', 'more songs join the playlist; the one just opened plays');
      await md.locator('.md-prev').click();
      await page.waitForFunction(() => document.querySelector('.md-title').textContent === 'first song' && document.querySelector('.md-time:last-child')?.textContent === '1:05');
      check(true, '"previous" goes to the song before');
      if ((await md.locator('.md-play').getAttribute('data-state')) !== 'playing') await md.locator('.md-play').click();
      await page.waitForFunction(() => document.querySelector('.md-play').dataset.state === 'playing' && document.querySelector('.md-progress .md-time').textContent !== '0:00', null, { timeout: 15000 });
      check(true, 'it plays: the time moves');
      await md.locator('.md-play').click();
      await page.waitForFunction(() => document.querySelector('.md-play').dataset.state === 'paused');
      check((await md.locator('.md-play').getAttribute('title')) === '播放', 'the middle button pauses and starts');
      await md.locator('.md-menu').click();
      check((await menuLabels()).join('|') === '開啟檔案…|速度 0.5×|速度 0.75×|✓ 速度 1×|速度 1.25×|速度 1.5×|速度 2×|設定', 'the menu: open a file, the playing speeds, settings', (await menuLabels()).join('|'));
      await pick('速度 1.5×');
      check(await waitApp('mounds', (d) => d.rate === 1.5), 'the speed is applied and kept in ~/.remosh-gui/app/mounds');
      await md.locator('.md-menu').click();
      check((await menuLabels()).includes('✓ 速度 1.5×'), 'the menu marks the speed in use');
      await pick('設定');
      const mdSet = page.locator('.win', { has: page.locator('.md-settings-win') });
      await mdSet.locator('.md-swatch').first().waitFor();
      check((await mdSet.locator('.titlebar .ttext').textContent()) === '設定 — Mounds' && (await md.locator('.md-settings-win').count()) === 0, 'settings open in a window of their own, not over the player', await mdSet.locator('.titlebar .ttext').textContent());
      await mdSet.locator('.md-swatch[data-colour="#1f6feb"]').click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.md-body')).backgroundColor === 'rgb(31, 111, 235)');
      check(await waitApp('mounds', (d) => d.bg === '#1f6feb') && (await md.locator('.md-title').evaluate((el) => getComputedStyle(el).color)) === 'rgb(255, 255, 255)', 'settings: the background colour changes, with text that stays readable');
      await mdSet.locator('.md-swatch-none').click();
      check(await waitApp('mounds', (d) => d.bg === null) && (await mdSet.locator('.md-swatch-none').evaluate((el) => el.classList.contains('on'))), 'the colour can go back to the default');
      await mdSet.locator('.traffic .close').click();
      await md.locator('.titlebar').click();
      // shuffle and repeat
      await md.locator('.md-repeat').click();
      check(await waitApp('mounds', (d) => d.repeat === 'all') && (await md.locator('.md-repeat').getAttribute('title')) === '循環：整個歌單' && (await md.locator('.md-repeat').getAttribute('aria-pressed')) === 'true', 'repeat: the whole playlist');
      await md.locator('.md-repeat').click();
      check(await waitApp('mounds', (d) => d.repeat === 'one') && await md.locator('.md-repeat i').isVisible(), 'repeat: one song, marked with a 1');
      await md.locator('.md-repeat').click();
      check(await waitApp('mounds', (d) => d.repeat === 'off') && (await md.locator('.md-repeat').getAttribute('aria-pressed')) === 'false', 'and off again');
      await md.locator('.md-shuffle').click();
      check(await waitApp('mounds', (d) => d.shuffle === true) && (await md.locator('.md-shuffle').getAttribute('title')) === '隨機播放：開', 'shuffle can be switched on');
      await md.locator('.md-next').click();
      await page.waitForFunction(() => document.querySelector('.md-title').textContent === 'second');
      await md.locator('.md-prev').click();
      await page.waitForFunction(() => document.querySelector('.md-title').textContent === 'first song');
      check(true, 'shuffling plays another song, and "previous" goes back to the one before');
      await md.locator('.md-shuffle').click();
      // the song at the end of a list that repeats is followed by the first one
      await md.locator('.md-repeat').click();
      await md.locator('.md-song', { hasText: 'second' }).locator('.md-song-main').click();
      await page.waitForFunction(() => document.querySelector('.md-title').textContent === 'second' && document.querySelector('.md-time:last-child')?.textContent === '0:02');
      if ((await md.locator('.md-play').getAttribute('data-state')) !== 'playing') await md.locator('.md-play').click();
      await page.waitForFunction(() => document.querySelector('.md-title').textContent === 'first song', null, { timeout: 20000 });
      check(true, 'with repeat on, the end of the playlist goes round to the first song');
      await md.locator('.md-play').click();
      await md.locator('.md-repeat').click();
      await md.locator('.md-repeat').click();
      // drag a song to another place in the playlist
      {
        const a = await md.locator('.md-song', { hasText: 'first song' }).locator('.md-song-main').boundingBox();
        const b = await md.locator('.md-song', { hasText: 'second' }).locator('.md-song-main').boundingBox();
        await page.mouse.move(a.x + 80, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + 80, b.y + b.height - 3, { steps: 6 });
        await page.mouse.up();
        await sleep(80);
        check((await md.locator('.md-song .md-song-name').allTextContents()).join() === 'second,first song' && (await md.locator('.md-song.on .md-song-name').textContent()) === 'first song'
          && (await md.locator('.md-song-no').allTextContents()).join() === '1,2' && (await md.locator('.md-title').textContent()) === 'first song',
          'songs can be dragged up and down the playlist; the one playing stays the one playing', (await md.locator('.md-song .md-song-name').allTextContents()).join());
      }
      await launch(home + '/music/notes.txt');
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('不是 Mounds 能播放的檔案')));
      check((await md.locator('.md-song').count()) === 2, 'a file that is not music is refused');
      await md.locator('.md-list-btn').click();
      check(await md.locator('.md-list').isHidden() && Math.abs((await md.boundingBox()).height - before) < 3, 'the playlist button folds the playlist away again');
      const tags = await page.evaluate(() => import('/js/apps/mounds/tags.js').then((m) => {
        const frame = (id, text) => { const body = [3, ...new TextEncoder().encode(text)]; return [...id].map((c) => c.charCodeAt(0)).concat([0, 0, 0, body.length, 0, 0], body); };
        const frames = [...frame('TIT2', '夜曲'), ...frame('TPE1', 'Someone')];
        return m.readTags(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, frames.length, ...frames, 0xff, 0xfb]));
      }));
      check(tags.title === '夜曲' && tags.artist === 'Someone', 'the title and the artist are read from an MP3\'s tag', JSON.stringify(tags));
      // a video: recorded here from a canvas, then played from the host
      const clip = await page.evaluate(async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
        const g = canvas.getContext('2d');
        const rec = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm' });
        const parts = [];
        rec.ondataavailable = (ev) => parts.push(ev.data);
        const done = new Promise((resolve) => { rec.onstop = resolve; });
        rec.start();
        for (let i = 0; i < 20; i++) {
          g.fillStyle = `hsl(${i * 18} 80% 50%)`;
          g.fillRect(0, 0, 320, 180);
          await new Promise((r) => setTimeout(r, 70));
        }
        rec.stop();
        await done;
        const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
      });
      fs.writeFileSync(home + '/music/clip.webm', Buffer.from(clip, 'base64'));
      give(home + '/music/clip.webm');
      check((await md.locator('.md-screen').isHidden()), 'music plays without a screen');
      await launch(home + '/music/clip.webm');
      await page.waitForFunction(() => document.querySelector('.md-video')?.videoWidth === 320, null, { timeout: 15000 });
      await sleep(150);
      const screenBox = await md.locator('.md-screen').boundingBox();
      check(await md.locator('.md-screen').isVisible() && Math.abs(screenBox.height - 264) < 3 && Math.abs((await md.boundingBox()).height - before - 264 - 230) < 3
        && (await md.locator('.md-title').textContent()) === 'clip', 'a video gets a screen above the controls, and the window grows for it', JSON.stringify(screenBox));
      check((await md.locator('.md-song').count()) === 3 && (await md.locator('.md-song.on .md-song-name').textContent()) === 'clip', 'videos sit in the same playlist as the music');
      // the file is streamed from the host, not fetched whole
      const streamUrl = await page.evaluate(() => document.querySelector('.md-video').currentSrc);
      const part = await page.evaluate(async (u) => {
        const r = await fetch(u, { headers: { Range: 'bytes=4-13' } });
        return { status: r.status, range: r.headers.get('content-range'), type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
      }, streamUrl);
      const clipSize = fs.statSync(home + '/music/clip.webm').size;
      check(/\/api\/stream\/[0-9a-f]{48}$/.test(streamUrl) && part.status === 206 && part.bytes === 10 && part.range === `bytes 4-13/${clipSize}` && part.type === 'video/webm',
        'the player streams the file: any part of it can be asked for', JSON.stringify(part));
      check((await page.evaluate((u) => fetch(u.slice(0, -4) + '0000').then((r) => r.status), streamUrl)) === 404, 'a made-up stream address gets nothing');
      await md.locator('.md-screen').dblclick();
      await sleep(350);
      check(await md.evaluate((el) => el.classList.contains('maximized')) && (await md.locator('.md-screen').boundingBox()).height > 300, 'double-click on the picture fills the desktop');
      await md.locator('.md-screen').dblclick();
      await sleep(350);
      check(!(await md.evaluate((el) => el.classList.contains('maximized'))), 'and again goes back');
      await md.locator('.md-song', { hasText: 'second' }).locator('.md-song-main').click();
      await page.waitForFunction(() => document.querySelector('.md-title').textContent === 'second' && !document.querySelector('.md-body').classList.contains('md-has-video'));
      await sleep(150);
      check(await md.locator('.md-screen').isHidden() && Math.abs((await md.boundingBox()).height - before - 230) < 3, 'back on a song, the screen folds away');
      await md.locator('.traffic .close').click();
      await sleep(300);
      check((await page.evaluate((u) => fetch(u).then((r) => r.status), streamUrl)) === 404, 'a stream address stops working once the player has moved on');
      fs.rmSync(home + '/music', { recursive: true, force: true });
    }
  },
};
