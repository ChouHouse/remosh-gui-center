// e2e area "sqlite": SQLite 檢視器. Run alone with --only=sqlite (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  async run(shared) {
    const { check, fs, home, owner, page } = shared;
    // ---- SQLite 檢視器: reads a database on the host with nothing installed there
    {
      const cp = require('child_process');
      const dbPath = home + '/docs/shop.db';
      const py = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript('''
create table users(id integer primary key, name text not null, age int, avatar blob, note text default 'hi');
create index users_age on users(age);
create table empty(a);
create view adults as select id, name from users where age >= 18;
''')
rows = [(i, 'user%03d' % i, i % 90, None, None) for i in range(1, 451)]
rows[0] = (1, 'first', None, bytes(range(40)), 'x' * 3000)
rows[1] = (2, 'big', 9007199254740993, None, '中文')
db.executemany('insert into users values (?,?,?,?,?)', rows)
db.commit()
`;
      const run = (code, ...args) => cp.execFileSync('python3', ['-I', '-c', code, ...args]);
      fs.rmSync(dbPath, { force: true });
      run(py, dbPath);
      fs.writeFileSync(home + '/docs/not-really.db', 'hello, not a database\n');
      cp.execSync(`chown ${owner.uid}:${owner.gid} ${JSON.stringify(dbPath)} ${JSON.stringify(home + '/docs/not-really.db')}`);
      const before = fs.readFileSync(dbPath).toString('base64');
      const temps = () => fs.readdirSync(require('os').tmpdir()).filter((n) => n.startsWith('remogui-sqlite-')).length;
      const temps0 = temps();
      check(await page.evaluate(() => import('/js/shell/apps.js').then((m) => m.appsForExt('db').some((a) => a.id === 'sqlite'))), 'SQLite 檢視器 opens .db files');
      await page.evaluate((p) => import('/js/shell/apps.js').then((m) => { m.launchApp('sqlite', { path: p }); }), dbPath);
      const sw = page.locator('.win[data-app="SQLite 檢視器"]');
      await sw.locator('.sq-item').first().waitFor({ timeout: 15000 });
      await sw.locator('.sq-pane .sq-note', { hasText: '沒有資料' }).waitFor();
      check((await sw.locator('.sq-item.on .nm').textContent()) === 'empty' && (await sw.locator('.sq-grid th').allTextContents()).join() === 'a', 'the first table opens; an empty one shows its columns and says it has no data');
      check((await sw.locator('.sq-item .nm').allTextContents()).join() === 'empty,users,adults' && (await sw.locator('.sq-group').allTextContents()).join() === '資料表,檢視',
        'it lists the tables, then the views', (await sw.locator('.sq-item .nm').allTextContents()).join());
      check((await sw.locator('.sq-item[data-name="users"] small').textContent()) === '450', 'each table shows how many rows it has');
      await sw.locator('.sq-item[data-name="users"]').click();
      await page.waitForFunction(() => document.querySelector('.win[data-app="SQLite 檢視器"] .sq-grid tbody')?.rows.length === 200);
      const foot = () => sw.locator('.sq-range').textContent();
      check((await foot()) === '第 1–200 列，共 450 列', 'rows come 200 to a page', await foot());
      const row = (i) => sw.locator('.sq-grid tbody tr').nth(i).locator('td');
      check((await row(0).allTextContents()).slice(0, 4).join('|') === '1|first|NULL|BLOB（40 B）' && (await row(0).nth(2).getAttribute('class')) === 'null',
        'NULL and BLOB cells are shown as such', (await row(0).allTextContents()).join('|').slice(0, 80));
      check((await row(1).nth(2).textContent()) === '9007199254740993' && (await row(1).nth(4).textContent()) === '中文', 'big integers keep every digit; text in Chinese is fine');
      check((await row(0).nth(4).getAttribute('title')).includes('共 3000 字'), 'long text is cut, and says how long it is');
      await sw.locator('.sq-page', { hasText: '›' }).click();
      await page.waitForFunction(() => document.querySelector('.win[data-app="SQLite 檢視器"] .sq-range').textContent.startsWith('第 201–400'));
      await sw.locator('.sq-page', { hasText: '»' }).click();
      await page.waitForFunction(() => document.querySelector('.win[data-app="SQLite 檢視器"] .sq-range').textContent === '第 401–450 列，共 450 列');
      check(await sw.locator('.sq-page', { hasText: '›' }).isDisabled(), 'next and last page; on the last page next is off');
      await sw.locator('.sq-grid th', { hasText: 'age' }).click();
      await page.waitForFunction(() => document.querySelector('.win[data-app="SQLite 檢視器"] .sq-range').textContent.startsWith('第 1–200'));
      check((await row(0).nth(2).textContent()) === 'NULL' && (await row(1).nth(2).textContent()) === '0' && (await sw.locator('.sq-grid th i').textContent()) === '▲', 'clicking a column header sorts by it (back to the first page)');
      await sw.locator('.sq-grid th', { hasText: 'age' }).click();
      await page.waitForFunction(() => document.querySelector('.win[data-app="SQLite 檢視器"] .sq-grid th i')?.textContent === '▼');
      check((await row(0).nth(2).textContent()) === '9007199254740993', 'a second click sorts the other way');
      await sw.locator('.sq-grid tbody tr').first().locator('td').nth(1).click({ button: 'right' });
      check((await page.locator('.ctx-menu button').allTextContents()).join('|') === '複製值|複製整列', 'right-click a cell: copy the value or the row');
      await page.keyboard.press('Escape');
      // structure
      await sw.locator('.sq-tab[data-tab="schema"]').click();
      await sw.locator('.sq-cols').waitFor();
      check((await sw.locator('.sq-cols tbody td.nm').allTextContents()).join() === 'id,name,age,avatar,note' && (await sw.locator('.sq-cols tbody tr').first().locator('td').nth(2).textContent()) === '✓',
        '結構 lists the columns, with the primary key');
      check((await sw.locator('.sq-sql').first().textContent()).startsWith('CREATE TABLE users') && (await sw.locator('.sq-sql').nth(1).textContent()).includes('users_age'), 'and the SQL that created the table and its indexes');
      // queries
      await sw.locator('.sq-tab[data-tab="sql"]').click();
      const box = sw.locator('.sq-input');
      check((await box.inputValue()) === 'SELECT * FROM "users" LIMIT 100;', 'SQL 查詢 starts with a query of the table');
      await box.fill('select count(*) as n from adults');
      await box.press('Control+Enter');
      await sw.locator('.sq-out .sq-grid').waitFor();
      const adults = run("import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select count(*) from adults').fetchone()[0])", dbPath).toString().trim();
      check((await sw.locator('.sq-out .sq-grid td').textContent()) === adults && (await sw.locator('.sq-out .sq-stat').textContent()).startsWith('1 列'), 'Ctrl+Enter runs a query and shows the result');
      const sqlErr = async (q) => {
        await box.fill(q);
        await sw.locator('.sq-run').click();
        await sw.locator('.sq-out .sq-err').waitFor();
        return sw.locator('.sq-out .sq-err').textContent();
      };
      check((await sqlErr('delete from users')) === '這裡只能查詢資料（SELECT），不能修改', 'changing data is refused');
      check((await sqlErr("attach '/etc/hosts' as x")) === '這裡只能查詢資料（SELECT），不能修改', 'so is ATTACH (it could reach files on the server)');
      check((await sqlErr('pragma query_only = off')) === '這裡只能查詢資料（SELECT），不能修改', 'and pragmas that set something');
      check((await sqlErr('select 1; drop table users')) === '一次只能執行一個查詢', 'only one statement at a time');
      check((await sqlErr('select nope from users')).includes('no such column'), 'SQL errors are shown as SQLite says them');
      check(fs.readFileSync(dbPath).toString('base64') === before, 'the file on the host is never changed');
      // reload takes a fresh copy
      run("import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute(\"insert into users(name) values ('new')\"); d.commit()", dbPath);
      await sw.locator('.sq-tool-reload').click();
      await page.waitForFunction(() => document.querySelector('.win[data-app="SQLite 檢視器"] .sq-item[data-name="users"] small')?.textContent === '451');
      check(true, '重新讀取 shows what changed on the host since it was opened');
      check(temps() === temps0 + 1, 'one copy on the server while it is open (the old one was dropped on reload)');
      // not a database
      await page.evaluate((p) => import('/js/shell/apps.js').then((m) => { m.launchApp('sqlite', { path: p }); }), home + '/docs/not-really.db');
      const bad = page.locator('.win[data-app="SQLite 檢視器"]').nth(1);
      await bad.locator('.sq-blank .sq-err').waitFor();
      check((await bad.locator('.sq-blank .sq-err').textContent()) === '這不是 SQLite 資料庫', 'a file that is not SQLite says so');
      await bad.locator('.traffic .close').click();
      await sw.locator('.traffic .close').click();
      await page.waitForFunction(() => !document.querySelector('.win[data-app="SQLite 檢視器"]'));
      for (let i = 0; i < 20 && temps() !== temps0; i++) await page.waitForTimeout(100);
      check(temps() === temps0, 'closing the window deletes the copy on the server');
      fs.rmSync(dbPath);
      fs.rmSync(home + '/docs/not-really.db');
    }
  },
};
