#!/usr/bin/env node
'use strict';
// Browser smoke test against a running map server (headless Chrome via puppeteer-core):
// tiles render, search "Carnegie Mellon University", open the place, car directions
// CMU -> Pittsburgh International Airport (distance/time read from the DOM), switch to foot,
// back button, map click -> "Show address". Fails on any console error or failed request.
//   node sites/map/test/smoke.js [--base http://127.0.0.1:7600] [--chrome /usr/bin/google-chrome] [--port 7690] [--shots DIR]
const { parseArgs } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const { values: a } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:7600' }, chrome: { type: 'string', default: '/usr/bin/google-chrome' }, port: { type: 'string', default: '7690' }, shots: { type: 'string' } } });
const BASE = a.base.replace(/\/$/, '');
const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const r = await fn(); steps.push({ name, ok: true, ms: Date.now() - t0 }); console.log(`ok   ${name} (${Date.now() - t0} ms)${r ? ' - ' + r : ''}`); }
  catch (e) { steps.push({ name, ok: false, error: e.message }); console.log(`FAIL ${name}: ${e.message}`); throw e; }
};

(async () => {
  const tmpRoot = (process.env.WSB_TMP || os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tmpRoot, 'wsb-map-chrome-'));
  const browser = await puppeteer.launch({ executablePath: a.chrome, headless: true,
    args: ['--no-sandbox', `--remote-debugging-port=${a.port}`, `--user-data-dir=${profile}`, '--no-first-run', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,900'] });
  const errors = [];
  let failed = false;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure() && r.failure().errorText}`));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
    const shot = async (n) => { if (a.shots) { fs.mkdirSync(a.shots, { recursive: true }); await page.screenshot({ path: path.join(a.shots, `${n}.png`) }); } };
    const idle = () => page.waitForFunction(() => !document.body.classList.contains('loading'), { timeout: 20000 });
    const text = (sel) => page.$eval(sel, (e) => e.innerText.trim());
    const tilesLoaded = () => page.waitForFunction(() => window.wsbMap && window.wsbMap.loaded() && window.wsbMap.areTilesLoaded(), { timeout: 30000, polling: 200 });

    await step('home: map + tiles render', async () => {
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await tilesLoaded();
      const n = await page.evaluate(() => window.wsbMap.queryRenderedFeatures().length);
      if (n < 50) throw new Error(`only ${n} rendered features`);
      const attr = await text('.maplibregl-ctrl-attrib');
      if (!/OpenStreetMap contributors/.test(attr)) throw new Error('attribution: ' + attr);
      if (!/#map=\d+\/40\.44\d*\/-79\.94\d*/.test(page.url())) throw new Error('permalink hash: ' + page.url());
      await shot('1-home');
      return `${n} features; ${page.url().replace(BASE, '')}`;
    });

    let placeUrl;
    await step('search "Carnegie Mellon University"', async () => {
      await page.type('#query', 'Carnegie Mellon University');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#results_h');
      await idle();
      if (!page.url().includes('/search?query=Carnegie+Mellon+University')) throw new Error('url ' + page.url());
      const first = await text('.results-list li');
      if (!/^University\s+Carnegie Mellon University, .*Pittsburgh/.test(first)) throw new Error('first result: ' + first);
      await shot('2-search');
      return first.slice(0, 90);
    });

    await step('open the place', async () => {
      await page.click('.results-list li a');
      await page.waitForSelector('#place_h');
      await idle();
      placeUrl = page.url();
      const name = await text('#place_h'), addr = await text('.place-address'), ll = await text('.place-coords');
      if (name !== 'Carnegie Mellon University' || !/15213/.test(addr) || !/^40\.4\d+, -79\.9\d+$/.test(ll)) throw new Error(`${name} | ${addr} | ${ll}`);
      if (!/\/(relation|way|node)\/\d+#map=/.test(placeUrl)) throw new Error('url ' + placeUrl);
      const sb = await page.$eval('#sidebar_content', (e) => e.innerText);
      if (!sb.includes('Carnegie Mellon University')) throw new Error('#sidebar_content');
      await shot('3-place');
      return `${addr} @ ${ll}`;
    });

    let car;
    await step('car directions CMU -> Pittsburgh International Airport', async () => {
      await page.click('a.btn[href^="/directions?route="]');   // "Directions from here"
      await page.waitForSelector('#route_to');
      await idle();
      const from = await page.$eval('#route_from', (e) => e.value);
      if (!from.startsWith('Carnegie Mellon University')) throw new Error('from field: ' + from);
      await page.select('#route_engine', 'fossgis_osrm_car');
      await page.type('#route_to', 'Pittsburgh International Airport');
      await page.click('#directions_form button[type=submit]');
      await page.waitForSelector('.route-distance');
      await idle();
      await page.waitForFunction(() => document.body.dataset.routeDrawn === '1', { timeout: 10000 });
      const u = new URL(page.url());
      if (u.searchParams.get('engine') !== 'fossgis_osrm_car' || !/^40\.\d+,-79\.\d+;40\.\d+,-80\.\d+$/.test(u.searchParams.get('route'))) throw new Error('url ' + page.url());
      const sel = await page.$eval('div#content select.routing_engines', (e) => e.selectedIndex);
      if (sel !== 1) throw new Error('selectedIndex ' + sel);
      const to = await page.$eval('[name="route_to"]', (e) => e.value);
      if (!to.startsWith('Pittsburgh International Airport')) throw new Error('to field: ' + to);
      car = { d: await text('.route-distance'), t: await text('.route-time'), summary: await text('#routing_summary .summary-line') };
      const nSteps = await page.$$eval('.routing_step', (x) => x.length);
      if (!/km$/.test(car.d) || !/min$/.test(car.t) || nSteps < 5) throw new Error(JSON.stringify(car) + ' steps ' + nSteps);
      await tilesLoaded();
      await shot('4-car');
      return `${car.summary} (${nSteps} steps)`;
    });

    await step('switch to foot', async () => {
      await page.select('#route_engine', 'fossgis_osrm_foot');   // resubmits the form
      await page.waitForFunction(() => new URL(location.href).searchParams.get('engine') === 'fossgis_osrm_foot' && document.querySelector('.route-time'), { timeout: 20000 });
      await idle();
      const t = await text('.route-time'), d = await text('.route-distance');
      if (t === car.t || !/h /.test(t)) throw new Error(`foot time ${t}`);
      const sel = await page.$eval('select.routing_engines', (e) => e.selectedIndex);
      if (sel !== 2) throw new Error('selectedIndex ' + sel);
      await shot('5-foot');
      return `Distance: ${d}. Time: ${t}.`;
    });

    await step('back button returns to the car route', async () => {
      await page.goBack();
      await page.waitForFunction(() => new URL(location.href).searchParams.get('engine') === 'fossgis_osrm_car' && !document.body.classList.contains('loading'), { timeout: 20000 });
      const t = await text('.route-time');
      if (t !== car.t) throw new Error(`time ${t} != ${car.t}`);
    });

    await step('map click -> Show address (Where is this?)', async () => {
      await page.goto(BASE + '/#map=17/40.4443/-79.9436', { waitUntil: 'load' });
      await tilesLoaded();
      const box = await (await page.$('#map')).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector('.map-popup');
      await page.click('.map-popup a[href^="/search?lat="]');
      await page.waitForSelector('#where_h');
      await idle();
      const r = await text('#sidebar_content .results-list');
      if (!/Pittsburgh/.test(r)) throw new Error(r);
      await shot('6-whereis');
      return r.split('\n')[0];
    });

    await step('no console errors / failed requests', async () => {
      if (errors.length) throw new Error(errors.slice(0, 5).join(' || '));
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
