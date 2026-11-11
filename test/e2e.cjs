// Browser end-to-end test. Needs a running `wrangler dev` and a reachable SSH
// account whose home contains project/src/math.ts and docs/ (see README).
//   NODE_PATH=<dir with playwright>/node_modules node test/e2e.cjs \
//     http://127.0.0.1:3000 127.0.0.1 2222 user password /home/user
const { chromium } = require('playwright');
const fs = require('node:fs');

const [base, host, port, user, password, home, shotDir] = process.argv.slice(2);
let failed = 0;
const check = (cond, label, extra = '') => {
  if (cond) console.log('ok   ' + label);
  else {
    failed++;
    console.log('FAIL ' + label + (extra ? ' :: ' + extra : ''));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
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
  await page.waitForSelector('.files .item');
  const names = async () => page.$$eval('.files .item .name', (els) => els.map((e) => e.textContent));
  let list = await names();
  check(list.includes('project') && list.includes('docs'), 'finder lists the home directory', list.join(','));
  check(!list.some((n) => n.startsWith('.')), 'hidden files are hidden by default');
  check((await page.textContent('#conn-label')).startsWith(user + '@'), 'menubar shows user@host');

  const openItem = async (name) => {
    await page.locator('.files .item', { has: page.locator('.name', { hasText: new RegExp('^' + name.replace(/[.]/g, '\\.') + '$') }) }).dblclick();
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
  const value = () => page.evaluate(() => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('math.ts')).getValue());
  const original = await value();
  check(original.includes('export function add'), 'editor shows the file content');
  const edWin = page.locator('.win', { has: page.locator('.monaco-editor') }).first();
  const state = () => edWin.locator('.statusbar span').first().textContent();
  check((await edWin.locator('.statusbar').textContent()).includes('typescript'), 'language detected as typescript');
  check((await page.$$('.dock-item')).length === 2, 'dock has Finder + the editor');
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
  check(await page.locator('.monaco-editor .find-widget.visible').count() === 1, 'Ctrl+F opens the find widget');
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
  const maxBox = await edWin.boundingBox();
  check(maxBox.width === 1280 && Math.round(maxBox.y + maxBox.height) === Math.round(dockBox.y), 'double-click title maximises');
  await edWin.locator('.titlebar .title').dblclick();
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

  // ---- disconnect
  await page.click('#disconnect');
  await page.waitForSelector('#login:not([hidden])');
  check(await page.isHidden('#desktop') && (await page.inputValue('#f-pass')) === '', 'disconnect returns to an empty password prompt');

  check(errors.length === 0, 'no browser console errors', errors.join(' | '));
  await browser.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(2);
});
