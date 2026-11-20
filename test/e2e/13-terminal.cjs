// e2e area "terminal": terminal. Run alone with --only=terminal (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  // The file cabinet shows ~/project (setup leaves it in project/src).
  async alone({ page, item }) {
    await page.click('button[title="上層資料夾"]');
    await item('hello.sh').waitFor();
  },
  async run(shared) {
    const { check, fs, home, item, menuLabels, page, pick } = shared;
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
  },
};
