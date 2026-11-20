// e2e area "accounts": switch user. Run alone with --only=accounts (see test/e2e.cjs).
module.exports = {
  needs: ['setup', 'files'],
  async run(shared) {
    const { blank, check, clip1, clipId, ctx, fs, give, home, host, item, legacySettings, page, password, pick, port, settingsFile, sh, sleep, toFinder, user, waitApp } = shared;
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
    await page.locator('.set-nav button', { hasText: '動畫' }).click();
    check(!(await page.isChecked('#set-anim-enabled')) && (await page.inputValue('#set-anim-speed')) === 'fast', 'settings window shows the loaded values');
    await page.check('#set-anim-enabled');
    await page.click('#set-save');
    await page.waitForFunction(() => document.querySelector('.set-status').textContent === '已儲存');
    const kept = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check(kept.animation.enabled === true && kept.future?.keep === 1, 'saving keeps keys this version does not know', JSON.stringify(kept));
    check(!('sidebar' in (kept.files || {})) && !('sidebarWidth' in (kept.files || {})), 'and drops what now belongs to an app', JSON.stringify(kept.files));
    fs.rmSync(home + '/.remosh-gui', { recursive: true, force: true });
  },
};
