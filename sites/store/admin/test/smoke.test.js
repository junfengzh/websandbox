'use strict';
// Browser smoke test of the back office (headless Chrome via puppeteer-core), node --test:
// sign in through the form, edit a product price, add an order comment, approve a review, run
// a sales report through the menu (background job), then /__rl/reset and see everything undone.
// puppeteer-core: PUPPETEER_CORE_DIR, else $WSB_TMP/store/node_modules or
// $WSB_TMP/shot/node_modules (skipped if none). Chrome: CHROME (default /usr/bin/google-chrome).
// Admin password: STORE_ADMIN_PASSWORD or WebArena env_config.py (never printed); without it the
// browser gets an admin session cookie from POST /__rl/login instead of the form.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = process.env.STORE_DATA || '$WSB_DATA_ROOT/store';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const TMP = (process.env.WSB_TMP || os.tmpdir());
function loadPuppeteer() {
  const dirs = [process.env.PUPPETEER_CORE_DIR, path.join(TMP, 'store', 'node_modules'), path.join(TMP, 'shot', 'node_modules')].filter(Boolean);
  for (const d of dirs) { try { return require(require.resolve('puppeteer-core', { paths: [d] })); } catch {} }
  return null;
}
function adminPassword() {
  if (process.env.STORE_ADMIN_PASSWORD) return process.env.STORE_ADMIN_PASSWORD;
  const f = path.join(__dirname, '../../../../../3rd-party/webarena/browser_env/env_config.py');
  const m = fs.existsSync(f) && /"shopping_admin":\s*\{\s*"username":\s*"admin",\s*"password":\s*"([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
  return m ? m[1] : null;
}
const puppeteer = loadPuppeteer();
const ctrl = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const one = async (base, sql) => { const r = (await ctrl(base, '/__rl/query', { sql })).rows; return r[0] ? Object.values(r[0])[0] : undefined; };

test('back office in a browser', { skip: (!puppeteer && 'puppeteer-core not found') || (!fs.existsSync(CHROME) && 'no Chrome'), timeout: 180000 }, async () => {
  const site = require('../../server.js');
  const tmp = fs.mkdtempSync(path.join(TMP, 'wsb-admin-smoke-'));
  const s = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: path.join(tmp, 'uploads'), jobTickMs: 100 });
  const base = s.url(0);
  await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', `--user-data-dir=${path.join(tmp, 'profile')}`, '--remote-debugging-port=7391'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    page.on('dialog', (d) => d.accept());
    const go = (u) => page.goto(base + u, { waitUntil: 'domcontentloaded' });
    const clickNav = (sel) => Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click(sel)]);
    const flash = () => page.$$eval('#messages .message', (xs) => xs.map((x) => x.textContent.trim()).join(' | '));

    // 1. sign in
    await go('/admin');
    const pw = adminPassword();
    if (pw) {
      await page.type('#username', 'admin');
      await page.type('#login', pw);
      await clickNav('button.action-login');
    } else {
      const r = await ctrl(base, '/__rl/login', { user: 'admin' });
      await page.setCookie({ name: r.cookie.name, value: r.cookie.value, url: base });
      await go('/admin/dashboard/');
    }
    assert.match(await page.$eval('h1.page-title', (e) => e.textContent), /Dashboard/);
    assert.match(await page.$eval('#lifetime-sales', (e) => e.textContent), /^\$[\d,]+\.\d\d$/);

    // 2. product price via the edit form
    await go('/admin/catalog/product/edit/id/1481/');
    assert.equal(await page.$eval('[name="product[price]"]', (e) => e.value), '32.00');
    await page.$eval('[name="product[price]"]', (e) => { e.value = ''; });
    await page.type('[name="product[price]"]', '27');
    await clickNav('#save');
    assert.match(await flash(), /You saved the product/);
    assert.equal(await page.$eval('[name="product[price]"]', (e) => e.value), '27.00');
    assert.equal(await one(base, 'SELECT price FROM products WHERE id = 1481'), 27);

    // 3. order comment
    await go('/admin/sales/order/view/order_id/299/');
    await page.type('#history_comment', 'the order is ready to be shipped soon!');
    await page.click('#history_notify');
    await clickNav('#submit_comment');
    assert.match(await flash(), /comment has been added/);
    assert.match(await page.$eval('.note-list', (e) => e.textContent), /ready to be shipped soon/);
    assert.equal(await one(base, "SELECT is_customer_notified FROM order_status_history WHERE order_id = 299 AND comment LIKE 'the order is ready%'"), 1);

    // 4. approve a pending review
    await go('/admin/review/product/pending/');
    assert.match(await page.$eval('[data-records-found]', (e) => e.textContent), /^5$/);
    await go('/admin/review/product/edit/id/352/');
    await page.select('[name="status_id"]', '1');
    await clickNav('#save_button');
    assert.match(await flash(), /You saved the review/);
    assert.equal(await one(base, 'SELECT status FROM reviews WHERE id = 352'), 'approved');

    // 5. sales report through the menu: Reports > Orders, Feb 2023 by month
    await go('/admin/dashboard/');
    await page.click('#menu-magento-backend .item-reports > a');
    await page.waitForSelector('#submenu-reports:not([hidden])');
    await clickNav('#submenu-reports a[href="/admin/reports/report_sales/sales/"]');
    await page.type('#sales_report_from', '2/1/23');
    await page.type('#sales_report_to', '2/28/23');
    await page.select('#sales_report_period_type', 'month');
    await clickNav('#filter_form_submit');
    assert.match(page.url(), /\/admin\/reports\/report_sales\/sales\/\?/);
    await page.waitForSelector('#gridReport', { timeout: 30000 }); // the page reloads until the job is done
    assert.equal(await page.$eval('#sales_report_from', (e) => e.value), '2/1/23');
    const cells = await page.$$eval('#gridReport tbody tr', (rows) => rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()));
    assert.ok(cells.length >= 1);
    assert.equal(await one(base, "SELECT status FROM admin_report_runs WHERE type = 'sales'"), 'done');

    // 6. reset undoes everything
    await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
    assert.equal(await one(base, 'SELECT price FROM products WHERE id = 1481'), 32);
    assert.equal(await one(base, 'SELECT count(*) FROM order_status_history WHERE order_id = 299'), 0);
    assert.equal(await one(base, 'SELECT status FROM reviews WHERE id = 352'), 'pending');
    await go('/admin/catalog/product/edit/id/1481/');
    assert.match(page.url(), /auth\/login/, 'sessions are reset too');
  } finally {
    await browser.close();
    await s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
