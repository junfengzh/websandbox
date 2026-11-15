#!/usr/bin/env node
'use strict';
// Browser smoke test against a running wiki server (headless Chrome via puppeteer-core):
// WebArena's Kiwix start URL -> landing page; type "Christopher Nolan" in the search box
// (autocomplete listbox shows it), Enter -> the article (infobox, TOC, references, images);
// open the filmography link; What links here; Random article; a misspelt full-text search
// shows "Showing results for"; page information. Fails on any console error, page error,
// failed request or HTTP >= 400 (except the deliberate 404 check at the end).
//   node sites/wiki/test/smoke.js [--base http://127.0.0.1:7500] [--chrome /usr/bin/google-chrome] [--port 7590] [--shots DIR]
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { values: a } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:7500' }, chrome: { type: 'string', default: '/usr/bin/google-chrome' }, port: { type: 'string', default: '7590' }, shots: { type: 'string' } } });
const BASE = a.base.replace(/\/$/, '');
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const r = await fn(); console.log(`ok   ${name} (${Date.now() - t0} ms)${r ? ' - ' + r : ''}`); }
  catch (e) { console.log(`FAIL ${name}: ${e.message}`); throw e; }
};
const assert = (c, msg) => { if (!c) throw new Error(msg); };

(async () => {
  const tmpRoot = (process.env.WSB_TMP || os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'wsb-wiki-chrome-'));
  const browser = await puppeteer.launch({ executablePath: a.chrome, headless: true,
    args: ['--no-sandbox', `--remote-debugging-port=${a.port}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1280,900'] });
  const errors = [];
  let failed = false, allow404 = false;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', (m) => { if (m.type() === 'error' && !(allow404 && /404/.test(m.text()))) errors.push('console: ' + m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure() && r.failure().errorText}`));
    page.on('response', (r) => { if (r.status() >= 400 && !allow404) errors.push(`HTTP ${r.status()} ${r.url()}`); });
    const shot = async (n) => { if (a.shots) { fs.mkdirSync(a.shots, { recursive: true }); await page.screenshot({ path: path.join(a.shots, `${n}.png`) }); } };
    const h1 = () => page.$eval('#firstHeading', (e) => e.textContent.trim());
    const nav = (fn) => Promise.all([page.waitForNavigation({ waitUntil: 'load' }), fn()]);
    // every <img> on the page: load all lazy ones and check they decoded
    const imagesOk = async () => {
      await page.evaluate(() => document.querySelectorAll('img[loading=lazy]').forEach((i) => { i.loading = 'eager'; }));
      await page.waitForFunction(() => [...document.images].every((i) => i.complete), { timeout: 20000 });
      const bad = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth && !/\.svg$/.test(i.src)).map((i) => i.src));
      assert(!bad.length, 'broken images: ' + bad.slice(0, 3).join(', '));
      return page.evaluate(() => document.images.length);
    };

    await step('WebArena Kiwix start URL -> landing page', async () => {
      await page.goto(BASE + '/wikipedia_en_all_maxi_2022-05/A/User:The_other_Kiwix_guy/Landing', { waitUntil: 'load' });
      assert(page.url() === BASE + '/wiki/User:The_other_Kiwix_guy/Landing', 'url ' + page.url());
      const n = await page.$$eval('#mw-content-text a[href^="/wiki/"]', (x) => x.length);
      assert(n > 50, `landing topic links: ${n}`);
      await shot('1-landing');
      return `${n} topic links`;
    });

    await step('search box autocomplete + Go -> Christopher Nolan', async () => {
      await page.type('#searchInput', 'Christopher Nol', { delay: 20 });
      await page.waitForSelector('#searchSuggestions:not([hidden]) li[role=option]');
      const opts = await page.$$eval('#searchSuggestions li[role=option]', (x) => x.map((e) => e.textContent.trim()));
      assert(opts[0] === 'Christopher Nolan', 'suggestions: ' + opts.join(' | '));
      assert(await page.$eval('#searchInput', (e) => e.getAttribute('aria-expanded')) === 'true', 'aria-expanded');
      await shot('2-suggest');
      await page.type('#searchInput', 'an');
      await nav(() => page.keyboard.press('Enter'));
      assert(page.url() === BASE + '/wiki/Christopher_Nolan', 'url ' + page.url());
      assert(await h1() === 'Christopher Nolan', 'h1');
      const toc = await page.$$eval('#toc .toctext', (x) => x.map((e) => e.textContent));
      assert(toc.includes('1993–2003: Early career and breakthrough'), 'toc: ' + toc.join(' | '));
      assert(await page.$('table.infobox'), 'infobox');
      const refs = await page.$$eval('ol.references li', (x) => x.length);
      assert(refs > 100, 'references ' + refs);
      // TOC link scrolls to its section
      await page.click('#toc a[href="#Filmography"]');
      assert(page.url().endsWith('#Filmography'), 'toc anchor');
      const imgs = await imagesOk();
      await shot('3-nolan');
      return `${toc.length} TOC entries, ${refs} references, ${imgs} images`;
    });

    await step('open the filmography link', async () => {
      await nav(() => page.click('#mw-content-text a[href="/wiki/Christopher_Nolan_filmography"]'));
      assert(await h1() === 'Christopher Nolan filmography', 'h1 ' + await h1());
      const text = await page.$eval('#mw-content-text', (e) => e.innerText);
      for (const f of ['Following', 'Memento', 'Inception', 'Tenet']) assert(text.includes(f), 'missing ' + f);
      await imagesOk();
      await shot('4-filmography');
    });

    await step('What links here (tools menu)', async () => {
      await nav(() => page.click('#t-whatlinkshere a'));
      assert(page.url() === BASE + '/wiki/Special:WhatLinksHere/Christopher_Nolan_filmography', 'url ' + page.url());
      const links = await page.$$eval('#mw-whatlinkshere-list a', (x) => x.map((e) => e.textContent));
      assert(links.includes('Christopher Nolan'), 'list: ' + links.slice(0, 10).join(' | '));
      const sum = await page.$eval('#mw-whatlinkshere-summary', (e) => e.textContent);
      await shot('5-whatlinkshere');
      return sum.replace(/\s+/g, ' ').trim();
    });

    await step('Random article', async () => {
      await nav(() => page.click('#n-random a'));
      assert(/\/wiki\/[^:]+$/.test(page.url()) || /\/wiki\//.test(page.url()), 'url ' + page.url());
      const t = await h1();
      assert(t.length > 0, 'h1');
      await imagesOk();
      await shot('6-random');
      return t;
    });

    await step('full-text search with a typo -> did you mean', async () => {
      await page.goto(BASE + '/w/index.php?search=mackinaw+brige&title=Special%3ASearch&fulltext=1', { waitUntil: 'load' });
      const dym = await page.$eval('.searchdidyoumean', (e) => e.textContent.replace(/\s+/g, ' ').trim());
      assert(/Showing results for mackinaw bridge/.test(dym), dym);
      const first = await page.$eval('.mw-search-result-heading a', (e) => e.textContent);
      assert(first === 'Mackinac Bridge', 'first result ' + first);
      await shot('7-search');
      return first;
    });

    await step('page information', async () => {
      await page.goto(BASE + '/wiki/Mackinac_Bridge', { waitUntil: 'load' });
      await nav(() => page.click('#t-info a'));
      const t = await h1();
      assert(t === 'Information for "Mackinac Bridge"', t);
    });

    await step('missing article -> 404 page with search link', async () => {
      allow404 = true;
      const r = await page.goto(BASE + '/wiki/No_such_article_zzqx', { waitUntil: 'load' });
      assert(r.status() === 404, 'status ' + r.status());
      assert(await page.$('.noarticletext a[href*="fulltext=1"]'), 'search link');
      allow404 = false;
    });

    if (errors.length) throw new Error('browser errors:\n  ' + errors.join('\n  '));
    console.log('smoke ok');
  } catch (e) {
    failed = true;
    console.error(e.message);
    if (errors.length) console.error(errors.join('\n'));
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();
