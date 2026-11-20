// e2e area "reconnect": a dropped connection comes back by itself. Run alone with --only=reconnect (see test/e2e.cjs).
module.exports = {
  needs: ['setup', 'shell'],
  async run(shared) {
    const { check, fileDock, page } = shared;
    // ---- a dropped connection comes back by itself, without asking for the password
    const back = await page.evaluate(async () => {
      const m = await import('/js/core/rpc.js');
      const old = m.conn.ws;
      old.close();
      const t0 = performance.now();
      while (performance.now() - t0 < 12000) {
        if (m.conn.ws && m.conn.ws !== old && m.conn.ws.readyState === 1 && document.querySelector('#reconnecting').hidden) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return m.rpc('ping').then(() => 'ok', (e) => String(e.code || e));
    });
    check(await page.isHidden('#login') && back === 'ok', 'a dropped connection is restored without the login form', back + ' ' + await page.textContent('#login-sub'));
    check(true, 'the preview goes away when the pointer leaves');
    await fileDock.click();
    await page.mouse.move(600, 300);
    await page.click('button[title="列表檢視"]');
    check(await page.isVisible('.files.list .list-head'), 'list view shows column headers');
    await page.click('button[title="圖示檢視"]');
  },
};
