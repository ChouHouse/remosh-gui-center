// e2e area "filex": Filex. Run alone with --only=filex (see test/e2e.cjs).
module.exports = {
  needs: ['editor', 'setup'],
  async run(shared) {
    const { check, edWin, fs, home, page, pcTab, pcTabs, treeNames, waitApp } = shared;
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
  },
};
