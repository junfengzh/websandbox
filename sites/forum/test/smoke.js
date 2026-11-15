#!/usr/bin/env node
'use strict';
// Browser smoke test against a running forum server (headless Chrome via puppeteer-core):
// log in as MarvelsGrantMan136, browse, vote, comment, reply, post, subscribe, search, then
// check that POST /__rl/reset restores the database exactly.
//   node sites/forum/test/smoke.js [--base http://127.0.0.1:7200] [--chrome /usr/bin/google-chrome] [--port 7290] [--shots DIR]
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { values: a } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:7200' }, chrome: { type: 'string', default: '/usr/bin/google-chrome' }, port: { type: 'string', default: '7290' }, shots: { type: 'string' } } });
const BASE = a.base.replace(/\/$/, '');
const rl = async (p, body) => {
  const r = await fetch(BASE + '/__rl' + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${p}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const q1 = async (sql) => { const r = await rl('/query', { sql, raw: true }); return r.rows.length ? r.rows[0][0] : null; };
const SNAP = `SELECT json_object('submissions', (SELECT count(*) FROM submissions), 'max_sub', (SELECT max(id) FROM submissions), 'comments', (SELECT count(*) FROM comments),
  'votes', (SELECT count(*) FROM submission_votes) + (SELECT count(*) FROM comment_votes), 'score', (SELECT total(net_score) FROM submissions WHERE forum_id IN (SELECT id FROM forums WHERE name = 'books')),
  'subs', (SELECT count(*) FROM forum_subscriptions), 'notifications', (SELECT count(*) FROM notifications), 'sessions', (SELECT count(*) FROM kit_sessions),
  'comment_seq', (SELECT seq FROM sqlite_sequence WHERE name = 'comments'), 'fts', (SELECT count(*) FROM submissions_fts WHERE submissions_fts MATCH 'smoketest'))`;

const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const r = await fn(); steps.push({ name, ok: true, ms: Date.now() - t0, ...(r || {}) }); console.log(`ok   ${name} (${Date.now() - t0} ms)${r && r.note ? ' - ' + r.note : ''}`); }
  catch (e) { steps.push({ name, ok: false, error: e.message }); console.log(`FAIL ${name}: ${e.message}`); throw e; }
};

(async () => {
  await rl('/reset', {});
  const before = await q1(SNAP);
  const profile = fs.mkdtempSync(path.join((process.env.WSB_TMP || os.tmpdir()), 'wsb-forum-chrome-'));
  const browser = await puppeteer.launch({ executablePath: a.chrome, headless: true, args: ['--no-sandbox', `--remote-debugging-port=${a.port}`, `--user-data-dir=${profile}`, '--no-first-run'] });
  let failed = false;
  try {
    const newPage = async (ctx) => { const pg = await ctx.newPage(); await pg.setViewport({ width: 1280, height: 900 }); pg.on('dialog', (d) => d.accept()); return pg; };
    let page = await newPage(browser);
    const shot = async (n) => { if (a.shots) { fs.mkdirSync(a.shots, { recursive: true }); await page.screenshot({ path: path.join(a.shots, `${n}.png`) }); } };
    const go = (p) => page.goto(BASE + p, { waitUntil: 'load' });
    const clickNav = (sel) => Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click(sel)]);
    const text = (sel) => page.$eval(sel, (e) => e.textContent.trim());

    await step('front page', async () => { await go('/'); await shot('front'); return { note: await page.title() }; });
    await step('log in', async () => {
      await clickNav('a[href^="/login"]');
      await page.type('#login-username', 'MarvelsGrantMan136');
      await page.type('#login-password', 'test1234');
      await clickNav('.auth-box button[type=submit]');
      const who = await text('.user-menu summary');
      if (!who.includes('MarvelsGrantMan136')) throw new Error(`header shows ${who}`);
      // Headless Chrome (145) opens an invisible "save password?" prompt after a password form
      // is submitted, and it swallows all input to that window. Continue the same session in a
      // fresh browser context.
      const cookies = await page.cookies();
      await page.close();
      page = await newPage(await browser.createBrowserContext());
      await page.setCookie(...cookies);
      await go('/');
    });
    await step('browse forums -> /f/books -> top', async () => {
      await clickNav('.site-nav a[href="/forums"]');
      await clickNav('table.forum-table a[href="/f/books"]');
      await clickNav('.sort-tabs a[href="/f/books/top"]');
      const first = await page.$eval('.submission-list article', (e) => e.id);
      const want = await q1("SELECT 'submission-' || id FROM submissions WHERE forum_id = (SELECT id FROM forums WHERE name = 'books') AND visibility = 'visible' ORDER BY net_score DESC, id DESC LIMIT 1");
      if (first !== want) throw new Error(`top post ${first} != ${want}`);
      await shot('books-top');
      return { note: first };
    });
    let sid;
    await step('open a submission', async () => {
      await clickNav('.submission-list article:nth-of-type(2) a.submission__link');
      sid = +/\/f\/books\/(\d+)\//.exec(page.url())[1];
      return { note: page.url() };
    });
    await step('upvote (JS)', async () => {
      const s0 = +(await text(`#submission-${sid} .vote__net-score`));
      await page.click(`#submission-${sid} .vote__up`);
      await page.waitForFunction((id, s) => +document.querySelector(`#submission-${id} .vote__net-score`).textContent === s + 1, { timeout: 5000 }, sid, s0);
      const up = await q1(`SELECT upvote FROM submission_votes WHERE user_id = 13915 AND submission_id = ${sid}`);
      if (up !== 1) throw new Error('no vote row');
      const cls = await page.$eval(`#submission-${sid} form.vote`, (f) => f.className);
      if (!cls.includes('vote--user-upvoted')) throw new Error(`class ${cls}`);
    });
    await step('downvote a comment (JS)', async () => {
      const cid = await page.$eval('.comment-tree > details.comment', (e) => +e.id.split('-')[1]);
      await page.click(`#comment-${cid} > .comment__inner .vote__down`);
      await page.waitForFunction((id) => document.querySelector(`#comment-${id} > .comment__inner form.vote`).classList.contains('vote--user-downvoted'), { timeout: 5000 }, cid);
      if (await q1(`SELECT upvote FROM comment_votes WHERE user_id = 13915 AND comment_id = ${cid}`) !== 0) throw new Error('no comment vote row');
    });
    await step('post a comment', async () => {
      await page.type('#comment-new', 'Smoke test comment: great post!');
      await clickNav('.comment-form--top button[type=submit]');
      const flash = await text('.kit-flash');
      if (!/comment was posted/.test(flash)) throw new Error(`flash: ${flash}`);
      const n = await q1(`SELECT count(*) FROM comments WHERE submission_id = ${sid} AND user_id = 13915 AND body = 'Smoke test comment: great post!'`);
      if (n !== 1) throw new Error('comment not in DB');
      await shot('commented');
    });
    await step('reply to a comment', async () => {
      const cid = await page.$eval('.comment-tree > details.comment', (e) => +e.id.split('-')[1]);
      await page.click(`#comment-${cid} .reply-box > summary`);
      await page.type(`#reply-${cid}`, 'Smoke test reply');
      await clickNav(`#comment-${cid} .reply-box button[type=submit]`);
      const n = await q1(`SELECT count(*) FROM comments WHERE parent_id = ${cid} AND user_id = 13915 AND body = 'Smoke test reply'`);
      if (n !== 1) throw new Error('reply not in DB');
    });
    let newId;
    await step('create a text post', async () => {
      await clickNav('.site-nav a[href="/submit"]');
      await page.click('input[name=type][value=text]');
      await page.select('#submission_forum', 'books');
      await page.type('#submission_title', 'Smoketest: what are you reading this week?');
      await page.type('#submission_body', 'I am reading *Dune*.');
      await clickNav('#submission-form button[type=submit]');
      newId = +/\/f\/books\/(\d+)\/smoketest-what-are-you-reading-this-week$/.exec(page.url())[1];
      const t = await text('h1.submission__title');
      if (!t.startsWith('Smoketest: what are you reading')) throw new Error(`title ${t}`);
      if (await q1(`SELECT title FROM submissions WHERE id = ${newId}`) !== 'Smoketest: what are you reading this week?') throw new Error('post not in DB');
      await shot('new-post');
      return { note: page.url() };
    });
    await step('subscribe from the sidebar', async () => {
      await clickNav('#sidebar form.subscribe-form button');
      if (await q1("SELECT count(*) FROM forum_subscriptions WHERE user_id = 13915 AND forum_id = (SELECT id FROM forums WHERE name = 'books')") !== 1) throw new Error('not subscribed');
      await go('/');
      const side = await page.$$eval('#sidebar > section a', (as) => as.map((x) => x.getAttribute('href')));
      if (!side.includes('/f/books')) throw new Error('sidebar lacks /f/books');
    });
    await step('search from the header', async () => {
      await page.type('#site-search-q', 'smoketest reading');
      await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
      const hits = await page.$$eval('.search-results article', (as) => as.map((x) => x.id));
      if (!hits.includes(`submission-${newId}`)) throw new Error(`hits ${hits}`);
    });
    await step('reset restores everything', async () => {
      const during = await q1(SNAP);
      if (during === before) throw new Error('nothing changed before reset?');
      const r = await rl('/reset', {});
      const after = await q1(SNAP);
      if (after !== before) throw new Error(`after reset ${after} != before ${before}`);
      const resp = await go(`/f/books/${newId}/-`);
      if (resp.status() !== 404) throw new Error(`new post still there: ${resp.status()}`);
      const loggedOut = await page.$('a[href^="/login"]');
      if (!loggedOut) throw new Error('session survived the reset');
      return { note: `reset ${r.ms} ms` };
    });
  } catch (e) {
    failed = true;
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failed ? 'SMOKE FAILED' : `SMOKE OK (${steps.length} steps)`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
