// e2e area "graphoto": Graphoto. Run alone with --only=graphoto (see test/e2e.cjs).
module.exports = {
  needs: ['setup', 'shell'],
  async run(shared) {
    const { check, ctxLabels, fs, give, home, page } = shared;
    // ---- Graphoto
    {
      const zlib = require('zlib');
      const png = (w, hh, rgb) => {
        const chunk = (type, data) => {
          const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
          const td = Buffer.concat([Buffer.from(type), data]);
          const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
          return Buffer.concat([len, td, crc]);
        };
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(hh, 4); ihdr[8] = 8; ihdr[9] = 2;
        const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))]);
        const raw = Buffer.concat(Array.from({ length: hh }, () => row));
        return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
      };
      const pics = home + '/pics';
      fs.mkdirSync(pics, { recursive: true });
      fs.writeFileSync(pics + '/a.png', png(40, 30, [200, 40, 40]));
      fs.writeFileSync(pics + '/b10.png', png(20, 50, [40, 200, 40]));
      fs.writeFileSync(pics + '/b9.png', png(64, 64, [40, 40, 200]));
      fs.writeFileSync(pics + '/note.txt', 'not a picture');
      for (const f of ['', '/a.png', '/b10.png', '/b9.png', '/note.txt']) give(pics + f);
      const gp = page.locator('.win[data-app="Graphoto"]');
      const natural = () => gp.locator('.gp-img').evaluate((el) => (el.hidden ? 0 : el.naturalWidth));
      const launchGp = (path) => page.evaluate((p) => import('/js/shell/apps.js').then((m) => m.launchApp('graphoto', { path: p })), path);
      await launchGp(pics + '/a.png');
      await page.waitForFunction(() => document.querySelector('.win[data-app="Graphoto"] .gp-img')?.naturalWidth === 40);
      check((await gp.locator('.statusbar').innerText()).includes('1 / 3') && (await gp.locator('.statusbar').innerText()).includes('40 × 30'), 'Graphoto shows the picture, its place among the folder\'s pictures and its size', await gp.locator('.statusbar').innerText());
      await gp.locator('.gp-stage').press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.win[data-app="Graphoto"] .gp-img')?.naturalWidth === 64);
      check((await gp.locator('.ttext').textContent()).startsWith('b9.png'), '→ goes to the next picture, in natural order (b9 before b10)');
      await gp.locator('.gp-stage').press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.win[data-app="Graphoto"] .gp-img')?.naturalWidth === 20);
      await gp.locator('.gp-stage').press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.win[data-app="Graphoto"] .gp-img')?.naturalWidth === 40);
      check(true, 'and wraps round; other files in the folder are skipped');
      await gp.locator('.gp-btn[title^="實際大小"]').click();
      check((await gp.locator('.gp-zoom').textContent()) === '100%', 'actual size is 100%');
      await gp.locator('.gp-btn[title^="放大"]').click();
      check((await gp.locator('.gp-zoom').textContent()) === '125%', 'zoom in');
      const sb = await gp.locator('.gp-stage').boundingBox();
      await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
      await page.mouse.wheel(0, -300);
      await page.waitForFunction(() => parseInt(document.querySelector('.win[data-app="Graphoto"] .gp-zoom').textContent, 10) > 125);
      check(true, 'the wheel zooms');
      await gp.locator('.gp-btn[title^="向右旋轉"]').click();
      check((await gp.locator('.gp-img').evaluate((el) => el.style.transform)).includes('rotate(90deg)'), 'rotate');
      await gp.locator('.gp-zoom').click();
      check((await gp.locator('.gp-zoom').textContent()) === '100%', 'clicking the percentage fits it again (small pictures are not blown up)');
      await gp.locator('.gp-stage').click({ button: 'right' });
      check((await ctxLabels()).join() === '上一張,下一張,放大,縮小,符合視窗,實際大小,向左旋轉,向右旋轉,在檔案櫃中顯示,下載到這台電腦', 'right-click menu', (await ctxLabels()).join());
      await page.keyboard.press('Escape');
      await launchGp(pics + '/a.png');
      check((await gp.count()) === 1, 'opening a picture that is already open brings its window forward');
      await gp.locator('.traffic .close').click();
      await page.evaluate(() => import('/js/shell/apps.js').then((m) => m.launchApp('graphoto')));
      await gp.waitFor();
      check((await gp.locator('.gp-empty').textContent()).includes('拖到這裡') && (await natural()) === 0, 'opened from the start menu it waits for a picture');
      await gp.locator('.traffic .close').click();
      fs.rmSync(pics, { recursive: true, force: true });
    }
  },
};
