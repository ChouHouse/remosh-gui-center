// e2e area "taskman": start menu. Run alone with --only=taskman (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  async run(shared) {
    const { check, execSyncTop, fs, home, page, sleep, user } = shared;
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
  },
};
