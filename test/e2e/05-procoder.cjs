// e2e area "procoder": Procoder. Run alone with --only=procoder (see test/e2e.cjs).
module.exports = {
  needs: ['setup', 'editor'],
  async run(shared) {
    const { check, edWin, fs, home, owner, page, pcTab, sleep, waitApp } = shared;
    // ---- Procoder: titlebar tools, the terminal panel (Ctrl+`), the ⋯ tab menu
    {
      // two lines of room below the last line, not extra lines
      const room = () => page.evaluate(() => {
        const e = window.monaco.editor.getEditors().find((x) => x.getModel() && x.getDomNode()?.closest('.win[data-app="Procoder"]'));
        const lh = e.getOption(window.monaco.editor.EditorOption.lineHeight);
        return { extra: e.getContentHeight() - e.getModel().getLineCount() * lh, lh, lines: e.getModel().getLineCount(), text: e.getModel().getValue() };
      });
      let r = await room();
      check(r.extra === 2 * r.lh && !r.text.endsWith('\n\n\n'), 'the code area keeps two lines of room under the last line (space, not newlines)', JSON.stringify({ extra: r.extra, lh: r.lh }));
      await page.evaluate(() => import('/js/apps/editor/prefs.js').then((m) => m.setFontSize(m.prefs.fontSize + 4)));
      await sleep(300);
      const big = await room();
      await page.evaluate(() => import('/js/apps/editor/prefs.js').then((m) => m.setFontSize(m.prefs.fontSize - 4)));
      check(big.lh > r.lh && big.extra === 2 * big.lh, 'still two lines with a larger text size', JSON.stringify({ extra: big.extra, lh: big.lh }));
      const tools = edWin.locator('.win-tools button');
      check((await tools.count()) === 2, 'Procoder puts two tools in its title bar: file tree and terminal');
      const geo = await edWin.evaluate((w) => {
        const r = (s) => w.querySelector(s).getBoundingClientRect();
        return { tools: r('.win-tools'), title: r('.titlebar .ttext'), traffic: r('.traffic'), win: w.getBoundingClientRect() };
      });
      check(geo.traffic.right < geo.title.left && geo.title.right < geo.tools.left && geo.win.right - geo.tools.right < 16, 'title bar: window buttons | title | the app\'s tools at the right', JSON.stringify(geo.tools));
      const sideBtn = edWin.locator('.pc-tool-side');
      const wasShown = (await sideBtn.getAttribute('aria-pressed')) === 'true';
      await sideBtn.click();
      await page.waitForFunction((was) => document.querySelector('.win[data-app="Procoder"] .pc-main').classList.contains('no-side') === was, wasShown);
      check((await sideBtn.getAttribute('aria-pressed')) === String(!wasShown), 'the file-tree tool shows and hides the tree');
      await sideBtn.click();
      await page.waitForFunction((was) => document.querySelector('.win[data-app="Procoder"] .pc-main').classList.contains('no-side') === !was, wasShown);
      // Ctrl+` from the editor opens the panel with a terminal in the project folder
      await edWin.locator('.monaco-editor .view-lines').click();
      await page.keyboard.press('Control+Backquote');
      await edWin.locator('.pc-panel:not([hidden]) .pc-term-host:not([hidden]) .xterm').waitFor({ timeout: 15000 });
      check((await edWin.locator('.pc-tool-panel').getAttribute('aria-pressed')) === 'true', 'Ctrl+` opens the terminal panel; its title-bar tool shows it is open');
      const termText = () => edWin.locator('.pc-term-host:not([hidden]) .xterm-rows').textContent();
      await sleep(800);
      await page.keyboard.type('echo PANEL-$((6*7)) $PWD\n');
      await page.waitForFunction(() => /PANEL-42 \S+\/project/.test(document.querySelector('.pc-term-host:not([hidden]) .xterm-rows')?.textContent || ''), null, { timeout: 15000 });
      check(true, 'the terminal works and starts in the folder open in the tree');
      await edWin.locator('.pc-term-add').click();
      await page.waitForFunction(() => document.querySelectorAll('.win[data-app="Procoder"] .pc-term-item').length === 2);
      await sleep(800);
      await page.keyboard.type('echo SECOND\n');
      await page.waitForFunction(() => /SECOND/.test(document.querySelector('.pc-term-host:not([hidden]) .xterm-rows')?.textContent || ''), null, { timeout: 15000 });
      check((await edWin.locator('.pc-term-item .pc-term-name').allTextContents()).join() === '終端機 1,終端機 2' && (await edWin.locator('.pc-term-item.on .pc-term-name').textContent()) === '終端機 2', '+ adds a terminal to the list on the left, and switches to it');
      await edWin.locator('.pc-term-item', { hasText: '終端機 1' }).click();
      check((await termText()).includes('PANEL-42') && !(await termText()).includes('SECOND'), 'the list switches between terminals, each keeps its own session');
      await edWin.locator('.pc-term-item', { hasText: '終端機 2' }).hover();
      await edWin.locator('.pc-term-item', { hasText: '終端機 2' }).locator('.pc-term-close').click();
      check((await edWin.locator('.pc-term-item').count()) === 1, 'a terminal can be closed from the list');
      await edWin.locator('.pc-term-host:not([hidden]) .xterm').click();
      await page.keyboard.press('Control+Backquote');
      await page.waitForFunction(() => document.querySelector('.win[data-app="Procoder"] .pc-panel').hidden);
      check(await page.evaluate(() => !!document.activeElement.closest('.monaco-editor')), 'Ctrl+` in the terminal hides the panel and goes back to the editor');
      await edWin.locator('.menu-btn', { hasText: '介面' }).click();
      const termItem = edWin.locator('.menu button', { hasText: '終端機' });
      check((await termItem.locator('.key').textContent()) === 'Ctrl+`' && (await termItem.getAttribute('aria-checked')) === 'false', '介面 has 終端機 (Ctrl+`)');
      await termItem.click();
      await edWin.locator('.pc-panel:not([hidden])').waitFor();
      check((await termText()).includes('PANEL-42'), 'showing it again brings back the same terminal');
      await edWin.locator('.pc-tool-panel').click();
      await page.waitForFunction(() => document.querySelector('.win[data-app="Procoder"] .pc-panel').hidden);
      check(true, 'the title-bar tool hides it too');
      // the ⋯ at the end of the tab bar, in a window of its own
      await edWin.first().locator('.menu-btn', { hasText: '檔案' }).click();
      await edWin.first().locator('.menu button', { hasText: '開新視窗' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.win[data-app="Procoder"]').length === 2);
      const w2 = page.locator('.win[data-app="Procoder"]').nth(1);
      for (const f of ['package.json', 'docs/notes.txt']) {
        await page.evaluate((p) => import('/js/shell/apps.js').then((m) => m.launchApp('editor', { path: p })), home + (f.startsWith('docs/') ? '/' : '/project/') + f);
        await w2.locator(`.pc-tab[data-name="${f.split('/').pop()}"]`).waitFor();
      }
      await w2.locator('.monaco-editor .view-lines').click();
      await page.keyboard.type('x');
      await w2.locator('.pc-tab.dirty').waitFor();
      // the tab strip hides its scrollbar; the mouse wheel scrolls it sideways
      const strip = w2.locator('.pc-tabs');
      await strip.evaluate((el) => { el.style.flex = '0 0 120px'; el.style.width = '120px'; el.scrollLeft = 0; });
      await strip.hover();
      await page.mouse.wheel(0, 200);
      await page.waitForFunction(() => document.querySelectorAll('.win[data-app="Procoder"]')[1].querySelector('.pc-tabs').scrollLeft > 0);
      check(true, 'the mouse wheel scrolls the Procoder tab strip');
      await strip.evaluate((el) => { el.style.flex = ''; el.style.width = ''; });
      const more = w2.locator('.pc-tab-more');
      const mb = await more.boundingBox();
      const bar = await w2.locator('.pc-tabbar').boundingBox();
      check(Math.abs(mb.x + mb.width - (bar.x + bar.width)) < 2, 'the tab bar ends with ⋯');
      await more.click();
      check((await page.locator('.ctx-menu button').allTextContents()).join('|') === '關閉所有分頁|關閉已儲存分頁', '⋯ offers 關閉所有分頁 and 關閉已儲存分頁');
      await page.locator('.ctx-menu button', { hasText: '關閉已儲存分頁' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.win[data-app="Procoder"]')[1].querySelectorAll('.pc-tab').length === 2);
      check((await w2.locator('.pc-tab .pc-tab-name').allTextContents()).join() === '歡迎,notes.txt', 'closing the saved tabs keeps the one with unsaved changes', (await w2.locator('.pc-tab .pc-tab-name').allTextContents()).join());
      await more.click();
      await page.locator('.ctx-menu button', { hasText: '關閉所有分頁' }).click();
      await page.locator('.modal button', { hasText: '不儲存' }).click();
      await page.waitForFunction(() => document.querySelectorAll('.win[data-app="Procoder"]')[1].querySelectorAll('.pc-tab').length === 1);
      check((await w2.locator('.pc-tab .pc-tab-name').allTextContents()).join() === '歡迎', 'closing all tabs asks about unsaved changes, then leaves the welcome page');
      await w2.locator('.traffic .close').click();
      await page.waitForFunction(() => document.querySelectorAll('.win[data-app="Procoder"]').length === 1);
    }

    // ---- Procoder: 效能 › 允許 200M 檔案, and full-width punctuation is not boxed
    {
      const big = home + '/docs/big-fake.txt';
      fs.writeFileSync(big, '中文，標點。測試：好！\nlet a = 1，b;\n'); // the second line is where Monaco would box ，
      require('child_process').execSync(`chown ${owner.uid}:${owner.gid} ${JSON.stringify(big)}`);
      const openBig = () => page.evaluate((p) => import('/js/shell/apps.js').then((m) => { m.launchApp('editor', { path: p, size: 300 * 1024 * 1024 }); }), big);
      await openBig();
      await edWin.locator('.ed-large .ed-large-open').waitFor();
      check((await edWin.locator('.ed-large p').textContent()).includes('300 MB'), 'a file over 200 MB asks first');
      await pcTab('big-fake.txt').click({ button: 'middle' });
      await pcTab('big-fake.txt').waitFor({ state: 'detached' });
      await edWin.locator('.menu-btn', { hasText: '效能' }).click();
      const allow = edWin.locator('.menu button', { hasText: '允許 200M 檔案' });
      check((await allow.getAttribute('aria-checked')) === 'false', '效能 has 允許 200M 檔案, off at first');
      await allow.click();
      check(await waitApp('editor', (d) => d.allowLarge === true), 'switching it on is saved with Procoder\'s settings');
      await openBig();
      await page.waitForFunction(() => /中文，標點。/.test(document.querySelector('.win[data-app="Procoder"] .monaco-editor .view-lines')?.textContent || ''), null, { timeout: 15000 });
      check((await edWin.locator('.ed-large').count()) === 0, 'with it on, a file over 200 MB opens straight away');
      await sleep(800);
      const boxed = () => edWin.locator('.monaco-editor .unicode-highlight').count();
      const noBox = (await boxed()) === 0;
      // the same text with Monaco's default does get boxes: the check above means something
      await page.evaluate(() => window.monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.endsWith('/big-fake.txt')).updateOptions({ unicodeHighlight: { ambiguousCharacters: true, allowedLocales: {} } })); // as for a browser not set to Chinese
      await page.waitForFunction(() => document.querySelectorAll('.win[data-app="Procoder"] .monaco-editor .unicode-highlight').length > 0, null, { timeout: 5000 }).catch(() => {});
      const withDefault = await boxed();
      await page.evaluate(() => window.monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.endsWith('/big-fake.txt')).updateOptions({ unicodeHighlight: { ambiguousCharacters: false } }));
      check(noBox && withDefault > 0, 'full-width punctuation (，。：！) is not boxed as "looks like ASCII" (Monaco\'s default would box it)', String(withDefault));
      await pcTab('big-fake.txt').click({ button: 'middle' });
      await pcTab('big-fake.txt').waitFor({ state: 'detached' });
      await edWin.locator('.menu-btn', { hasText: '效能' }).click();
      await edWin.locator('.menu button', { hasText: '允許 200M 檔案' }).click();
      await waitApp('editor', (d) => d.allowLarge === false);
      fs.rmSync(big, { force: true });
    }

    // ---- Procoder: Python completion from pyright running in the browser, with
    // the files the program imports read from the host
    {
      const pj = home + '/pyproj';
      fs.rmSync(pj, { recursive: true, force: true });
      const site = pj + '/.venv/lib/python3.13/site-packages/fakepkg';
      fs.mkdirSync(site, { recursive: true });
      fs.writeFileSync(pj + '/.venv/pyvenv.cfg', 'home = /usr/bin\n');
      fs.writeFileSync(site + '/__init__.py', 'from .widget import Widget\n');
      fs.writeFileSync(site + '/widget.py', 'class Widget:\n    """A thing that spins."""\n\n    def spin(self, times: int = 1) -> str:\n        """Spin the widget."""\n        return "spun" * times\n');
      fs.writeFileSync(pj + '/helpers.py', 'def greet(name: str) -> str:\n    """Say hello."""\n    return "hi " + name\n');
      fs.writeFileSync(pj + '/main.py', 'import os\nfrom helpers import greet\nfrom fakepkg import Widget\n\nw = Widget()\nprint(greet("x"), os.getcwd())\n');
      require('child_process').execSync(`chown -R ${owner.uid}:${owner.gid} ${JSON.stringify(pj)}`);
      const pyEd = (file) => `window.monaco.editor.getEditors().find((x) => x.getModel()?.uri.path.endsWith(${JSON.stringify(file)}))`;
      const caret = (file, line, col) => page.evaluate(`(() => { const e = ${pyEd(file)}; const m = e.getModel(); const l = ${line} || m.getLineCount(); e.setPosition({ lineNumber: l, column: ${col} || m.getLineMaxColumn(l) }); e.focus(); })()`);
      const suggestions = () => edWin.locator('.suggest-widget.visible .monaco-list-row .label-name').allTextContents();
      await page.evaluate((p) => import('/js/shell/apps.js').then((m) => m.launchApp('editor', { path: p })), pj + '/main.py');
      await pcTab('main.py').waitFor();
      await page.waitForFunction(() => /可提示/.test(document.querySelector('.win[data-app="Procoder"] .pc-mod')?.textContent || ''), null, { timeout: 60000 });
      check(true, 'a Python file starts the checker; the status bar says suggestions are on');
      await caret('/pyproj/main.py', 0, 0);
      await page.keyboard.press('Enter');
      await page.keyboard.type('w.');
      await edWin.locator('.suggest-widget.visible .monaco-list-row').first().waitFor({ timeout: 20000 });
      await sleep(300);
      const sugg = await suggestions();
      check(sugg[0] === 'spin', 'completion knows the methods of a class from an installed package (read from the host\'s virtual environment)', sugg.slice(0, 5).join());
      await page.keyboard.press('Escape');
      await page.keyboard.type('spin(');
      await edWin.locator('.parameter-hints-widget.visible').waitFor({ timeout: 10000 });
      check((await edWin.locator('.parameter-hints-widget').textContent()).includes('times: int = 1'), 'typing ( shows the parameters');
      await page.keyboard.press('Escape');
      await page.keyboard.type('nope_name)');
      await page.waitForFunction(() => window.monaco.editor.getModelMarkers({ owner: 'pyright' }).some((m) => m.message.includes('nope_name')), null, { timeout: 15000 });
      check(true, 'an unknown name is marked as an error');
      const hover = await page.evaluate(async () => {
        const m = await import('/js/apps/editor/modules/python/index.js');
        const { sessions, request } = m.pyDebug();
        const s = [...sessions.values()].find((x) => x.root.endsWith('/pyproj'));
        return (await request(s, 'textDocument/hover', { textDocument: { uri: 'file://' + s.root + '/main.py' }, position: { line: 1, character: 22 } }))?.contents?.value || '';
      });
      check(hover.includes('def greet(name: str) -> str') && hover.includes('Say hello.'), 'hover over a function from another file of the project shows its signature and docstring', hover);
      // an import added while editing brings in the files it needs
      fs.writeFileSync(pj + '/extra.py', 'class Thing:\n    def wobble(self) -> None: ...\n');
      require('child_process').execSync(`chown ${owner.uid}:${owner.gid} ${JSON.stringify(pj + '/extra.py')}`);
      await caret('/pyproj/main.py', 1, 1);
      await page.keyboard.type('from extra import Thing\n');
      await caret('/pyproj/main.py', 0, 0);
      await page.keyboard.press('Enter');
      let wob = [];
      for (let i = 0; i < 15 && !wob.includes('wobble'); i++) {
        await sleep(600);
        await page.keyboard.type('Thing().');
        await edWin.locator('.suggest-widget.visible .monaco-list-row').first().waitFor({ timeout: 5000 }).catch(() => {});
        await sleep(200);
        wob = await suggestions();
        await page.keyboard.press('Escape');
        for (let k = 0; k < 8; k++) await page.keyboard.press('Backspace');
      }
      check(wob.includes('wobble'), 'a new import typed in the editor fetches that module from the host; its contents are suggested', wob.slice(0, 4).join());
      // go to definition into the installed package
      await caret('/pyproj/main.py', 6, 6);
      await page.keyboard.press('F12');
      await pcTab('widget.py').waitFor({ timeout: 15000 });
      await page.waitForFunction(`(${pyEd('/fakepkg/widget.py')})?.getPosition().lineNumber === 1`, null, { timeout: 5000 }).catch(() => {});
      check(await page.evaluate(`(${pyEd('/fakepkg/widget.py')})?.getModel().uri.path`) === site + '/widget.py', 'F12 on a name from an installed package opens its source file from the host');
      // close the two tabs (main.py has unsaved changes: drop them)
      await pcTab('widget.py').click({ button: 'middle' });
      await pcTab('widget.py').waitFor({ state: 'detached' });
      await pcTab('main.py').click({ button: 'middle' });
      await page.locator('.modal button', { hasText: '不儲存' }).click();
      await pcTab('main.py').waitFor({ state: 'detached' });
      check(await page.evaluate(async () => (await import('/js/apps/editor/modules/python/index.js')).pyDebug().sessions.size === 0), 'closing the last Python file stops the checker');
      fs.rmSync(pj, { recursive: true, force: true });
    }

    // ---- Procoder: Node.js across files (TypeScript's service in the browser,
    // given the project's files and the packages' declarations read from the host)
    {
      const np = home + '/nodeproj';
      fs.rmSync(np, { recursive: true, force: true });
      const put = (rel, text) => { fs.mkdirSync(require('path').dirname(np + '/' + rel), { recursive: true }); fs.writeFileSync(np + '/' + rel, text); };
      put('node_modules/fakelib/package.json', '{"name":"fakelib","types":"dist/index.d.ts"}');
      put('node_modules/fakelib/dist/index.d.ts', 'export declare class Gadget {\n  /** Twist it. */\n  twist(turns: number): string;\n}\n');
      put('node_modules/cjslib/package.json', '{"name":"cjslib","main":"lib.js"}');
      put('node_modules/cjslib/lib.js', 'module.exports = { bounce() {} };\n');
      put('node_modules/@types/cjslib/package.json', '{"name":"@types/cjslib","types":"index.d.ts"}');
      put('node_modules/@types/cjslib/index.d.ts', 'declare const lib: { bounce(height: number): void };\nexport = lib;\n');
      put('node_modules/@types/node/package.json', '{"name":"@types/node","types":"index.d.ts"}');
      put('node_modules/@types/node/index.d.ts', '/// <reference path="fs.d.ts" />\n');
      put('node_modules/@types/node/fs.d.ts', 'declare module "fs" {\n  export function readFileSync(path: string): string;\n}\ndeclare module "node:fs" {\n  export * from "fs";\n}\n');
      put('util.ts', 'export function helper(n: number): string {\n  return String(n);\n}\n');
      put('main.ts', "import { Gadget } from 'fakelib';\nimport cjs = require('cjslib');\nimport * as fs from 'node:fs';\nimport { helper } from './util';\n\nconst g = new Gadget();\n");
      require('child_process').execSync(`chown -R ${owner.uid}:${owner.gid} ${JSON.stringify(np)}`);
      const caretN = (line, col) => page.evaluate(`(() => { const e = window.monaco.editor.getEditors().find((x) => x.getModel()?.uri.path.endsWith('/nodeproj/main.ts')); const m = e.getModel(); const l = ${line} || m.getLineCount(); e.setPosition({ lineNumber: l, column: ${col} || m.getLineMaxColumn(l) }); e.focus(); })()`);
      const suggestFor = async (text) => {
        let got = [];
        for (let i = 0; i < 10 && !got.length; i++) {
          await page.keyboard.type(text);
          await edWin.locator('.suggest-widget.visible .monaco-list-row').first().waitFor({ timeout: 4000 }).catch(() => {});
          await sleep(200);
          got = await edWin.locator('.suggest-widget.visible .monaco-list-row .label-name').allTextContents();
          await page.keyboard.press('Escape');
          for (let k = 0; k < text.length; k++) await page.keyboard.press('Backspace');
        }
        return got;
      };
      await page.evaluate((p) => import('/js/shell/apps.js').then((m) => m.launchApp('editor', { path: p })), np + '/main.ts');
      await pcTab('main.ts').waitFor();
      await page.waitForFunction(() => /Node\.js：可提示/.test(document.querySelector('.win[data-app="Procoder"] .pc-mod')?.textContent || ''), null, { timeout: 60000 });
      const given = await page.evaluate(async () => [...(await import('/js/apps/editor/modules/node/index.js')).nodeDebug().sessions.values()].find((x) => x.root.endsWith('/nodeproj'))?.libs.size || 0);
      check(given >= 8, 'a JavaScript/TypeScript file reads what it imports from the host (project files, package declarations, @types)', String(given));
      await caretN(0, 0);
      await page.keyboard.press('Enter');
      const gadget = await suggestFor('g.');
      check(gadget.includes('twist'), 'completion knows a package\'s class from its own declarations ("types" in package.json)', gadget.slice(0, 4).join());
      const bounce = await suggestFor('cjs.');
      check(bounce.includes('bounce'), 'a package without declarations gets them from @types', bounce.slice(0, 4).join());
      const fsList = await suggestFor('fs.');
      check(fsList.includes('readFileSync'), 'Node\'s own modules (node:fs) come from @types/node', fsList.slice(0, 4).join());
      await caretN(4, 12);
      await page.keyboard.press('F12');
      await pcTab('util.ts').waitFor({ timeout: 15000 });
      check(true, 'F12 on an imported function opens the project file it comes from');
      await pcTab('util.ts').click({ button: 'middle' });
      await pcTab('util.ts').waitFor({ state: 'detached' });
      // 效能 › 語言解析器 switches the analysers off and on
      await pcTab('main.ts').click();
      await edWin.locator('.menu-btn', { hasText: '效能' }).click();
      check((await edWin.locator('.menu button .lbl').allTextContents()).join() === '語言解析器,允許 200M 檔案' && (await edWin.locator('.menu button', { hasText: '語言解析器' }).getAttribute('aria-checked')) === 'true', 'Procoder has a 效能 menu with 語言解析器, on at first');
      await edWin.locator('.menu button', { hasText: '語言解析器' }).click();
      check(await waitApp('editor', (d) => d.analysis === false), 'switching it off is saved with Procoder\'s settings');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.win[data-app="Procoder"] .pc-mod')).display === 'none');
      check(await page.evaluate(async () => (await import('/js/apps/editor/modules/node/index.js')).nodeDebug().sessions.size === 0), 'off: the analysers stop and the status bar shows nothing');
      await edWin.locator('.menu-btn', { hasText: '效能' }).click();
      await edWin.locator('.menu button', { hasText: '語言解析器' }).click();
      await page.waitForFunction(() => /Node\.js：可提示/.test(document.querySelector('.win[data-app="Procoder"] .pc-mod')?.textContent || ''), null, { timeout: 30000 });
      check(await waitApp('editor', (d) => d.analysis === true), 'on again: they start again');
      await pcTab('main.ts').click({ button: 'middle' });
      if (await page.locator('.modal button', { hasText: '不儲存' }).count()) await page.locator('.modal button', { hasText: '不儲存' }).click();
      await pcTab('main.ts').waitFor({ state: 'detached' });
      fs.rmSync(np, { recursive: true, force: true });
    }

    // ---- Procoder: a project without @types/node still knows Node's own modules
    {
      const mp = home + '/mintproj';
      fs.rmSync(mp, { recursive: true, force: true });
      fs.mkdirSync(mp);
      fs.writeFileSync(mp + '/index.js', 'import os from "os";\n\n');
      require('child_process').execSync(`chown -R ${owner.uid}:${owner.gid} ${JSON.stringify(mp)}`);
      await page.evaluate((p) => import('/js/shell/apps.js').then((m) => m.launchApp('editor', { path: p })), mp + '/index.js');
      await pcTab('index.js').waitFor();
      await page.waitForFunction(() => /@types\/node/.test(document.querySelector('.win[data-app="Procoder"] .pc-mod')?.title || ''), null, { timeout: 30000 });
      check(true, 'no @types/node in the project: the status says Remogui\'s own copy is used');
      await page.evaluate(() => { const e = window.monaco.editor.getEditors().find((x) => x.getModel()?.uri.path.endsWith('/mintproj/index.js')); e.setPosition({ lineNumber: 3, column: 1 }); e.focus(); });
      let got = [];
      for (let i = 0; i < 10 && !got.includes('cpus'); i++) {
        await page.keyboard.type('os.');
        await edWin.locator('.suggest-widget.visible .monaco-list-row').first().waitFor({ timeout: 4000 }).catch(() => {});
        await sleep(200);
        got = await edWin.locator('.suggest-widget.visible .monaco-list-row .label-name').allTextContents();
        await page.keyboard.press('Escape');
        for (let k = 0; k < 3; k++) await page.keyboard.press('Backspace');
      }
      check(got.includes('cpus'), 'import os from "os" then os. lists what the os module has', got.slice(0, 5).join());
      await pcTab('index.js').click({ button: 'middle' });
      if (await page.locator('.modal button', { hasText: '不儲存' }).count()) await page.locator('.modal button', { hasText: '不儲存' }).click();
      await pcTab('index.js').waitFor({ state: 'detached' });
      fs.rmSync(mp, { recursive: true, force: true });
    }
  },
};
