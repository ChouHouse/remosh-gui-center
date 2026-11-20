// e2e area "shell": back / forward from the mouse side buttons and the keyboard go to the window in front. Run alone with --only=shell (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  async run(shared) {
    const { check, page, waitSetting } = shared;
    // ---- back / forward from the mouse side buttons and the keyboard go to the window in front
    const hasFile = (name) => page.waitForFunction((n) => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === n), name);
    const sideClick = (button) => page.evaluate((b) => {
      const el = document.querySelector('.files');
      return ['mousedown', 'mouseup', 'auxclick'].map((t) => !el.dispatchEvent(new MouseEvent(t, { button: b, bubbles: true, cancelable: true })));
    }, button);
    const urlBefore = page.url();
    const prevented = await sideClick(3);
    await hasFile('README.md');
    check(prevented.every(Boolean), 'the mouse back button is kept away from the browser');
    await sideClick(4);
    await hasFile('math.ts');
    check(true, 'mouse side buttons go back / forward in the file cabinet');
    await page.locator('.files').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await hasFile('README.md');
    await page.keyboard.press('Alt+ArrowRight');
    await hasFile('math.ts');
    check(page.url() === urlBefore, 'Alt+←/→ go back / forward and the page stays where it is');

    // ---- taskbar preview
    const fileDock = page.locator('.dock-item').first();
    await fileDock.hover();
    await page.waitForSelector('.win-preview .win-preview-stage > .win');
    const pv = await page.evaluate(() => {
      const p = document.querySelector('.win-preview');
      const r = p.getBoundingClientRect();
      const s = p.querySelector('.win-preview-stage').getBoundingClientRect();
      return { title: p.querySelector('.lbl').textContent, bottom: r.bottom, dockTop: document.querySelector('#dock').getBoundingClientRect().top,
        w: s.width, h: s.height, names: p.querySelectorAll('.files .item .name').length, ids: p.querySelectorAll('[id]').length };
    });
    check(pv.bottom <= pv.dockTop && pv.w <= 242 && pv.h <= 162 && pv.w > 100, 'hovering a taskbar entry shows a small preview above it', JSON.stringify(pv));
    check(pv.names > 0 && pv.ids === 0 && pv.title.length > 0, 'the preview shows the window content and its title', JSON.stringify(pv));
    await fileDock.click();
    check((await page.locator('.win-preview').count()) === 0 && await page.locator('.win.minimized').count() === 1, 'clicking the entry removes the preview');
    await page.mouse.move(600, 300);
    await fileDock.hover();
    await page.waitForSelector('.win-preview .win-preview-stage > .win');
    check(await page.evaluate(() => document.querySelector('.win-preview-stage > .win').getBoundingClientRect().width > 100), 'a minimised window can be previewed too');
    await page.locator('.win-preview').hover();
    await page.waitForTimeout(400);
    check(await page.evaluate(() => !!document.querySelector('.win-preview') && document.documentElement.classList.contains('peeking')
      && getComputedStyle(document.querySelector('#windows > .win.minimized')).display === 'flex'), 'the pointer can move onto the preview, which then shows that window alone');
    await page.mouse.move(600, 300);
    await page.waitForSelector('.win-preview', { state: 'detached' });
    check(await page.evaluate(() => !document.documentElement.classList.contains('peeking') && getComputedStyle(document.querySelector('#windows > .win.minimized')).display === 'none'), 'leaving puts everything back');

    // ---- taskbar right-click menus, pinning, focus mode
    const ctxLabels = () => page.locator('.ctx-menu button').allTextContents();
    await fileDock.click(); // bring the window back for this part
    await page.mouse.move(600, 300);
    await page.click('#start-btn', { button: 'right' });
    check((await ctxLabels()).join() === '工作管理員,終端機,設定,切換使用者,登出' && await page.isHidden('#start-menu'), 'right-click on start: tools and account actions');
    await page.keyboard.press('Escape');
    await page.click('#clock', { button: 'right' });
    check((await ctxLabels()).join() === '移除這個時鐘', 'right-click on the clock offers to remove it');
    await page.keyboard.press('Escape');
    await fileDock.click({ button: 'right' });
    check((await ctxLabels()).join() === '專注模式,釘選到工作列,關閉應用程式', 'right-click on an entry: focus mode, pin, close');
    await page.locator('.ctx-menu button', { hasText: '釘選到工作列' }).click();
    await page.waitForSelector('#dock-pins .dock-pin[data-pin="files"]', { state: 'attached' });
    check(await page.isHidden('#dock-pins .dock-pin[data-pin="files"]'), 'a pinned app that is open shows only its own entry');
    const setTb = (change) => page.evaluate((c) => import('/js/shell/taskbar.js').then((m) => m.setTaskbar(c)), change);
    await setTb({ pinned: ['files', 'settings'] });
    await page.click('#dock-pins .dock-pin[data-pin="settings"]');
    await page.waitForSelector('.win[data-app="設定"]');
    check(await page.isHidden('#dock-pins .dock-pin[data-pin="settings"]'), 'a launcher opens its app and steps aside');
    await page.locator('.win[data-app="設定"] .traffic .close').click();
    await page.waitForSelector('#dock-pins .dock-pin[data-pin="settings"]:not([hidden])');
    check(true, 'and comes back when the app is closed');
    await setTb({ pinned: ['files'] });
    await page.evaluate(() => import('/js/shell/apps.js').then((m) => m.launchApp('files')));
    await page.waitForFunction(() => document.querySelectorAll('#dock-items .dock-item').length === 2);
    // merged entries
    await setTb({ group: true });
    await page.waitForFunction(() => document.querySelectorAll('#dock-items .dock-item:not(.grouped)').length === 1);
    check((await page.textContent('#dock-items .dock-item:not(.grouped) .grp')) === '檔案櫃' && (await page.textContent('#dock-items .dock-item:not(.grouped) .cnt')) === '2', 'merged: one entry for the app, with the number of windows on its icon');
    // the × on a picture closes that one window only
    await page.evaluate(() => import('/js/shell/apps.js').then((m) => { m.launchApp('files'); }));
    await page.waitForFunction(() => document.querySelector('#dock-items .dock-item:not(.grouped) .cnt')?.textContent === '3');
    await page.mouse.move(600, 300);
    await page.click('#dock-items .dock-item:not(.grouped)');
    await page.waitForSelector('.win-preview');
    check((await page.locator('.win-preview .win-preview-card .win-preview-close').count()) === 3, 'every picture in a preview has its own close button');
    await page.locator('.win-preview .win-preview-card').last().locator('.win-preview-close').click();
    await page.waitForFunction(() => document.querySelectorAll('.win-preview .win-preview-card').length === 2);
    check((await page.locator('#windows > .win').count()) === 2 && (await page.textContent('#dock-items .dock-item:not(.grouped) .cnt')) === '2' && (await page.locator('.win-preview').count()) === 1,
      'it closes just that window; the others and their pictures stay');
    await page.mouse.move(600, 300);
    await page.waitForSelector('.win-preview', { state: 'detached' });
    await page.mouse.move(600, 300);
    await page.click('#dock-items .dock-item:not(.grouped)');
    await page.waitForSelector('.win-preview');
    check((await page.locator('.win-preview .win-preview-card').count()) === 2, 'its preview shows every window');
    await page.evaluate(() => { window.__second = [...document.querySelectorAll('#windows > .win')][0]; });
    await page.locator('.win-preview .win-preview-card').first().click();
    check(await page.evaluate(() => window.__second.classList.contains('focused') && !document.querySelector('.win-preview')), 'clicking one of them goes to that window');
    await setTb({ group: false });
    await page.waitForFunction(() => document.querySelectorAll('#dock-items .dock-item:not(.grouped)').length === 2 && !document.querySelector('.grp'));
    await page.mouse.move(600, 300);
    const order = () => page.evaluate(() => [...document.querySelectorAll('#dock-items .dock-item')].map((e) => e === window.__first));
    await page.evaluate(() => { window.__first = document.querySelector('#dock-items .dock-item'); });
    const b0 = await page.locator('#dock-items .dock-item').nth(0).boundingBox();
    const b1 = await page.locator('#dock-items .dock-item').nth(1).boundingBox();
    await page.mouse.move(b0.x + b0.width / 2, b0.y + 10);
    await page.mouse.down();
    await page.mouse.move(b1.x + b1.width / 2 + 6, b1.y + 10, { steps: 6 });
    await page.mouse.up();
    check((await order()).join() === 'false,true' && (await page.locator('.win.minimized').count()) === 0, 'dragging an entry sideways moves it, without counting as a click', JSON.stringify(await order()));
    await page.mouse.move(600, 300);
    await page.locator('#dock-items .dock-item').nth(0).click({ button: 'right' });
    await page.locator('.ctx-menu button', { hasText: '專注模式' }).click();
    check(await page.evaluate(() => document.querySelectorAll('#windows > .win:not(.minimized)').length === 1 && !!document.querySelector('#windows > .win.maximized.focused')), 'focus mode leaves that window alone, maximised');
    await page.locator('#dock-items .dock-item').nth(0).click({ button: 'right' });
    await page.locator('.ctx-menu button', { hasText: '關閉應用程式' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#dock-items .dock-item').length === 1);
    await page.locator('#dock-items .dock-item').nth(0).click({ button: 'right' });
    await page.locator('.ctx-menu button', { hasText: '從工作列取消釘選' }).click();
    await page.waitForFunction(() => !document.querySelector('#dock-pins .dock-pin'));
    check(true, 'close and unpin from the menus');
    await page.mouse.click(600, 790, { button: 'right' });
    check((await ctxLabels()).join() === '工作列設定', 'right-click on the bar itself leads to its settings');
    await page.keyboard.press('Escape');
    await page.mouse.move(600, 300);
    await page.click('#start-btn');
    await page.click('#sm-user');
    await page.click('#sm-all-btn');
    check(await page.isHidden('#sm-logout-row') && await page.isVisible('#sm-all'), 'the account card closes when something else in the menu is used');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#start-menu', { state: 'hidden' });

    // ---- workspaces
    const wsState = () => page.evaluate(() => import('/js/shell/wm.js').then((m) => ({ list: m.wm.workspaces.length, cur: m.wm.workspaces.indexOf(m.wm.ws) + 1 })));
    const shownWins = () => page.locator('#windows > .win:not(.ws-hidden):not(.minimized)').count();
    const wsBtnBox = await page.locator('#ws-btn').boundingBox();
    const wsClockBox = await page.locator('#clock').boundingBox();
    check(wsBtnBox.x + wsBtnBox.width <= wsClockBox.x + 1 && Math.abs((wsBtnBox.y + wsBtnBox.height / 2) - (wsClockBox.y + wsClockBox.height / 2)) < 4, 'a screen button sits left of the clock', JSON.stringify([wsBtnBox, wsClockBox]));
    const wsFilesBefore = await shownWins();
    await page.click('#ws-btn');
    await page.waitForSelector('#ws-panel');
    check((await page.locator('#ws-panel .ws-card').count()) === 2 && (await page.locator('#ws-panel .ws-card.current .ws-stage .win').count()) === wsFilesBefore, 'the panel shows the workspace with a preview of its windows, and 新增工作區');
    await page.click('#ws-panel .ws-card.new');
    await page.waitForFunction(() => document.querySelectorAll('#ws-panel .ws-card').length === 3);
    await page.click('#ws-panel .ws-card[data-ws]:not(.current):not(.new)');
    await page.waitForSelector('#ws-panel', { state: 'detached' });
    check((await wsState()).cur === 2 && (await shownWins()) === 0 && (await page.locator('#dock-items .dock-item:not(.ws-other)').count()) === 0, 'workspace 2 starts empty: the other windows and their taskbar entries are hidden');
    check((await page.textContent('#ws-btn .ws-num')) === '2', 'the button shows which workspace this is');
    check(await page.locator('#dock-items').evaluate((el) => el.classList.contains('none-shown')), 'with nothing open here the window strip counts as empty (no stray separators)');
    await page.evaluate(() => import('/js/shell/apps.js').then((m) => m.launchApp('settings')));
    await page.waitForSelector('.win[data-app="設定"]:not(.ws-hidden)');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.waitForSelector('#ws-panel');
    check((await page.locator('#ws-panel .ws-card.current .ws-stage .win[data-app="設定"]').count()) === 1, 'pressing Tab twice opens the panel; each workspace has its own preview');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#ws-panel', { state: 'detached' });
    check((await wsState()).cur === 1 && (await shownWins()) === wsFilesBefore && await page.locator('.win[data-app="設定"]').evaluate((el) => el.classList.contains('ws-hidden')), 'arrow keys and Enter switch back to workspace 1');
    await page.click('#ws-btn', { button: 'right' });
    check((await ctxLabels()).join() === '工作區 1（目前）,工作區 2,新增工作區,隱藏這個小工具', 'right-click the button: go to a workspace, add one, hide the button', (await ctxLabels()).join());
    await page.locator('.ctx-menu button', { hasText: '工作區 2' }).click();
    await page.waitForSelector('.win[data-app="設定"]:not(.ws-hidden)');
    check((await wsState()).cur === 2, 'and goes straight there');
    await page.locator('.dock-item[data-app="設定"]').click({ button: 'right' });
    check((await ctxLabels()).includes('移到工作區 1'), 'a window can be moved to another workspace');
    await page.locator('.ctx-menu button', { hasText: '移到工作區 1' }).click();
    check((await shownWins()) === 0, 'after moving it is gone from here');
    await page.evaluate(() => import('/js/shell/apps.js').then((m) => m.launchApp('settings')));
    await page.waitForFunction(() => import('/js/shell/wm.js').then((m) => m.wm.ws === m.wm.workspaces[0]));
    check(true, 'opening an app that is open on another workspace goes there');
    await page.click('#ws-btn');
    await page.waitForSelector('#ws-panel');
    await page.locator('#ws-panel .ws-card').nth(1).hover();
    await page.locator('#ws-panel .ws-card').nth(1).locator('.ws-close').click();
    await page.waitForFunction(() => document.querySelectorAll('#ws-panel .ws-card[data-ws]:not(.new)').length === 1);
    await page.keyboard.press('Escape');
    check((await wsState()).list === 1 && (await page.locator('#ws-btn .ws-num').isHidden()), 'a workspace can be closed');
    for (let i = 0; i < 6; i++) await page.evaluate(() => import('/js/shell/wm.js').then((m) => m.addWorkspace()));
    check((await wsState()).list === 5, 'at most five workspaces');
    await page.evaluate(() => import('/js/shell/wm.js').then((m) => { for (const id of m.wm.workspaces.slice(1)) m.removeWorkspace(id); }));
    await page.locator('.win[data-app="設定"] .traffic .close').click();
    await page.click('#ws-btn', { button: 'right' });
    await page.locator('.ctx-menu button', { hasText: '隱藏這個小工具' }).click();
    await page.waitForSelector('#ws-btn', { state: 'hidden' });
    check(await waitSetting((st) => st.taskbar.workspaces === false), 'the button can be hidden, and that is saved');
    await setTb({ workspaces: true });
    await page.waitForSelector('#ws-btn', { state: 'visible' });
    await page.mouse.move(600, 300);
    Object.assign(shared, { ctxLabels, fileDock });
  },
};
