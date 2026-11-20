// Browser end-to-end test. Needs the server running (`npm start`) and a reachable SSH
// account whose home contains project/src/math.ts and docs/ (see README).
//   NODE_PATH=<dir with playwright>/node_modules node test/e2e.cjs \
//     http://127.0.0.1:3000 127.0.0.1 2222 user password /home/user [--only=sqlite,mcp] [--list]
//
// The checks are split by area into test/e2e/NN-<area>.cjs, run in that order.
// Each exports { needs, run(shared) }: `shared` carries what the areas before
// it set up (the page, helpers ...), and `needs` names the areas it builds on.
// An area may also export alone(shared): run first when the area before it in
// the list did not run, to put the screen in the state that area leaves.
// --only=a,b runs those areas plus what they need (setup, which logs in, always
// runs first); without it every area runs. --list prints the areas.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const [base, host, port, user, password, home, shotDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
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
const { execSync: execSyncTop } = require('node:child_process');

const DIR = path.join(__dirname, 'e2e');
const AREAS = fs.readdirSync(DIR).filter((f) => /^\d\d-[\w-]+\.cjs$/.test(f)).sort()
  .map((f) => ({ id: f.slice(3, -4), file: path.join(DIR, f), ...require(path.join(DIR, f)) }));

function chosen() {
  const only = flags.find((f) => f.startsWith('--only='));
  if (!only) return AREAS;
  const want = new Set(['setup']);
  const add = (id) => {
    const a = AREAS.find((x) => x.id === id);
    if (!a) {
      console.error(`unknown area "${id}"; the areas are: ${AREAS.map((x) => x.id).join(', ')}`);
      process.exit(2);
    }
    if (want.has(id) && id !== 'setup') return;
    want.add(id);
    a.needs.forEach(add);
  };
  only.slice(7).split(',').filter(Boolean).forEach(add);
  return AREAS.filter((a) => want.has(a.id));
}

if (flags.includes('--list')) {
  for (const a of AREAS) console.log(a.id.padEnd(14) + (a.needs.length ? 'needs ' + a.needs.join(', ') : ''));
  process.exit(0);
}

(async () => {
  const shared = { base, host, port, user, password, home, shotDir, check, sleep, fs, chromium, P_BASE, execSyncTop };
  const run = chosen();
  if (run.length < AREAS.length) console.log('areas: ' + run.map((a) => a.id).join(', ') + '\n');
  for (const area of run) {
    if (run.length < AREAS.length) console.log(`---- ${area.id}`);
    try {
      const prev = AREAS[AREAS.indexOf(area) - 1];
      if (area.alone && prev && !run.includes(prev)) await area.alone(shared);
      await area.run(shared);
    } catch (err) {
      // say what was on screen: an unexpected dialog is the usual reason a click times out
      const dialogs = await shared.page?.locator('.modal').allInnerTexts().catch(() => []);
      if (dialogs?.length) console.error(`open dialog(s) when "${area.id}" crashed:\n  ` + dialogs.map((d) => d.replace(/\s+/g, ' ')).join('\n  '));
      throw err;
    }
  }
  check(shared.errors.length === 0, 'no browser console errors', shared.errors.join(' | '));
  await shared.browser.close();
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(2);
});
