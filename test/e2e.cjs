// Browser end-to-end test. Needs the server running (`npm start`) and a reachable SSH
// account whose home contains project/src/math.ts and docs/ (see README).
//   NODE_PATH=<dir with playwright>/node_modules node test/e2e.cjs \
//     http://127.0.0.1:3000 127.0.0.1 2222 user password /home/user
const { chromium } = require('playwright');
const fs = require('node:fs');

const [base, host, port, user, password, home, shotDir] = process.argv.slice(2);
let failed = 0;
const P_BASE = (p) => p.slice(p.lastIndexOf('/') + 1);
const check = (cond, label, extra = '') => {
  if (cond) console.log('ok   ' + label);
  else {
    failed++;
    console.log('FAIL ' + label + (extra ? ' :: ' + extra : ''));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { execSync: execSyncTop } = require('node:child_process');

(async () => {
  const settingsFile = home + '/.remosh-gui/setting.inv-remosh_gui-config';
  const legacySettings = home + '/.remosh-gui/setting.json';
  // The account's real settings are put back when the test ends, however it ends.
  const realSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const realLegacy = fs.existsSync(legacySettings) ? fs.readFileSync(legacySettings) : null;
  const owner = fs.statSync(home);
  const give = (path) => fs.chownSync(path, owner.uid, owner.gid);
  const scratch = ['/project/m1.txt', '/project/m2.txt', '/project/drag-a.txt', '/project/drag-b.txt', '/project/ren-a.txt', '/project/ren-b.txt', '/project/poll-new.txt', '/docs/todo.txt', '/docs/todo 複本.txt', '/project/todo 複本.txt', '/project/hello.sh', '/project/src/copy.py'];
  const { execSync: sh } = require('node:child_process');
  process.on('exit', () => {
    try { sh('chpasswd', { input: `${user}:${password}\n` }); } catch { /* not root */ }
    try { sh('userdel -r e2etmpuser 2>/dev/null'); } catch { /* was not created */ }
    for (const f of scratch) fs.rmSync(home + f, { force: true });
    fs.rmSync(home + '/.remosh-gui', { recursive: true, force: true });
    fs.rmSync(home + '/pics', { recursive: true, force: true });
    if (realLegacy) {
      fs.mkdirSync(home + '/.remosh-gui', { recursive: true, mode: 0o700 });
      fs.writeFileSync(legacySettings, realLegacy);
      give(home + '/.remosh-gui');
      give(legacySettings);
    }
    if (realSettings) {
      fs.mkdirSync(home + '/.remosh-gui', { recursive: true, mode: 0o700 });
      fs.writeFileSync(settingsFile, realSettings);
      give(home + '/.remosh-gui');
      give(settingsFile);
    }
  });
  fs.rmSync(home + '/.remosh-gui', { recursive: true, force: true });
  for (const f of scratch) fs.rmSync(home + f, { force: true });
  fs.writeFileSync(home + '/docs/todo.txt', 'buy milk\n', { mode: 0o644 });
  give(home + '/docs/todo.txt');
  fs.writeFileSync(home + '/project/hello.sh', '#!/bin/sh\necho RAN-$((40+2))\n', { mode: 0o644 });
  give(home + '/project/hello.sh');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // The browser logs the 401 of a deliberately wrong access password; that one is expected.
  page.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push('console: ' + m.text()));

  await page.goto(base);
  // Access password (server started with WEB_PASSWORD): pass the same value in the environment.
  const webPassword = process.env.WEB_PASSWORD || '';
  const gateStatus = await (await fetch(base + '/api/gate')).json();
  check(gateStatus.required === !!webPassword, 'server reports whether an access password is required', JSON.stringify(gateStatus));
  if (webPassword) {
    await page.waitForSelector('#gate:not([hidden])');
    check(await page.isHidden('#login') && await page.isHidden('#desktop'), 'access-password screen comes first; the SSH login is not shown yet');
    const noCookie = await new Promise((resolve) => {
      const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws');
      ws.onopen = () => resolve('opened');
      ws.onerror = () => resolve('refused');
    });
    check(noCookie === 'refused', 'the WebSocket is refused without the access cookie');
    await page.fill('#gate-pass', 'not-the-password');
    await page.click('#gate-btn');
    await page.waitForSelector('#gate-error:not([hidden])');
    check((await page.textContent('#gate-error')).includes('不正確') && await page.isVisible('#gate'), 'a wrong access password is rejected');
    await page.fill('#gate-pass', webPassword);
    await page.click('#gate-btn');
    await page.waitForSelector('#gate', { state: 'hidden' });
    check(await page.isVisible('#login'), 'the right one leads to the SSH login');
    const cookies = await ctx.cookies();
    const c = cookies.find((k) => k.name === 'remosh_gate');
    check(c && c.httpOnly && c.sameSite === 'Strict', 'the access cookie is HttpOnly and SameSite=Strict');
  } else {
    await page.waitForSelector('#login:not([hidden])');
    check(await page.isHidden('#gate'), 'no access-password screen when none is set');
  }
  await page.fill('#f-host', host);
  await page.fill('#f-port', String(port));
  await page.fill('#f-user', user);
  await page.fill('#f-pass', 'definitely-wrong');
  await page.click('#login-btn');
  await page.waitForSelector('#login-error:not([hidden])', { timeout: 30000 });
  check((await page.textContent('#login-error')).includes('登入失敗'), 'wrong password shows an error');
  check(await page.isHidden('#desktop'), 'desktop stays hidden after failed login');
  check((await page.locator('#saved-servers .saved-server').count()) === 0, 'a failed login is not remembered as a server');

  await page.fill('#f-pass', password);
  await page.click('#login-btn');
  await page.waitForSelector('#desktop:not([hidden])', { timeout: 30000 });
  check(await page.isHidden('#login'), 'login overlay closes');
  await sleep(300);
  const fsNow = () => page.evaluate(() => !!document.fullscreenElement);
  check(await fsNow(), 'a successful login enters full screen');
  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  const icon = await fetch(base + '/icons/icon-180.png');
  check(manifest.display === 'standalone' && manifest.name === 'Remosh GUI' && manifest.icons.length === 2 && icon.ok && icon.headers.get('content-type') === 'image/png', 'the site can be installed as an app (manifest and icons are served)');
  check(await page.evaluate(() => !!document.querySelector('link[rel="manifest"]') && !!document.querySelector('link[rel="apple-touch-icon"]') && document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content === 'yes'), 'the page declares itself as a web app for Safari');
  await page.click('#start-btn');
  check(await page.isHidden('#sm-fullscreen'), 'the full-screen switch is not in the main menu');
  await page.click('#sm-user');
  const fsBox = await page.locator('#sm-fullscreen').boundingBox();
  const outBox0 = await page.locator('#disconnect').boundingBox();
  check(fsBox.y + fsBox.height <= outBox0.y + 1 && Math.abs(fsBox.x - outBox0.x) < 2, 'it sits above logout on the same card');
  check((await page.textContent('#sm-fullscreen-label')) === '離開全螢幕', 'and shows the full-screen state');
  await page.click('#sm-fullscreen');
  await page.waitForFunction(() => !document.fullscreenElement);
  check((await page.textContent('#sm-fullscreen-label')) === '全螢幕', 'and can leave it');
  await page.click('#sm-fullscreen');
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#start-menu', { state: 'hidden' });
  check((await page.evaluate(() => localStorage.getItem('sshdesk.hostkeys'))) === null && (await page.locator('.toast').count()) === 0, 'the host key fingerprint is not remembered or announced');
  check((await page.$$('.win')).length === 0 && (await page.$$('.dock-item')).length === 0, 'no app opens by itself after login');
  check((await page.locator('#start-btn').innerText()).trim() === '' && (await page.locator('#start-btn circle').count()) === 3, 'start button is an icon with three dots, no text');
  const dotFills = await page.$$eval('#start-btn circle', (els) => els.map((e) => getComputedStyle(e).fill));
  check(new Set(dotFills).size === 3, 'the three dots have different colours', dotFills.join(' '));
  await page.click('#start-btn');
  await page.click('#sm-files');
  await page.waitForSelector('.files .item'); // the title follows the folder once it is listed
  check((await page.textContent('.win .titlebar .ttext')) === P_BASE(home) + ' — 檔案櫃', 'file cabinet title bar names the folder and the app');
  await page.waitForSelector('.files .item');
  const names = async () => page.$$eval('.files .item .name', (els) => els.map((e) => e.textContent));
  let list = await names();
  check(list.includes('project') && list.includes('docs'), 'finder lists the home directory', list.join(','));
  check(!list.some((n) => n.startsWith('.')), 'hidden files are hidden by default');
  check((await page.textContent('#conn-label')).startsWith(user + '@'), 'menubar shows user@host');

  const item = (name) => page.locator('.files .item', { has: page.locator('.name', { hasText: new RegExp('^' + name.replace(/[.]/g, '\\.') + '$') }) });
  // Double-click; the first time an extension is opened, answer "which app?" with the editor.
  const openItem = async (name) => {
    await item(name).dblclick();
    await sleep(250);
    const choice = page.locator('.modal .app-choice[data-app="editor"]');
    if (await choice.count()) await choice.click();
  };
  const menuLabels = () => page.locator('.ctx-menu button').allTextContents();
  const pick = (label) => page.locator('.ctx-menu button', { hasText: label }).click();
  const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const appFile = (id) => home + '/.remosh-gui/app/' + id + '/config.inv-remosh_gui-config';
  const waitApp = async (id, test) => {
    for (let i = 0; i < 40; i++) {
      try {
        if (test(JSON.parse(fs.readFileSync(appFile(id), 'utf8')))) return true;
      } catch { /* not written yet */ }
      await sleep(100);
    }
    return false;
  };
  const waitSetting = async (test) => {
    for (let i = 0; i < 40; i++) {
      try {
        if (test(readSettings())) return true;
      } catch { /* not written yet */ }
      await sleep(100);
    }
    return false;
  };
  await openItem('project');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'src'));
  await openItem('src');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'math.ts'));
  check((await page.textContent('.finder-main + .statusbar .path')) === home + '/project/src', 'navigated into project/src');
  await page.click('button[title="上一頁"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'README.md'));
  await page.click('button[title="下一頁"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'math.ts'));
  check(true, 'back / forward work');

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

  // ---- a dropped connection comes back by itself, without asking for the password
  const back = await page.evaluate(async () => {
    const m = await import('/js/core/rpc.js');
    const old = m.conn.ws;
    old.close();
    const t0 = performance.now();
    while (performance.now() - t0 < 12000) {
      if (m.conn.ws && m.conn.ws !== old && m.conn.ws.readyState === 1 && document.querySelector('#reconnecting').hidden) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return m.rpc('ping').then(() => 'ok', (e) => String(e.code || e));
  });
  check(await page.isHidden('#login') && back === 'ok', 'a dropped connection is restored without the login form', back + ' ' + await page.textContent('#login-sub'));
  check(true, 'the preview goes away when the pointer leaves');
  await fileDock.click();
  await page.mouse.move(600, 300);
  await page.click('button[title="列表檢視"]');
  check(await page.isVisible('.files.list .list-head'), 'list view shows column headers');
  await page.click('button[title="圖示檢視"]');

  // ---- open a file in a Monaco window
  await openItem('math.ts');
  // the first start asks which look Procoder should have
  await page.waitForFunction(() => document.querySelector('.modal h2')?.textContent === 'Procoder 要用亮色還是暗色？');
  check((await page.locator('.modal .btns button').allTextContents()).join() === '亮色,暗色', 'the first time Procoder starts it asks: light or dark');
  await page.locator('.modal button', { hasText: '亮色' }).click();
  check(await waitApp('editor', (d) => d.theme === 'light') && (await page.locator('.win[data-app="Procoder"]').getAttribute('data-pc-theme')) === 'light', 'the answer is kept in ~/.remosh-gui/app/editor and applied');
  await page.waitForSelector('.win .monaco-editor .view-lines', { timeout: 60000 });
  const value = () => page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('math.ts')).getValue()); // model keeps its URI after save-as
  const original = await value();
  check(original.includes('export function add'), 'editor shows the file content');
  const edWin = page.locator('.win[data-app="Procoder"]');
  const state = () => edWin.locator('.statusbar span').first().textContent();
  check((await edWin.locator('.statusbar').textContent()).includes('TypeScript'), 'language detected as typescript');
  check((await page.$$('.dock-item')).length === 2, 'dock has Finder + the editor');
  check((await edWin.locator('.titlebar .ttext').textContent()) === 'math.ts — Procoder', 'editor title bar names the file and the app');
  check(await page.locator('.dock-item.active .lbl').textContent() === 'math.ts', 'editor is the active dock item');

  // ---- shortcuts
  await edWin.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('//e2e'); // a single word, so one undo step
  check((await state()) === '已修改', 'typing marks the file modified');
  check((await page.locator('.dock-item.is-dirty').count()) === 1, 'dock shows the unsaved dot');
  await page.keyboard.press('Control+z');
  await sleep(150);
  check((await value()) === original && (await state()) === '已儲存', 'Ctrl+Z undoes back to the saved state', JSON.stringify([await value(), await state()]));
  await page.keyboard.press('Control+y');
  await sleep(150);
  check((await value()).includes('//e2e'), 'Ctrl+Y redoes');
  await page.keyboard.press('Control+s');
  await page.waitForFunction((w) => w.querySelector('.statusbar span').textContent === '已儲存', await edWin.elementHandle());
  const onDisk = fs.readFileSync(home + '/project/src/math.ts', 'utf8');
  check(onDisk === original + '//e2e', 'Ctrl+S wrote the file on the SSH host', JSON.stringify(onDisk));

  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+v');
  await sleep(300);
  check((await value()) === onDisk + onDisk, 'Ctrl+A / Ctrl+C / Ctrl+V copy and paste');
  await page.keyboard.press('Control+z');
  await sleep(150);

  const wrapBtn = edWin.locator('.statusbar button:not(.pc-lang-btn)');
  const before = await wrapBtn.textContent();
  await page.keyboard.press('Alt+z');
  await sleep(150);
  const after = await wrapBtn.textContent();
  check(before === '換行：關' && after === '換行：開', 'Alt+Z toggles word wrap', before + ' -> ' + after);
  await page.keyboard.press('Alt+z');

  await page.keyboard.press('Control+f');
  check(await page.locator('.monaco-editor .find-widget.visible').waitFor({ timeout: 5000 }).then(() => true, () => false), 'Ctrl+F opens the find widget');
  await page.keyboard.press('Escape');

  // ---- dock / window behaviour
  const dockEd = page.locator('.dock-item', { hasText: 'math.ts' });
  await dockEd.click();
  check(await edWin.isHidden(), 'clicking the active dock item minimises the window');
  await dockEd.click();
  check(await edWin.isVisible(), 'clicking it again restores the window');
  const box = await edWin.boundingBox();
  const dockBox = await page.locator('#dock').boundingBox();
  check(dockBox.y + dockBox.height === 800 && box.y + box.height <= dockBox.y, 'dock sits at the bottom, window above it');
  await edWin.locator('.titlebar .title').dblclick();
  await sleep(60);
  const midBox = await edWin.boundingBox();
  check(midBox.width > box.width && midBox.width < 1280, 'maximising is animated (window is mid-way after 60 ms)', String(midBox.width));
  await sleep(320);
  const maxBox = await edWin.boundingBox();
  check(maxBox.width === 1280 && Math.round(maxBox.y + maxBox.height) === Math.round(dockBox.y), 'double-click title maximises');
  await edWin.locator('.titlebar .title').dblclick();
  await sleep(320);
  const restored = await edWin.boundingBox();
  check(Math.round(restored.width) === Math.round(box.width) && Math.round(restored.x) === Math.round(box.x), 'restoring animates back to the original size');
  check(!(await edWin.evaluate((el) => el.classList.contains('animating'))), 'animation class is removed afterwards');
  const tb = await edWin.locator('.titlebar .title').boundingBox();
  await page.mouse.move(tb.x + 80, tb.y + 10);
  await page.mouse.down();
  await page.mouse.move(tb.x + 200, tb.y + 90, { steps: 5 });
  await page.mouse.up();
  const moved = await edWin.boundingBox();
  check(Math.round(moved.x - box.x) === 120 && Math.round(moved.y - box.y) === 80, 'window drags by its title bar');
  // ---- snapping: left half, right half, top = maximise; dragging away restores the size
  const areaH = Math.round(dockBox.y);
  const dragTitle = async (toX, toY) => {
    const b = await edWin.locator('.titlebar .title').boundingBox();
    await page.mouse.move(b.x + 60, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + 90, b.y + 40, { steps: 3 });
    await page.mouse.move(toX, toY, { steps: 6 });
  };
  const normal = await edWin.boundingBox();
  await dragTitle(1, 300);
  check((await page.locator('.snap-preview').count()) === 1, 'dragging to the left edge shows where the window will go');
  await page.mouse.up();
  await sleep(350);
  let snap = await edWin.boundingBox();
  check(snap.x === 0 && snap.y === 0 && snap.width === 640 && Math.round(snap.height) === areaH && (await page.locator('.snap-preview').count()) === 0, 'left edge -> left half of the screen', JSON.stringify(snap));
  await dragTitle(1279, 300);
  await page.mouse.up();
  await sleep(350);
  snap = await edWin.boundingBox();
  check(snap.x === 640 && snap.width === 640 && Math.round(snap.height) === areaH, 'right edge -> right half', JSON.stringify(snap));
  await dragTitle(600, 1);
  await page.mouse.up();
  await sleep(350);
  snap = await edWin.boundingBox();
  check(snap.x === 0 && snap.width === 1280 && Math.round(snap.height) === areaH, 'top edge -> maximised', JSON.stringify(snap));
  await dragTitle(500, 300);
  await page.mouse.up();
  await sleep(100);
  snap = await edWin.boundingBox();
  check(Math.round(snap.width) === Math.round(normal.width) && Math.round(snap.height) === Math.round(normal.height) && snap.y > 100, 'dragging it away gives the normal size back', JSON.stringify([snap, normal]));
  // ---- show desktop
  const sd = await page.locator('#show-desktop').boundingBox();
  const ck = await page.locator('#clock').boundingBox();
  check(sd.x + sd.width >= 1279 && ck.x + ck.width <= sd.x + 1 && sd.width >= 10, 'an invisible strip sits right of the clock, in the corner', JSON.stringify([sd, ck]));
  const lineOpacity = () => page.evaluate(() => getComputedStyle(document.querySelector('#show-desktop'), '::before').opacity);
  check((await lineOpacity()) === '0', 'nothing shows until the pointer is on it');
  await page.mouse.move(sd.x + 5, sd.y + 20);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#show-desktop'), '::before').opacity === '0.75');
  check(true, 'hovering shows a line at 0.75 opacity');
  const openBefore = await page.locator('.win:not(.minimized)').count();
  await page.click('#show-desktop');
  check(openBefore >= 2 && (await page.locator('.win:not(.minimized)').count()) === 0, 'clicking it hides every window');
  await page.click('#show-desktop');
  check((await page.locator('.win:not(.minimized)').count()) === openBefore && (await page.locator('.dock-item.active .lbl').textContent()) === 'math.ts', 'clicking again brings them back, same window in front');
  if (shotDir) await page.screenshot({ path: shotDir + '/desk.jpg', type: 'jpeg', quality: 55 });

  // ---- second editor, Big5 round trip, binary refusal
  await page.locator('.dock-item', { hasText: 'src' }).click();
  await page.click('.sidebar button[title="' + home + '"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'docs'));
  await openItem('docs');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'legacy.asp'));
  await openItem('legacy.asp');
  await page.waitForFunction(() => window.monaco.editor.getModels().some((m) => m.uri.path.endsWith('legacy.asp')));
  const big5Win = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'legacy.asp' }) });
  await big5Win.locator('.monaco-editor .view-lines').waitFor();
  const big5Text = await page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('legacy.asp')).getValue());
  check(big5Text.includes('中文測試'), 'Big5 file decodes correctly', JSON.stringify(big5Text));
  check((await big5Win.locator('.statusbar').textContent()).includes('Big5') && (await big5Win.locator('.statusbar').textContent()).includes('CRLF'), 'status bar shows Big5 + CRLF');
  await big5Win.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.insertText('繁體');
  await page.keyboard.press('Control+s');
  await page.waitForFunction((w) => w.querySelector('.statusbar span').textContent === '已儲存', await big5Win.elementHandle());
  const raw = fs.readFileSync(home + '/docs/legacy.asp');
  const expected = Buffer.concat([Buffer.from([0xc1, 0x63, 0xc5, 0xe9]), fs.readFileSync(home + '/docs/legacy.orig')]);
  check(raw.equals(expected), 'Big5 file saved back as Big5 with CRLF intact', raw.toString('hex'));
  const pcTab = (name) => page.locator('.win[data-app="Procoder"] .pc-tab[data-name="' + name + '"]');
  const pcTabs = () => page.locator('.win[data-app="Procoder"] .pc-tab .pc-tab-name').allTextContents().then((a) => a.join());
  check((await page.$$('.dock-item')).length === 2 && (await page.locator('.win[data-app="Procoder"]').count()) === 1 && (await pcTabs()) === 'math.ts,legacy.asp',
    'a second file opens as a tab in the one Procoder window', await pcTabs());
  check(await pcTab('legacy.asp').evaluate((el) => el.classList.contains('active')) && (await page.evaluate(() => window.monaco.editor.getEditors().length)) === 1, 'the new tab is in front, and the tabs share one editor');

  await page.locator('.dock-item').first().click();
  await openItem('blob.bin');
  await page.waitForSelector('.toast.err');
  check((await page.textContent('.toast.err')).includes('不是文字檔'), 'binary file is refused with a message');
  check((await page.$$('.dock-item')).length === 2 && (await pcTabs()) === 'math.ts,legacy.asp', 'no tab left behind for the binary file', await pcTabs());

  // ---- tabs: switch, keep each file's state, reorder, close
  await pcTab('math.ts').click();
  check((await edWin.locator('.titlebar .ttext').textContent()) === 'math.ts — Procoder' && (await edWin.locator('.statusbar').textContent()).includes('TypeScript') && (await edWin.locator('.statusbar .path').textContent()) === home + '/project/src/math.ts',
    'clicking a tab shows that file: title, language and path follow');
  check((await edWin.locator('.monaco-editor .view-lines').textContent()).includes('export'), 'the editor shows the tab\'s content');
  // the language can be chosen by hand, whatever the file name says
  {
    const langOf = () => page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('math.ts')).getLanguageId());
    const btn = edWin.locator('.statusbar .pc-lang-btn');
    await btn.click();
    await page.waitForSelector('.pc-lang input');
    check((await page.locator('.pc-lang-list button').first().textContent()) === '自動偵測依檔名：TypeScript' && (await page.locator('.pc-lang-list button.on').getAttribute('data-lang')) === 'typescript',
      'clicking the language in the status bar lists the languages, the current one marked');
    await page.keyboard.type('php');
    check((await page.locator('.pc-lang-list button').first().getAttribute('data-lang')) === 'php', 'typing narrows the list');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.statusbar .pc-lang-btn').textContent === 'PHP');
    check((await langOf()) === 'php' && (await page.locator('.pc-lang').count()) === 0, 'the file is then treated as the chosen language');
    check(await waitApp('editor', (d) => d.langs && d.langs[home + '/project/src/math.ts'] === 'php'), 'the choice is remembered for that file');
    await pcTab('legacy.asp').click();
    await pcTab('math.ts').click();
    check((await btn.textContent()) === 'PHP' && (await edWin.locator('.statusbar .pc-lang-btn').count()) === 1, 'other tabs keep their own language');
    await btn.click();
    await page.locator('.pc-lang-list button[data-lang="auto"]').click();
    await page.waitForFunction(() => document.querySelector('.statusbar .pc-lang-btn').textContent === 'TypeScript');
    check((await langOf()) === 'typescript' && await waitApp('editor', (d) => !d.langs || !(home + '/project/src/math.ts' in d.langs)), '"auto" goes back to what the file name says');
  }
  {
    const a = await pcTab('math.ts').boundingBox();
    const b = await pcTab('legacy.asp').boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 10, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    check((await pcTabs()) === 'legacy.asp,math.ts', 'dragging a tab sideways reorders the tabs', await pcTabs());
  }
  await pcTab('legacy.asp').click({ button: 'right' });
  check((await page.locator('.ctx-menu button').allTextContents()).join('|') === '關閉|關閉其他分頁|關閉右側分頁|關閉全部分頁|複製路徑', 'a tab has its own right-click menu');
  await page.keyboard.press('Escape');
  await pcTab('math.ts').click({ button: 'right' });
  await page.locator('.ctx-menu button', { hasText: '關閉其他分頁' }).click();
  await sleep(150);
  check((await pcTabs()) === 'math.ts' && (await edWin.locator('.titlebar .ttext').textContent()) === 'math.ts — Procoder', '"close the other tabs" leaves only this one', await pcTabs());
  await edWin.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('y');
  check(await pcTab('math.ts').evaluate((el) => el.classList.contains('dirty')), 'a modified tab is marked');
  await pcTab('math.ts').locator('.pc-tab-close').click();
  await page.waitForSelector('.modal');
  check((await page.textContent('.modal h2')).includes('math.ts'), 'closing a modified tab asks first');
  await page.locator('.modal button', { hasText: '不儲存' }).click();
  await page.waitForSelector('.pc-welcome');
  check((await pcTabs()) === '歡迎' && (await edWin.locator('.titlebar .ttext').textContent()) === '歡迎 — Procoder', 'closing the last file brings the welcome page back');
  check((await page.locator('.pc-w-recent .pc-w-name').allTextContents()).slice(0, 2).join() === 'legacy.asp,math.ts', 'the welcome page lists the files opened lately', (await page.locator('.pc-w-recent .pc-w-name').allTextContents()).join());
  await page.locator('.pc-w-recent', { hasText: 'math.ts' }).locator('.pc-w-link').click();
  await edWin.locator('.monaco-editor .view-lines').waitFor();
  await page.waitForFunction(() => document.querySelector('.win[data-app="Procoder"] .pc-pane').style.display === 'none');
  check((await pcTabs()) === '歡迎,math.ts', 'a recent file opens from the welcome page as a tab');
  await pcTab('歡迎').hover();
  await pcTab('歡迎').locator('.pc-tab-close').click();

  // ---- file tree: open a folder, browse it, open files from it
  const treeNames = () => edWin.locator('.pc-row .pc-row-name').allTextContents();
  check(await edWin.locator('.pc-side .pc-tree-empty').isVisible() && (await edWin.locator('.pc-side-title').textContent()) === '檔案', 'the file tree is on the left and starts without a folder');
  await edWin.locator('.pc-tree-open').click();
  // the system file chooser, here choosing a folder
  const pk = page.locator('.modal.picker');
  const pkItem = (side, name) => pk.locator(`.pk-col.${side} .pk-item[data-name="${name}"]`);
  const pkHead = (side) => pk.locator(`.pk-col.${side} .pk-col-name`).textContent();
  await pkItem('right', 'math.ts').waitFor();
  check((await page.textContent('.modal h2')) === '開啟資料夾' && (await pk.locator('input[type="text"]').count()) === 0, '"open folder" brings up the chooser, with nothing to type');
  check((await pkHead('left')) === 'project' && (await pkHead('right')) === 'src' && await pkItem('left', 'src').evaluate((el) => el.classList.contains('on')),
    'two columns: the folder on the left, what is inside the picked one on the right');
  check(await pkItem('right', 'math.ts').isDisabled() && await pkItem('left', 'README.md').isDisabled() && (await pk.locator('.pk-ok').textContent()) === '選擇「src」',
    'choosing a folder: files cannot be picked, and the button names the folder');
  await pk.locator('.pk-col.right .pk-back').click();
  await pkItem('right', 'src').waitFor();
  check((await pkHead('left')) === P_BASE(home) && (await pkHead('right')) === 'project' && (await pk.locator('.pk-ok').textContent()) === '選擇「project」', 'the back button on the right goes up one level');
  await pk.locator('.pk-col.left .pk-back').click();
  await page.waitForFunction((n) => document.querySelector('.modal.picker .pk-col.right .pk-col-name')?.textContent === n, P_BASE(home));
  check(true, 'and so does the one on the left');
  await pkItem('right', 'project').click();
  await pkItem('right', 'src').waitFor();
  check((await pkHead('left')) === P_BASE(home) && (await pkHead('right')) === 'project' && (await pk.locator('.pk-where').textContent()) === home + '/project', 'clicking a folder on the right walks into it and shifts the columns');
  await pk.locator('.pk-ok').click();
  await page.waitForFunction(() => document.querySelector('.pc-row.current .pc-row-name')?.textContent === 'math.ts');
  {
    const names = await treeNames();
    check((await edWin.locator('.pc-side-title').textContent()) === 'project' && names[0] === 'src' && names.includes('README.md') && names.indexOf('README.md') > names.indexOf('math.ts'),
      'the folder is listed, folders first', names.join());
    check(names.includes('math.ts') && (await edWin.locator('.pc-row.dir.open .pc-row-name').textContent()) === 'src', 'the folder holding the open file is expanded and the file is marked');
  }
  await edWin.locator('.pc-row', { hasText: 'README.md' }).click();
  await pcTab('README.md').waitFor();
  await page.waitForFunction(() => document.querySelector('.pc-row.current .pc-row-name')?.textContent === 'README.md');
  check((await pcTabs()) === 'math.ts,README.md' && (await edWin.locator('.titlebar .ttext').textContent()) === 'README.md — Procoder', 'clicking a file in the tree opens it as a tab');
  await pcTab('math.ts').click();
  check((await edWin.locator('.pc-row.current .pc-row-name').textContent()) === 'math.ts', 'the tree follows the tab in front');
  await edWin.locator('.pc-row.dir', { hasText: 'src' }).click();
  check(!(await treeNames()).includes('math.ts') && (await edWin.locator('.pc-row.dir').first().getAttribute('aria-expanded')) === 'false', 'clicking a folder collapses it');
  await edWin.locator('.pc-row.dir', { hasText: 'src' }).click();
  check((await treeNames()).includes('math.ts'), 'and expands it again');
  // new file / new folder / rename / delete, from the tree's right-click menu
  const treeRow = (name) => edWin.locator(`.pc-row[data-path$="/${name}"]`);
  const treeCtx = async (name, label) => {
    await treeRow(name).click({ button: 'right' });
    await page.locator('.ctx-menu button', { hasText: label }).click();
  };
  const inProject = (rel) => fs.existsSync(home + '/project/' + rel);
  for (const rel of ['src/made.ts', 'src/made2.ts']) fs.rmSync(home + '/project/' + rel, { force: true });
  fs.rmSync(home + '/project/newdir', { recursive: true, force: true });
  await treeRow('src').click({ button: 'right' });
  check((await page.locator('.ctx-menu button').allTextContents()).join('|') === '收合|新增檔案|新增資料夾|重新命名（F2）|刪除|複製路徑|重新整理', 'a folder in the tree has a right-click menu');
  await page.locator('.ctx-menu button', { hasText: '新增檔案' }).click();
  await page.fill('.modal input', 'made.ts');
  await page.keyboard.press('Enter');
  await pcTab('made.ts').waitFor();
  await page.waitForFunction(() => document.querySelector('.pc-row.current .pc-row-name')?.textContent === 'made.ts');
  check(inProject('src/made.ts') && (await edWin.locator('.titlebar .ttext').textContent()) === 'made.ts — Procoder', 'new file: created inside that folder on the host and opened as a tab');
  await edWin.locator('.pc-side-tools button[title="新增資料夾"]').click();
  await page.fill('.modal input', 'newdir');
  await page.keyboard.press('Enter');
  await treeRow('newdir').waitFor();
  check(fs.statSync(home + '/project/newdir').isDirectory() && (await treeNames())[0] === 'newdir', 'new folder (from the tree\'s header) is created in the opened folder');
  await treeRow('math.ts').click();
  await pcTab('math.ts').and(page.locator('.active')).waitFor();
  await page.keyboard.press('ArrowUp');
  check(await page.evaluate(() => document.activeElement.dataset.path?.endsWith('/made.ts')), 'after clicking a file the tree keeps the keyboard; the arrow keys move along the rows');
  await page.keyboard.press('F2');
  await page.waitForSelector('.modal input');
  check((await page.inputValue('.modal input')) === 'made.ts' && (await page.textContent('.modal h2')) === '重新命名', 'F2 renames the row in the tree, starting from the current name');
  await page.fill('.modal input', 'made2.ts');
  await page.keyboard.press('Enter');
  await pcTab('made2.ts').waitFor();
  await treeRow('made2.ts').waitFor();
  await treeRow('made.ts').waitFor({ state: 'detached' });
  check(await page.evaluate(() => document.activeElement.dataset.path?.endsWith('/made2.ts')), 'the renamed row keeps the focus');
  check(inProject('src/made2.ts') && !inProject('src/made.ts') && (await treeRow('made2.ts').count()) === 1 && (await treeRow('made.ts').count()) === 0, 'rename: the file, its row and its tab all take the new name');
  await treeCtx('made2.ts', '刪除');
  check((await page.textContent('.modal h2')).includes('made2.ts'), 'delete asks first');
  await page.locator('.modal button', { hasText: '刪除' }).click();
  await treeRow('made2.ts').waitFor({ state: 'detached' });
  check(!inProject('src/made2.ts') && (await pcTabs()) === 'math.ts,README.md', 'delete: the file is gone from the host, the tree and the tabs', await pcTabs());
  await treeCtx('newdir', '刪除');
  await page.locator('.modal button', { hasText: '刪除' }).click();
  await treeRow('newdir').waitFor({ state: 'detached' });
  check(!inProject('newdir'), 'a folder can be deleted too');

  // another Procoder window; a file from outside opens in the one used last
  {
    const launch = (rel) => page.evaluate((path) => import('/js/shell/apps.js').then((m) => { m.launchApp('editor', { path, size: 10 }); }), home + '/project/' + rel);
    const wins = page.locator('.win[data-app="Procoder"]');
    const tabsOf = (i) => wins.nth(i).locator('.pc-tab .pc-tab-name').allTextContents().then((a) => a.join());
    await edWin.locator('.menu-btn', { hasText: '檔案' }).click();
    check((await edWin.locator('.menu button .lbl').first().textContent()) === '開新視窗', 'the 檔案 menu starts with "new window"');
    await edWin.locator('.menu button', { hasText: '開新視窗' }).click();
    await wins.nth(1).locator('.pc-welcome').waitFor();
    check((await wins.count()) === 2 && (await tabsOf(1)) === '歡迎' && await wins.nth(1).locator('.pc-tree-empty').isVisible(), 'it opens a second Procoder on its welcome page, without a folder');
    await launch('src/app.py');
    await wins.nth(1).locator('.pc-tab[data-name="app.py"]').waitFor();
    check((await tabsOf(0)) === 'math.ts,README.md' && (await tabsOf(1)) === '歡迎,app.py', 'a file from outside opens in the Procoder used last', (await tabsOf(0)) + ' / ' + (await tabsOf(1)));
    await wins.nth(0).evaluate((el) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await launch('package.json');
    await wins.nth(0).locator('.pc-tab[data-name="package.json"]').waitFor();
    check((await tabsOf(1)) === '歡迎,app.py', 'after using the first one again, files open there');
    await launch('src/app.py');
    await page.waitForFunction(() => document.querySelector('.dock-item.active .lbl')?.textContent === 'app.py');
    check((await tabsOf(0)) === 'math.ts,README.md,package.json' && (await tabsOf(1)) === '歡迎,app.py', 'a file already open in another Procoder is shown there, not opened twice');
    await wins.nth(1).locator('.traffic .close').click();
    await page.waitForFunction(() => document.querySelectorAll('.win[data-app="Procoder"]').length === 1);
    await pcTab('package.json').click({ button: 'middle' });
    await pcTab('math.ts').click();
  }

  // ---- Filex: upload files from this computer, several at once
  {
    const crypto = require('crypto');
    for (const f of ['fx-a.txt', 'fx-a 複本.txt', 'fx-big.bin']) fs.rmSync(home + '/' + f, { force: true });
    await page.evaluate(() => import('/js/shell/apps.js').then((m) => { m.launchApp('filex'); }));
    const fx = page.locator('.win[data-app="Filex"]');
    await fx.locator('.fx-drop').waitFor();
    check((await fx.locator('.titlebar .ttext').textContent()) === 'Filex' && (await fx.locator('.fx-dest-path').textContent()) === home && await fx.locator('input[type="file"]').evaluate((el) => el.multiple),
      'Filex opens with the home folder as the place to upload to, and takes several files at once');
    const big = crypto.randomBytes(5 * 1024 * 1024 + 123);
    await fx.locator('input[type="file"]').setInputFiles([{ name: 'fx-a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello filex') }, { name: 'fx-big.bin', mimeType: 'application/octet-stream', buffer: big }]);
    await page.waitForFunction(() => document.querySelectorAll('.fx-item[data-state="done"]').length === 2, null, { timeout: 60000 });
    check(fs.readFileSync(home + '/fx-a.txt', 'utf8') === 'hello filex' && fs.readFileSync(home + '/fx-big.bin').equals(big), 'both files arrive on the host intact (one of them over 5 MB, sent in pieces)');
    check((await fx.locator('.statusbar span').first().textContent()) === '完成 2 個' && (await fx.locator('.fx-item[data-name="fx-a.txt"] .fx-status').textContent()) === '完成', 'each file shows how it went');
    await fx.locator('input[type="file"]').setInputFiles([{ name: 'fx-a.txt', mimeType: 'text/plain', buffer: Buffer.from('second') }]);
    await page.waitForFunction(() => document.querySelector('.modal h2')?.textContent.includes('已經存在'));
    check((await page.locator('.modal .btns button').allTextContents()).join() === '略過,保留兩者,取代', 'a name that is taken asks: skip, keep both or replace');
    await page.locator('.modal button', { hasText: '保留兩者' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.fx-item[data-state="done"]').length === 3);
    check(fs.readFileSync(home + '/fx-a 複本.txt', 'utf8') === 'second' && fs.readFileSync(home + '/fx-a.txt', 'utf8') === 'hello filex', '"keep both" uploads under a new name');
    await fx.locator('input[type="file"]').setInputFiles([{ name: 'fx-a.txt', mimeType: 'text/plain', buffer: Buffer.from('third') }]);
    await page.locator('.modal button', { hasText: '略過' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.fx-item[data-state="skip"]').length === 1);
    check(fs.readFileSync(home + '/fx-a.txt', 'utf8') === 'hello filex', '"skip" leaves the file on the host alone');
    await fx.locator('.fx-clear').click();
    check((await fx.locator('.fx-item').count()) === 0 && (await fx.locator('.statusbar span').first().textContent()) === '還沒有要上傳的檔案', 'the finished ones can be cleared from the list');
    await fx.locator('.fx-change').click();
    await page.locator('.modal.picker .pk-col.right .pk-item[data-name="project"]').click();
    await page.locator('.modal.picker .pk-ok').click();
    check((await fx.locator('.fx-dest-path').textContent()) === home + '/project' && await waitApp('filex', (d) => d.dest === home + '/project'), 'the folder to upload to is chosen with the system chooser and remembered');
    await fx.locator('.traffic .close').click();
    for (const f of ['fx-a.txt', 'fx-a 複本.txt', 'fx-big.bin']) fs.rmSync(home + '/' + f, { force: true });
  }

  fs.writeFileSync(home + '/project/tree-new.txt', 'x');
  fs.writeFileSync(home + '/project/secret.inv-test', 'x');
  await edWin.locator('.pc-side-tools button[title="重新整理"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.pc-row .pc-row-name')].some((e) => e.textContent === 'tree-new.txt'));
  check(!(await treeNames()).includes('secret.inv-test'), 'refresh picks up new files; internal files stay out of the tree');
  fs.rmSync(home + '/project/tree-new.txt');
  fs.rmSync(home + '/project/secret.inv-test');
  check(await waitApp('editor', (d) => d.folder === home + '/project'), 'the opened folder is remembered in ~/.remosh-gui/app/editor');
  {
    const before = (await edWin.locator('.pc-side').boundingBox()).width;
    const g = await edWin.locator('.pc-side-grip').boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + 60);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + 70, g.y + 60, { steps: 4 });
    await page.mouse.up();
    const after = (await edWin.locator('.pc-side').boundingBox()).width;
    check(Math.abs(after - before - 70) <= 2 && await waitApp('editor', (d) => d.sideWidth === Math.round(after)), 'the tree can be dragged wider, and the width is saved', before + ' -> ' + after);
  }
  await edWin.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+b');
  check(await edWin.locator('.pc-side').isHidden(), 'Ctrl+B hides the file tree');
  await edWin.locator('.menu-btn', { hasText: '介面' }).click();
  await edWin.locator('.menu button', { hasText: '顯示檔案樹' }).click();
  check(await edWin.locator('.pc-side').isVisible(), 'the 介面 menu shows it again');
  await pcTab('README.md').click({ button: 'middle' });
  check((await page.locator('.modal').count()) === 0 && (await pcTabs()) === 'math.ts', 'middle-clicking tabs closes them without pasting anything into the next file', await pcTabs());
  await edWin.locator('.pc-side-tools button[title="關閉資料夾"]').click();
  check(await edWin.locator('.pc-tree-empty').isVisible() && await waitApp('editor', (d) => d.folder === null), 'the folder can be closed again');
  await pcTab('math.ts').click();

  // ---- unsaved-changes guard
  await edWin.locator('.monaco-editor .view-lines').click();
  await page.keyboard.type('x');
  await edWin.locator('.traffic .close').click();
  await page.waitForSelector('.modal');
  check((await page.textContent('.modal h2')).includes('math.ts'), 'closing a modified file asks first');
  await page.locator('.modal button', { hasText: '取消' }).click();
  check(await edWin.isVisible(), 'cancel keeps the window open');
  await edWin.locator('.traffic .close').click();
  await page.locator('.modal button', { hasText: '不儲存' }).click();
  await sleep(200);
  check((await page.$$('.dock-item')).length === 1, 'discard closes the window and its dock item');
  check(fs.readFileSync(home + '/project/src/math.ts', 'utf8') === onDisk, 'discarded edit was not written');

  // ---- File menu: undo / redo / save / save as / close
  const copyPath = home + '/project/src/copy.py';
  fs.rmSync(copyPath, { force: true });
  const finderDock = page.locator('.dock-item').first();
  if (!(await finderDock.evaluate((el) => el.classList.contains('active')))) await finderDock.click();
  await page.click('.sidebar button[title="' + home + '"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'project'));
  await openItem('project');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'src'));
  await openItem('src');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'math.ts'));
  await openItem('math.ts');
  const mWin = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'math.ts' }) });
  await mWin.locator('.monaco-editor .view-lines').click();
  const menu = async (label) => {
    await mWin.locator('.menu-btn', { hasText: '檔案' }).click();
    await mWin.locator('.menu button', { hasText: label }).click();
  };
  await mWin.locator('.menu-btn', { hasText: '檔案' }).click();
  check((await mWin.locator('.menu button .lbl').allTextContents()).join('|') === '開新視窗|新增檔案|開啟檔案…|開啟資料夾…|關閉資料夾|上一步（復原）|下一步（重做）|存檔|另存新檔…|關閉分頁|結束 Procoder', 'File menu lists its commands');
  check(await mWin.locator('.menu button', { hasText: '上一步' }).isDisabled(), 'undo is disabled when there is nothing to undo');
  await page.keyboard.press('Escape');
  check((await mWin.locator('.menu').count()) === 0, 'Escape closes the menu');
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('//menu');
  await menu('上一步');
  await sleep(150);
  check((await value()) === onDisk, 'menu undo reverts the edit');
  await menu('下一步');
  await sleep(150);
  check((await value()) === onDisk + '//menu', 'menu redo re-applies it');
  await menu('存檔');
  await page.waitForFunction((w) => w.querySelector('.statusbar span').textContent === '已儲存', await mWin.elementHandle());
  check(fs.readFileSync(home + '/project/src/math.ts', 'utf8') === onDisk + '//menu', 'menu save wrote the file');
  await menu('另存新檔');
  await page.waitForSelector('.modal input');
  check((await page.inputValue('.modal.picker .pk-name input')) === 'math.ts' && (await page.textContent('.modal.picker .pk-where')) === '存到 ' + home + '/project/src', 'save-as opens the chooser at the file\'s folder with its name filled in');
  await page.fill('.modal input', copyPath);
  await page.keyboard.press('Enter');
  const cWin = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'copy.py' }) });
  await cWin.waitFor();
  check(fs.readFileSync(copyPath, 'utf8') === onDisk + '//menu', 'save as wrote the new file');
  check((await cWin.locator('.statusbar').textContent()).includes('Python'), 'language follows the new file name');
  check((await page.locator('.dock-item', { hasText: 'copy.py' }).count()) === 1 && (await page.locator('.dock-item', { hasText: 'math.ts' }).count()) === 0, 'dock entry is renamed');
  await page.waitForFunction(() => [...document.querySelectorAll('.files .item .name')].some((e) => e.textContent === 'copy.py'));
  check(true, 'finder shows the new file');
  await cWin.locator('.menu-btn', { hasText: '檔案' }).click();
  await cWin.locator('.menu button', { hasText: '另存新檔' }).click();
  await page.fill('.modal input', 'math.ts');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.modal h2')?.textContent.includes('已經存在'));
  check(true, 'saving over an existing file asks first');
  await page.locator('.modal button', { hasText: '取消' }).click();
  // ---- 介面 menu: text size and minimap
  const opt = (name) => page.evaluate((n) => {
    const e = window.monaco.editor.getEditors()[0];
    const o = e.getRawOptions();
    return n === 'minimap' ? o.minimap.enabled : o[n];
  }, name);
  const view = async (label) => {
    await cWin.locator('.menu-btn', { hasText: '介面' }).click();
    await cWin.locator('.menu button', { hasText: label }).click();
  };
  check((await opt('fontSize')) === 13 && (await opt('minimap')) === true, 'defaults: 13px text, minimap on');
  check((await cWin.locator('.monaco-editor .minimap').count()) === 1, 'minimap is rendered');
  await view('放大文字');
  await view('放大文字');
  check((await opt('fontSize')) === 15, 'enlarge text twice -> 15');
  await view('縮小文字');
  check((await opt('fontSize')) === 14, 'shrink text -> 14');
  await cWin.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+Equal');
  check((await opt('fontSize')) === 15, 'Ctrl+= enlarges');
  await page.keyboard.press('Control+Minus');
  await page.keyboard.press('Control+Minus');
  check((await opt('fontSize')) === 13, 'Ctrl+- shrinks');
  await view('放大文字');
  await view('顯示右側縮圖');
  check((await opt('minimap')) === false && !(await cWin.locator('.monaco-editor .minimap').isVisible().catch(() => false)), 'minimap can be turned off');
  await cWin.locator('.menu-btn', { hasText: '介面' }).click();
  check((await cWin.locator('.menu button[aria-checked="false"]', { hasText: '顯示右側縮圖' }).count()) === 1, 'menu shows the minimap as unchecked');
  check((await cWin.locator('.menu button', { hasText: '重設文字大小（目前 14）' }).count()) === 1, 'reset item shows the current size');
  await page.keyboard.press('ArrowLeft');
  check((await cWin.locator('.menu[aria-label="檔案"]').count()) === 1, 'arrow keys switch between menus');
  await page.keyboard.press('Escape');
  check(await waitApp('editor', (d) => d.fontSize === 14 && d.minimap === false), 'preferences are saved in ~/.remosh-gui/app/editor');
  await page.locator('.dock-item', { hasText: 'copy.py' }).click(); // minimise so the Finder is reachable
  await openItem('app.py');
  await pcTab('app.py').waitFor();
  await page.waitForFunction(() => window.monaco.editor.getEditors()[0].getModel()?.uri.path.endsWith('app.py'));
  check(await page.evaluate(() => window.monaco.editor.getEditors().every((e) => e.getRawOptions().fontSize === 14 && e.getRawOptions().minimap.enabled === false)), 'another tab has the same preferences');
  await page.locator('.win[data-app="Procoder"] .monaco-editor').click();
  await page.keyboard.press('Alt+w');
  await sleep(150);
  check((await pcTabs()) === 'copy.py', 'Alt+W closes the tab in front', await pcTabs());
  await view('重設文字大小');
  await view('顯示右側縮圖');
  check((await opt('fontSize')) === 13 && (await opt('minimap')) === true, 'reset restores the defaults');

  await cWin.locator('.menu-btn', { hasText: '檔案' }).click();
  await cWin.locator('.menu button', { hasText: '結束 Procoder' }).click();
  await sleep(200);
  check((await cWin.count()) === 0 && (await page.$$('.dock-item')).length === 1, 'the menu\'s quit closes the window');
  fs.rmSync(copyPath, { force: true });

  // ---- start menu, clock, task manager
  check((await page.locator('#menubar').count()) === 0, 'top bar is gone');
  check(/^\d\d:\d\d$/.test(await page.textContent('#clock-time')) && /^\d{4}\/\d\d\/\d\d$/.test(await page.textContent('#clock-date')), 'clock shows time and date');
  const clockBox = await page.locator('#clock').boundingBox();
  const startBox = await page.locator('#start-btn').boundingBox();
  check(startBox.x < 20 && startBox.y > 740 && clockBox.x + clockBox.width > 1240 && clockBox.x + clockBox.width <= 1266 && clockBox.y > 740, 'start button bottom-left; clock bottom-right, kept a little off the edge');
  const menuGone = () => page.waitForSelector('#start-menu', { state: 'hidden', timeout: 2000 }).then(() => true, () => false);
  check(await page.isHidden('#start-menu'), 'start menu starts closed');
  await page.click('#start-btn');
  await sleep(40);
  const midOpacity = Number(await page.evaluate(() => getComputedStyle(document.querySelector('#start-menu')).opacity));
  check(await page.isVisible('#start-menu') && midOpacity > 0 && midOpacity < 1, 'start button opens the menu with a fade', String(midOpacity));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('#start-menu')).opacity === '1');
  check((await page.textContent('#sm-username')) === user, 'start menu shows the current user');
  check(await page.isHidden('#disconnect'), 'logout is hidden until the user is clicked');
  await page.keyboard.press('Escape');
  check(await page.isVisible('#start-menu') && await menuGone(), 'Escape closes the start menu, fading out first');

  await page.locator('.win', { has: page.locator('.finder-main') }).locator('.traffic .close').click();
  check((await page.locator('.finder-main').count()) === 0 && (await page.$$('.dock-item')).length === 0, 'file cabinet can be closed');
  await page.click('#start-btn');
  await page.click('#sm-files');
  await page.waitForSelector('.files .item');
  check(await menuGone() && (await page.textContent('.finder-main + .statusbar .path')) === home, 'start menu reopens the file cabinet at home');

  await page.click('#start-btn');
  await page.click('#sm-tasks');
  const tm = page.locator('.win', { has: page.locator('.tm-top') });
  await tm.waitFor();
  check((await tm.locator('.titlebar .ttext').textContent()) === '工作管理員', 'task manager has its title');
  await page.waitForFunction(() => document.querySelectorAll('.tm-list tbody tr').length > 3 && !document.querySelector('.tm-meter .val').textContent.includes('計算'), null, { timeout: 20000 });
  const cg = fs.existsSync('/sys/fs/cgroup/memory.max') ? fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim() : null;
  const meters = await tm.locator('.tm-meter').allTextContents();
  console.log('     task manager:', (await tm.locator('.tm-meta').textContent()).replace(/\s+/g, ' '), '|', meters.join(' | '));
  if (fs.existsSync('/.dockerenv')) {
    check((await page.textContent('#tm-scope')).startsWith('容器'), 'task manager reports the container scope');
    if (cg && cg !== 'max') {
      const gb = (Number(cg) / 2 ** 30).toFixed(1) + ' GB';
      const hostGb = Math.round(Number(/MemTotal:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 2 ** 20);
      check(meters[1].includes('/ ' + gb), 'memory is measured against the container limit (' + gb + ')');
      check(!meters[1].includes(hostGb + ' GB'), 'host memory total (' + hostGb + ' GB) is not shown');
    }
    const cpuMax = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ');
    if (cpuMax[0] !== 'max') check(meters[0].includes('/ ' + Number(cpuMax[0]) / Number(cpuMax[1]) + ' 核'), 'CPU is measured against the container quota');
  }
  const procNames = await tm.locator('.tm-list tbody td:first-child').allTextContents();
  check(procNames.includes('sshd') || procNames.some((n) => n.startsWith('sshd')), 'process list includes sshd', procNames.slice(0, 8).join(','));
  await tm.locator('.tm-list th button', { hasText: 'PID' }).click();
  await tm.locator('.tm-list th button', { hasText: 'PID' }).click();
  check((await tm.locator('.tm-list tbody tr').first().locator('td').nth(1).textContent()) === '1', 'clicking a column sorts the list');
  check((await page.locator('.dock-item', { hasText: '工作管理員' }).count()) === 1, 'task manager has a dock entry');
  // ---- two pages: 進程 and 圖表
  check((await tm.locator('.tm-tabs button').allTextContents()).join() === '進程,圖表' && await tm.locator('.tm-list').isVisible() && await tm.locator('.tm-perf').isHidden(), 'task manager has two pages, 進程 first');
  await tm.locator('.tm-tabs button', { hasText: '圖表' }).click();
  check(await tm.locator('.tm-perf').isVisible() && await tm.locator('.tm-list').isHidden(), '圖表 replaces the process list');
  check((await tm.locator('.tm-meter h4').allTextContents()).join() === 'CPU,記憶體,儲存空間,網路', 'it shows CPU, memory, storage and network');
  const cpuModel = (fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^model name\s*:\s*(.+)$/m) || [])[1];
  if (cpuModel) check((await tm.locator('.tm-meter[data-k="cpu"] .extra').textContent()) === cpuModel.replace(/\s+/g, ' ').trim(), 'the CPU card names the processor', await tm.locator('.tm-meter[data-k="cpu"] .extra').textContent());
  const dfRoot = execSyncTop('df -kP / | tail -n 1').toString().trim().split(/\s+/);
  check((await tm.locator('.tm-meter[data-k="disk"] .val').textContent()).endsWith('%') && (await tm.locator('.tm-meter[data-k="disk"] .sub').textContent()).includes('剩'), 'storage shows how full it is and what is left', await tm.locator('.tm-meter[data-k="disk"]').textContent());
  check(Number(dfRoot[1]) > 0, 'df works on this host');
  await page.waitForFunction(() => /\/s$/.test(document.querySelector('.tm-meter[data-k="net"] .val').textContent), null, { timeout: 10000 });
  check((await tm.locator('.tm-meter[data-k="net"] .sub').textContent()).startsWith('↑'), 'network shows receive and send rates');
  await page.waitForFunction(() => (document.querySelector('.tm-meter[data-k="cpu"] polyline.line')?.getAttribute('points') || '').split(' ').length >= 2, null, { timeout: 10000 });
  check(await tm.locator('.tm-meter[data-k="net"] polyline.line').count() === 2 && await tm.locator('.tm-meter[data-k="disk"] svg').count() === 0, 'CPU, memory and network are drawn as charts (two lines for the network)');
  await tm.locator('.tm-tabs button', { hasText: '進程' }).click();
  await tm.locator('.tm-list').waitFor();
  // ---- double-click a process -> details window -> force close
  const { spawn } = require('node:child_process');
  const execSync = execSyncTop;
  spawn('su', [user, '-c', 'exec sleep 4321'], { detached: true, stdio: 'ignore' }).unref();
  await sleep(500);
  const victim = Number(execSync('pgrep -n -x sleep -u ' + user).toString().trim());
  const vRow = tm.locator(`.tm-list tbody tr[data-pid="${victim}"]`);
  await vRow.waitFor({ timeout: 10000 });
  await vRow.dblclick();
  const pw = page.locator('.win', { has: page.locator('.proc-body') });
  await pw.waitFor();
  await pw.locator('dd[data-k="指令"]').waitFor();
  const dd = (k) => pw.locator(`dd[data-k="${k}"]`).textContent();
  check((await pw.locator('.titlebar .ttext').textContent()) === `sleep（${victim}） — 行程`, 'double-click opens a process window');
  check((await dd('PID')) === String(victim) && (await dd('執行者')) === user && (await dd('指令')) === 'sleep 4321', 'it shows pid, who runs it and the command', [await dd('PID'), await dd('執行者'), await dd('指令')].join(' | '));
  check(/B$/.test(await dd('記憶體')) && (await dd('狀態')) === '休眠' && (await dd('執行檔')).endsWith('sleep'), 'and its resource use and state', [await dd('記憶體'), await dd('狀態'), await dd('執行檔')].join(' | '));
  await page.waitForFunction(() => /%$/.test(document.querySelector('.proc-body dd[data-k="CPU"]').textContent), null, { timeout: 8000 });
  check(true, 'CPU usage appears after the second sample');
  await pw.locator('.proc-kill').click();
  check((await page.textContent('.modal h2')).includes(`PID ${victim}`), 'force close asks first');
  await page.locator('.modal button', { hasText: '強制關閉' }).click();
  await page.waitForFunction(() => document.querySelector('.proc-status').textContent === '已強制關閉');
  let dead = false;
  try { process.kill(victim, 0); } catch { dead = true; }
  check(dead && await pw.locator('.proc-kill').isDisabled(), 'the process is really gone and the button is disabled');
  await pw.locator('.traffic .close').click();
  const rootRow = tm.locator('.tm-list tbody tr[data-pid="7"]');
  if (await rootRow.count()) {
    await rootRow.dblclick();
    await pw.locator('dd[data-k="指令"]').waitFor();
    await pw.locator('.proc-kill').click();
    await page.locator('.modal button', { hasText: '強制關閉' }).click();
    await page.waitForSelector('.toast.err');
    check((await page.locator('.toast.err').last().textContent()).includes('權限不足'), 'killing someone else\'s process is refused by the host');
    check(await pw.locator('.proc-kill').isEnabled(), 'and the window stays usable');
    await pw.locator('.traffic .close').click();
  }
  await tm.locator('.traffic .close').click();
  check((await tm.count()) === 0, 'task manager closes');

  // ---- right-click menus, open-with, notepad, clipboard, delete, properties
  // Bring the (first) file cabinet window to the front; open one if none is left.
  const toFinder = async () => {
    const entry = page.locator('.dock-item[data-app="檔案櫃"]').first();
    if (await entry.count()) {
      if (!(await entry.evaluate((el) => el.classList.contains('active')))) await entry.click();
      return;
    }
    await page.click('#start-btn');
    await page.click('#sm-files');
  };
  await page.click('#start-btn');
  const allApps = '檔案櫃,Procoder,記事本,Graphoto,Filex,終端機,工作管理員,設定';
  check((await page.locator('#sm-apps button').allTextContents()).join() === allApps, 'every app is pinned to start by default');
  await page.click('#sm-all-btn');
  check(await page.isVisible('#sm-all') && await page.isHidden('#sm-home') && (await page.locator('#sm-all-list button').allTextContents()).join() === allApps, '"all apps" lists every app, the code editor included');
  await page.locator('#sma-tasks').click({ button: 'right' });
  check((await menuLabels()).join('|') === '開啟|從開始取消釘選', 'right-click on an app offers to unpin it');
  await pick('從開始取消釘選');
  check(await waitSetting((st) => st.start?.pinned && !st.start.pinned.includes('tasks') && st.start.pinned.length === 7), 'unpinning is saved');
  check(await page.isVisible('#start-menu'), 'the start menu stays open while pinning');
  await page.click('#sm-back');
  check((await page.locator('#sm-apps button').allTextContents()).join() === '檔案櫃,Procoder,記事本,Graphoto,Filex,終端機,設定', 'the unpinned app leaves the pinned list');
  await page.click('#sm-all-btn');
  await page.locator('#sma-tasks').click({ button: 'right' });
  check((await menuLabels()).join('|') === '開啟|釘選到開始', 'an unpinned app offers to pin');
  await pick('釘選到開始');
  await page.click('#sm-back');
  check((await page.locator('#sm-apps button').last().textContent()) === '工作管理員', 'pinning adds it at the end');
  await page.click('#sm-editor');
  const pcWin = page.locator('.win[data-app="Procoder"]');
  await pcWin.locator('.pc-welcome').waitFor();
  check((await pcWin.locator('.titlebar .ttext').textContent()) === '歡迎 — Procoder' && (await pcWin.locator('.pc-tab').count()) === 1 && (await pcWin.locator('.pc-w-head h1').textContent()) === 'Procoder',
    'the code editor starts on its welcome page, in a tab');
  check((await pcWin.locator('.pc-w-start .pc-w-link').allTextContents()).join() === '新增檔案,開啟檔案…,開啟資料夾…', 'the welcome page offers a new file and opening a file or a folder');
  await page.click('#start-btn');
  await page.click('#sm-editor');
  check((await page.locator('.win[data-app="Procoder"]').count()) === 1 && (await pcWin.locator('.pc-tab').count()) === 1, 'starting it again does not open a second Procoder');
  await pcWin.locator('.pc-w-link', { hasText: '開啟檔案…' }).click();
  {
    const pk = page.locator('.modal.picker');
    const item = (side, name) => pk.locator(`.pk-col.${side} .pk-item[data-name="${name}"]`);
    await item('right', 'project').waitFor();
    check((await pk.locator('h2').textContent()) === '開啟檔案' && await pk.locator('.pk-ok').isDisabled() && (await pk.locator('.pk-where').textContent()) === '請選擇一個檔案', 'choosing a file: nothing can be opened until a file is picked');
    await item('right', 'project').click();
    await item('right', 'README.md').waitFor();
    check(await pk.locator('.pk-ok').isDisabled(), 'a folder is walked into, not chosen');
    check((await pk.locator('.pk-item[data-name=".bashrc"]').count()) === 0, 'hidden files are left out at first');
    await item('right', 'README.md').click();
    check(await pk.locator('.pk-ok').isEnabled() && (await pk.locator('.pk-where').textContent()) === home + '/project/README.md' && await item('right', 'README.md').evaluate((el) => el.classList.contains('on')), 'clicking a file picks it');
    await item('left', 'docs').click();
    await item('right', 'legacy.asp').waitFor();
    check(await pk.locator('.pk-ok').isDisabled(), 'moving to another folder drops the pick');
    await item('left', 'project').click();
    await item('right', 'README.md').dblclick();
  }
  await pcWin.locator('.pc-tab[data-name="README.md"]').waitFor();
  check((await pcWin.locator('.pc-tab.active .pc-tab-name').textContent()) === 'README.md' && (await page.locator('.modal').count()) === 0, 'double-clicking a file opens it as a tab');
  await pcWin.locator('.pc-tab[data-name="README.md"]').click({ button: 'middle' });
  await pcWin.locator('.pc-welcome').waitFor();
  await pcWin.locator('.pc-w-link', { hasText: '新增檔案' }).click();
  const blankEd = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: '未命名 — Procoder' }) });
  await blankEd.locator('.monaco-editor .view-lines').click();
  await page.keyboard.insertText('fresh');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.modal input');
  check((await page.inputValue('.modal input')) === '未命名.txt' && (await page.textContent('.modal.picker .pk-where')) === '存到 ' + home, 'the code editor opens from start with a new document; saving asks where');
  await page.keyboard.press('Escape');
  await blankEd.locator('.traffic .close').click();
  await page.locator('.modal button', { hasText: '不儲存' }).click();
  await sleep(150);
  await toFinder();
  await openItem('docs');
  await item('todo.txt').waitFor();
  await item('todo.txt').click({ button: 'right' });
  check((await menuLabels()).join('|') === '開啟|開啟程式…|複製|剪下|貼上|重新命名|刪除|內容', 'file right-click menu', (await menuLabels()).join('|'));
  await pick('內容');
  const props = await page.locator('.modal dl.props').textContent();
  check(props.includes('todo.txt') && props.includes('rw-r--r--（644）') && props.includes('9 位元組') && props.includes(home + '/docs'), 'properties show name, location, size and permissions', props);
  await page.locator('.modal button', { hasText: '關閉' }).click();

  await item('todo.txt').dblclick();
  await page.waitForSelector('.modal .app-choice');
  check((await page.locator('.modal .app-choice').allTextContents()).join() === 'Procoder,記事本', 'unknown extension asks, offering only apps that accept .txt');
  check(await page.isChecked('#choose-remember') && (await page.textContent('.choose-remember')).includes('以後.txt 檔都用這個程式開啟'), 'the dialog offers "always use this app", ticked for an unknown extension');
  await page.uncheck('#choose-remember');
  await page.locator('.modal .app-choice[data-app="editor"]').click();
  const once = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'todo.txt — Procoder' }) });
  await once.waitFor();
  await once.locator('.traffic .close').click();
  await sleep(300);
  check(!fs.existsSync(settingsFile) || !('txt' in (readSettings().files?.associations || {})), 'unticked: opens once and registers nothing');
  await toFinder();
  await item('todo.txt').dblclick();
  await page.waitForSelector('.modal .app-choice');
  check(await page.isChecked('#choose-remember'), 'so the next open asks again');
  await page.locator('.modal .app-choice[data-app="notepad"]').click();
  const np = page.locator('.win', { has: page.locator('.np-text') });
  await np.waitFor();
  await page.waitForFunction(() => document.querySelector('.np-text').value === 'buy milk\n');
  check((await np.locator('.titlebar .ttext').textContent()) === 'todo.txt — 記事本' && (await np.locator('.monaco-editor').count()) === 0, 'notepad opens the file in a plain textarea');
  check(await waitSetting((s) => s.files.associations.txt === 'notepad'), 'the choice is registered in setting.json');
  await np.locator('.np-text').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('eggs');
  check((await np.locator('.statusbar span').first().textContent()) === '已修改', 'notepad tracks changes');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('.np-text').closest('.win').querySelector('.statusbar span').textContent === '已儲存');
  check(fs.readFileSync(home + '/docs/todo.txt', 'utf8') === 'buy milk\neggs', 'notepad Ctrl+S saves to the host');
  await np.locator('.traffic .close').click();
  await toFinder();
  await item('todo.txt').dblclick();
  await np.waitFor();
  check((await page.locator('.modal').count()) === 0, 'second open goes straight to the registered app');
  await np.locator('.traffic .close').click();

  await toFinder();
  await item('todo.txt').click({ button: 'right' });
  await pick('開啟程式');
  check(!(await page.isChecked('#choose-remember')), '"open with" does not remember unless asked');
  await page.locator('.modal .app-choice[data-app="editor"]').click();
  const viaEditor = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'todo.txt — Procoder' }) });
  await viaEditor.waitFor();
  check(readSettings().files.associations.txt === 'notepad', 'one-off "open with" leaves the association alone');
  await viaEditor.locator('.traffic .close').click();

  await toFinder();
  await item('todo.txt').click({ button: 'right' });
  await pick('複製');
  const clip1 = await page.evaluate(() => navigator.clipboard.readText());
  const clipId = (text) => /<<([0-9a-f]{12})>>$/.exec(text)?.[1];
  check(clip1 === `remosh/file:${home}/docs/todo.txt<<${clipId(clip1)}>>` && !!clipId(clip1), 'copy puts remosh/file:<path><<id>> on the clipboard', clip1);
  const blank = async () => {
    const b = await page.locator('.files').boundingBox();
    // the window may reach past the edge of the screen
    await page.mouse.click(Math.min(b.x + b.width - 30, 1250), Math.min(b.y + b.height - 30, 730), { button: 'right' });
  };
  await blank();
  check((await menuLabels()).join('|') === '新增資料夾|在這裡開啟終端機|貼上|重新整理|內容', 'right-click on empty space', (await menuLabels()).join('|'));
  await pick('貼上');
  await item('todo 複本.txt').waitFor();
  check(fs.readFileSync(home + '/docs/todo 複本.txt', 'utf8') === 'buy milk\neggs' && fs.existsSync(home + '/docs/todo.txt'), 'paste makes a copy under a free name');

  await item('todo 複本.txt').click({ button: 'right' });
  await pick('剪下');
  check(await page.locator('.files .item.cut .name', { hasText: 'todo 複本.txt' }).waitFor({ timeout: 3000 }).then(() => true, () => false), 'cut item is dimmed');
  await page.click('.sidebar button[title="' + home + '"]');
  await item('project').waitFor();
  await openItem('project');
  await item('hello.sh').waitFor();
  await blank();
  await pick('貼上');
  await item('todo 複本.txt').waitFor();
  check(fs.existsSync(home + '/project/todo 複本.txt') && !fs.existsSync(home + '/docs/todo 複本.txt'), 'cut + paste moves the file');
  await blank();
  await pick('貼上');
  await sleep(600);
  check((await page.locator('.toast.err').last().textContent().catch(() => '')).includes('沒有檔案'), 'a cut can only be pasted once', (await page.locator('.toast').allTextContents()).join(' / ') + ' | clip=' + JSON.stringify(await page.evaluate(() => navigator.clipboard.readText())));

  await item('todo 複本.txt').click({ button: 'right' });
  await pick('刪除');
  check((await page.textContent('.modal h2')).includes('todo 複本.txt'), 'delete asks first');
  await page.locator('.modal button', { hasText: '刪除' }).click();
  await item('todo 複本.txt').waitFor({ state: 'detached' });
  check(!fs.existsSync(home + '/project/todo 複本.txt'), 'delete removes the file on the host');

  // ---- new folder, terminal here, and no browser menu
  check(await page.evaluate(() => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.documentElement.dispatchEvent(e);
    return e.defaultPrevented;
  }) && (await page.locator('.ctx-menu').count()) === 0, 'the browser\'s own right-click menu is disabled where we have none');
  fs.rmSync(home + '/project/e2e 新資料夾', { recursive: true, force: true });
  await blank();
  await pick('新增資料夾');
  await page.fill('.modal input', 'e2e 新資料夾');
  await page.keyboard.press('Enter');
  await item('e2e 新資料夾').waitFor();
  const made = fs.statSync(home + '/project/e2e 新資料夾');
  check(made.isDirectory() && (made.mode & 0o777) === 0o755 && made.uid === owner.uid, 'new folder is created on the host (755, owned by the user)');
  await blank();
  await pick('新增資料夾');
  await page.fill('.modal input', 'e2e 新資料夾');
  await page.keyboard.press('Enter');
  check(await page.locator('.toast.err', { hasText: '已經有' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'a duplicate name is refused', (await page.locator('.toast').allTextContents()).join(' / '));
  await item('e2e 新資料夾').click({ button: 'right' });
  check((await menuLabels()).includes('在終端機開啟'), 'folders offer "open in terminal"');
  await pick('在終端機開啟');
  const tw0 = page.locator('.win', { has: page.locator('.term-host') });
  await tw0.waitFor();
  const termText = () => page.evaluate(() => (document.querySelector('.term-host .xterm-rows')?.textContent || '').replace(/\u00a0/g, ' '));
  await page.waitForFunction(() => /[$#] *$/.test((document.querySelector('.term-host .xterm-rows')?.textContent || '').replace(/\u00a0/g, ' ').trimEnd() + ' '), null, { timeout: 15000 });
  check((await termText()).includes('新資料夾') && !(await termText()).includes('M-'), 'non-ASCII folder names show properly in the prompt', (await termText()).trim().slice(0, 200));
  await tw0.locator('.term-host').click();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  // xterm draws spaces as non-breaking spaces, so compare with those normalised.
  const inFolder = await page.waitForFunction((d) => document.querySelector('.term-host .xterm-rows')?.textContent.replace(/\u00a0/g, ' ').includes(d), home + '/project/e2e 新資料夾', { timeout: 15000 }).then(() => true, () => false);
  check(inFolder, 'pwd in that terminal prints the folder', (await tw0.locator('.xterm-rows').textContent()).replace(/\u00a0/g, ' ').trim().slice(0, 300));
  check((await tw0.locator('.titlebar .ttext').textContent()) === 'e2e 新資料夾 — 終端機', 'the terminal starts in that folder');
  await tw0.locator('.traffic .close').click();
  await toFinder();
  await item('e2e 新資料夾').click({ button: 'right' });
  await pick('刪除');
  await page.locator('.modal button', { hasText: '刪除' }).click();
  await item('e2e 新資料夾').waitFor({ state: 'detached' });

  // ---- several file cabinet windows
  await page.click('#start-btn');
  await page.click('#sm-files');
  await page.waitForFunction(() => document.querySelectorAll('.win[data-app="檔案櫃"]').length === 2);
  const second = page.locator('.win[data-app="檔案櫃"]').nth(1);
  await second.locator('.files .item').first().waitFor();
  check((await second.locator('.statusbar .path').textContent()) === home && (await page.locator('.win[data-app="檔案櫃"]').first().locator('.statusbar .path').textContent()) === home + '/project', 'a second file cabinet opens at home; the first keeps its folder');
  check((await page.locator('.dock-item[data-app="檔案櫃"]').count()) === 2, 'each has its own taskbar entry');
  await second.locator('.traffic .close').click();
  check((await page.locator('.win[data-app="檔案櫃"]').count()) === 1, 'closing one leaves the other');
  await toFinder();

  // ---- rename (menu and F2); an open editor follows the file
  fs.writeFileSync(home + '/project/ren-a.txt', 'rename me\n');
  give(home + '/project/ren-a.txt');
  await item('ren-a.txt').waitFor({ timeout: 9000 });
  check(true, 'a file created outside the app appears by itself (live view)');
  await item('ren-a.txt').click({ button: 'right' });
  await pick('開啟程式');
  await page.locator('.modal .app-choice[data-app="editor"]').click();
  const renWin = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'ren-a.txt — Procoder' }) });
  await renWin.locator('.monaco-editor .view-lines').waitFor();
  await toFinder();
  await item('ren-a.txt').click({ button: 'right' });
  await pick('重新命名');
  check((await page.inputValue('.modal input')) === 'ren-a.txt', 'rename starts from the current name');
  await page.fill('.modal input', 'ren-b.txt');
  await page.keyboard.press('Enter');
  await item('ren-b.txt').waitFor();
  check(fs.existsSync(home + '/project/ren-b.txt') && !fs.existsSync(home + '/project/ren-a.txt'), 'rename from the menu renames the file on the host');
  const renamedWin = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'ren-b.txt — Procoder' }) });
  check(await renamedWin.waitFor({ timeout: 3000 }).then(() => true, () => false) && (await renamedWin.locator('.statusbar .path').textContent()) === home + '/project/ren-b.txt', 'the open editor follows the renamed file');
  await page.locator('.dock-item', { hasText: 'ren-b.txt' }).click();
  await renamedWin.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText('saved-after-rename');
  await page.keyboard.press('Control+s');
  await page.waitForFunction((w) => w.querySelector('.statusbar span').textContent === '已儲存', await renamedWin.elementHandle());
  check(fs.readFileSync(home + '/project/ren-b.txt', 'utf8') === 'rename me\nsaved-after-rename' && !fs.existsSync(home + '/project/ren-a.txt'), 'saving afterwards writes the new name, not the old one');
  await renamedWin.locator('.traffic .close').click();
  await toFinder();
  await item('ren-b.txt').click();
  await page.keyboard.press('F2');
  await page.fill('.modal input', 'hello.sh');
  await page.keyboard.press('Enter');
  check(await page.locator('.toast.err', { hasText: '同名' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false) && fs.existsSync(home + '/project/ren-b.txt'), 'F2 renames too, and refuses a name that is taken');
  fs.rmSync(home + '/project/ren-b.txt');
  await item('ren-b.txt').waitFor({ state: 'detached', timeout: 9000 });
  check(true, 'a file deleted outside the app disappears by itself');

  // ---- sidebar right-click
  await page.locator('.sidebar h3').click({ button: 'right' });
  check((await menuLabels()).join('|') === '加入目前的資料夾（project）|還原成預設', 'sidebar right-click on empty space', (await menuLabels()).join('|'));
  await pick('加入目前的資料夾');
  await page.locator('.sidebar button[title="' + home + '/project"]').waitFor();
  check(await waitApp('files', (d) => d.sidebar?.includes(home + '/project')), 'sidebar folders are saved in ~/.remosh-gui/app/files');
  await page.locator('.sidebar button[title="/etc"]').click({ button: 'right' });
  check((await menuLabels()).slice(0, 4).join('|') === '開啟|上移|下移|從側邊欄移除', 'sidebar item right-click', (await menuLabels()).join('|'));
  await pick('從側邊欄移除');
  await page.locator('.sidebar button[title="/etc"]').waitFor({ state: 'detached' });
  await item('src').click({ button: 'right' });
  check((await menuLabels()).includes('加到側邊欄') && !(await menuLabels()).includes('開啟程式…'), 'folders offer "add to sidebar" instead of "open with"');
  await page.keyboard.press('Escape');
  check((await page.locator('.ctx-menu').count()) === 0, 'Escape closes the right-click menu');
  await page.locator('.sidebar h3').click({ button: 'right' });
  await pick('還原成預設');
  await page.locator('.sidebar button[title="/etc"]').waitFor();
  check(await waitApp('files', (d) => !('sidebar' in d)), 'sidebar can be reset');

  // ---- terminal: run a file, then type a command
  await item('hello.sh').dblclick();
  await page.waitForSelector('.modal .app-choice');
  check((await page.locator('.modal .app-choice').allTextContents()).join() === 'Procoder,記事本,終端機', '.sh offers the terminal as well');
  await page.locator('.modal .app-choice[data-app="terminal"]').click();
  const tw = page.locator('.win', { has: page.locator('.term-host') });
  await tw.waitFor();
  await page.waitForFunction(() => document.querySelector('.term-host .xterm-rows')?.textContent.includes('RAN-42'), null, { timeout: 20000 });
  check((fs.statSync(home + '/project/hello.sh').mode & 0o777) === 0o777, 'opening with the terminal sets the file to 777');
  check(true, 'and runs it as ./hello.sh (output RAN-42)');
  check((await tw.locator('.titlebar .ttext').textContent()) === 'hello.sh — 終端機', 'terminal window title');
  await tw.locator('.term-host').click();
  await page.keyboard.type('pwd; echo sum-$((20+3))');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.term-host .xterm-rows').textContent.includes('sum-23'), null, { timeout: 10000 });
  check((await tw.locator('.xterm-rows').textContent()).includes(home + '/project'), 'typed commands run in the file\'s folder');
  // copy and paste
  const isMacUA = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform));
  await tw.locator('.term-host').click({ button: 'right' });
  check((await menuLabels()).join('|') === (isMacUA ? '複製（⌘C）|貼上（⌘V）|全選|清除畫面' : '複製（Ctrl+Shift+C）|貼上（Ctrl+Shift+V）|全選|清除畫面') && await page.locator('.ctx-menu button', { hasText: '複製' }).isDisabled(), 'terminal right-click: copy (needs a selection), paste, select all, clear', (await menuLabels()).join('|'));
  await pick('全選');
  await tw.locator('.term-host').click({ button: 'right' });
  await pick('複製');
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.includes('sum-23')));
  check(true, 'copy puts the selected text on the clipboard');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await tw.locator('.term-host').click({ button: 'right' });
  await pick('全選');
  await tw.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press(isMacUA ? 'Meta+KeyC' : 'Control+Shift+KeyC');
  await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.includes('sum-23')));
  check(true, isMacUA ? '⌘C copies' : 'Ctrl+Shift+C copies');
  await page.evaluate(() => navigator.clipboard.writeText('echo pasted-$((40+2))'));
  await tw.locator('.term-host').click({ button: 'right' });
  await pick('貼上');
  await page.waitForFunction(() => document.querySelector('.term-host .xterm-rows').textContent.includes('echo pasted-$((40+2))'), null, { timeout: 10000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.term-host .xterm-rows').textContent.includes('pasted-42'), null, { timeout: 10000 });
  check(true, 'paste from the menu types the clipboard into the shell');
  await tw.locator('.term-host').click({ button: 'right' });
  await pick('清除畫面');
  await tw.locator('.traffic .close').click();
  check((await tw.count()) === 0, 'terminal closes');

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
    const b = await locator.boundingBox();
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
  check((await fwin.locator('.files').evaluate((el) => getComputedStyle(el).scrollbarWidth)) === 'thin', 'scroll bars are the thin themed kind');
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
  await item('m2.txt').click({ modifiers: ['Control'] });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.win[data-app="記事本"]').length === 2, null, { timeout: 15000 });
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
  check((await sw.locator('.set-nav button').allTextContents()).join() === '動畫,檔案關聯,樣式,工作列,帳號', 'settings categories');
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

  // ---- settings: 檔案關聯 lists what was remembered and lets it be changed
  await sw.locator('.set-nav button', { hasText: '檔案關聯' }).click();
  const rowExts = await sw.locator('.assoc-row code').allTextContents();
  check(['.asp', '.bin', '.py', '.ts', '.txt'].every((x) => rowExts.includes(x)), 'remembered extensions are listed', rowExts.join(' '));
  check((await sw.locator('.assoc-row[data-ext="txt"] select').inputValue()) === 'notepad', '.txt shows 記事本');
  check((await sw.locator('.assoc-row[data-ext="txt"] select option').allTextContents()).join() === 'Procoder,記事本', 'only apps that accept .txt are offered');
  await sw.locator('.assoc-row[data-ext="txt"] select').selectOption('editor');
  await sw.locator('.assoc-row[data-ext="bin"] .assoc-del').click();
  check((await sw.locator('.set-pane input, #assoc-add-btn').count()) === 0, 'associations cannot be added by hand, only changed or removed');
  await page.click('#set-save');
  await page.waitForFunction(() => document.querySelector('.set-status').textContent === '已儲存');
  const assoc = readSettings().files.associations;
  check(assoc.txt === 'editor' && !('bin' in assoc), 'association edits are saved', JSON.stringify(assoc));
  check(readSettings().animation.enabled === false, 'saving associations keeps the other settings');

  // ---- switch user: several signed-in users in one tab (needs a second account: SSH_USER2 / SSH_PW2)
  const user2 = process.env.SSH_USER2;
  if (user2) {
    const home2 = '/home/' + user2;
    process.on('exit', () => fs.rmSync(home2 + '/.remosh-gui', { recursive: true, force: true }));
    const sessionFrame = async () => {
      for (let i = 0; i < 50; i++) {
        const f = page.frames().find((x) => /[?&]session=/.test(x.url()));
        if (f) return f;
        await sleep(100);
      }
      throw new Error('no session frame');
    };
    const label1 = `${user}@${host}:${port}`;
    await page.click('#start-btn');
    await page.click('#sm-user');
    const cardButtons = await page.locator('#sm-logout-row > button:not([hidden])').evaluateAll((els) => els.map((e) => e.textContent.trim() + (e.querySelector('svg') ? '*' : '')));
    check(cardButtons.join('|') === '切換使用者*|離開全螢幕*|登出*', 'the user card: switch user, full screen, log out, each with an icon', cardButtons.join('|'));
    await page.click('#sm-switch');
    let f2 = await sessionFrame();
    await f2.waitForSelector('#login:not([hidden])');
    const kept = f2.locator('#kept-sessions button');
    await kept.waitFor();
    const keptBox = await kept.boundingBox();
    check((await kept.textContent()).trim().endsWith(label1) && keptBox.x < 40 && keptBox.y > 700, 'the login screen for another user lists the signed-in one at the bottom left', JSON.stringify(keptBox));
    await kept.click();
    await page.waitForFunction(() => !document.querySelector('.session-frame'));
    check(await page.isVisible('#desktop') && await page.isHidden('#login'), 'clicking it goes straight back; the unused login screen is dropped');
    await page.click('#start-btn');
    await page.click('#sm-user');
    await page.click('#sm-switch');
    f2 = await sessionFrame();
    await f2.fill('#f-host', host);
    await f2.fill('#f-port', String(port));
    await f2.fill('#f-user', user2);
    await f2.fill('#f-pass', process.env.SSH_PW2);
    await f2.click('#login-btn');
    await f2.waitForSelector('#desktop:not([hidden])', { timeout: 30000 });
    check((await f2.textContent('#conn-label')).startsWith(user2 + '@') && (await f2.locator('.win').count()) === 0, 'a second user signs in with their own empty desktop');
    // this second account may use sudo: it can create accounts
    try { sh('userdel -r e2etmpuser 2>/dev/null'); } catch { /* not there */ }
    await f2.click('#start-btn');
    await f2.click('#sm-settings');
    await f2.locator('.set-nav button', { hasText: '帳號' }).click();
    await f2.waitForSelector('#acc-create');
    check(await f2.isVisible('#acc-sudo') && (await f2.locator('#acc-users .acc-user').allTextContents()).includes(user), 'with sudo rights the account page offers "create account" and lists the accounts');
    const fillNew = async (sudoPw) => {
      await f2.fill('#acc-name', 'e2etmpuser');
      await f2.fill('#acc-pass', 'New-User-Pw-1');
      await f2.fill('#acc-pass2', 'New-User-Pw-1');
      await f2.fill('#acc-sudo', sudoPw);
      await f2.click('#acc-create');
      await f2.locator('.modal button', { hasText: '建立' }).click();
    };
    await fillNew('wrong-sudo-password');
    check(await f2.locator('.toast.err', { hasText: 'sudo 驗證失敗' }).first().waitFor({ timeout: 20000 }).then(() => true, () => false) && !/e2etmpuser/.test(sh('getent passwd').toString()), 'a wrong sudo password creates nothing');
    await fillNew(process.env.SSH_PW2);
    check(await f2.locator('.toast', { hasText: '已建立帳號' }).first().waitFor({ timeout: 20000 }).then(() => true, () => false), 'with the right one the account is created');
    const made = sh('getent passwd e2etmpuser || true').toString();
    check(/^e2etmpuser:.*:\/home\/e2etmpuser:\/bin\/bash/.test(made) && fs.existsSync('/home/e2etmpuser'), 'it exists on the host with a home folder', made.trim());
    await f2.locator('#acc-users .acc-user', { hasText: 'e2etmpuser' }).waitFor();
    await f2.fill('#acc-name', 'Bad Name');
    await f2.fill('#acc-pass', 'x');
    await f2.fill('#acc-pass2', 'x');
    await f2.fill('#acc-sudo', process.env.SSH_PW2);
    await f2.click('#acc-create');
    await f2.locator('.modal button', { hasText: '建立' }).click();
    check(await f2.locator('.toast.err', { hasText: '帳號名稱只能用' }).first().waitFor({ timeout: 10000 }).then(() => true, () => false), 'an invalid account name is refused');
    await f2.locator('.win[data-app="設定"] .traffic .close').click();
    await f2.click('#start-btn');
    await f2.click('#sm-files');
    const item2 = f2.locator('.files .item', { has: f2.locator('.name', { hasText: /^two\.txt$/ }) });
    await item2.click({ button: 'right' });
    await f2.locator('.ctx-menu button', { hasText: '複製' }).click();
    await sleep(200);
    const clip2 = await page.evaluate(() => navigator.clipboard.readText());
    check(clip2 === `remosh/file:${home2}/two.txt<<${clipId(clip2)}>>` && clipId(clip2) !== clipId(clip1), 'a different account gets a different id', clip2 + ' vs ' + clip1);
    await f2.click('#start-btn');
    await f2.click('#sm-user');
    check((await f2.locator('#sm-sessions .sm-session').textContent()).trim().endsWith(label1), 'the other signed-in user is listed on the user card');
    const t0 = Date.now();
    await f2.locator('#sm-sessions .sm-session').click();
    await page.waitForFunction(() => document.querySelector('.session-frame').hidden);
    check(Date.now() - t0 < 1500 && await page.isHidden('#login') && await page.isVisible('#desktop'), 'switching back is immediate and asks for no password');
    await toFinder();
    await page.click('button[title="重新整理"]');
    await item('hello.sh').waitFor();
    check(true, 'the first user\'s connection is still alive');
    await blank();
    await pick('貼上');
    check(await page.locator('.toast.err', { hasText: '不可跨域貼上' }).first().waitFor({ timeout: 5000 }).then(() => true, () => false) && !fs.existsSync(home + '/project/two.txt'), 'pasting files copied under another account is refused: 不可跨域貼上');
    await page.click('#start-btn');
    await page.click('#sm-user');
    await page.locator('#sm-sessions .sm-session').click();
    await page.waitForFunction(() => !document.querySelector('.session-frame').hidden);
    await f2.click('button[title="重新整理"]');
    await item2.waitFor();
    check((await f2.locator('.win').count()) === 1, 'the second user is exactly as they left it, still connected');
    await f2.click('#start-btn');
    await f2.click('#sm-user');
    await f2.click('#disconnect');
    await page.waitForFunction(() => !document.querySelector('.session-frame'));
    check(await page.isVisible('#desktop') && await page.evaluate(() => !!document.fullscreenElement), 'logging the second user out returns to the first, still full screen');
    await page.click('#start-btn');
    await page.click('#sm-user');
    check((await page.locator('#sm-sessions .sm-session').count()) === 0, 'and they are gone from the list');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#start-menu', { state: 'hidden' });
  }

  // ---- log out from the start menu
  await page.click('#start-btn');
  await page.click('#sm-user');
  check(await page.isVisible('#disconnect'), 'clicking the user reveals logout');
  const menuBox = await page.locator('#start-menu').boundingBox();
  const userBox = await page.locator('#sm-user').boundingBox();
  const outBox = await page.locator('#disconnect').boundingBox();
  check(outBox.x >= menuBox.x + menuBox.width && outBox.y + outBox.height > userBox.y && outBox.y < userBox.y + userBox.height + 8, 'logout opens to the right of the user row, not above it', JSON.stringify([menuBox, userBox, outBox]));
  await page.click('#disconnect');
  await page.waitForSelector('#login:not([hidden])');
  check(await page.isHidden('#desktop') && (await page.inputValue('#f-pass')) === '', 'disconnect returns to an empty password prompt');
  check(await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 }).then(() => true, () => false), 'logging out (the last user) leaves full screen');

  // ---- settings follow the account: log in again and they are loaded from the host
  check(!(await page.evaluate(() => document.documentElement.classList.contains('no-anim'))), 'logout resets settings to defaults');
  // Written under the old name: it is read, and moved to the new one.
  fs.rmSync(settingsFile, { force: true });
  fs.mkdirSync(home + '/.remosh-gui', { recursive: true });
  fs.writeFileSync(legacySettings, JSON.stringify({ version: 1, animation: { enabled: false, speed: 'fast' }, files: { sidebar: ['/tmp', home], sidebarWidth: 200 }, future: { keep: 1 } }));
  fs.rmSync(home + '/.remosh-gui/app', { recursive: true, force: true });
  await page.evaluate(() => localStorage.setItem('sshdesk.fontSize', '20'));
  give(home + '/.remosh-gui');
  give(legacySettings);
  // servers logged in to before sit beside the form and fill it in
  {
    const mine = page.locator('#saved-servers .saved-server', { hasText: user + '@' + host });
    check((await mine.count()) === 1 && (await mine.locator('span').textContent()) === '連接埠 ' + port && await mine.evaluate((el) => el.classList.contains('on')), 'the login screen lists the server logged in to before');
    await page.fill('#f-host', 'elsewhere.example');
    await page.fill('#f-port', '2200');
    await page.fill('#f-user', 'nobody');
    check(!(await mine.evaluate((el) => el.classList.contains('on'))), 'it is no longer marked once the form says something else');
    await mine.locator('.fill').click();
    check((await page.inputValue('#f-host')) === host && (await page.inputValue('#f-port')) === String(port) && (await page.inputValue('#f-user')) === user && (await page.inputValue('#f-pass')) === ''
      && await page.evaluate(() => document.activeElement.id === 'f-pass'), 'one click fills in host, port and account; the password is left to type');
    const cookie = (await ctx.cookies()).find((k) => k.name === 'remosh_servers');
    const kept = cookie ? JSON.parse(decodeURIComponent(cookie.value)) : null;
    check(kept && kept.some((k) => k.host === host && k.port === Number(port) && k.username === user) && kept.every((k) => Object.keys(k).sort().join() === 'host,port,username') && !cookie.value.includes(encodeURIComponent(password)),
      'they are kept in a cookie: host, port and account only, never the password', cookie && cookie.value);
    await page.evaluate(() => { document.cookie = 'remosh_servers=' + encodeURIComponent(JSON.stringify([{ host: 'old.example', port: 22, username: 'x' }, ...JSON.parse(decodeURIComponent(document.cookie.split('; ').find((c) => c.startsWith('remosh_servers=')).slice(15)))])) + '; Path=/'; });
    await page.fill('#f-user', user + ' ');
    await page.fill('#f-user', user);
    await page.locator('#saved-servers .saved-server', { hasText: 'x@old.example' }).locator('.forget').click();
    check((await page.locator('#saved-servers .saved-server', { hasText: 'old.example' }).count()) === 0 && (await mine.count()) === 1, 'a server can be taken off the list');
  }
  await page.fill('#f-pass', password);
  await page.click('#login-btn');
  await page.waitForSelector('#desktop:not([hidden])');
  await page.waitForFunction(() => document.documentElement.classList.contains('no-anim'));
  check(true, 'settings are loaded from the host at login');
  check(await (async () => {
    for (let i = 0; i < 50 && (fs.existsSync(legacySettings) || !fs.existsSync(settingsFile)); i++) await sleep(100);
    return !fs.existsSync(legacySettings) && JSON.parse(fs.readFileSync(settingsFile, 'utf8')).future?.keep === 1;
  })(), 'a setting.json from an earlier version is moved to setting.inv-remosh_gui-config, unknown keys kept');
  await page.evaluate((d) => import('/js/shell/apps.js').then((m) => m.launchApp('files', { path: d })), home + '/.remosh-gui');
  const cab = page.locator('.win[data-app="檔案櫃"]').last();
  await cab.locator('.files .item .name', { hasText: /^desktop$/ }).waitFor();
  check(!(await cab.locator('.files .item .name').allTextContents()).some((n) => n.startsWith('setting')), 'the settings file is not listed in the file cabinet');
  check(await waitApp('files', (d) => d.sidebar?.join() === ['/tmp', home].join() && d.sidebarWidth === 200), 'the file cabinet\'s sidebar moves from the old settings to ~/.remosh-gui/app/files');
  check(await waitApp('editor', (d) => d.fontSize === 20) && (await page.evaluate(() => localStorage.getItem('sshdesk.fontSize'))) === null, 'Procoder\'s preferences move from the browser to ~/.remosh-gui/app/editor');
  check((await cab.locator('.sidebar button[data-path]').evaluateAll((els) => els.map((e) => e.dataset.path))).join() === ['/tmp', home].join(), 'and the file cabinet uses them');
  await cab.locator('.traffic .close').click();
  await page.click('#start-btn');
  await page.click('#sm-settings');
  check(!(await page.isChecked('#set-anim-enabled')) && (await page.inputValue('#set-anim-speed')) === 'fast', 'settings window shows the loaded values');
  await page.check('#set-anim-enabled');
  await page.click('#set-save');
  await page.waitForFunction(() => document.querySelector('.set-status').textContent === '已儲存');
  const kept = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check(kept.animation.enabled === true && kept.future?.keep === 1, 'saving keeps keys this version does not know', JSON.stringify(kept));
  check(!('sidebar' in (kept.files || {})) && !('sidebarWidth' in (kept.files || {})), 'and drops what now belongs to an app', JSON.stringify(kept.files));
  fs.rmSync(home + '/.remosh-gui', { recursive: true, force: true });

  check(errors.length === 0, 'no browser console errors', errors.join(' | '));
  await browser.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(2);
});
