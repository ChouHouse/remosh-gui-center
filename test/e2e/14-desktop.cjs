// e2e area "desktop": desktop. Run alone with --only=desktop (see test/e2e.cjs).
module.exports = {
  needs: ['setup', 'files'],
  async run(shared) {
    const { check, fs, give, home, item, menuLabels, page, pick, sleep, toFinder, waitApp, waitSetting } = shared;
    // ---- desktop: ~/.remosh-gui/desktop, drag and drop, shortcuts
    const desk = home + '/.remosh-gui/desktop';
    check(fs.existsSync(desk) && fs.statSync(desk).isDirectory(), 'the desktop folder is created in ~/.remosh-gui');
    const deskItem = (name) => page.locator('.desk-item', { has: page.locator('.name', { hasText: new RegExp('^' + name.replace(/[.]/g, '\\.') + '$') }) });
    const exists = async (path, want = true) => {
      for (let i = 0; i < 50; i++) {
        if (fs.existsSync(path) === want) return true;
        await sleep(100);
      }
      return false;
    };
    // A file shows up before its content is written; wait for the content.
    const holds = async (path, text) => {
      for (let i = 0; i < 50; i++) {
        if (fs.existsSync(path) && fs.readFileSync(path, 'utf8') === text) return true;
        await sleep(100);
      }
      return false;
    };
    const beginDrag = async (locator, x, y, mod) => {
      await locator.scrollIntoViewIfNeeded().catch(() => {}); // e.g. far down a long list
      let b = null; // the icons may be redrawn right now: ask again until the item is there
      for (let i = 0; i < 40 && !b; i++) {
        await locator.waitFor();
        b = await locator.boundingBox();
        if (!b) await sleep(50);
      }
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      if (mod) await page.keyboard.down(mod);
      await page.mouse.move(b.x + b.width / 2 + 12, b.y + b.height / 2 + 12, { steps: 2 });
      await page.mouse.move(x, y, { steps: 6 });
    };
    const endDrag = async (mod) => {
      await page.mouse.up();
      if (mod) await page.keyboard.up(mod);
    };
    const ghost = async () => [await page.textContent('.drag-ghost .nm'), await page.textContent('.drag-ghost .act')].join('|');
    // Clear the screen first: only the file cabinet stays up.
    if (await page.locator('.win:not(.minimized)').count()) await page.click('#show-desktop');
    await toFinder();
    const fwin = page.locator('.win[data-app="檔案櫃"]').first();
    let tb2 = await fwin.locator('.titlebar .title').boundingBox();
    await page.mouse.move(tb2.x + 60, tb2.y + 10);
    await page.mouse.down();
    await page.mouse.move(tb2.x + 90, tb2.y + 40, { steps: 3 });
    await page.mouse.move(1279, 300, { steps: 6 });
    await page.mouse.up();
    await sleep(350); // file cabinet on the right half, desktop free on the left
    for (const n of ['drag-a.txt', 'drag-b.txt']) {
      fs.writeFileSync(home + '/project/' + n, n + '\n');
      give(home + '/project/' + n);
    }
    await item('drag-b.txt').waitFor({ timeout: 9000 });
    await beginDrag(item('drag-a.txt'), 300, 420);
    check((await ghost()) === 'drag-a.txt|移動' && (await page.locator('.drag-ghost .ico svg').count()) === 1, 'dragging shows a card with icon, name and what will happen');
    check(await page.evaluate(() => document.querySelector('#desktop-icons').classList.contains('drop-over')), 'the desktop lights up as a drop target', await page.evaluate(() => {
      const chain = [];
      for (let el = document.elementFromPoint(300, 420); el; el = el.parentElement) chain.push(el.tagName + '#' + el.id + '.' + String(el.className).slice(0, 30) + (el.dataset?.app ? '[' + el.dataset.app + ']' : ''));
      return chain.slice(0, 6).join(' < ') + ' | open: ' + [...document.querySelectorAll('.win:not(.minimized) .titlebar .title')].map((e) => e.textContent).join(',');
    }));
    await endDrag();
    check(await exists(desk + '/drag-a.txt') && await exists(home + '/project/drag-a.txt', false), 'dropping a file on the desktop moves it into ~/.remosh-gui/desktop');
    await deskItem('drag-a.txt').waitFor();
    check((await page.locator('.drag-ghost').count()) === 0, 'the card disappears after the drop');
    await beginDrag(item('drag-b.txt'), 300, 420, 'Control');
    check((await ghost()) === 'drag-b.txt|複製', 'holding Ctrl turns it into a copy');
    await endDrag('Control');
    check(await exists(desk + '/drag-b.txt') && fs.existsSync(home + '/project/drag-b.txt'), 'Ctrl + drop copies');
    await beginDrag(item('src'), 300, 420, 'Alt');
    check((await ghost()) === 'src|建立捷徑', 'holding Alt makes a shortcut');
    await endDrag('Alt');
    check(await holds(desk + '/src.remosh_gui-lnk', 'lnk:' + home + '/project/src\n') && fs.existsSync(home + '/project/src'), 'Alt + drop writes a .remosh_gui-lnk with "lnk:<path>"');
    await deskItem('src').waitFor();
    check((await deskItem('src').locator('.lnk-badge').count()) === 1, 'a shortcut shows its target\'s icon with an arrow, and hides the extension');
    const boxes = await page.locator('.desk-item').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.top)]));
    const onGrid = boxes.every((b) => (b[0] - 12) % 96 === 0 && (b[1] - 12) % 96 === 0) && new Set(boxes.map(String)).size === boxes.length;
    const dropCell = [12 + Math.floor((300 - 12) / 96) * 96, 12 + Math.floor((420 - 12) / 96) * 96];
    check(onGrid && String(await deskItem('src').evaluate((el) => [el.offsetLeft, el.offsetTop])) === String(dropCell), 'icons sit on a grid, one per cell; the last one dropped is where it was dropped', JSON.stringify(await page.locator('.desk-item').evaluateAll((els) => els.map((e) => [e.textContent.trim(), e.offsetLeft, e.offsetTop]))));
    fs.writeFileSync(desk + '/fresh.txt', 'x');
    give(desk + '/fresh.txt');
    await deskItem('fresh.txt').waitFor({ timeout: 9000 });
    const freshAt = await deskItem('fresh.txt').evaluate((el) => [el.offsetLeft, el.offsetTop]);
    check(freshAt[0] === 12 && !boxes.some((b) => String(b) === String(freshAt)), 'a file that appears on its own takes the first free cell from the top left', JSON.stringify(freshAt));
    fs.rmSync(desk + '/fresh.txt');
    await deskItem('fresh.txt').waitFor({ state: 'detached', timeout: 9000 });
    await deskItem('src').dblclick();
    await page.waitForFunction(() => document.querySelectorAll('.win[data-app="檔案櫃"]').length === 2);
    const viaLnk = page.locator('.win[data-app="檔案櫃"]').nth(1);
    await viaLnk.locator('.files .item').first().waitFor();
    check((await viaLnk.locator('.statusbar .path').textContent()) === home + '/project/src', 'opening the shortcut opens the folder it points at');
    await viaLnk.locator('.traffic .close').click();
    // free placement: an icon stays in the grid cell it is dropped on
    const cfg = desk + '/config.inv-remosh_gui-config';
    await beginDrag(deskItem('drag-b.txt'), 500, 300);
    await endDrag();
    await sleep(200);
    let placedAt = await deskItem('drag-b.txt').boundingBox();
    check(placedAt.x === 12 + 5 * 96 && placedAt.y === 12 + 3 * 96, 'a desktop icon dropped elsewhere snaps to that grid cell', JSON.stringify(placedAt));
    let saved2 = null;
    for (let i = 0; i < 50 && !saved2; i++) {
      try {
        const list = JSON.parse(fs.readFileSync(cfg, 'utf8'));
        if (Array.isArray(list) && list.some((x) => x.name === 'drag-b.txt' && x.col === 5 && x.row === 3)) saved2 = list;
      } catch { /* not written yet */ }
      if (!saved2) await sleep(100);
    }
    check(!!saved2 && saved2.every((x) => typeof x.name === 'string' && Number.isInteger(x.col) && Number.isInteger(x.row)), 'places are saved as an array of { name, col, row } in desktop/config.inv-remosh_gui-config', fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : 'missing');
    check((await page.locator('.desk-item .name').allTextContents()).every((n) => !n.includes('config')), 'the config file is not shown on the desktop');
    await page.locator('#desktop-icons').click({ button: 'right', position: { x: 300, y: 600 } });
    await pick('重新整理');
    await sleep(600);
    placedAt = await deskItem('drag-b.txt').boundingBox();
    check(placedAt.x === 12 + 5 * 96 && placedAt.y === 12 + 3 * 96, 'the place survives a reload');
    const aBefore = await deskItem('drag-a.txt').boundingBox();
    await beginDrag(deskItem('drag-a.txt'), 500, 300);
    await endDrag();
    await sleep(200);
    const swapA = await deskItem('drag-a.txt').boundingBox();
    const swapB = await deskItem('drag-b.txt').boundingBox();
    check(swapA.x === 12 + 5 * 96 && swapA.y === 12 + 3 * 96 && swapB.x === aBefore.x && swapB.y === aBefore.y, 'dropping onto an occupied cell swaps the two icons', JSON.stringify([swapA, swapB, aBefore]));
    // an app dragged out of the start menu becomes an app shortcut
    await page.click('#start-btn');
    await page.click('#sm-all-btn');
    await beginDrag(page.locator('#sma-tasks'), 300, 520);
    check((await ghost()) === '工作管理員|建立捷徑', 'apps can be dragged out of the start menu');
    await endDrag();
    check(await holds(desk + '/工作管理員.remosh_gui-app', 'app:tasks\n'), 'dropping an app on the desktop writes a .remosh_gui-app with "app:<id>"');
    if (await page.isVisible('#start-menu')) await page.keyboard.press('Escape');
    await deskItem('工作管理員').waitFor();
    await deskItem('工作管理員').dblclick();
    const viaApp = page.locator('.win', { has: page.locator('.tm-top') });
    await viaApp.waitFor();
    check(true, 'double-clicking the app shortcut starts the app');
    await viaApp.locator('.traffic .close').click();
    await deskItem('工作管理員').click({ button: 'right' });
    check((await menuLabels()).join('|') === '開啟|釘選到開始|刪除' && await page.locator('.ctx-menu button', { hasText: '釘選到開始' }).isDisabled(), 'desktop right-click: open, pin to start (already pinned), delete', (await menuLabels()).join('|'));
    await page.keyboard.press('Escape');
    // back into the file cabinet by dragging
    const fbox = await fwin.locator('.files').boundingBox();
    await beginDrag(deskItem('drag-a.txt'), fbox.x + fbox.width - 60, fbox.y + fbox.height - 60);
    check((await ghost()) === 'drag-a.txt|移動', 'desktop icons can be dragged too');
    await endDrag();
    check(await exists(home + '/project/drag-a.txt') && await exists(desk + '/drag-a.txt', false), 'dropping it in the file cabinet moves it back');
    await item('drag-a.txt').waitFor();
    // in the file cabinet, an app shortcut can be pinned from the right-click menu
    await page.locator('#desktop-icons').click({ button: 'right', position: { x: 300, y: 600 } });
    check((await menuLabels()).join('|') === '重新整理|開啟桌面資料夾', 'desktop right-click on empty space', (await menuLabels()).join('|'));
    await pick('開啟桌面資料夾');
    await page.waitForFunction(() => document.querySelectorAll('.win[data-app="檔案櫃"]').length === 2);
    const deskWin = page.locator('.win[data-app="檔案櫃"]').nth(1);
    const appRow = deskWin.locator('.files .item', { has: page.locator('.name', { hasText: /^工作管理員\.remosh_gui-app$/ }) });
    await appRow.waitFor();
    check((await deskWin.locator('.statusbar .path').textContent()) === desk, 'the desktop folder opens in a file cabinet');
    await deskWin.locator('button[title="顯示隱藏檔"]').click();
    await sleep(200);
    const listedNames = await deskWin.locator('.files .item .name').allTextContents();
    check(fs.existsSync(cfg) && !listedNames.some((n) => n.includes('.inv-')), '.inv-* files stay invisible in the file cabinet even with hidden files shown', listedNames.join(','));
    check(require('node:child_process').execSync('ls -a ' + JSON.stringify(desk)).toString().includes('config.inv-remosh_gui-config'), 'a terminal still lists it');
    await deskWin.locator('button[title="顯示隱藏檔"]').click();
    await appRow.click({ button: 'right' });
    check((await menuLabels()).includes('釘選到開始') && !(await menuLabels()).includes('開啟程式…'), 'file cabinet right-click on an app shortcut offers "pin to start"', (await menuLabels()).join('|'));
    await page.keyboard.press('Escape');
    await deskWin.locator('.traffic .close').click();
    await deskItem('src').click({ button: 'right' });
    await pick('刪除');
    check((await page.textContent('.modal p')).includes('只會刪除捷徑'), 'deleting a shortcut says the target is safe');
    await page.locator('.modal button', { hasText: '刪除' }).click();
    check(await exists(desk + '/src.remosh_gui-lnk', false) && fs.existsSync(home + '/project/src/math.ts'), 'the shortcut is gone, the folder untouched');
    // ---- list view: column widths can be dragged
    await toFinder();
    await fwin.locator('button[title="列表檢視"]').click();
    const colBox = (k) => fwin.locator(`.list-head .col:has(.col-resize[data-col="${k}"])`).boundingBox();
    const filesWidth = (await fwin.locator('.files').boundingBox()).width;
    let nameW = (await colBox('name')).width;
    check(nameW === 260 && nameW < filesWidth * 0.6 && (await colBox('size')).width === 90, 'list columns have set widths; the name column no longer takes all the room', JSON.stringify({ nameW, filesWidth }));
    check(await page.evaluate(() => {
      const rules = [...document.styleSheets].flatMap((sh) => { try { return [...sh.cssRules]; } catch { return []; } });
      const rule = (sel) => rules.find((r) => r.selectorText === sel);
      return rule('::-webkit-scrollbar')?.style.width === '6px' && rule('::-webkit-scrollbar-button')?.style.display === 'none'
        && getComputedStyle(document.querySelector('.files')).scrollbarWidth === 'auto'; // set, Chrome would ignore the rules above
    }), 'scroll bars: 6 px, no arrow buttons (and Chrome is not sent to its own thin bars)');
    const grip = await fwin.locator('.col-resize[data-col="name"]').boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 100, grip.y + grip.height / 2, { steps: 4 });
    await page.mouse.up();
    nameW = (await colBox('name')).width;
    const cellW = (await fwin.locator('.files .item .namecell').first().boundingBox()).width;
    check(nameW === 360 && cellW === 360 && (await fwin.locator('.marquee').count()) === 0, 'dragging a column edge resizes that column, header and rows together', JSON.stringify({ nameW, cellW }));
    check(await waitApp('files', (d) => d.cols?.name === 360), 'the widths are remembered');
    const grip2 = await fwin.locator('.col-resize[data-col="name"]').boundingBox();
    await page.mouse.move(grip2.x + grip2.width / 2, grip2.y + grip2.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip2.x + grip2.width / 2 - 100, grip2.y + grip2.height / 2, { steps: 4 });
    await page.mouse.up();
    await fwin.locator('button[title="圖示檢視"]').click();
    // ---- sidebar: drag to reorder, drop a folder to add
    const sideOrder = () => fwin.locator('.sidebar button[data-path]').evaluateAll((els) => els.map((e) => e.dataset.path));
    const homeBtn = await fwin.locator(`.sidebar button[title="${home}"]`).boundingBox();
    await beginDrag(fwin.locator('.sidebar button[title="/tmp"]'), homeBtn.x + 30, homeBtn.y + 2);
    check((await ghost()) === 'tmp|移動', 'sidebar places can be dragged');
    check(await fwin.locator('.sidebar .side-insert').isVisible() && Math.abs((await fwin.locator('.sidebar .side-insert').boundingBox()).y - homeBtn.y) < 4, 'a line shows where the place will go');
    await endDrag();
    await page.waitForFunction(() => document.querySelector('.sidebar button[data-path]').dataset.path === '/tmp');
    check((await sideOrder()).join() === ['/tmp', home, '/', '/etc', '/var'].join() && await waitApp('files', (d) => d.sidebar?.[0] === '/tmp'), 'dropping one above another reorders the list, and the order is saved', (await sideOrder()).join());
    const sideBox = await fwin.locator('.sidebar').boundingBox();
    await beginDrag(item('src'), sideBox.x + 40, sideBox.y + sideBox.height - 12);
    check((await ghost()) === 'src|加到側邊欄', 'a folder can be dragged onto the sidebar');
    await endDrag();
    await fwin.locator(`.sidebar button[title="${home}/project/src"]`).waitFor();
    check((await sideOrder()).pop() === home + '/project/src', 'and is added where it was dropped');
    check(await fwin.locator('.sidebar .side-insert').count() === 0, 'the line goes away after the drop');
    await fwin.locator('.sidebar button[title="/"]').click({ button: 'right' });
    check((await menuLabels()).slice(0, 4).join('|') === '開啟|上移|下移|從側邊欄移除', 'right-click a place: move up / down', (await menuLabels()).join('|'));
    await pick('下移');
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar button[data-path]')].map((e) => e.dataset.path).indexOf('/') === 3);
    check(true, '下移 moves it one place down');
    await fwin.locator('.sidebar h3').click({ button: 'right' });
    await pick('還原成預設');
    await page.waitForFunction((h0) => document.querySelector('.sidebar button[data-path]').dataset.path === h0, home);
    // ---- sidebar width
    const sideW = () => fwin.locator('.sidebar').evaluate((el) => el.offsetWidth);
    const sGrip = await fwin.locator('.side-resize').boundingBox();
    await page.mouse.move(sGrip.x + sGrip.width / 2, sGrip.y + 60);
    await page.mouse.down();
    await page.mouse.move(sGrip.x + sGrip.width / 2 + 90, sGrip.y + 60, { steps: 5 });
    await page.mouse.up();
    check(Math.abs((await sideW()) - 240) <= 2 && await waitApp('files', (d) => Math.abs(d.sidebarWidth - 240) <= 2), 'dragging the edge widens the sidebar, and the width is saved', String(await sideW()));
    await page.mouse.move(sGrip.x + 90 + sGrip.width / 2, sGrip.y + 60);
    await page.mouse.down();
    await page.mouse.move(sGrip.x - 400, sGrip.y + 60, { steps: 5 });
    await page.mouse.up();
    check((await sideW()) === 110, 'it does not get narrower than 110 px', String(await sideW()));
    await fwin.locator('.side-resize').dblclick();
    await page.waitForFunction(() => document.querySelector('.sidebar').offsetWidth === 150);
    check(await waitApp('files', (d) => d.sidebarWidth === 150), 'double-click brings back the default width');

    // ---- multi-selection and rubber-band selection (file cabinet and desktop)
    await toFinder();
    for (const n of ['m1.txt', 'm2.txt']) {
      fs.writeFileSync(home + '/project/' + n, n + '\n');
      give(home + '/project/' + n);
    }
    await item('m2.txt').waitFor({ timeout: 9000 });
    const selCount = () => fwin.locator('.files .item.selected').count();
    const total = await fwin.locator('.files .item').count();
    await item('README.md').click();
    await item('package.json').click({ modifiers: ['Control'] });
    check((await selCount()) === 2 && (await fwin.locator('.statusbar span').first().textContent()).includes('已選取 2 個'), 'Ctrl+click adds to the selection');
    await item('package.json').click({ modifiers: ['Control'] });
    check((await selCount()) === 1, 'Ctrl+click again removes it');
    await fwin.locator('.files .item').nth(0).click();
    await fwin.locator('.files .item').nth(2).click({ modifiers: ['Shift'] });
    check((await selCount()) === 3, 'Shift+click selects the range');
    await page.keyboard.press('Control+a');
    check((await selCount()) === total && total > 4, 'Ctrl+A selects everything');
    await page.locator('.dock-item[data-app="檔案櫃"]').first().click(); // minimise ...
    await page.locator('.dock-item[data-app="檔案櫃"]').first().click(); // ... and restore: selection is kept
    check((await selCount()) === total, 'the selection survives hiding and showing the window');
    const fb = await fwin.locator('.files').boundingBox();
    await page.mouse.click(fb.x + fb.width - 25, fb.y + fb.height - 25);
    check((await selCount()) === 0, 'a click on empty space clears it');
    await page.mouse.move(fb.x + fb.width - 25, fb.y + fb.height - 25);
    await page.mouse.down();
    await page.mouse.move(fb.x + fb.width - 60, fb.y + fb.height - 60, { steps: 2 });
    await page.mouse.move(fb.x + 8, fb.y + 34, { steps: 6 });
    const mq = await fwin.locator('.marquee').boundingBox();
    check(!!mq && mq.width > 300 && mq.height > 200 && (await selCount()) === total, 'dragging on empty space draws a box and selects what it touches', JSON.stringify(mq));
    await page.mouse.up();
    await sleep(100);
    check((await fwin.locator('.marquee').count()) === 0 && (await selCount()) === total, 'the box goes away and the selection stays');
    await item('README.md').click({ button: 'right' });
    check((await menuLabels()).join('|') === `開啟 ${total} 個項目|複製 ${total} 個項目|剪下 ${total} 個項目|貼上|刪除 ${total} 個項目`, 'right-click on a multi-selection acts on all of it', (await menuLabels()).join('|'));
    await page.keyboard.press('Escape');
    // Enter opens everything that is selected
    await item('m1.txt').click();
    await item('m1.txt').click({ button: 'right' }); // make the notepad the habit for .txt again
    await pick('用 記事本 開啟');
    await page.locator('.win[data-app="記事本"] .np-text').waitFor();
    await page.locator('.win[data-app="記事本"] .traffic .close').click();
    await page.waitForFunction(() => document.querySelectorAll('.win[data-app="記事本"]').length === 0);
    check(await waitSetting((d) => d.system?.openWith?.txt === 'notepad'), 'the habit follows the last app used');
    await sleep(200);
    await toFinder();
    await item('m1.txt').click();
    await item('m2.txt').click({ modifiers: ['Control'] });
    await page.keyboard.press('Enter');
    for (let n = 1; n <= 2; n++) { // .txt goes to the app that opened it last time
      await page.waitForFunction((want) => document.querySelectorAll('.win[data-app="記事本"]').length === want, n, { timeout: 15000 });
    }
    const openedTitles = (await page.locator('.win[data-app="記事本"] .titlebar .ttext').allTextContents()).sort().join();
    check(openedTitles === 'm1.txt — 記事本,m2.txt — 記事本', 'Enter opens every selected file', openedTitles);
    check((await page.locator('.win[data-app="記事本"] .titlebar .ticon svg').count()) === 2 && (await fwin.locator('.titlebar .ticon svg').count()) === 1, 'title bars show the window\'s icon next to the title');
    const tiBox = await fwin.locator('.titlebar .ticon').boundingBox();
    const ttBox = await fwin.locator('.titlebar .ttext').boundingBox();
    check(tiBox.width === 16 && tiBox.x + tiBox.width <= ttBox.x && ttBox.x - (tiBox.x + tiBox.width) < 12, 'the icon sits just left of the title text', JSON.stringify([tiBox, ttBox]));
    for (let i = 0; i < 2; i++) await page.locator('.win.focused[data-app="記事本"] .traffic .close').click();
    await toFinder();
    // the box scrolls the list when the pointer reaches the bottom edge
    await fwin.locator('.sidebar button[title="/etc"]').click();
    await fwin.locator('.files .item').nth(40).waitFor();
    const eb = await fwin.locator('.files').boundingBox();
    await page.mouse.move(eb.x + 5, eb.y + 5);
    await page.mouse.down();
    await page.mouse.move(eb.x + 30, eb.y + 40, { steps: 2 });
    await page.mouse.move(eb.x + eb.width - 30, eb.y + eb.height - 6, { steps: 5 });
    const selBefore = await selCount();
    await sleep(900);
    const scrolled = await fwin.locator('.files').evaluate((el) => el.scrollTop);
    const selAfter = await selCount();
    check(scrolled > 100 && selAfter > selBefore, 'holding the box at the bottom edge scrolls and keeps selecting', JSON.stringify({ scrolled, selBefore, selAfter }));
    await page.mouse.up();
    await sleep(100);
    await fwin.locator('button[title="上一頁"]').click();
    await item('m2.txt').waitFor();
    await item('m1.txt').click();
    await item('m2.txt').click({ modifiers: ['Control'] });
    await page.keyboard.press('Control+c');
    await sleep(200);
    const clipMulti = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
    check(clipMulti.length === 2 && clipMulti.every((l) => /^remosh\/file:.*\/m[12]\.txt<<[0-9a-f]{12}>>$/.test(l)), 'copying several files puts one line per file on the clipboard', clipMulti.join(' ; '));
    await beginDrag(item('m1.txt'), 300, 520);
    check((await ghost()) === '2 個項目|移動', 'dragging one of several selected items drags them all');
    await endDrag();
    check(await exists(desk + '/m1.txt') && await exists(desk + '/m2.txt') && await exists(home + '/project/m1.txt', false) && await exists(home + '/project/m2.txt', false), 'and they all move');
    await deskItem('m2.txt').waitFor();
    await sleep(500);
    const d1 = await deskItem('m1.txt').boundingBox();
    const d2 = await deskItem('m2.txt').boundingBox();
    const dropCol = Math.floor((300 - 12) / 96);
    const dropRow = Math.floor((520 - 12) / 96);
    const landed = [[d1.x, d1.y], [d2.x, d2.y]].map(String).sort();
    check(landed.includes(String([12 + dropCol * 96, 12 + dropRow * 96])) && d1.x === d2.x && Math.abs(d1.y - d2.y) === 96, 'several files dropped on the desktop land together, from the cell they were dropped on', JSON.stringify([d1, d2]));
    // desktop: box selection, group move, group delete
    await page.mouse.move(250, 690);
    await page.mouse.down();
    await page.mouse.move(230, 670, { steps: 2 });
    await page.mouse.move(4, 4, { steps: 6 });
    const deskSel = await page.locator('.desk-item.selected').count();
    check((await page.locator('#desktop-icons > .marquee').count()) === 1 && deskSel >= 2, 'box selection works on the desktop too', String(deskSel));
    await page.mouse.up();
    await sleep(100);
    await page.locator('#desktop-icons').click({ position: { x: 300, y: 690 } });
    check((await page.locator('.desk-item.selected').count()) === 0, 'click on the empty desktop clears the selection');
    await deskItem('m1.txt').click();
    await deskItem('m2.txt').click({ modifiers: ['Control'] });
    const g1 = await deskItem('m1.txt').boundingBox();
    const g2 = await deskItem('m2.txt').boundingBox();
    await beginDrag(deskItem('m1.txt'), g1.x + 46 + 96 * 2, g1.y + 46);
    check((await ghost()).startsWith('2 個項目'), 'several desktop icons drag together');
    await endDrag();
    await sleep(250);
    const h1 = await deskItem('m1.txt').boundingBox();
    const h2 = await deskItem('m2.txt').boundingBox();
    check(h1.x === g1.x + 192 && h1.y === g1.y && h2.x - h1.x === g2.x - g1.x && h2.y - h1.y === g2.y - g1.y, 'and keep their arrangement when moved', JSON.stringify([g1, g2, h1, h2].map((b) => [b.x, b.y])));
    await page.keyboard.press('Delete');
    check((await page.textContent('.modal h2')).includes('這 2 個項目'), 'Delete on a multi-selection asks once for all');
    await page.locator('.modal button', { hasText: '刪除' }).click();
    check(await exists(desk + '/m1.txt', false) && await exists(desk + '/m2.txt', false), 'and removes them all');

    await toFinder();
    tb2 = await fwin.locator('.titlebar .title').boundingBox();
    await page.mouse.move(tb2.x + 60, tb2.y + 10);
    await page.mouse.down();
    await page.mouse.move(tb2.x + 30, tb2.y + 60, { steps: 3 });
    await page.mouse.move(640, 200, { steps: 5 });
    await page.mouse.up();
    await sleep(150);
  },
};
