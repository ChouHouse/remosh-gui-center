// e2e area "files": right-click menus. Run alone with --only=files (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  // Procoder's first-run question (light or dark) is answered in the editor
  // area, and the file cabinet is back at the home folder.
  async alone({ page, item }) {
    await page.click('button[title="上層資料夾"]');
    await item('src').waitFor();
    await page.click('button[title="上層資料夾"]');
    await item('docs').waitFor();
    await page.click('#start-btn');
    await page.click('#sm-editor');
    await page.locator('.modal button', { hasText: '亮色' }).click();
    await page.locator('.win[data-app="Procoder"] .traffic .close').click();
    await page.waitForFunction(() => !document.querySelector('.win[data-app="Procoder"]'));
  },
  async run(shared) {
    const { check, fs, give, home, item, menuLabels, openItem, owner, page, pick, readSettings, settingsFile, sleep, waitApp, waitSetting } = shared;
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
    const allApps = '檔案櫃,Procoder,記事本,Graphoto,Mounds,SQLite 檢視器,Filex,終端機,tmux 終端管理器,工作管理員,設定';
    check((await page.locator('#sm-apps button').allTextContents()).join() === allApps, 'every app is pinned to start by default');
    await page.click('#sm-all-btn');
    check(await page.isVisible('#sm-all') && await page.isHidden('#sm-home') && (await page.locator('#sm-all-list button').allTextContents()).join() === allApps, '"all apps" lists every app, the code editor included');
    await page.locator('#sma-tasks').click({ button: 'right' });
    check((await menuLabels()).join('|') === '開啟|從開始取消釘選', 'right-click on an app offers to unpin it');
    await pick('從開始取消釘選');
    check(await waitSetting((st) => st.start?.pinned && !st.start.pinned.includes('tasks') && st.start.pinned.length === 10), 'unpinning is saved');
    check(await page.isVisible('#start-menu'), 'the start menu stays open while pinning');
    await page.click('#sm-back');
    check((await page.locator('#sm-apps button').allTextContents()).join() === '檔案櫃,Procoder,記事本,Graphoto,Mounds,SQLite 檢視器,Filex,終端機,tmux 終端管理器,設定', 'the unpinned app leaves the pinned list');
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
    check((await menuLabels()).join('|') === '開啟|用 Procoder 開啟|用 記事本 開啟|複製|剪下|貼上|重新命名|刪除|內容', 'file right-click menu: one "open with" entry for each app that takes the file', (await menuLabels()).join('|'));
    check(await page.evaluate(() => {
      const kids = [...document.querySelector('.ctx-menu').children];
      const withs = kids.filter((k) => k.textContent.startsWith('用 '));
      return kids[kids.indexOf(withs[0]) - 1].classList.contains('menu-sep') && kids[kids.indexOf(withs[withs.length - 1]) + 1].classList.contains('menu-sep');
    }), 'the "open with" entries form a group of their own, between separators');
    await pick('內容');
    const props = await page.locator('.modal dl.props').textContent();
    check(props.includes('todo.txt') && props.includes('rw-r--r--（644）') && props.includes('9 位元組') && props.includes(home + '/docs'), 'properties show name, location, size and permissions', props);
    await page.locator('.modal button', { hasText: '關閉' }).click();

    await item('todo.txt').dblclick();
    await page.waitForSelector('.modal .app-choice');
    check((await page.locator('.modal .app-choice').allTextContents()).join() === 'Procoder,記事本', 'unknown extension asks, offering only apps that accept .txt');
    check((await page.locator('#choose-remember').count()) === 0, 'the choice is kept quietly: the dialog has no "always" box');
    await page.locator('.modal .app-choice[data-app="editor"]').click();
    const once = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'todo.txt — Procoder' }) });
    await once.waitFor();
    await once.locator('.traffic .close').click();
    await sleep(300);
    await toFinder();
    check(await waitSetting((d) => d.system?.openWith?.txt === 'editor'), 'the app chosen for .txt is kept in the settings file, with no page for it');
    await sleep(200);
    await item('todo.txt').dblclick();
    await once.waitFor();
    check((await page.locator('.modal .app-choice').count()) === 0, 'the next double-click opens with the same app, without asking');
    await once.locator('.traffic .close').click();
    await sleep(300);
    await toFinder();
    await item('todo.txt').click({ button: 'right' });
    await pick('用 記事本 開啟');
    check(await waitSetting((d) => d.system?.openWith?.txt === 'notepad'), 'opening with another app from the right-click menu becomes the new habit');
    await sleep(200);
    const np = page.locator('.win', { has: page.locator('.np-text') });
    await np.waitFor();
    await page.waitForFunction(() => document.querySelector('.np-text').value === 'buy milk\n');
    check((await np.locator('.titlebar .ttext').textContent()) === 'todo.txt — 記事本' && (await np.locator('.monaco-editor').count()) === 0, 'notepad opens the file in a plain textarea');
    await np.locator('.np-text').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('eggs');
    check((await np.locator('.statusbar span').first().textContent()) === '已修改', 'notepad tracks changes');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('.np-text').closest('.win').querySelector('.statusbar span').textContent === '已儲存');
    check(fs.readFileSync(home + '/docs/todo.txt', 'utf8') === 'buy milk\neggs', 'notepad Ctrl+S saves to the host');
    await np.locator('.traffic .close').click();
    await toFinder();
    await item('todo.txt').click({ button: 'right' });
    await pick('用 Procoder 開啟');
    const viaEditor = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'todo.txt — Procoder' }) });
    await viaEditor.waitFor();
    check((await page.locator('.modal').count()) === 0 && (!fs.existsSync(settingsFile) || !('files' in readSettings())), '"open with Procoder" on the right-click menu opens it at once; no association is kept');
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
    check((await menuLabels()).slice(0, 4).join('|') === '開啟|加到側邊欄|用 Procoder 開啟|用 終端機 開啟', 'folders offer the apps that registered for folders: Procoder and the terminal', (await menuLabels()).join('|'));
    await pick('用 終端機 開啟');
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
    await pick('用 Procoder 開啟');
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
    Object.assign(shared, { blank, clip1, clipId, toFinder });
  },
};
