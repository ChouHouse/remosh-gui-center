// e2e area "tmux": apps can require things on the host; the tmux manager needs tmux. Run alone with --only=tmux (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  async run(shared) {
    const { check, page, sleep, user } = shared;
    // ---- apps can require things on the host; the tmux manager needs tmux
    {
      const tmuxCmd = (args) => require('child_process').execSync(`su ${user} -s /bin/sh -c ${JSON.stringify('tmux ' + args)} 2>/dev/null || true`).toString();
      tmuxCmd('kill-server');
      // an app that needs something the host does not have
      await page.evaluate(async () => {
        const m = await import('/js/shell/apps.js');
        m.registerApp({ id: 'needsfoo', name: 'NeedsFoo', icon: () => '', startMenu: true, requires: [{ command: 'no-such-tool-xyz', install: 'sudo apt install no-such-tool-xyz' }], launch: () => { window.__needsLaunched = true; } });
        await m.checkRequirements();
      });
      await page.click('#start-btn');
      await page.locator('#sm-all-btn').click();
      const needs = page.locator('#sma-needsfoo');
      check((await needs.getAttribute('class')) === 'needs' && (await needs.getAttribute('title')) === '需要主機上有：no-such-tool-xyz' && (await page.locator('#sma-tmux').getAttribute('class')) !== 'needs',
        'an app whose requirement the host lacks is dimmed in the start menu and says what it needs; tmux is there, so its app is not');
      await needs.click();
      await page.waitForSelector('.modal');
      const msg = (await page.textContent('.modal .box p')).replace(/\s+/g, ' ');
      check(msg.includes('no-such-tool-xyz') && msg.includes('sudo apt install no-such-tool-xyz') && !(await page.evaluate(() => !!window.__needsLaunched)), 'opening it explains what is missing and how to get it, instead of opening', msg);
      await page.locator('.modal button', { hasText: '知道了' }).click();
      // the tmux manager
      await page.evaluate(() => import('/js/shell/apps.js').then((m) => { m.launchApp('tmux'); }));
      const tw = page.locator('.win', { has: page.locator('.tx-side') });
      await tw.locator('.tx-empty button').waitFor();
      check(true, 'tmux manager: with no sessions it says so and offers to create one');
      await tw.locator('.tx-new').click();
      check((await page.inputValue('.modal input')) === 'remogui-1', 'a new session gets a free name to start from');
      await page.fill('.modal input', 'work');
      await page.locator('.modal button', { hasText: '確定' }).click();
      await tw.locator('.tx-term .xterm').waitFor({ timeout: 15000 });
      await sleep(1500);
      await page.keyboard.type('echo TMUX-$((6*7))\n');
      await page.waitForFunction(() => /TMUX-42/.test(document.querySelector('.tx-term .xterm-rows')?.textContent || ''), null, { timeout: 15000 });
      check(tmuxCmd('ls -F "#{session_name}"').trim() === 'work', 'it creates the session on the host and attaches to it in a terminal');
      await tw.locator('.tx-ses-row[data-session="work"]').waitFor();
      await tw.locator('.tx-ses-row[data-session="work"]').click({ button: 'right' });
      await page.locator('.ctx-menu button', { hasText: '新增視窗' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.tx-win-row').length === 2, null, { timeout: 10000 });
      check(tmuxCmd('list-windows -t =work -F "#{window_index}"').trim().split('\n').length === 2, 'right-click a session: new window; the list shows the session\'s windows');
      await tw.locator('.tx-win-row[data-window="work:0"]').click();
      await page.waitForFunction(() => document.querySelector('.tx-win-row[data-window="work:0"]')?.classList.contains('active-win'), null, { timeout: 10000 });
      check(tmuxCmd('list-windows -t =work -F "#{window_active}#{window_index}"').split('\n').includes('10'), 'clicking a window switches the attached session to it');
      // closing the manager only detaches
      await tw.locator('.traffic .close').click();
      await sleep(800);
      check(tmuxCmd('ls -F "#{session_name}:#{session_attached}"').trim() === 'work:0', 'closing the window detaches: the session keeps running on the host');
      await page.evaluate(() => import('/js/shell/apps.js').then((m) => { m.launchApp('tmux'); }));
      await tw.locator('.tx-ses-row[data-session="work"]').click();
      await page.waitForFunction(() => /TMUX-42/.test(document.querySelector('.tx-term .xterm-rows')?.textContent || ''), null, { timeout: 15000 });
      check(true, 'opening it again and choosing the session brings back what was there');
      await tw.locator('.tx-ses-row[data-session="work"]').click({ button: 'right' });
      await page.locator('.ctx-menu button', { hasText: '重新命名' }).click();
      await page.fill('.modal input', '專案');
      await page.locator('.modal button', { hasText: '確定' }).click();
      await tw.locator('.tx-ses-row[data-session="專案"]').waitFor({ timeout: 10000 });
      check(tmuxCmd('ls -F "#{session_name}"').trim() === '專案', 'sessions can be renamed (Chinese names too)');
      await tw.locator('.tx-ses-row[data-session="專案"]').click({ button: 'right' });
      await page.locator('.ctx-menu button', { hasText: '結束工作階段' }).click();
      await page.locator('.modal button', { hasText: /^結束$/ }).click();
      await tw.locator('.tx-empty').waitFor({ timeout: 10000 });
      check(tmuxCmd('ls').trim() === '', 'ending a session (after asking) closes it on the host');
      await tw.locator('.traffic .close').click();
      tmuxCmd('kill-server');
    }
  },
};
