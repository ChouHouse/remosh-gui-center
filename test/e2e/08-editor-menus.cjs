// e2e area "editor-menus": unsaved-changes guard. Run alone with --only=editor-menus (see test/e2e.cjs).
module.exports = {
  needs: ['editor', 'setup'],
  async run(shared) {
    const { check, edWin, fs, home, onDisk, openItem, page, pcTab, pcTabs, sleep, value, waitApp } = shared;
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
  },
};
