'use strict';
// Back-office route tests on the real store data (node --test sites/store/admin/test/).
// Needs $WSB_DATA_ROOT/store (or STORE_DATA). The admin password comes from
// STORE_ADMIN_PASSWORD, else WebArena's env_config.py (never printed); without it the
// form-login test is skipped and the rest use POST /__rl/login.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = process.env.STORE_DATA || '$WSB_DATA_ROOT/store';
function adminPassword() {
  if (process.env.STORE_ADMIN_PASSWORD) return process.env.STORE_ADMIN_PASSWORD;
  const f = path.join(__dirname, '../../../../../3rd-party/webarena/browser_env/env_config.py');
  const m = fs.existsSync(f) && /"shopping_admin":\s*\{\s*"username":\s*"admin",\s*"password":\s*"([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
  return m ? m[1] : null;
}

class Client {
  constructor(base) { this.base = base; this.jar = new Map(); }
  async req(method, p, { form, headers = {} } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = kv.slice(i + 1);
      if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
  }
  get(p) { return this.req('GET', p); }
  async csrf(p = '/admin/dashboard/') { const r = await this.get(p); return (/name="csrf-token" content="([^"]+)"/.exec(r.text) || [])[1]; }
  // POST a form with the CSRF token of page `from` (as a browser would)
  async post(p, form, from = '/admin/dashboard/') {
    const pairs = Array.isArray(form) ? form : Object.entries(form);
    return this.req('POST', p, { form: [...pairs, ['_csrf', await this.csrf(from)]] });
  }
  async follow(r) { let x = r; for (let i = 0; i < 5 && x.location; i++) x = await this.get(x.location); return x; }
}
const ctrl = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const query = async (base, sql, params) => (await ctrl(base, '/__rl/query', { sql, params })).rows;
const one = async (base, sql, params) => { const r = await query(base, sql, params); return r[0] ? Object.values(r[0])[0] : undefined; };
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

let s; let base;
async function adminClient() {
  const c = new Client(base);
  const r = await ctrl(base, '/__rl/login', { user: 'admin' });
  c.jar.set(r.cookie.name, r.cookie.value);
  return c;
}
test.before(async () => {
  const site = require('../../server.js');
  const root = (process.env.WSB_TMP || os.tmpdir());
  const up = fs.mkdtempSync(path.join(root, 'wsb-admin-test-'));
  s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: up, jobTickMs: 50 });
  base = s.url(0);
  await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
});
test.after(async () => { if (s) await s.close(); });

test('anonymous admin URLs show the sign-in form; customers are not admins', async () => {
  const c = new Client(base);
  let r = await c.get('/admin/catalog/product/edit/id/1481/');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/admin\/admin\/auth\/login\?next=/);
  r = await c.get('/admin');
  assert.equal(r.status, 200);
  assert.match(r.text, /name="login\[username\]"/);
  const cust = await ctrl(base, '/__rl/login', { user: 'emma.lopez@gmail.com' });
  c.jar.set(cust.cookie.name, cust.cookie.value);
  r = await c.get('/admin/dashboard/');
  assert.equal(r.status, 302, 'a customer session is not an admin session');
});

test('admin login form, dashboard, sign out', { skip: !adminPassword() && 'no admin password' }, async () => {
  const c = new Client(base);
  const csrf = await c.csrf('/admin');
  let r = await c.req('POST', '/admin/admin/auth/login/', { form: { 'login[username]': 'admin', 'login[password]': 'wrong', _csrf: csrf } });
  assert.match(r.text, /account sign-in was incorrect/);
  r = await c.req('POST', '/admin/admin/auth/login/', { form: { 'login[username]': 'admin', 'login[password]': adminPassword(), _csrf: await c.csrf('/admin'), next: '/admin/sales/order/' } });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin/sales/order/');
  assert.ok(c.jar.has('wsb_admin_sid'), 'admin session cookie');
  r = await c.get('/admin/dashboard/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Lifetime Sales/);
  assert.match(r.text, /id="lifetime-sales">\$[\d,]+\.\d\d/);
  assert.match(text(r.text), /Top Search Terms Search Term Results Uses hollister 1 19/);
  r = await c.post('/admin/admin/auth/logout/', {});
  assert.equal(r.status, 302);
  r = await c.get('/admin/dashboard/');
  assert.equal(r.status, 302);
});

test('product grid: keyword, filters, sort, columns, paging', async () => {
  const c = await adminClient();
  let r = await c.get('/admin/catalog/product/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<span data-records-found>106,408<\/span> records found/);
  r = await c.get('/admin/catalog/product/?q=hollister');
  assert.match(r.text, /Hollister Backyard Sweatshirt/);
  r = await c.get('/admin/catalog/product/?qty_from=10&qty_to=10&cols=id,sku,qty&per_page=200');
  const n = await one(base, 'SELECT count(*) FROM products WHERE qty = 10');
  assert.match(r.text, new RegExp(`<span data-records-found>${n.toLocaleString('en-US')}</span>`));
  assert.match(r.text, /admin__data-grid-filters-current/);
  assert.doesNotMatch(r.text, /<th[^>]*><a[^>]*>Thumbnail/, 'column chooser hides thumbnail');
  r = await c.get('/admin/catalog/product/?name=sweatshirt&sort=price_desc&cols=id,name,price');
  const prices = [...r.text.matchAll(/<td class="num"><div class="data-grid-cell-content">\$([\d,.]+)/g)].map((m) => +m[1].replace(/,/g, ''));
  assert.ok(prices.length > 3);
  assert.deepEqual(prices, [...prices].sort((a, b) => b - a));
  r = await c.get('/admin/catalog/product/?sort=name_asc&page=3');
  assert.equal(r.status, 200);
  assert.match(r.text, /value="3" class="admin__control-text"/);
});

test('edit a product price, stock, attributes; mass status; variants', async () => {
  const c = await adminClient();
  let r = await c.get('/admin/catalog/product/edit/id/1481/');
  assert.match(r.text, /name="product\[price\]" value="32.00"/);
  r = await c.post('/admin/catalog/product/save/id/1481/', { 'product[price]': '27', 'product[quantity_and_stock_status][qty]': '5', 'product[quantity_and_stock_status][is_in_stock]': '1' }, '/admin/catalog/product/edit/id/1481/');
  assert.equal(r.status, 302);
  r = await c.follow(r);
  assert.match(r.text, /You saved the product/);
  assert.match(r.text, /name="product\[price\]" value="27.00"/);
  assert.deepEqual((await query(base, 'SELECT price, qty FROM products WHERE id = 1481'))[0], { price: 27, qty: 5 });
  // the product grid (temp shadow) follows the write
  r = await c.get('/admin/catalog/product/?id_from=1481&id_to=1481&cols=id,price,qty');
  assert.match(r.text, /\$27\.00/);
  // validation
  r = await c.post('/admin/catalog/product/save/id/1481/', { 'product[price]': '-3' }, '/admin/catalog/product/edit/id/1481/');
  assert.equal(r.status, 422);
  assert.match(r.text, /Please enter a number 0 or greater/);
  // long-tail attribute: Hollister on sale
  r = await c.post('/admin/catalog/product/save/id/126/', { 'product[_attrs]': 'sale', 'product[sale]': '1' }, '/admin/catalog/product/edit/id/126/');
  assert.equal(await one(base, "SELECT value FROM product_attributes WHERE product_id = 126 AND attribute_code = 'sale'"), '1');
  // mass disable
  r = await c.post('/admin/catalog/product/massAction/', [['mass_action', 'status_2'], ['selected', '78'], ['selected', '79']], '/admin/catalog/product/');
  assert.equal(await one(base, 'SELECT group_concat(status) FROM products WHERE id IN (78, 79)'), '2,2');
  // add a configuration (Phoebe Zipper Sweatshirt, S, Brown)
  r = await c.post('/admin/catalog/product/addVariant/id/1130/', { 'variant[size]': '167', 'variant[color]': '51', 'variant[qty]': '3' }, '/admin/catalog/product/edit/id/1130/');
  assert.equal(r.status, 302);
  r = await c.follow(r);
  assert.match(r.text, /Phoebe Zipper Sweatshirt-S-Brown/);
  assert.equal(await one(base, "SELECT count(*) FROM product_variants v JOIN products p ON p.id = v.child_id WHERE v.parent_id = 1130 AND p.name = 'Phoebe Zipper Sweatshirt-S-Brown'"), 1);
  // new simple product
  r = await c.post('/admin/catalog/product/save/set/9/type/simple/', { 'product[name]': 'Energy-Bulk Women Shirt', 'product[sku]': 'EBWS-1', 'product[price]': '60', 'product[quantity_and_stock_status][qty]': '50', 'product[size]': '167', 'product[color]': '50', 'product[category_ids_present]': '1', 'product[category_ids][]': '21' }, '/admin/catalog/product/new/set/9/type/simple/');
  assert.equal(r.status, 302);
  const np = (await query(base, "SELECT id, price, qty, size, color, attribute_set_id, url_key FROM products WHERE sku = 'EBWS-1'"))[0];
  assert.deepEqual({ ...np, id: undefined }, { id: undefined, price: 60, qty: 50, size: 'S', color: 'Blue', attribute_set_id: 9, url_key: 'energy-bulk-women-shirt' });
  assert.equal(await one(base, 'SELECT count(*) FROM product_categories WHERE product_id = ? AND category_id = 21', [np.id]), 1);
});

test('orders: comment, ship with tracking, invoice, credit memo, cancel, address, fraud filter', async () => {
  const c = await adminClient();
  let r = await c.get('/admin/sales/order/view/order_id/299/');
  assert.match(r.text, /id="order_status"[^>]*>Pending</);
  r = await c.post('/admin/sales/order/addComment/order_id/299/', { 'history[status]': 'pending', 'history[comment]': 'the order is ready to be shipped soon!', 'history[is_customer_notified]': '1' }, '/admin/sales/order/view/order_id/299/');
  assert.equal(r.status, 302);
  assert.deepEqual((await query(base, "SELECT comment, is_customer_notified FROM order_status_history WHERE order_id = 299 AND comment LIKE 'the order is ready%'"))[0], { comment: 'the order is ready to be shipped soon!', is_customer_notified: 1 });
  r = await c.post('/admin/admin/order_shipment/save/order_id/299/', { 'tracking[0][carrier_code]': 'fedex', 'tracking[0][number]': '8974568499' }, '/admin/admin/order_shipment/new/order_id/299/');
  assert.equal(r.status, 302);
  r = await c.get('/admin/sales/order/commentsHistory/order_id/299/active_tab/order_shipments/');
  assert.match(r.text, /Tracking number 8974568499 for Federal Express assigned/);
  r = await c.post('/admin/sales/order_invoice/save/order_id/299/', {}, '/admin/sales/order_invoice/new/order_id/299/');
  assert.deepEqual((await query(base, 'SELECT state, total_invoiced, total_paid FROM orders WHERE id = 299'))[0], { state: 'complete', total_invoiced: 219.4, total_paid: 219.4 });
  r = await c.post('/admin/sales/order_creditmemo/save/order_id/299/', {}, '/admin/sales/order_creditmemo/new/order_id/299/');
  assert.deepEqual((await query(base, 'SELECT state, total_refunded FROM orders WHERE id = 299'))[0], { state: 'closed', total_refunded: 219.4 });
  r = await c.post('/admin/sales/order/cancel/order_id/302/', {}, '/admin/sales/order/view/order_id/302/');
  r = await c.follow(r);
  assert.match(r.text, /id="order_status"[^>]*>Canceled</);
  r = await c.post('/admin/sales/order/addressSave/address_id/597/', { firstname: 'Sarah', lastname: 'Miller', 'street[0]': '456 Oak Avenue', 'street[1]': 'Apartment 5B', city: 'New York', country_id: 'US', region_id: '43', postcode: '10001', telephone: '5107819902' }, '/admin/sales/order/address/address_id/597/');
  assert.equal(await one(base, 'SELECT street || \'|\' || city || \'|\' || region || \'|\' || postcode FROM order_addresses WHERE id = 597'), '456 Oak Avenue\nApartment 5B|New York|New York|10001');
  r = await c.get('/admin/sales/order/?status=fraud');
  assert.match(text(r.text), /Active filters: Status: Suspected Fraud/);
  r = await c.get('/admin/sales/order/?q=000000299');
  assert.match(r.text, /<span data-records-found>1<\/span>/);
});

test('reviews: approve, pending grid, mass delete, missing review', async () => {
  const c = await adminClient();
  let r = await c.get('/admin/review/product/pending/');
  assert.match(r.text, /<span data-records-found>5<\/span>/);
  r = await c.get('/admin/review/product/edit/id/352/');
  assert.match(r.text, /name="status_id"/);
  r = await c.post('/admin/review/product/save/id/352/', { status_id: '1', nickname: 'Valorie', title: 'x', detail: 'y' }, '/admin/review/product/edit/id/352/');
  assert.equal(r.status, 302);
  assert.equal(await one(base, 'SELECT status FROM reviews WHERE id = 352'), 'approved');
  r = await c.get('/admin/review/product/pending/');
  assert.match(r.text, /<span data-records-found>4<\/span>/);
  r = await c.post('/admin/review/product/massAction/', [['mass_action', 'delete'], ['selected', '347'], ['back_url', '/admin/review/product/pending/']], '/admin/review/product/pending/');
  assert.equal(await one(base, 'SELECT count(*) FROM reviews WHERE id = 347'), 0);
  r = await c.get('/admin/review/product/edit/id/347/');
  assert.equal(r.status, 404);
  assert.match(r.text, /Rating isn't Available/);
  r = await c.get('/admin/review/product/?name=circe');
  assert.match(r.text, /Circe Hooded Ice Fleece/);
});

test('sales report via background job; statistics refresh', async () => {
  const c = await adminClient();
  const url = '/admin/reports/report_sales/sales/?report_from=1/1/22&report_to=12/31/22&report_period=year&filter=1';
  let r = await c.get(url);
  assert.match(r.text, /being generated/);
  assert.equal(await one(base, "SELECT count(*) FROM kit_jobs WHERE type = 'admin.report'"), 1);
  await ctrl(base, '/__rl/jobs/run');
  r = await c.get(url);
  assert.match(r.text, /id="gridReport"/);
  const row = text(r.text).match(/Interval Orders .*? 2022 (\d+) /);
  assert.ok(row, 'a 2022 row');
  assert.equal(+row[1], await one(base, "SELECT count(*) FROM orders WHERE state NOT IN ('new', 'pending_payment') AND created_at >= '2022-01-01 05:00:00' AND created_at < '2023-01-01 05:00:00'"));
  assert.equal(await one(base, "SELECT status FROM admin_report_runs WHERE type = 'sales'"), 'done');
  assert.match(r.text, /id="sales_report_from" name="report_from" value="1\/1\/22"/);
  // bestsellers 2022: Quest Lumaflex Band first (as in WebArena)
  r = await c.get('/admin/reports/report_sales/bestsellers/?report_from=1/1/22&report_to=12/31/22&report_period=year');
  await ctrl(base, '/__rl/jobs/run');
  r = await c.get('/admin/reports/report_sales/bestsellers/?report_from=1/1/22&report_to=12/31/22&report_period=year');
  assert.match(text(r.text), /Interval Product Price Order Quantity 2022 Quest Lumaflex(?:&trade;|™) Band \$19\.00 5/);
  // refresh statistics -> report_* rows with source 'live'
  r = await c.post('/admin/reports/report_statistics/refresh/', [['mode', 'lifetime'], ['codes', 'report_order_aggregated'], ['codes', 'report_bestsellers_aggregated']], '/admin/reports/report_statistics/');
  await ctrl(base, '/__rl/jobs/run');
  assert.ok(await one(base, "SELECT count(*) FROM report_bestsellers WHERE source = 'live' AND period_type = 'yearly'") > 0);
  assert.ok(await one(base, "SELECT count(*) FROM report_sales WHERE source = 'live'") > 0);
});

test('customers, CMS page, cart price rule, admin user', async () => {
  const c = await adminClient();
  let r = await c.get('/admin/customer/index/?q=2058812302');
  assert.match(r.text, /john.smith.xyz@gmail.com/);
  r = await c.post('/admin/customer/index/save/id/2/', { 'customer[firstname]': 'John', 'customer[lastname]': 'Smith', 'customer[email]': 'john.smith.xyz@gmail.com', 'customer[group_id]': '2' }, '/admin/customer/index/edit/id/2/active_tab/account/');
  assert.equal(await one(base, 'SELECT group_id FROM customers WHERE id = 2'), 2);
  r = await c.post('/admin/cms/page/save/', { page_id: '1', is_active: '1', title: 'Bruh bro you clicked the wrong page', identifier: 'no-route', content: 'x' }, '/admin/cms/page/edit/page_id/1/');
  assert.equal(await one(base, 'SELECT title FROM cms_pages WHERE id = 1'), 'Bruh bro you clicked the wrong page');
  r = await c.post('/admin/sales_rule/promo_quote/save/', [['name', 'spring sale'], ['is_active', '1'], ['website_ids[]', '1'], ['customer_group_ids[]', '0'], ['customer_group_ids[]', '1'], ['coupon_type', '1'], ['simple_action', 'by_percent'], ['discount_amount', '20']], '/admin/sales_rule/promo_quote/new/');
  assert.deepEqual((await query(base, "SELECT simple_action, discount_amount, customer_group_ids FROM sales_rules WHERE name = 'spring sale'"))[0], { simple_action: 'by_percent', discount_amount: 20, customer_group_ids: '0,1' });
  const pw = adminPassword();
  if (pw) {
    r = await c.post('/admin/admin/user/save/', { username: 'clerk', firstname: 'C', lastname: 'L', email: 'clerk@example.com', password: 'abc12345', password_confirmation: 'abc12345', is_active: '1', roles: '1', current_password: pw }, '/admin/admin/user/new/');
    assert.equal(await one(base, "SELECT count(*) FROM admin_users WHERE username = 'clerk'"), 1);
  }
});

test('task-conversion fixes: phone keyword, SKU from name, last shown report, SQL functions', async () => {
  await ctrl(base, '/__rl/reset');
  const c = await adminClient();
  // formatted phone numbers find the customer (digits compared)
  for (const q of ['+1 2058812302', '555-229-3326']) {
    const r = await c.get(`/admin/customer/index/?q=${encodeURIComponent(q)}`);
    assert.match(r.text, q.startsWith('+') ? /john.smith.xyz@gmail.com/ : /roni_cost@example.com/, q);
  }
  // a new product saved without SKU gets its name as SKU (Magento's form fills it)
  await c.post('/admin/catalog/product/save/set/9/type/simple/', { 'product[name]': 'Energy-Bulk Women Shirt', 'product[sku]': '', 'product[price]': '60', 'product[attribute_set_id]': '9', 'product[quantity_and_stock_status][qty]': '50' }, '/admin/catalog/product/new/set/9/type/simple/');
  assert.equal(await one(base, "SELECT sku FROM products WHERE name = 'Energy-Bulk Women Shirt'"), 'Energy-Bulk Women Shirt');
  // report runs record which one was shown last (reused runs too)
  const rep = (f, t) => `/admin/reports/report_sales/sales/?filter=1&report_from=${f}&report_to=${t}`;
  await c.get(rep('2/1/23', '2/28/23')); await ctrl(base, '/__rl/jobs/run');
  await c.get(rep('3/1/23', '3/31/23')); await ctrl(base, '/__rl/jobs/run');
  await c.get(rep('2/1/23', '2/28/23'));
  assert.equal(await one(base, "SELECT json_extract(params, '$.from') FROM temp.admin_report_runs ORDER BY last_shown DESC LIMIT 1"), '2023-02-01');
  assert.equal(await one(base, 'SELECT count(*) FROM temp.admin_report_runs'), 2);
  // admin_local() is available to graders on a fresh tenant
  assert.equal(await one(s.url(1), "SELECT admin_local('2023-05-31 06:55:09')"), '2023-05-31 02:55:09');
  await ctrl(base, '/__rl/reset');
});

test('/__rl/reset restores every back-office write; tenants are isolated', async () => {
  const c = await adminClient();
  await c.post('/admin/catalog/product/save/id/1481/', { 'product[price]': '27' }, '/admin/catalog/product/edit/id/1481/');
  assert.equal(await one(base, 'SELECT price FROM products WHERE id = 1481'), 27);
  assert.equal(await one(s.url(1), 'SELECT price FROM products WHERE id = 1481'), 32, 'tenant 1 untouched');
  await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
  assert.equal(await one(base, 'SELECT price FROM products WHERE id = 1481'), 32);
  assert.equal(await one(base, 'SELECT count(*) FROM order_status_history WHERE order_id = 299'), 0);
  assert.equal(await one(base, "SELECT status FROM reviews WHERE id = 352"), 'pending');
  assert.equal(await one(base, 'SELECT count(*) FROM reviews WHERE id = 347'), 1);
  assert.equal(await one(base, "SELECT title FROM cms_pages WHERE id = 1"), '404 Not Found');
  assert.equal(await one(base, 'SELECT count(*) FROM admin_report_runs'), 0);
  assert.equal(await one(base, "SELECT count(*) FROM report_sales WHERE source = 'live'"), 0);
  assert.equal(await one(base, "SELECT count(*) FROM products WHERE sku = 'EBWS-1'"), 0);
  assert.equal(await one(base, 'SELECT qty FROM admin_pgrid WHERE id = 1481'), 100, 'grid shadow reverted with products');
  assert.equal(await one(base, "SELECT count(*) FROM admin_rstat WHERE status = 'pending'"), 5);
  const h = await (await fetch(base + '/__rl/health')).json();
  assert.equal(h.ok, true);
});

test('grid latency (single client)', async () => {
  const c = await adminClient();
  const urls = ['/admin/catalog/product/', '/admin/catalog/product/?sort=qty_desc', '/admin/catalog/product/?q=shirt', '/admin/catalog/product/?name=bag&sort=price_asc',
    '/admin/catalog/product/?sort=name_asc&page=40', '/admin/review/product/', '/admin/review/product/?name=circe', '/admin/review/product/pending/', '/admin/review/product/?sort=review_id_asc&page=500', '/admin/review/product/?detail=disappointed', '/admin/review/product/?nickname=john&status=1',
    '/admin/sales/order/?status=complete&sort=grand_total_desc', '/admin/customer/index/?q=gmail',
    '/admin/sales/order/', '/admin/customer/index/', '/admin/dashboard/'];
  const times = [];
  for (let round = 0; round < 2; round++) {
    for (const u of urls) {
      const t = performance.now();
      const r = await c.get(u);
      assert.equal(r.status, 200, u);
      if (round) times.push([performance.now() - t, u]);
    }
  }
  times.sort((a, b) => a[0] - b[0]);
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))][0];
  console.log(`# grid p50 ${times[times.length >> 1][0].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${times.at(-1)[0].toFixed(0)} ms (${times.at(-1)[1]})`);
  assert.ok(p95 < 1500, `p95 ${p95.toFixed(0)} ms`); // generous: shared, loaded build box; see dev/bench.js
});
