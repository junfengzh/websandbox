#!/usr/bin/env node
'use strict';
// Browser smoke test of the collaboration side (headless Chrome via puppeteer-core):
//   sign in as byteblaze (form) -> create an issue with a label -> comment -> close it ->
//   create a milestone -> invite a member -> web-commit a file on a new branch -> create the
//   merge request from the editor's redirect -> approve + merge -> reset restores the base state.
// node sites/code/collab/test/smoke.js   (CODE_DATA, CODE_PASSWORD optional; Chrome port 7482)
// The password comes from CODE_PASSWORD or WebArena's env_config.py and is never printed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require(require.resolve('puppeteer-core', { paths: [path.join(__dirname, '../..')] }));

const DATA = process.env.CODE_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../../..', 'data'), 'code');
function password() {
  if (process.env.CODE_PASSWORD) return process.env.CODE_PASSWORD;
  const f = path.join(__dirname, '../../../../../3rd-party/webarena/browser_env/env_config.py');
  const m = fs.existsSync(f) && /"gitlab":\s*\{\s*"username":\s*"byteblaze",\s*"password":\s*"([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
  if (!m) throw new Error('no password: set CODE_PASSWORD');
  return m[1];
}

(async () => {
  const tmp = fs.mkdtempSync(path.join((process.env.WSB_TMP || os.tmpdir()), 'collab-smoke-'));
  const site = require('../../server.js');
  const srv = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: path.join(tmp, 'up'), jobTickMs: 50 });
  const base = srv.url(0);
  const q = async (sql, params = []) => {
    const r = await (await fetch(base + '/__rl/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, params }) })).json();
    if (r.error) throw new Error(r.error);
    return r.rows.map((row) => (Array.isArray(row) ? row[0] : Object.values(row)[0]));
  };
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--remote-debugging-port=7482', `--user-data-dir=${path.join(tmp, 'chrome')}`] });
  const steps = [];
  const step = async (name, fn) => { const t = Date.now(); await fn(); steps.push(`ok  ${name} (${Date.now() - t} ms)`); console.log(steps[steps.length - 1]); };
  try {
    let page = await browser.newPage();
    await page.setViewport({ width: 1300, height: 900 });
    const go = (u) => page.goto(base + u, { waitUntil: 'load' });
    const submit = async (sel) => { await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(sel)]); };
    const P = '/a11yproject/a11yproject.com';

    await step('sign in with the form', async () => {
      await go('/users/sign_in');
      await page.type('[name=login]', 'byteblaze');
      await page.type('[name=password]', password());
      await submit('[data-testid=sign-in-button]');
      assert.ok(!page.url().includes('/users/sign_in'), 'signed in');
      // Chrome's post-login password bubble keeps keyboard focus in that tab: continue in a fresh one
      await page.close();
      page = await browser.newPage();
      await page.setViewport({ width: 1300, height: 900 });
    });
    let iid;
    await step('create an issue with a label', async () => {
      await go(`${P}/-/issues/new`);
      await page.type('#issue_title', 'Smoke: 401 bad gateway');
      await page.type('#issue_description', 'Seen on the **homepage**');
      const bug = await page.$$eval('#new-issue-labels li label', (ls) => ls.findIndex((l) => l.textContent.trim() === 'bug'));
      assert.ok(bug >= 0);
      await page.click(`#new-issue-labels li:nth-child(${bug + 1}) input`);
      await page.type('#issue_due_date', '12312030');
      await submit('[data-qa-selector=issuable_create_button]');
      const m = /\/-\/issues\/(\d+)$/.exec(page.url());
      assert.ok(m, page.url());
      iid = +m[1];
      assert.equal(await page.$eval('[data-qa-selector=title_content]', (e) => e.textContent.trim()), 'Smoke: 401 bad gateway');
      const [lbl] = await q(`SELECT l.title FROM issues i JOIN label_links ll ON ll.target_type = 'issue' AND ll.target_id = i.id JOIN labels l ON l.id = ll.label_id WHERE i.title = 'Smoke: 401 bad gateway'`);
      assert.equal(lbl, 'bug');
    });
    await step('comment on it', async () => {
      await page.type('#note-body', 'Thanks, working on it');
      await submit('[data-testid=comment-button]');
      const t = await page.$$eval('#notes-list .timeline-discussion-body', (els) => els.map((e) => e.innerText.trim()));
      assert.ok(t.includes('Thanks, working on it'));
    });
    await step('close it', async () => {
      await submit('[data-testid=close-issue]');
      assert.equal(await page.$eval('[data-testid=issue-state]', (e) => e.textContent.trim()), 'Closed');
      const [st] = await q(`SELECT state FROM issues WHERE title = 'Smoke: 401 bad gateway'`);
      assert.equal(st, 'closed');
    });
    await step('filter the list by label (GitLab URL)', async () => {
      await go(`${P}/-/issues/?label_name%5B%5D=bug&state=closed&sort=created_date`);
      const titles = await page.$$eval('.issuable-title a', (as) => as.map((a) => a.textContent.trim()));
      assert.equal(titles[0], 'Smoke: 401 bad gateway');
    });
    await step('create a milestone', async () => {
      await go(`${P}/-/milestones/new`);
      await page.type('#milestone_title', 'product launch');
      await page.type('#milestone_start_date', '01162023');
      await page.type('#milestone_due_date', '01302023');
      await submit('.milestone-form button[type=submit]');
      assert.match(await page.$eval('.block.start_date', (e) => e.innerText), /Jan 16, 2023/);
      const [d] = await q(`SELECT start_date || '/' || due_date FROM milestones WHERE title = 'product launch'`);
      assert.equal(d, '2023-01-16/2023-01-30');
    });
    await step('invite a member', async () => {
      await go('/byteblaze/dotfiles/-/project_members');
      await page.type('#invitees', 'abisubramanya27');
      await page.select('#access_level', '10');
      await submit('[data-testid=invite-button]');
      const role = await page.$eval('tr.member[data-username=abisubramanya27] [data-testid=access-level-dropdown]', (s) => s.options[s.selectedIndex].text);
      assert.equal(role, 'Guest');
      const [lvl] = await q(`SELECT access_level FROM members WHERE source_type = 'project' AND source_id = (SELECT id FROM projects WHERE full_path = 'byteblaze/dotfiles') AND user_id = (SELECT id FROM users WHERE username = 'abisubramanya27')`);
      assert.equal(lvl, 10);
    });
    await step('web commit on a new branch -> new merge request', async () => {
      await go('/byteblaze/cloud-to-butt/-/new/master/');
      await page.type('[name=file_name]', 'SMOKE.md');
      await page.type('[name=content]', 'smoke test\n');
      await page.$eval('[name=branch_name]', (e) => { e.value = 'smoke-branch'; });
      const cmr = await page.$('[name=create_merge_request]');
      if (cmr && !(await cmr.evaluate((e) => e.checked))) await cmr.click();
      await submit('#commit-changes');
      assert.ok(page.url().includes('/-/merge_requests/new'), 'the editor redirects to a new merge request');
      // a fork's MR targets the upstream by default (as GitLab); pick the fork itself as the target
      const [pid] = await q("SELECT id FROM projects WHERE full_path = 'byteblaze/cloud-to-butt'");
      await go(`/byteblaze/cloud-to-butt/-/merge_requests/new?merge_request%5Bsource_branch%5D=smoke-branch&merge_request%5Btarget_project_id%5D=${pid}&merge_request%5Btarget_branch%5D=master`);
      await page.$eval('#mr_title', (e) => { e.value = 'Smoke merge'; });
      await page.type('#pu-reviewer_ids', 'byteblaze');
      await submit('#new_merge_request [data-qa-selector=issuable_create_button]');
      assert.match(page.url(), /\/-\/merge_requests\/\d+$/);
      const src = await page.$$eval('.detail-page-description > a.gl-font-monospace', (as) => as.map((a) => a.textContent.trim()));
      assert.deepEqual(src, ['smoke-branch', 'master']);
    });
    await step('approve and merge', async () => {
      await submit('[data-testid=approve-button]');
      await submit('[data-testid=merge-button]');
      assert.equal(await page.$eval('[data-testid=mr-state]', (e) => e.textContent.trim()), 'Merged');
      const [st] = await q(`SELECT state FROM merge_requests WHERE title = 'Smoke merge'`);
      assert.equal(st, 'merged');
      const [head] = await q(`SELECT r.sha = m.merge_commit_sha FROM refs r JOIN merge_requests m ON m.project_id = r.project_id AND m.title = 'Smoke merge' WHERE r.kind = 'branch' AND r.name = 'master'`);
      assert.equal(head, 1);
      await go('/byteblaze/cloud-to-butt/-/raw/master/SMOKE.md');
      assert.equal((await page.evaluate(() => document.body.innerText)).trim(), 'smoke test');
    });
    await step('reset restores the base state', async () => {
      await fetch(base + '/__rl/reset', { method: 'POST' });
      const [n] = await q(`SELECT (SELECT count(*) FROM issues WHERE title = 'Smoke: 401 bad gateway') + (SELECT count(*) FROM milestones WHERE title = 'product launch')
        + (SELECT count(*) FROM merge_requests WHERE title = 'Smoke merge') + (SELECT count(*) FROM members WHERE user_id = (SELECT id FROM users WHERE username = 'abisubramanya27') AND source_id = (SELECT id FROM projects WHERE full_path = 'byteblaze/dotfiles'))`);
      assert.equal(n, 0);
    });
    console.log(`smoke: ${steps.length} steps passed`);
  } catch (e) {
    console.error('SMOKE FAILED:', e.message);
    try { const pg = (await browser.pages()).pop(); console.error('at', pg.url()); await pg.screenshot({ path: path.join((process.env.WSB_TMP || os.tmpdir()), 'collab-smoke-fail.png') }); } catch { /* ignore */ }
    process.exitCode = 1;
  } finally {
    await browser.close();
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
