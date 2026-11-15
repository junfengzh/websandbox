#!/usr/bin/env node
'use strict';
// Browser smoke test of the storefront (headless Chrome via puppeteer-core):
// sign in as emma.lopez@gmail.com, browse a category and sort it, search, add to cart,
// check out, see the order in My Orders, then /__rl/reset and see it gone.
//
//   node sites/store/storefront/dev/smoke.js [--port 7302] [--data DIR] [--shots DIR]
// puppeteer-core: resolved from PUPPETEER_CORE_DIR, else $WSB_TMP/store/node_modules
// (npm i puppeteer-core there). Password: STORE_TEST_PASSWORD or WebArena env_config.py (never printed).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { values: o } = parseArgs({ options: { port: { type: 'string', default: '7302' }, data: { type: 'string', default: path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../../..', 'data'), 'store') }, shots: { type: 'string' }, chrome: { type: 'string', default: '/usr/bin/google-chrome' } } });
const ppDir = process.env.PUPPETEER_CORE_DIR || path.join((process.env.WSB_TMP || os.tmpdir()), 'store', 'node_modules');
const puppeteer = require(require.resolve('puppeteer-core', { paths: [ppDir] }));
function password() {
  if (process.env.STORE_TEST_PASSWORD) return process.env.STORE_TEST_PASSWORD;
  const f = path.join(__dirname, '../../../../../3rd-party/webarena/browser_env/env_config.py');
  const m = /"shopping":\s*\{\s*"username":\s*"[^"]+",\s*"password":\s*"([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
  if (!m) throw new Error('no demo password (set STORE_TEST_PASSWORD)');
  return m[1];
}
const ok = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); console.log(`ok - ${msg}`); };

(async () => {
  const tmp = fs.mkdtempSync(path.join((process.env.WSB_TMP || os.tmpdir()), 'wsb-store-smoke-'));
  const site = require('../../server.js');
  const s = await site.start({ tenants: 1, port: +o.port, data: o.data, bind: 'ports', uploads: path.join(tmp, 'uploads') });
  const base = s.url(0);
  const ctrl = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  await ctrl('/__rl/reset', { now: '2023-06-12T16:00:00Z', frozen: true });
  const browser = await puppeteer.launch({ executablePath: o.chrome, headless: 'new', args: ['--no-sandbox', `--user-data-dir=${path.join(tmp, 'chrome')}`, `--remote-debugging-port=${+o.port + 40}`] });
  let n = 0;
  const shot = async (page, name) => { if (o.shots) { fs.mkdirSync(o.shots, { recursive: true }); await page.screenshot({ path: path.join(o.shots, `${String(++n).padStart(2, '0')}-${name}.png`) }); } };
  try {
    let page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);
    await page.setViewport({ width: 1280, height: 900 });
    const go = (p) => page.goto(base + p, { waitUntil: 'domcontentloaded' });
    const nav = (fn) => Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), fn()]).catch((e) => { throw new Error(`${e.message} (at ${page.url()})`); });
    const text = () => page.evaluate(() => document.body.innerText);

    // sign in
    await go('/customer/account/login/');
    await page.type('#email', 'emma.lopez@gmail.com');
    await page.type('#pass', password());
    await nav(() => page.click('#send2'));
    ok((await text()).includes('Welcome, Emma Lopez!'), 'signed in as Emma Lopez');
    await shot(page, 'account');
    // headless Chrome stops delivering mouse input to a tab after a password form was
    // submitted in it (password-manager UI); continue in a fresh tab (same cookies)
    const fresh = await browser.newPage();
    fresh.setDefaultNavigationTimeout(90000);
    await fresh.setViewport({ width: 1280, height: 900 });
    await page.close();
    page = fresh;

    // browse a category via the menu, sort by price (descending)
    await go('/');
    await nav(() => page.click('nav.navigation a[href="/video-games.html"]'));
    ok((await page.title()).startsWith('Video Games'), 'category page via the menu');
    const sortUrl = await page.$eval('#sorter', (s) => [...s.options].find((x) => x.text === 'Price').value);
    await nav(() => page.select('#sorter', sortUrl));
    await nav(() => page.click('a.sorter-action'));
    ok(/product_list_order=price/.test(page.url()) && /product_list_dir=desc/.test(page.url()), `sorted by price desc: ${page.url().replace(base, '')}`);
    const prices = await page.$$eval('.product-items [data-price-type="finalPrice"] .price', (els) => els.map((e) => +e.textContent.replace(/[$,]/g, '')));
    ok(prices.length > 3 && prices.every((p, i) => i === 0 || prices[i - 1] >= p), 'prices descending');
    await shot(page, 'category');

    // search from the header box
    await page.type('#search', 'usb wifi');
    await nav(() => page.keyboard.press('Enter'));
    ok(/\/catalogsearch\/result\/\?q=usb\+wifi/.test(page.url()), 'search URL /catalogsearch/result/?q=usb+wifi');
    const hits = await page.$$('.product-items .product-item');
    ok(hits.length > 0, `search results: ${hits.length} on page 1`);
    await shot(page, 'search');

    // open the first product that can go straight to the cart, add 1
    const href = await page.$$eval('.product-items .product-item', (els) => { const e = els.find((x) => x.querySelector('form.tocart-form')); return e && e.querySelector('a.product-item-link').getAttribute('href'); });
    ok(!!href, `product with a direct Add to Cart: ${href}`);
    await go(href);
    const name = (await page.$eval('h1.page-title .base', (e) => e.textContent)).trim();
    await nav(() => page.click('#product-addtocart-button'));
    ok(page.url().endsWith('/checkout/cart/') && (await text()).includes(`You added ${name}`), 'added to cart');
    await shot(page, 'cart');

    // checkout: default address, flat rate, check / money order
    await nav(() => page.click('a.action.checkout'));
    ok((await text()).includes('Shipping Methods'), 'checkout shipping step');
    await page.click('#s_method_flatrate_flatrate');
    await nav(() => page.click('#shipping-method-buttons-container button'));
    ok(page.url().endsWith('/checkout/payment/'), 'payment step');
    await shot(page, 'payment');
    await nav(() => page.click('button.action.checkout'));
    const num = await page.$eval('a.order-number strong', (e) => e.textContent.trim());
    ok(/^\d{9}$/.test(num), `order placed: #${num}`);
    await shot(page, 'success');

    // My Orders shows it first, Pending
    await go('/sales/order/history/');
    const first = await page.$eval('#my-orders-table tbody tr', (tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()));
    ok(first[0] === num && first[4] === 'Pending', `order history row: ${first.slice(0, 5).join(' | ')}`);
    await nav(() => page.click('#my-orders-table tbody tr a.action.view'));
    ok((await text()).includes(name), 'order view lists the product');
    await shot(page, 'order');

    // reset: the order (and the session) are gone
    const r = await ctrl('/__rl/reset', { now: '2023-06-12T16:00:00Z', frozen: true });
    ok(r.ok, `reset in ${r.ms} ms`);
    const q = await ctrl('/__rl/query', { sql: 'SELECT count(*) AS n FROM orders WHERE increment_id = ?', params: [num] });
    ok(q.rows[0].n === 0, 'order rolled back');
    await go('/sales/order/history/');
    ok(page.url().includes('/customer/account/login'), 'signed out after reset');
    console.log('smoke: all ok');
  } finally {
    await browser.close();
    await s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
