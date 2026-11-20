// e2e area "setup": log in. Run alone with --only=setup (see test/e2e.cjs).
module.exports = {
  needs: [],
  async run(shared) {
    const { P_BASE, base, check, chromium, fs, home, host, password, port, sleep, user } = shared;
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
    const ctx = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    // The browser logs the 401 of a deliberately wrong access password; that one is expected.
    // (the stream addresses the test asks for on purpose, to see them refused, do not count)
    page.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && !(/status of 404/.test(m.text()) && /\/api\/stream\//.test(m.location().url)) && errors.push('console: ' + m.text()));

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
    check(manifest.display === 'standalone' && manifest.name === 'Remogui' && manifest.icons.length === 2 && icon.ok && icon.headers.get('content-type') === 'image/png', 'the site can be installed as an app (manifest and icons are served)');
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
    Object.assign(shared, { browser, ctx, errors, give, item, legacySettings, menuLabels, openItem, owner, page, pick, readSettings, settingsFile, sh, waitApp, waitSetting, webPassword });
  },
};
