// e2e area "mcp": MCP mode. Run alone with --only=mcp (see test/e2e.cjs).
module.exports = {
  needs: ['setup'],
  async run(shared) {
    const { base, browser, check, errors, fs, sleep, webPassword } = shared;
    // ---- MCP mode: the same desktop through an agent instead of SSH (the Python agent here)
    {
      const cp = require('node:child_process');
      const agentHome = fs.mkdtempSync('/tmp/remogui-mcp-');
      fs.mkdirSync(agentHome + '/docs');
      fs.writeFileSync(agentHome + '/docs/hello-mcp.txt', 'hi from mcp\n');
      const agent = cp.spawn('python3', [require('node:path').join(__dirname, '..', '..', 'agent', 'remogui_agent.py'), '--no-tunnel', '--port', '18799', '--key', 'e2e-token'],
        { env: { ...process.env, HOME: agentHome }, stdio: 'ignore' });
      const c2 = await browser.newContext({ locale: 'zh-TW', viewport: { width: 1280, height: 800 } });
      try {
        for (let i = 0; i < 50; i++) {
          if (await fetch('http://127.0.0.1:18799/').then(() => true, () => false)) break;
          await sleep(100);
        }
        const p2 = await c2.newPage();
        p2.on('pageerror', (e) => errors.push('mcp pageerror: ' + e.message));
        await p2.goto(base);
        if (webPassword) {
          await p2.fill('#gate-pass', webPassword);
          await p2.click('#gate-btn');
        }
        await p2.waitForSelector('#login:not([hidden])');
        check(await p2.isVisible('#mode-ssh.on') && await p2.isHidden('#mcp-fields'), 'the login screen starts in SSH mode, with an SSH / MCP switch');
        await p2.click('#mode-mcp');
        check(await p2.isHidden('#ssh-fields') && await p2.isVisible('#f-url') && (await p2.textContent('#login-sub')).includes('MCP') && (await p2.textContent('#login-note')) === '權杖與密碼一樣不會被儲存。',
          'MCP shows the address and token fields instead');
        check(await p2.isVisible('.mcp-get a.get-py') && (await p2.getAttribute('.mcp-get a.get-py', 'download')) === 'mcp.py' && (await p2.getAttribute('.mcp-get a.get-js', 'download')) === 'mcp.mjs',
          'it offers the agent for download: Python (mcp.py) and Node.js (mcp.mjs)');
        const [dl] = await Promise.all([p2.waitForEvent('download'), p2.click('.mcp-get a.get-py')]);
        check(dl.suggestedFilename() === 'mcp.py' && fs.readFileSync(await dl.path(), 'utf8') === fs.readFileSync(require('node:path').join(__dirname, '..', '..', 'agent', 'remogui_agent.py'), 'utf8'),
          'clicking the Python icon downloads mcp.py');
        const plain = await fetch(base + '/download/mcp.mjs');
        check(plain.ok && (await plain.text()).includes('Remogui MCP agent (Node.js)'), 'the download works without the access password too (curl on the machine itself)');
        await p2.fill('#f-url', 'http://127.0.0.1:18799/mcp');
        await p2.fill('#f-token', 'wrong');
        await p2.click('#login-btn');
        await p2.waitForSelector('#login-error:not([hidden])');
        check((await p2.textContent('#login-error')) === 'MCP 伺服器拒絕了存取權杖', 'a wrong token is refused', await p2.textContent('#login-error'));
        await p2.fill('#f-token', 'e2e-token');
        await p2.click('#login-btn');
        await p2.waitForSelector('#desktop:not([hidden])', { timeout: 30000 });
        check(true, 'the right token opens the desktop');
        check(await p2.evaluate(() => import('/js/core/rpc.js').then((m) => m.conn.info.mode === 'mcp')), 'the session runs over MCP');
        await p2.evaluate((d) => import('/js/shell/apps.js').then((m) => m.launchApp('files', { path: d })), agentHome + '/docs');
        await p2.locator('.win[data-app="檔案櫃"] .files .item .name', { hasText: 'hello-mcp.txt' }).waitFor({ timeout: 15000 });
        check(true, 'the file cabinet lists the machine\'s files through the agent');
        const stored = await p2.evaluate(() => JSON.stringify(Object.entries(localStorage)));
        check(!stored.includes('e2e-token'), 'the token is not kept in the browser');
      } finally {
        await c2.close();
        agent.kill();
        fs.rmSync(agentHome, { recursive: true, force: true });
      }
    }
  },
};
