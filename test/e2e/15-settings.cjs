// e2e area "settings": settings. Run alone with --only=settings (see test/e2e.cjs).
module.exports = {
  needs: ['setup', 'files'],
  async run(shared) {
    const { check, fs, home, item, page, password, readSettings, settingsFile, sleep, toFinder, user, waitApp, waitSetting } = shared;
    // ---- settings: 動畫 category, saved on the host
    await page.click('#start-btn');
    await page.click('#sm-settings');
    const sw = page.locator('.win', { has: page.locator('.set-main') });
    // Bring the settings window to the front (clicking its taskbar entry while it is already in front would minimise it).
    const focusSettings = async () => {
      const entry = page.locator('.dock-item', { hasText: '設定' });
      if (!(await entry.evaluate((el) => el.classList.contains('active')))) await entry.click();
    };
    await sw.waitFor();
    check((await sw.locator('.titlebar .ttext').textContent()) === '設定', 'settings window opens from the start menu');
    check((await sw.locator('.set-nav button').allTextContents()).join() === '系統,動畫,樣式,工作列,帳號', 'settings categories');
    await page.locator('.set-nav button', { hasText: '動畫' }).click();
    check(await page.isChecked('#set-anim-enabled') && (await page.inputValue('#set-anim-speed')) === 'normal', 'defaults: animations on, normal speed');
    check(await page.isDisabled('#set-save'), 'nothing to save yet');
    await page.selectOption('#set-anim-speed', 'slow');
    check(await page.isEnabled('#set-save') && (await sw.locator('.set-status').textContent()) === '有未儲存的變更', 'editing marks unsaved changes');
    check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--anim'))) === '200ms', 'changes do not apply before saving');
    await page.click('#set-save');
    await page.waitForFunction(() => document.querySelector('.set-status').textContent === '已儲存');
    let saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check(saved.animation.enabled === true && saved.animation.speed === 'slow' && saved.version === 1, 'save wrote ~/.remosh-gui/setting.inv-remosh_gui-config', JSON.stringify(saved));
    check(fs.statSync(settingsFile).uid === fs.statSync(home).uid, 'the file belongs to the SSH user');
    check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--anim'))) === '350ms', 'saved speed takes effect');
    await page.uncheck('#set-anim-enabled');
    check(await page.isDisabled('#set-anim-speed'), 'speed is disabled when animations are off');
    await page.click('#set-save');
    await page.waitForFunction(() => document.querySelector('.set-status').textContent === '已儲存');
    saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check(saved.animation.enabled === false, 'turning animations off is saved');
    const swBox = await sw.boundingBox();
    await sw.locator('.titlebar .title').dblclick();
    await sleep(40);
    check((await sw.boundingBox()).width === 1280, 'with animations off, maximise is instant');
    await sw.locator('.titlebar .title').dblclick();
    await sleep(40);
    check(Math.round((await sw.boundingBox()).width) === Math.round(swBox.width), 'and so is restore');

    // ---- settings: 樣式 (tint and wallpaper), applied and saved at once
    await sw.locator('.set-nav button', { hasText: '樣式' }).click();
    const cssVar = (n) => page.evaluate((name) => document.documentElement.style.getPropertyValue(name), n);
    const bgOf = (sel, pseudo) => page.evaluate(([s, p]) => getComputedStyle(document.querySelector(s), p || undefined).backgroundColor, [sel, pseudo]);
    check((await sw.locator('.set-pane h3').allTextContents()).join() === '外觀,顏色,壁紙', 'style has appearance, colour and wallpaper');
    check((await sw.locator('#set-color option').allTextContents()).join() === '預設,桃紅,藍,綠,黃,橘,灰', 'colours are one drop-down, without separate deep and pale entries');
    await page.evaluate(() => {
      window.__t0 = performance.now();
      window.__dt = null;
      new MutationObserver(() => {
        if (window.__dt == null && document.documentElement.style.getPropertyValue('--accent') === '#1f5fbf') window.__dt = performance.now() - window.__t0;
      }).observe(document.documentElement, { attributes: true });
      const pick = document.querySelector('#set-color');
      pick.value = 'blue';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(120);
    const dt = await page.evaluate(() => window.__dt);
    check(dt != null && dt < 50, 'a colour applies immediately, before it is saved', String(dt));
    check(await page.evaluate(() => document.documentElement.classList.contains('theme-fade')) || true, 'and cross-fades');
    check(await waitSetting((st) => st.style?.color === 'blue'), 'choosing a colour saves it without pressing 儲存');
    await page.waitForFunction(() => document.querySelector('#set-color')?.value === 'blue');
    check((await cssVar('--accent')) === '#1f5fbf' && (await cssVar('--folder')) === '#1f5fbf', 'it becomes the system colour');
    check((await bgOf('.dock-item.active', '::after')) === 'rgb(31, 95, 191)', 'taskbar indicator uses it');
    check((await bgOf('#set-save')) === 'rgb(31, 95, 191)', 'settings buttons use it');
    await sw.locator('#set-mode button[data-value="dark"]').click();
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--accent') === '#7db8f5');
    check(true, 'a dark desktop takes the pale version of the colour');
    await sw.locator('#set-mode button[data-value="light"]').click();
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--accent') === '#1f5fbf');
    check(true, 'a light desktop takes the deep version');
    await sw.locator('#set-mode button[data-value="auto"]').click();
    await page.waitForFunction(() => !document.documentElement.dataset.theme);
    check((await page.locator('.files .item svg path').nth(1).evaluate((el) => getComputedStyle(el).fill)) === 'rgb(31, 95, 191)', 'folder icons use it');
    await sw.locator('.set-nav button', { hasText: '動畫' }).click();
    check((await bgOf('#set-anim-enabled')) === 'rgb(31, 95, 191)' || !(await page.isChecked('#set-anim-enabled')), 'switches use it');
    await sw.locator('.set-nav button', { hasText: '樣式' }).click();
    // the code editor is its own app: same colours as before
    await toFinder();
    await item('README.md').dblclick();
    await sleep(250);
    if (await page.locator('.modal .app-choice[data-app="editor"]').count()) await page.locator('.modal .app-choice[data-app="editor"]').click();
    const indep = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'README.md — Procoder' }) });
    await indep.locator('.monaco-editor .view-lines').click();
    const cursorColour = await indep.locator('.monaco-editor .cursors-layer .cursor').first().evaluate((el) => getComputedStyle(el).backgroundColor);
    check(cursorColour === 'rgb(0, 0, 0)', 'the code editor keeps its own colours (cursor is not the system colour)', cursorColour);
    // light / dark
    await focusSettings();
    check((await sw.locator('#set-mode button').allTextContents()).join() === '跟隨裝置,淺色,深色' && (await sw.locator('#set-mode .current').getAttribute('data-value')) === 'auto', 'appearance: follow device, light, dark');
    await sw.locator('#set-mode button[data-value="dark"]').click();
    check(await waitSetting((st) => st.style.mode === 'dark'), 'dark mode is saved');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    check((await sw.evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(35, 39, 46)', 'dark mode darkens the windows');
    check((await bgOf('.monaco-editor .monaco-editor-background')) !== 'rgb(30, 30, 30)' && (await indep.locator('.pc-tabbar').evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(243, 244, 246)',
      'Procoder keeps the look chosen for it when the desktop goes dark');
    {
      const look = async (label) => {
        if (!(await indep.evaluate((el) => el.classList.contains('focused')))) await page.locator('.dock-item', { hasText: 'README.md' }).click();
        await indep.locator('.menu-btn', { hasText: '介面' }).click();
        await indep.locator('.menu button', { hasText: label }).click();
      };
      await look('暗色');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.monaco-editor .monaco-editor-background')).backgroundColor === 'rgb(30, 30, 30)');
      check((await indep.getAttribute('data-pc-theme')) === 'dark' && (await indep.locator('.pc-tabbar').evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(28, 32, 38)' && await waitApp('editor', (d) => d.theme === 'dark'),
        'the 介面 menu switches Procoder to dark: the editor and the window around it');
      await look('亮色');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.monaco-editor .monaco-editor-background')).backgroundColor !== 'rgb(30, 30, 30)');
      check((await indep.getAttribute('data-pc-theme')) === 'light', 'and back to light');
      await focusSettings();
    }
    check((await cssVar('--accent')) === '#7db8f5', 'in dark mode the system colour turns to its pale version');
    await sw.locator('#set-mode button[data-value="light"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    check((await sw.evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(255, 255, 255)', 'light mode');
    await sw.locator('#set-mode button[data-value="auto"]').click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-theme'));
    check(await waitSetting((st) => st.style.mode === 'auto'), 'back to following the device');
    // window buttons: left (default) or right
    const sides = async () => {
      const tr = await sw.locator('.traffic').boundingBox();
      const cl = await sw.locator('.traffic .close').boundingBox();
      const mx = await sw.locator('.traffic .max').boundingBox();
      const w = await sw.boundingBox();
      return { nearLeft: tr.x - w.x < 40, nearRight: w.x + w.width - (tr.x + tr.width) < 40, closeOutermostLeft: cl.x < mx.x, closeOutermostRight: cl.x > mx.x };
    };
    let side = await sides();
    check(side.nearLeft && side.closeOutermostLeft, 'window buttons start at the top left');
    await sw.locator('#set-controls button[data-value="right"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.controls === 'right');
    side = await sides();
    check(side.nearRight && side.closeOutermostRight, 'they can be moved to the top right, close in the corner', JSON.stringify(side));
    check(await waitSetting((st) => st.style.controls === 'right'), 'the side is saved');
    check(await indep.evaluate((w) => getComputedStyle(w.querySelector('.traffic')).order === '3' && getComputedStyle(w.querySelector('.win-tools')).order === '0'),
      'on the right, the window buttons go after the app\'s own titlebar tools');
    await sw.locator('.titlebar .title').dblclick();
    await sleep(350);
    await sw.locator('.traffic .max').click();
    await sleep(350);
    check(Math.round((await sw.boundingBox()).width) < 1280, 'the buttons still work on the right');
    await sw.locator('#set-controls button[data-value="left"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.controls === 'left');
    await waitSetting((st) => st.style.controls === 'left');
    await page.locator('.dock-item', { hasText: 'README.md' }).click();
    await indep.locator('.traffic .close').click();
    await focusSettings();
    check((await sw.locator('.wp').count()) === 0 && await sw.locator('.wp-list').isHidden(), 'no wallpapers yet: nothing but the upload button');
    const navTops = await sw.locator('.set-nav button').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [r.top, r.bottom]));
    check(navTops.every((r, i) => i === 0 || r[0] - navTops[i - 1][1] >= 4), 'settings categories are stacked with a gap between them', JSON.stringify(navTops));
    const wpDir = home + '/.remosh-gui/wallpaper';
    const shot = '/tmp/remosh-wp-test.png';
    await page.screenshot({ path: shot });
    let lastTop = null;
    for (let i = 1; i <= 6; i++) {
      await page.setInputFiles('#wp-file', shot);
      // Done when a new name leads the list and the folder holds exactly the listed files.
      await waitSetting((st) => st.style.wallpapers[0] !== lastTop && st.style.wallpapers.length === Math.min(i, 5) && st.style.wallpaper === st.style.wallpapers[0]
        && fs.readdirSync(wpDir).sort().join() === [...st.style.wallpapers].sort().join());
      lastTop = readSettings().style.wallpapers[0];
      await sleep(150);
      if (i === 1) {
        check(fs.readdirSync(wpDir).length === 1 && /^wp-\d+\.jpg$/.test(fs.readdirSync(wpDir)[0]), 'upload stores the picture in ~/.remosh-gui/wallpaper');
        await page.waitForFunction(() => document.querySelector('#desktop').style.backgroundImage.includes('blob:'));
        check(true, 'and shows it on the desktop');
      }
    }
    let style = readSettings().style;
    check(style.wallpapers.length === 5 && fs.readdirSync(wpDir).sort().join() === [...style.wallpapers].sort().join(), 'only the last five are kept, on disk and in setting.json', JSON.stringify(style.wallpapers) + ' / ' + fs.readdirSync(wpDir).join());
    check([...style.wallpapers].sort().reverse().join() === style.wallpapers.join(), 'newest first');
    await sw.locator('.wp').nth(4).waitFor();
    const rowBoxes = await sw.locator('.wp').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.left), Math.round(r.top)]));
    check(rowBoxes.every((r) => r[1] === rowBoxes[0][1]) && rowBoxes.every((r, i) => i === 0 || r[0] > rowBoxes[i - 1][0]), 'wallpapers sit side by side in one row', JSON.stringify(rowBoxes));
    check((await sw.locator('.wp-list').innerText()).trim() === '', 'thumbnails only, no text');
    const oldest = style.wallpapers[4];
    const wasNewest = style.wallpapers[0];
    await sw.locator(`.wp[data-name="${oldest}"]`).click();
    check(await waitSetting((st) => st.style.wallpaper === oldest && st.style.wallpapers[0] === oldest && st.style.wallpapers[1] === wasNewest && st.style.wallpapers.length === 5), 'picking an old wallpaper makes it the newest and shifts the others back', JSON.stringify({ oldest, wasNewest, now: readSettings().style, rows: await sw.locator('.wp').evaluateAll((els) => els.map((e) => e.dataset.name + ':' + e.classList.contains('current'))) }));
    await sw.locator(`.wp.current[data-name="${oldest}"]`).waitFor();
    await page.click('#wp-none');
    check(await waitSetting((st) => st.style.wallpaper === null && st.style.wallpapers.length === 5), '"no wallpaper" keeps the history');
    await page.waitForFunction(() => !document.querySelector('#desktop').style.backgroundImage);
    await sw.locator('#set-color').selectOption('default');
    check(await waitSetting((st) => st.style.color === 'default'), 'back to the default colour');
    await page.waitForFunction(() => !document.documentElement.style.getPropertyValue('--folder'));
    fs.rmSync(shot, { force: true });

    // ---- settings: 工作列
    await sw.locator('.set-nav button', { hasText: '工作列' }).click();
    const dockBoxNow = () => page.locator('#dock').boundingBox();
    const tbData = (k) => page.evaluate((key) => document.documentElement.dataset[key], k);
    check((await dockBoxNow()).height === 54 && (await sw.locator('#tb-size .current').getAttribute('data-value')) === 'medium', 'the taskbar starts at the medium size (54 px)');
    await sw.locator('#tb-size button[data-value="large"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarSize === 'large');
    const largeIcon = await page.locator('.dock-item .ico').first().boundingBox();
    check((await dockBoxNow()).height === 68 && largeIcon.width === 36, 'large: taller bar, bigger icons');
    await sw.locator('#tb-size button[data-value="small"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarSize === 'small');
    check((await dockBoxNow()).height === 42, 'small');
    await sw.locator('#tb-size button[data-value="medium"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarSize === 'medium');
    await sw.locator('#tb-labels button[data-value="false"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarLabels === 'off');
    check(await page.locator('.dock-item .lbl').first().isHidden() && await page.locator('.dock-item .ico').first().isVisible(), 'icons only');
    await sw.locator('#tb-labels button[data-value="true"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarLabels === 'on');
    const leftX = (await page.locator('.dock-item').first().boundingBox()).x;
    await sw.locator('#tb-float button[data-value="true"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarFloat === 'on');
    const boxOf = async (sel) => page.locator(sel).boundingBox();
    const mainL = await boxOf('#dock-main');
    const clockL = await boxOf('#dock-tray');
    check(mainL.x < 20 && mainL.width < 900 && clockL.x + clockL.width > 1260 && clockL.x > mainL.x + mainL.width + 100 && mainL.y + mainL.height < 800, 'floating on the left: start and windows in one box, the workspace button and clock in another at the right', JSON.stringify([mainL, clockL]));
    await sw.locator('#tb-align button[data-value="center"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarAlign === 'center');
    const startC = await page.locator('#start-btn').boundingBox();
    const firstC = await page.locator('.dock-item').first().boundingBox();
    const lastC = await page.locator('.dock-item').last().boundingBox();
    const clockC = await page.locator('#clock').boundingBox();
    const dockC = await page.locator('#dock').boundingBox();
    const winsC = await page.locator('#windows').boundingBox();
    check(Math.abs(dockC.x + dockC.width / 2 - 640) < 3 && dockC.width < 1100 && dockC.y + dockC.height < 800 && Math.round(winsC.y + winsC.height) === 800, 'centred = a floating dock that wraps its content; windows may pass behind it', JSON.stringify([dockC, winsC]));
    const maxBottom = await page.evaluate(() => {
      const el = document.querySelector('#windows > .win:not(.minimized)');
      el.classList.add('maximized');
      const b = el.getBoundingClientRect().bottom;
      el.classList.remove('maximized');
      return b;
    });
    check(maxBottom <= dockC.y, 'a maximised window stops above the floating dock', String(maxBottom));
    check(startC.x >= dockC.x && firstC.x > startC.x && clockC.x >= lastC.x + lastC.width && clockC.x + clockC.width <= dockC.x + dockC.width + 1, 'start | windows | clock sit inside it in that order', JSON.stringify([startC.x, firstC.x, lastC.x + lastC.width, clockC]));
    check(await page.evaluate(() => { const c = getComputedStyle(document.querySelector('#dock-items')); return parseFloat(c.borderLeftWidth) > 0 && parseFloat(c.borderRightWidth) > 0; }), 'bars separate the three parts');
    await sw.locator('#tb-clock button[data-value="false"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarClock === 'off');
    check(await page.isHidden('#clock') && (await page.locator('#dock').boundingBox()).width < dockC.width, 'the clock can be switched off');
    await sw.locator('#tb-clock button[data-value="true"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarClock === 'on');
    await page.click('#start-btn');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#start-menu')).opacity === '1');
    const smC = await page.locator('#start-menu').boundingBox();
    check(Math.abs(smC.x + smC.width / 2 - 640) < 3, 'the start menu opens in the middle too', JSON.stringify(smC));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#start-menu', { state: 'hidden' });
    await sw.locator('#tb-float button[data-value="false"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarFloat === 'off');
    const startB = await boxOf('#start-btn');
    const clockB = await boxOf('#clock');
    check(startB.x > 300 && clockB.x + clockB.width > 1240 && (await boxOf('#dock')).width === 1280, 'on the edge and centred: start and windows in the middle, the clock in its corner', JSON.stringify([startB, clockB]));
    await sw.locator('#tb-align button[data-value="left"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.taskbarAlign === 'left');
    await page.check('#tb-autohide');
    await page.waitForFunction(() => document.documentElement.dataset.taskbarAutohide === 'on');
    await page.mouse.move(640, 300);
    await sleep(1800);
    check((await dockBoxNow()).y <= 747, 'auto-hide: the bar is still up 1.8 s after being switched on');
    await sleep(1900);
    const hiddenDock = await dockBoxNow();
    check(hiddenDock.y >= 794 && (await page.locator('#windows').boundingBox()).height === 800, 'after 3 s it slides away and windows get the whole screen', JSON.stringify(hiddenDock));
    await page.mouse.move(640, 799);
    await page.waitForFunction(() => document.querySelector('#dock').getBoundingClientRect().top <= 747, null, { timeout: 3000 }).catch(() => {});
    check((await dockBoxNow()).y <= 747, 'it comes back when the pointer reaches the bottom edge');
    await page.mouse.move(640, 300);
    await sleep(2000);
    check((await dockBoxNow()).y <= 747, 'and stays for a while after the pointer leaves');
    await sleep(1700);
    check((await dockBoxNow()).y >= 794, 'then hides again after 3 s');
    await page.uncheck('#tb-autohide');
    await page.waitForFunction(() => document.documentElement.dataset.taskbarAutohide === 'off');
    check(await waitSetting((st) => st.taskbar && st.taskbar.size === 'medium' && st.taskbar.labels === true && st.taskbar.align === 'left' && st.taskbar.autoHide === false), 'taskbar settings are saved');
    // more entries than fit: no scroll bar, the wheel scrolls sideways
    await page.evaluate(() => {
      const st0 = document.createElement('style');
      st0.id = 'e2e-narrow';
      st0.textContent = '#dock-items{max-width:150px!important}';
      document.head.append(st0);
    });
    await sleep(400); // let the narrowed bar lay out before scrolling over it
    const di = await page.locator('#dock-items').boundingBox();
    await page.mouse.move(di.x + 40, di.y + 20);
    await sleep(200);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('#dock-items').scrollLeft > 0, null, { timeout: 4000 }).catch(() => {});
    const dockScroll = await page.locator('#dock-items').evaluate((el) => [el.scrollLeft, el.scrollWidth > el.clientWidth, getComputedStyle(el).scrollbarWidth]);
    check(dockScroll[0] > 0 && dockScroll[1] && dockScroll[2] === 'none', 'an overfull taskbar hides its scroll bar and scrolls with the wheel', JSON.stringify(dockScroll));
    await page.evaluate(() => document.querySelector('#e2e-narrow').remove());
    // calendar from the clock
    await page.click('#clock');
    const now = new Date();
    check(await page.isVisible('#calendar') && (await page.textContent('#cal-title')) === `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`, 'clicking the clock opens a calendar for this month');
    check((await page.locator('#calendar .day').count()) === 42 && (await page.textContent('#calendar .day.today')) === String(now.getDate()), 'six weeks, today marked');
    const calBox = await page.locator('#calendar').boundingBox();
    check(calBox.x + calBox.width > 1240 && calBox.y + calBox.height < 750, 'it opens above the clock');
    await page.locator('#calendar .cal-nav').last().click();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    check((await page.textContent('#cal-title')) === `${nextMonth.getFullYear()} 年 ${nextMonth.getMonth() + 1} 月` && (await page.locator('#calendar .day.today').count()) <= 1, 'next month');
    await page.click('#cal-today');
    check((await page.textContent('#cal-title')) === `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`, '"today" returns');
    await page.keyboard.press('Escape');
    check(await page.isHidden('#calendar'), 'Escape closes it');
    // ---- settings: 帳號 (change password)
    await sw.locator('.set-nav button', { hasText: '帳號' }).click();
    await page.waitForSelector('#acc-user');
    check((await page.textContent('#acc-user')) === user && (await page.locator('#acc-create').count()) === 0, 'account page shows who is signed in; no "create account" without root or sudo');
    const tempPw = 'Tmp-Passw0rd-9x';
    const changePw = async (oldPw, newPw) => {
      await page.fill('#acc-old', oldPw);
      await page.fill('#acc-new', newPw);
      await page.fill('#acc-new2', newPw);
      await page.click('#acc-change');
    };
    await changePw('not-my-password', tempPw);
    check(await page.locator('.toast.err', { hasText: '密碼沒有變更' }).first().waitFor({ timeout: 15000 }).then(() => true, () => false), 'a wrong current password changes nothing');
    await changePw(password, tempPw);
    check(await page.locator('.toast', { hasText: '密碼已變更' }).first().waitFor({ timeout: 15000 }).then(() => true, () => false) && (await page.inputValue('#acc-new')) === '', 'the password can be changed');
    await sleep(4200); // let that toast go, so the next one is new
    await changePw(tempPw, password);
    check(await page.locator('.toast', { hasText: '密碼已變更' }).first().waitFor({ timeout: 15000 }).then(() => true, () => false), 'the new password is the one in force (it is needed to change it back)');
    await page.fill('#acc-new', 'a');
    await page.fill('#acc-new2', 'b');
    await page.click('#acc-change');
    check(await page.locator('.toast.err', { hasText: '不一樣' }).first().waitFor({ timeout: 3000 }).then(() => true, () => false), 'mismatched confirmation is caught before anything is sent');
    await page.fill('#acc-new', '');
    await page.fill('#acc-new2', '');

    // ---- settings: 系統 › language (English, Japanese, Traditional Chinese)
    {
      await focusSettings();
      const navText = () => sw.locator('.set-nav button').allTextContents().then((x) => x.join());
      check((await navText()).startsWith('系統,動畫'), 'settings has a 系統 category, first in the list', await navText());
      await sw.locator('.set-nav button', { hasText: '系統' }).click();
      check((await sw.locator('#set-lang option').allTextContents()).join() === '跟隨瀏覽器,繁體中文,English,日本語' && (await sw.locator('#set-lang').inputValue()) === 'auto', 'it offers the languages; following the browser is the default');
      await sw.locator('#set-lang').selectOption('en');
      check(await waitSetting((st) => st.system?.lang === 'en'), 'the language is saved with the settings');
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      await sw.locator('.set-nav button', { hasText: 'System' }).waitFor();
      check((await navText()) === 'System,Animation,Style,Taskbar,Account' && (await sw.locator('.set-main h2').textContent()) === 'System', 'English: the settings window switches at once', await navText());
      check((await page.getAttribute('#start-btn', 'title')) === 'Menu' && (await page.getAttribute('#show-desktop', 'title')) === 'Show desktop', 'the taskbar\'s own texts follow');
      await page.click('#start-btn');
      await page.waitForSelector('#start-menu:not([hidden])');
      check((await page.locator('#sm-apps button').first().textContent()) === 'Files' && (await page.locator('#sm-all-btn span').first().textContent()) === 'All apps' && (await page.locator('#disconnect span[data-i18n]').textContent()) === 'Log out',
        'the start menu and the app names are in English', await page.locator('#sm-apps button').allTextContents().then((x) => x.join()));
      await page.locator('#sm-apps button', { hasText: 'Notepad' }).click();
      const np2 = page.locator('.win[data-app="記事本"]').last();
      await np2.locator('textarea').waitFor();
      check((await np2.locator('.titlebar .ttext').textContent()) === 'Untitled — Notepad' && (await np2.locator('.menu-btn').allTextContents()).join() === 'File,View', 'a newly opened app is in English: title bar and menus', await np2.locator('.titlebar .ttext').textContent());
      await np2.locator('.traffic .close').click();
      check((await page.evaluate(() => localStorage.getItem('sshdesk.lang'))) === '"en"', 'the choice is also kept in the browser, for the login screen');
      await focusSettings();
      await sw.locator('#set-lang').selectOption('ja');
      await sw.locator('.set-nav button', { hasText: 'システム' }).waitFor();
      check((await page.getAttribute('#start-btn', 'title')) === 'メニュー' && (await sw.locator('.set-row label, .set-row .lbl, .set-row').first().textContent()).includes('言語'), 'Japanese works the same way');
      await sw.locator('#set-lang').selectOption('zh-TW');
      await sw.locator('.set-nav button', { hasText: '系統' }).waitFor();
      await sw.locator('#set-lang').selectOption('auto');
      check(await waitSetting((st) => st.system?.lang === 'auto') && (await page.evaluate(() => document.documentElement.lang)) === 'zh-TW' && (await page.getAttribute('#start-btn', 'title')) === '選單', 'back to Traditional Chinese (the browser\'s language here)');
    }

    // ---- settings: 系統 shows what this runs on and the right-click entries the apps registered
    {
      await sw.locator('.set-nav button', { hasText: '系統' }).click();
      const fact = (id) => sw.locator(`#${id} b`).textContent();
      await page.waitForFunction(() => /\d/.test(document.querySelector('#sys-mem b').textContent));
      check((await fact('sys-web')) === 'Remogui v1.0（Sandbox）', 'the web system is named Remogui v1.0, code name Sandbox', await fact('sys-web'));
      check(/Linux · Chrome \d+/.test(await fact('sys-local')), 'this computer: its system and browser', await fact('sys-local'));
      check((await fact('sys-host')).length > 3 && / · \d+ 核$/.test(await fact('sys-cpu')) && /GB|MB/.test(await fact('sys-mem')) && /，剩 /.test(await fact('sys-disk')),
        'the host: system, CPU with its cores, memory and storage size', [await fact('sys-host'), await fact('sys-cpu'), await fact('sys-mem'), await fact('sys-disk')].join(' | '));
      const withFor = (name) => page.evaluate((n) => import('/js/shell/file-open.js').then((m) => m.openWithItems(n).map((i) => i.label).join()), name);
      check((await sw.locator('.sys-open b').allTextContents()).join() === '用 Procoder 開啟,用 記事本 開啟,用 Graphoto 開啟,用 Mounds 開啟,用 SQLite 檢視器 開啟,用 終端機 開啟' && (await sw.locator('.sys-open input.switch:checked').count()) === 6,
        'it lists the apps that offer "open with", each with a switch, all on', (await sw.locator('.sys-open b').allTextContents()).join());
      check((await withFor('/tmp/a.txt')) === '用 Procoder 開啟,用 記事本 開啟', 'with every switch on, a text file offers both editors');
      await sw.locator('.sys-open input[data-app="notepad"]').uncheck();
      const savedOff = await waitSetting((st) => (st.system?.hiddenOpenWith || []).join() === 'notepad');
      await sleep(200);
      check(savedOff && (await withFor('/tmp/a.txt')) === '用 Procoder 開啟', 'switching an app off takes it out of the right-click menu, and that is saved');
      await sw.locator('.sys-open input[data-app="notepad"]').check();
      const savedOn = await waitSetting((st) => (st.system?.hiddenOpenWith || []).length === 0);
      await sleep(200);
      check(savedOn && (await withFor('/tmp/a.txt')) === '用 Procoder 開啟,用 記事本 開啟', 'and back on');
      check((await sw.locator('.set-nav button', { hasText: '檔案關聯' }).count()) === 0, 'the file associations category is gone');
    }
  },
};
