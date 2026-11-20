// e2e area "editor": open a file in a Monaco window. Run alone with --only=editor (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  async run(shared) {
    const { P_BASE, check, fs, home, openItem, page, shotDir, sleep, waitApp } = shared;
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
    check((await page.locator('.ctx-menu button').allTextContents()).join('|') === '收合|新增檔案|新增資料夾|複製|剪下|貼上|重新命名（F2）|刪除|複製路徑|重新整理', 'a folder in the tree has a right-click menu');
    await page.locator('.ctx-menu button', { hasText: '新增檔案' }).click();
    await page.fill('.modal input', 'made.ts');
    await page.keyboard.press('Enter');
    await pcTab('made.ts').waitFor();
    await page.waitForFunction(() => document.querySelector('.pc-row.current .pc-row-name')?.textContent === 'made.ts');
    check(inProject('src/made.ts') && (await edWin.locator('.titlebar .ttext').textContent()) === 'made.ts — Procoder', 'new file: created inside that folder on the host and opened as a tab');
    // the header's buttons work in the selected folder (or next to the selected file)
    fs.rmSync(home + '/project/src/seldir', { recursive: true, force: true });
    await page.waitForFunction(() => document.querySelector('.pc-row.sel')?.dataset.path.endsWith('/src/made.ts'));
    await edWin.locator('.pc-side-tools button[title="新增資料夾"]').click();
    check((await page.textContent('.modal .box')).includes('「src」'), 'with a file selected, "new folder" in the header works next to that file');
    await page.fill('.modal input', 'seldir');
    await page.keyboard.press('Enter');
    await treeRow('src/seldir').waitFor();
    check(fs.statSync(home + '/project/src/seldir').isDirectory(), 'the folder is created there, not at the top');
    await treeRow('src/seldir').click();
    await edWin.locator('.pc-side-tools button[title="新增資料夾"]').click();
    check((await page.textContent('.modal .box')).includes('「seldir」'), 'with a folder selected, it works inside that folder');
    await page.keyboard.press('Escape');
    await treeCtx('src/seldir', '刪除');
    await page.locator('.modal button', { hasText: '刪除' }).click();
    await treeRow('src/seldir').waitFor({ state: 'detached' });
    {
      const tb = await edWin.locator('.pc-tree').boundingBox();
      await page.mouse.click(tb.x + tb.width / 2, tb.y + tb.height - 8); // the empty part below the rows
    }
    check((await edWin.locator('.pc-row.sel').count()) === 0, 'a click below the rows selects nothing');
    await edWin.locator('.pc-side-tools button[title="新增資料夾"]').click();
    await page.fill('.modal input', 'newdir');
    await page.keyboard.press('Enter');
    await treeRow('newdir').waitFor();
    check(fs.statSync(home + '/project/newdir').isDirectory() && (await treeNames())[0] === 'newdir', 'with nothing selected, new folder is created in the opened folder');
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
    // copy / cut / paste in the tree
    fs.rmSync(home + '/project/src/math 複本.ts', { force: true });
    const treeExact = async (name, label) => {
      await treeRow(name).click({ button: 'right' });
      await page.locator('.ctx-menu button', { hasText: new RegExp('^' + label + '$') }).click();
    };
    await treeExact('src/math.ts', '複製');
    await treeExact('newdir', '貼上');
    await treeRow('newdir/math.ts').waitFor();
    check(inProject('newdir/math.ts') && inProject('src/math.ts') && fs.readFileSync(home + '/project/newdir/math.ts', 'utf8') === fs.readFileSync(home + '/project/src/math.ts', 'utf8'),
      'tree: copy a file, paste it into a folder (which opens to show it)');
    await treeRow('newdir/math.ts').focus();
    await page.keyboard.press('Control+x');
    await page.waitForFunction(() => document.querySelector('.pc-row.cut')?.dataset.path.endsWith('/newdir/math.ts'));
    check(true, 'Ctrl+X on a row cuts it, and the row is dimmed');
    await treeRow('src/math.ts').focus();
    await page.keyboard.press('Control+v');
    await treeRow('src/math 複本.ts').waitFor();
    check(inProject('src/math 複本.ts') && !inProject('newdir/math.ts') && (await edWin.locator('.pc-row[data-path$="/newdir/math.ts"]').count()) === 0,
      'Ctrl+V next to a file moves the cut file there, under a name that is free');
    // drag a row onto a folder
    {
      const from = await treeRow('src/math 複本.ts').boundingBox();
      const to = await treeRow('newdir').boundingBox();
      await page.mouse.move(from.x + 40, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 50, from.y + from.height / 2 + 8, { steps: 3 });
      await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 6 });
      check((await page.textContent('.drag-ghost')).includes('移動') && await treeRow('newdir').evaluate((el) => el.classList.contains('drop-into')), 'tree rows can be dragged; the folder under the pointer lights up');
      await page.mouse.up();
      await treeRow('newdir/math 複本.ts').waitFor();
      check(inProject('newdir/math 複本.ts') && !inProject('src/math 複本.ts') && (await edWin.locator('.pc-row[data-path$="/src/math 複本.ts"]').count()) === 0,
        'dropping it on a folder moves it in, without opening it');
    }
    await treeExact('newdir/math 複本.ts', '刪除');
    await page.locator('.modal button', { hasText: '刪除' }).click();
    await treeRow('newdir/math 複本.ts').waitFor({ state: 'detached' });
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
    Object.assign(shared, { edWin, onDisk, pcTab, pcTabs, treeNames, value });
  },
};
