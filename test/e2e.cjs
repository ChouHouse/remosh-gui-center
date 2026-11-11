// Browser end-to-end test. Needs a running `wrangler dev` and a reachable SSH
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

(async () => {
  const settingsFile = home + '/.remosh-gui/setting.json';
  // The account's real settings are put back when the test ends, however it ends.
  const realSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
  const owner = fs.statSync(home);
  const give = (path) => fs.chownSync(path, owner.uid, owner.gid);
  const scratch = ['/docs/todo.txt', '/docs/todo 複本.txt', '/project/todo 複本.txt', '/project/hello.sh', '/project/src/copy.py'];
  process.on('exit', () => {
    for (const f of scratch) fs.rmSync(home + f, { force: true });
    fs.rmSync(home + '/.remosh-gui', { recursive: true, force: true });
    if (realSettings) {
      fs.mkdirSync(home + '/.remosh-gui', { mode: 0o700 });
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
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

  await page.goto(base);
  await page.fill('#f-host', host);
  await page.fill('#f-port', String(port));
  await page.fill('#f-user', user);
  await page.fill('#f-pass', 'definitely-wrong');
  await page.click('#login-btn');
  await page.waitForSelector('#login-error:not([hidden])', { timeout: 30000 });
  check((await page.textContent('#login-error')).includes('登入失敗'), 'wrong password shows an error');
  check(await page.isHidden('#desktop'), 'desktop stays hidden after failed login');

  await page.fill('#f-pass', password);
  await page.click('#login-btn');
  await page.waitForSelector('#desktop:not([hidden])', { timeout: 30000 });
  check(await page.isHidden('#login'), 'login overlay closes');
  check((await page.$$('.win')).length === 0 && (await page.$$('.dock-item')).length === 0, 'no app opens by itself after login');
  check((await page.locator('#start-btn').innerText()).trim() === '' && (await page.locator('#start-btn circle').count()) === 3, 'start button is an icon with three dots, no text');
  const dotFills = await page.$$eval('#start-btn circle', (els) => els.map((e) => getComputedStyle(e).fill));
  check(new Set(dotFills).size === 3, 'the three dots have different colours', dotFills.join(' '));
  await page.click('#start-btn');
  await page.click('#sm-files');
  await page.waitForSelector('.files .item'); // the title follows the folder once it is listed
  check((await page.textContent('.win .titlebar .title')) === P_BASE(home) + ' — 檔案櫃', 'file cabinet title bar names the folder and the app');
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
  await page.click('button[title="列表檢視"]');
  check(await page.isVisible('.files.list .list-head'), 'list view shows column headers');
  await page.click('button[title="圖示檢視"]');

  // ---- open a file in a Monaco window
  await openItem('math.ts');
  await page.waitForSelector('.win .monaco-editor .view-lines', { timeout: 60000 });
  const value = () => page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('math.ts')).getValue()); // model keeps its URI after save-as
  const original = await value();
  check(original.includes('export function add'), 'editor shows the file content');
  const edWin = page.locator('.win', { has: page.locator('.monaco-editor') }).first();
  const state = () => edWin.locator('.statusbar span').first().textContent();
  check((await edWin.locator('.statusbar').textContent()).includes('typescript'), 'language detected as typescript');
  check((await page.$$('.dock-item')).length === 2, 'dock has Finder + the editor');
  check((await edWin.locator('.titlebar .title').textContent()) === 'math.ts — 編輯器', 'editor title bar names the file and the app');
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

  const wrapBtn = edWin.locator('.statusbar button');
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
  check((await page.$$('.dock-item')).length === 3, 'dock shows both editors');

  await page.locator('.dock-item').first().click();
  await openItem('blob.bin');
  await page.waitForSelector('.toast.err');
  check((await page.textContent('.toast.err')).includes('不是文字檔'), 'binary file is refused with a message');
  check((await page.$$('.dock-item')).length === 3, 'no window left behind for the binary file');

  // ---- unsaved-changes guard
  await dockEd.click();
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
  check((await page.$$('.dock-item')).length === 2, 'discard closes the window and its dock item');
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
  check((await mWin.locator('.menu button .lbl').allTextContents()).join('|') === '上一步（復原）|下一步（重做）|存檔|另存新檔…|關閉', 'File menu lists the five commands');
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
  check((await page.inputValue('.modal input')) === home + '/project/src/math.ts', 'save-as dialog starts from the current path');
  await page.fill('.modal input', copyPath);
  await page.keyboard.press('Enter');
  const cWin = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'copy.py' }) });
  await cWin.waitFor();
  check(fs.readFileSync(copyPath, 'utf8') === onDisk + '//menu', 'save as wrote the new file');
  check((await cWin.locator('.statusbar').textContent()).includes('python'), 'language follows the new file name');
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
  check((await page.evaluate(() => [localStorage.getItem('sshdesk.fontSize'), localStorage.getItem('sshdesk.minimap')].join())) === '14,false', 'preferences are remembered');
  await page.locator('.dock-item', { hasText: 'copy.py' }).click(); // minimise so the Finder is reachable
  await openItem('app.py');
  await page.waitForFunction(() => window.monaco.editor.getEditors().length === 3);
  check(await page.evaluate(() => window.monaco.editor.getEditors().every((e) => e.getRawOptions().fontSize === 14 && e.getRawOptions().minimap.enabled === false)), 'new and existing editors share the preferences');
  await page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'app.py' }) }).locator('.traffic .close').click();
  await page.locator('.dock-item', { hasText: 'copy.py' }).click();
  await view('重設文字大小');
  await view('顯示右側縮圖');
  check((await opt('fontSize')) === 13 && (await opt('minimap')) === true, 'reset restores the defaults');

  await cWin.locator('.menu-btn', { hasText: '檔案' }).click();
  await cWin.locator('.menu button', { hasText: '關閉' }).click();
  await sleep(200);
  check((await cWin.count()) === 0 && (await page.$$('.dock-item')).length === 2, 'menu close closes the window');
  fs.rmSync(copyPath, { force: true });

  // ---- start menu, clock, task manager
  check((await page.locator('#menubar').count()) === 0, 'top bar is gone');
  check(/^\d\d:\d\d$/.test(await page.textContent('#clock-time')) && /^\d{4}\/\d\d\/\d\d$/.test(await page.textContent('#clock-date')), 'clock shows time and date');
  const clockBox = await page.locator('#clock').boundingBox();
  const startBox = await page.locator('#start-btn').boundingBox();
  check(startBox.x < 20 && startBox.y > 740 && clockBox.x + clockBox.width > 1260 && clockBox.y > 740, 'start button bottom-left, clock bottom-right');
  check(await page.isHidden('#start-menu'), 'start menu starts closed');
  await page.click('#start-btn');
  check(await page.isVisible('#start-menu'), 'start button opens the menu');
  check((await page.textContent('#sm-username')) === user, 'start menu shows the current user');
  check(await page.isHidden('#disconnect'), 'logout is hidden until the user is clicked');
  await page.keyboard.press('Escape');
  check(await page.isHidden('#start-menu'), 'Escape closes the start menu');

  await page.locator('.win', { has: page.locator('.finder-main') }).locator('.traffic .close').click();
  check((await page.locator('.finder-main').count()) === 0 && (await page.$$('.dock-item')).length === 1, 'file cabinet can be closed');
  await page.click('#start-btn');
  await page.click('#sm-files');
  await page.waitForSelector('.files .item');
  check(await page.isHidden('#start-menu') && (await page.textContent('.finder-main + .statusbar .path')) === home, 'start menu reopens the file cabinet at home');

  await page.click('#start-btn');
  await page.click('#sm-tasks');
  const tm = page.locator('.win', { has: page.locator('.tm-top') });
  await tm.waitFor();
  check((await tm.locator('.titlebar .title').textContent()) === '工作管理員', 'task manager has its title');
  await page.waitForFunction(() => document.querySelectorAll('.tm-list tbody tr').length > 3 && !document.querySelector('.tm-meter .val').textContent.includes('計算'), null, { timeout: 20000 });
  const cg = fs.existsSync('/sys/fs/cgroup/memory.max') ? fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim() : null;
  const meters = await tm.locator('.tm-meter').allTextContents();
  console.log('     task manager:', (await tm.locator('.tm-meta').textContent()).replace(/\s+/g, ' '), '|', meters.join(' | '));
  if (fs.existsSync('/.dockerenv')) {
    check((await page.textContent('#tm-scope')).startsWith('容器'), 'task manager reports the container scope');
    check((await tm.locator('.tm-note').textContent()).includes('不是宿主機'), 'it says the figures are not the host\'s');
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
  await tm.locator('.traffic .close').click();
  check((await tm.count()) === 0, 'task manager closes');

  // ---- right-click menus, open-with, notepad, clipboard, delete, properties
  const toFinder = async () => {
    await page.click('#start-btn');
    await page.click('#sm-files');
  };
  check((await page.locator('#sm-apps button').allTextContents()).join() === '檔案櫃,記事本,終端機,工作管理員,設定', 'start menu lists every tool');
  await toFinder();
  await openItem('docs');
  await item('todo.txt').waitFor();
  await item('todo.txt').click({ button: 'right' });
  check((await menuLabels()).join('|') === '開啟|開啟程式…|複製|剪下|貼上|刪除|內容', 'file right-click menu', (await menuLabels()).join('|'));
  await pick('內容');
  const props = await page.locator('.modal dl.props').textContent();
  check(props.includes('todo.txt') && props.includes('rw-r--r--（644）') && props.includes('9 位元組') && props.includes(home + '/docs'), 'properties show name, location, size and permissions', props);
  await page.locator('.modal button', { hasText: '關閉' }).click();

  await item('todo.txt').dblclick();
  await page.waitForSelector('.modal .app-choice');
  check((await page.locator('.modal .app-choice').allTextContents()).join() === '編輯器,記事本', 'unknown extension asks, offering only apps that accept .txt');
  check(await page.isChecked('#choose-remember') && (await page.textContent('.choose-remember')).includes('以後.txt 檔都用這個程式開啟'), 'the dialog offers "always use this app", ticked for an unknown extension');
  await page.uncheck('#choose-remember');
  await page.locator('.modal .app-choice[data-app="editor"]').click();
  const once = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'todo.txt — 編輯器' }) });
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
  check((await np.locator('.titlebar .title').textContent()) === 'todo.txt — 記事本' && (await np.locator('.monaco-editor').count()) === 0, 'notepad opens the file in a plain textarea');
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
  const viaEditor = page.locator('.win', { has: page.locator('.titlebar .title', { hasText: 'todo.txt — 編輯器' }) });
  await viaEditor.waitFor();
  check(readSettings().files.associations.txt === 'notepad', 'one-off "open with" leaves the association alone');
  await viaEditor.locator('.traffic .close').click();

  await toFinder();
  await item('todo.txt').click({ button: 'right' });
  await pick('複製');
  check((await page.evaluate(() => navigator.clipboard.readText())) === 'remosh/file:' + home + '/docs/todo.txt', 'copy puts remosh/file:<path> on the clipboard');
  const blank = async () => {
    const b = await page.locator('.files').boundingBox();
    await page.mouse.click(b.x + b.width - 30, b.y + b.height - 30, { button: 'right' });
  };
  await blank();
  check((await menuLabels()).join('|') === '貼上|重新整理|內容', 'right-click on empty space', (await menuLabels()).join('|'));
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

  // ---- sidebar right-click
  await page.locator('.sidebar h3').click({ button: 'right' });
  check((await menuLabels()).join('|') === '加入目前的資料夾（project）|還原成預設', 'sidebar right-click on empty space', (await menuLabels()).join('|'));
  await pick('加入目前的資料夾');
  await page.locator('.sidebar button[title="' + home + '/project"]').waitFor();
  check(await waitSetting((s) => s.files.sidebar?.includes(home + '/project')), 'sidebar folders are saved in setting.json');
  await page.locator('.sidebar button[title="/etc"]').click({ button: 'right' });
  check((await menuLabels()).slice(0, 2).join('|') === '開啟|從側邊欄移除', 'sidebar item right-click', (await menuLabels()).join('|'));
  await pick('從側邊欄移除');
  await page.locator('.sidebar button[title="/etc"]').waitFor({ state: 'detached' });
  await item('src').click({ button: 'right' });
  check((await menuLabels()).includes('加到側邊欄') && !(await menuLabels()).includes('開啟程式…'), 'folders offer "add to sidebar" instead of "open with"');
  await page.keyboard.press('Escape');
  check((await page.locator('.ctx-menu').count()) === 0, 'Escape closes the right-click menu');
  await page.locator('.sidebar h3').click({ button: 'right' });
  await pick('還原成預設');
  await page.locator('.sidebar button[title="/etc"]').waitFor();
  check(await waitSetting((s) => s.files.sidebar === null), 'sidebar can be reset');

  // ---- terminal: run a file, then type a command
  await item('hello.sh').dblclick();
  await page.waitForSelector('.modal .app-choice');
  check((await page.locator('.modal .app-choice').allTextContents()).join() === '編輯器,記事本,終端機', '.sh offers the terminal as well');
  await page.locator('.modal .app-choice[data-app="terminal"]').click();
  const tw = page.locator('.win', { has: page.locator('.term-host') });
  await tw.waitFor();
  await page.waitForFunction(() => document.querySelector('.term-host .xterm-rows')?.textContent.includes('RAN-42'), null, { timeout: 20000 });
  check((fs.statSync(home + '/project/hello.sh').mode & 0o777) === 0o777, 'opening with the terminal sets the file to 777');
  check(true, 'and runs it as ./hello.sh (output RAN-42)');
  check((await tw.locator('.titlebar .title').textContent()) === 'hello.sh — 終端機', 'terminal window title');
  await tw.locator('.term-host').click();
  await page.keyboard.type('pwd; echo sum-$((20+3))');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.term-host .xterm-rows').textContent.includes('sum-23'), null, { timeout: 10000 });
  check((await tw.locator('.xterm-rows').textContent()).includes(home + '/project'), 'typed commands run in the file\'s folder');
  await tw.locator('.traffic .close').click();
  check((await tw.count()) === 0, 'terminal closes');

  // ---- settings: 動畫 category, saved on the host
  await page.click('#start-btn');
  await page.click('#sm-settings');
  const sw = page.locator('.win', { has: page.locator('.set-main') });
  await sw.waitFor();
  check((await sw.locator('.titlebar .title').textContent()) === '設定', 'settings window opens from the start menu');
  check((await sw.locator('.set-nav button').allTextContents()).join() === '動畫,檔案關聯', 'settings has the 動畫 and 檔案關聯 categories');
  check((await sw.locator('.set-path').textContent()) === '~/.remosh-gui/setting.json', 'it shows where settings are stored');
  check(await page.isChecked('#set-anim-enabled') && (await page.inputValue('#set-anim-speed')) === 'normal', 'defaults: animations on, normal speed');
  check(await page.isDisabled('#set-save'), 'nothing to save yet');
  await page.selectOption('#set-anim-speed', 'slow');
  check(await page.isEnabled('#set-save') && (await sw.locator('.set-status').textContent()) === '有未儲存的變更', 'editing marks unsaved changes');
  check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--anim'))) === '200ms', 'changes do not apply before saving');
  await page.click('#set-save');
  await page.waitForFunction(() => document.querySelector('.set-status').textContent === '已儲存');
  let saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check(saved.animation.enabled === true && saved.animation.speed === 'slow' && saved.version === 1, 'save wrote ~/.remosh-gui/setting.json', JSON.stringify(saved));
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

  // ---- settings: 檔案關聯 lists what was remembered and lets it be changed
  await sw.locator('.set-nav button', { hasText: '檔案關聯' }).click();
  const rowExts = await sw.locator('.assoc-row code').allTextContents();
  check(['.asp', '.bin', '.py', '.ts', '.txt'].every((x) => rowExts.includes(x)), 'remembered extensions are listed', rowExts.join(' '));
  check((await sw.locator('.assoc-row[data-ext="txt"] select').inputValue()) === 'notepad', '.txt shows 記事本');
  check((await sw.locator('.assoc-row[data-ext="txt"] select option').allTextContents()).join() === '編輯器,記事本', 'only apps that accept .txt are offered');
  await sw.locator('.assoc-row[data-ext="txt"] select').selectOption('editor');
  await sw.locator('.assoc-row[data-ext="bin"] .assoc-del').click();
  check((await sw.locator('.set-pane input, #assoc-add-btn').count()) === 0, 'associations cannot be added by hand, only changed or removed');
  await page.click('#set-save');
  await page.waitForFunction(() => document.querySelector('.set-status').textContent === '已儲存');
  const assoc = readSettings().files.associations;
  check(assoc.txt === 'editor' && !('bin' in assoc), 'association edits are saved', JSON.stringify(assoc));
  check(readSettings().animation.enabled === false, 'saving associations keeps the other settings');

  // ---- log out from the start menu
  await page.click('#start-btn');
  await page.click('#sm-user');
  check(await page.isVisible('#disconnect'), 'clicking the user reveals logout');
  await page.click('#disconnect');
  await page.waitForSelector('#login:not([hidden])');
  check(await page.isHidden('#desktop') && (await page.inputValue('#f-pass')) === '', 'disconnect returns to an empty password prompt');

  // ---- settings follow the account: log in again and they are loaded from the host
  check(!(await page.evaluate(() => document.documentElement.classList.contains('no-anim'))), 'logout resets settings to defaults');
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, animation: { enabled: false, speed: 'fast' }, future: { keep: 1 } }));
  await page.fill('#f-pass', password);
  await page.click('#login-btn');
  await page.waitForSelector('#desktop:not([hidden])');
  await page.waitForFunction(() => document.documentElement.classList.contains('no-anim'));
  check(true, 'settings are loaded from the host at login');
  await page.click('#start-btn');
  await page.click('#sm-settings');
  check(!(await page.isChecked('#set-anim-enabled')) && (await page.inputValue('#set-anim-speed')) === 'fast', 'settings window shows the loaded values');
  await page.check('#set-anim-enabled');
  await page.click('#set-save');
  await page.waitForFunction(() => document.querySelector('.set-status').textContent === '已儲存');
  const kept = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check(kept.animation.enabled === true && kept.future?.keep === 1, 'saving keeps keys this version does not know', JSON.stringify(kept));
  fs.rmSync(home + '/.remosh-gui', { recursive: true, force: true });

  check(errors.length === 0, 'no browser console errors', errors.join(' | '));
  await browser.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(2);
});
