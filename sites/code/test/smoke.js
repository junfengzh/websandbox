#!/usr/bin/env node
'use strict';
// Browser smoke test against a running code-hosting server (headless Chrome via puppeteer-core):
// sign in as byteblaze through the form, star the most-starred project, fork it, edit a file of
// the fork in the web editor, see the commit in the history, then check POST /__rl/reset restores
// the database exactly.
//   CODE_PASSWORD=... node sites/code/test/smoke.js [--base http://127.0.0.1:7400] [--chrome /usr/bin/google-chrome] [--port 7490] [--shots DIR]
// The password (docs/NOTES-code.md) comes from the environment and is never printed.
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { values: a } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:7400' }, chrome: { type: 'string', default: '/usr/bin/google-chrome' }, port: { type: 'string', default: '7490' }, shots: { type: 'string' }, user: { type: 'string', default: 'byteblaze' } } });
const BASE = a.base.replace(/\/$/, '');
const PASSWORD = process.env.CODE_PASSWORD;
if (!PASSWORD) { console.error('set CODE_PASSWORD (see docs/NOTES-code.md)'); process.exit(2); }

const rl = async (p, body) => {
  const r = await fetch(BASE + '/__rl' + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const q1 = async (sql) => { const r = await rl('/query', { sql, raw: true }); return r.rows.length ? r.rows[0][0] : null; };
const SNAP = `SELECT json_object('projects', (SELECT count(*) FROM projects), 'max_project', (SELECT max(id) FROM projects), 'stars', (SELECT count(*) FROM stars),
  'star_sum', (SELECT total(star_count) FROM projects), 'forks_sum', (SELECT total(forks_count) FROM projects), 'commits', (SELECT count(*) FROM commits),
  'objects', (SELECT count(*) FROM git_objects), 'refs', (SELECT count(*) FROM refs), 'branch_commits', (SELECT count(*) FROM branch_commits),
  'project_commits', (SELECT count(*) FROM project_commits), 'contributors', (SELECT total(commits) FROM contributors), 'events', (SELECT count(*) FROM events),
  'sessions', (SELECT count(*) FROM kit_sessions), 'fts', (SELECT count(*) FROM projects_fts WHERE projects_fts MATCH 'AndroidSlidingUpPanel'))`;

const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const r = await fn(); steps.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`ok   ${name} (${Date.now() - t0} ms)${r && r.note ? ' - ' + r.note : ''}`); }
  catch (e) { steps.push({ name, ok: false, error: e.message }); console.log(`FAIL ${name}: ${e.message}`); throw e; }
};

(async () => {
  await rl('/reset', {});
  const before = await q1(SNAP);
  const tmpRoot = (process.env.WSB_TMP || os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'wsb-code-chrome-'));
  const browser = await puppeteer.launch({ executablePath: a.chrome, headless: true, args: ['--no-sandbox', `--remote-debugging-port=${a.port}`, `--user-data-dir=${profile}`, '--no-first-run'] });
  let failed = false;
  try {
    const newPage = async (ctx) => { const pg = await ctx.newPage(); await pg.setViewport({ width: 1366, height: 900 }); pg.on('dialog', (d) => d.accept()); return pg; };
    let page = await newPage(browser);
    const shot = async (n) => { if (a.shots) { fs.mkdirSync(a.shots, { recursive: true }); await page.screenshot({ path: path.join(a.shots, `${n}.png`) }); } };
    const go = (p) => page.goto(BASE + p, { waitUntil: 'load' });
    const clickNav = (sel) => Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(sel)]);
    const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());
    let top, forkPath;

    await step('anonymous / redirects to sign in', async () => { await go('/'); if (!page.url().includes('/users/sign_in')) throw new Error(page.url()); });
    await step('sign in through the form', async () => {
      await page.type('#user_login', a.user);
      await page.type('#user_password', PASSWORD);
      await clickNav('[data-testid="sign-in-button"]');
      const who = await page.$eval('.user-summary', (e) => e.getAttribute('aria-label'));
      if (!who.includes(a.user)) throw new Error(`header shows ${who}`);
      // continue in a fresh context (headless Chrome's invisible "save password?" prompt swallows input)
      const cookies = await page.cookies();
      await page.close();
      page = await newPage(await browser.createBrowserContext());
      await page.setCookie(...cookies);
      await go('/');
      await shot('dashboard');
      if (!(await page.title()).startsWith('Projects')) throw new Error('dashboard title ' + (await page.title()));
    });
    await step('explore -> most stars -> open the top project', async () => {
      await go('/explore/projects');
      await clickNav('a[href="/explore/projects/starred"]');
      top = await q1("SELECT full_path FROM projects WHERE visibility = 'public' AND archived = 0 ORDER BY star_count DESC, id LIMIT 1");
      const first = await page.$eval('.projects-list .project-title a', (e) => e.getAttribute('href'));
      if (first !== '/' + top) throw new Error(`first ${first} != /${top}`);
      await clickNav('.projects-list .project-title a');
      return { note: top };
    });
    await step('star it', async () => {
      const n0 = await q1(`SELECT star_count FROM projects WHERE full_path = '${top}'`);
      await clickNav('.star-btn');
      const label = await text('.star-btn');
      if (!/Unstar/.test(label)) throw new Error('button says ' + label);
      const n1 = await q1(`SELECT star_count FROM projects WHERE full_path = '${top}'`);
      if (n1 !== n0 + 1) throw new Error(`star_count ${n0} -> ${n1}`);
      if ((await text('.star-count')) !== String(n1)) throw new Error('count not shown');
      await shot('starred');
      return { note: `${n0} -> ${n1}` };
    });
    await step('fork it into my namespace', async () => {
      await clickNav('.fork-btn');
      const ns = await q1(`SELECT id FROM namespaces WHERE kind = 'user' AND path = '${a.user}'`);
      await page.select('#fork-namespace', String(ns));
      await page.click('input[name=visibility][value=public]');
      await clickNav('.fork-form button[type=submit]');
      forkPath = new URL(page.url()).pathname.slice(1);
      const from = await q1(`SELECT f.full_path FROM projects p JOIN projects f ON f.id = p.forked_from_id WHERE p.full_path = '${forkPath}'`);
      if (from !== top) throw new Error(`fork ${forkPath} from ${from}`);
      if (!(await page.$('.flash-success'))) throw new Error('no flash');
      await shot('forked');
      return { note: forkPath };
    });
    let title;
    await step('edit README.md of the fork in the web editor', async () => {
      await clickNav('.readme-holder .card-header a');
      await clickNav('.file-actions a.js-edit-blob');
      await page.waitForSelector('#editor');
      await page.$eval('#editor', (t) => { t.value = t.value + '\n\nEdited in the websandbox smoke test.\n'; });
      title = 'Smoke test: edit README';
      await page.$eval('#commit_message', (t) => { t.value = ''; });
      await page.type('#commit_message', title);
      await shot('editor');
      await clickNav('#commit-changes');
      const flash = await text('.flash-success');
      if (!/committed/.test(flash)) throw new Error('flash: ' + flash);
      if (!(await page.content()).includes('Edited in the websandbox smoke test.')) throw new Error('new content not shown');
    });
    await step('see the commit in the history', async () => {
      await clickNav('.sidebar-sub a[href*="/-/commits/"]');
      const first = await text('.commit-list .commit-row-message');
      if (first !== title) throw new Error('first commit ' + first);
      const sha = await q1(`SELECT r.sha FROM refs r JOIN projects p ON p.id = r.project_id WHERE p.full_path = '${forkPath}' AND r.kind = 'branch' AND r.name = p.default_branch`);
      const t = await q1(`SELECT title FROM commits WHERE sha = '${sha}'`);
      if (t !== title) throw new Error('db head ' + t);
      await clickNav('.commit-list .commit-row-message');
      if (!(await page.$('table.diff tr.add'))) throw new Error('no diff');
      await shot('commit');
    });
    await step('reset restores the database', async () => {
      const mid = await q1(SNAP);
      if (mid === before) throw new Error('nothing changed?');
      const r = await rl('/reset', {});
      const after = await q1(SNAP);
      if (after !== before) throw new Error(`after reset ${after} != ${before}`);
      return { note: `${r.ms} ms` };
    });
  } catch (e) {
    failed = true;
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failed ? 'SMOKE FAILED' : `SMOKE OK (${steps.length} steps)`);
  process.exit(failed ? 1 : 0);
})();
