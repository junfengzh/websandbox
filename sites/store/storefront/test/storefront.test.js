'use strict';
// Storefront route tests on the real store data (node --test). Needs
// $WSB_DATA_ROOT/store (or STORE_DATA) and the WebArena demo password for
// emma.lopez@gmail.com: STORE_TEST_PASSWORD, else read from WebArena's env_config.py (never printed).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = process.env.STORE_DATA || '$WSB_DATA_ROOT/store';
const EMMA = 'emma.lopez@gmail.com';
function emmaPassword() {
  if (process.env.STORE_TEST_PASSWORD) return process.env.STORE_TEST_PASSWORD;
  const f = path.join(__dirname, '../../../../../3rd-party/webarena/browser_env/env_config.py');
  const m = fs.existsSync(f) && /"shopping":\s*\{\s*"username":\s*"[^"]+",\s*"password":\s*"([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
  return m ? m[1] : null;
}

class Client {
  constructor(base) { this.base = base; this.jar = new Map(); }
  async req(method, p, { form, json, headers = {} } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = kv.slice(i + 1);
      if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    const text = await r.text();
    return { status: r.status, text, location: r.headers.get('location') };
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, o) { return this.req('POST', p, o); }
  async follow(r) { let x = r; for (let i = 0; i < 5 && x.location; i++) x = await this.get(x.location); return x; }
  async csrf(p = '/contact/') { const r = await this.get(p); return (/name="csrf-token" content="([^"]+)"/.exec(r.text) || [])[1]; }
}

const ctrl = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const query = async (base, sql, params) => (await ctrl(base, '/__rl/query', { sql, params })).rows;

let s; let base;
test.before(async () => {
  const site = require('../../server.js');
  const up = fs.mkdtempSync(path.join((process.env.WSB_TMP || os.tmpdir()), 'wsb-store-test-'));
  s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: up, jobTickMs: 50 });
  base = s.url(0);
  await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
});
test.after(async () => { if (s) await s.close(); });

test('home, category, product, CMS', async () => {
  const c = new Client(base);
  let r = await c.get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Product Showcases/);
  assert.match(r.text, /href="\/video-games\.html"/); // category menu
  r = await c.get('/video-games.html');
  assert.equal(r.status, 200);
  assert.match(r.text, /<h1 class="page-title"><span class="base"[^>]*>Video Games/);
  assert.match(r.text, /product-item-link/);
  assert.match(r.text, /toolbar-number/);
  r = await c.get('/video-games/playstation-4/accessories.html?product_list_order=price&product_list_dir=desc');
  const prices = [...r.text.matchAll(/data-price-type="finalPrice"><span class="price">\$([\d,.]+)/g)].map((m) => +m[1].replace(/,/g, ''));
  assert.ok(prices.length >= 5);
  assert.deepEqual(prices, [...prices].sort((a, b) => b - a), 'sorted by price desc');
  r = await c.get('/clothing-shoes-jewelry/women/shoes.html?price=0-25');
  assert.match(r.text, /Now Shopping by/);
  const ps = [...r.text.matchAll(/data-price-type="finalPrice"><span class="price">\$([\d,.]+)/g)].map((m) => +m[1].replace(/,/g, ''));
  assert.ok(ps.length && ps.every((p) => p < 25));
  // product page by url key (WebArena task start URL)
  r = await c.get('/6s-wireless-headphones-over-ear-noise-canceling-hi-fi-bass-foldable-stereo-wireless-kid-headsets-earbuds-with-built-in-mic-micro-sd-tf-fm-for-iphone-samsung-ipad-pc-black-gold.html');
  assert.equal(r.status, 200);
  assert.match(r.text, /id="product_addtocart_form"/);
  assert.match(r.text, /Customer Reviews/);
  assert.match(r.text, /rating-histogram/);
  // configurable Luma product
  r = await c.get('/antonia-racer-tank.html');
  assert.equal(r.status, 200);
  assert.match(r.text, /name="super_attribute\[size\]"/);
  assert.match(r.text, /name="super_attribute\[color\]"/);
  r = await c.get('/about-us/');
  assert.equal(r.status, 200);
  r = await c.get('/no-such-page-xyz.html');
  assert.equal(r.status, 404);
  assert.match(r.text, /Whoops, our bad/);
});

test('search: results, sort, facets, suggestions', async () => {
  const c = new Client(base);
  let r = await c.get('/catalogsearch/result/?q=usb+wifi');
  assert.equal(r.status, 200);
  assert.match(r.text, /Search results for: &#39;usb wifi&#39;|Search results for: 'usb wifi'/);
  assert.match(r.text, /product-item-link/);
  r = await c.get('/catalogsearch/result/index/?product_list_order=price&q=chairs&product_list_dir=asc');
  const prices = [...r.text.matchAll(/data-price-type="finalPrice"><span class="price">\$([\d,.]+)/g)].map((m) => +m[1].replace(/,/g, ''));
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  assert.match(r.text, /filter-options-title">Category/);
  r = await c.get('/search/ajax/suggest/?q=nintendo');
  const j = JSON.parse(r.text);
  assert.ok(j.products.length > 0);
  r = await c.get('/catalogsearch/result/?q=zzzqqqxx');
  assert.match(r.text, /Your search returned no results/);
});

test('customer: login, account, address, newsletter, wishlist, review, contact; admin cookie is not a customer', async () => {
  const pw = emmaPassword();
  if (!pw) return test.skip('no demo password');
  const c = new Client(base);
  let _csrf = await c.csrf('/customer/account/login/');
  let r = await c.post('/customer/account/loginPost/', { form: { 'login[username]': EMMA, 'login[password]': 'wrong-password', _csrf } });
  assert.match(r.text, /account sign-in was incorrect/);
  r = await c.post('/customer/account/loginPost/', { form: { 'login[username]': EMMA, 'login[password]': pw, _csrf } });
  assert.equal(r.status, 302);
  r = await c.follow(r);
  assert.match(r.text, /Emma Lopez/);
  assert.match(r.text, /Default Billing Address/);
  r = await c.get('/customer/address/');
  assert.match(r.text, /box box-address-billing/);
  // newsletter
  _csrf = await c.csrf('/newsletter/manage/');
  r = await c.post('/newsletter/manage/save/', { form: { is_subscribed: '1', _csrf } });
  assert.equal(r.status, 302);
  r = await c.get('/newsletter/manage/');
  assert.match(r.text, /title="General Subscription" class="checkbox" checked/);
  const pid = (await query(base, "SELECT id FROM products WHERE url_key = 'elmwood-inn-fine-teas-orange-vanilla-caffeine-free-fruit-infusion-16-ounce-pouch'"))[0].id;
  r = await c.post('/wishlist/index/add/', { form: { product: String(pid), _csrf } });
  r = await c.follow(r);
  assert.match(r.text, /products-grid wishlist/);
  assert.match(r.text, /Elmwood Inn Fine Teas/);
  // new address
  r = await c.post('/customer/address/formPost/', { form: { firstname: 'Emma', lastname: 'Lopez', telephone: '6505551212', 'street[0]': '111 Magnolia Path', city: 'Atlanta', region_id: '19', postcode: '30303', country_id: 'US', default_shipping: '1', _csrf } });
  assert.equal(r.status, 302);
  r = await c.get('/customer/address/');
  assert.match(r.text, /111 Magnolia Path/);
  // review (pending moderation)
  r = await c.post(`/review/product/post/id/${pid}/`, { form: { 'ratings[4]': '4', nickname: 'Emma', title: 'Nice tea', detail: 'Lovely orange vanilla flavour.', _csrf } });
  assert.equal(r.status, 302);
  const rv = await query(base, "SELECT status, nickname FROM reviews WHERE product_id = ? ORDER BY id DESC LIMIT 1", [pid]);
  assert.deepEqual(rv[0], { status: 'pending', nickname: 'Emma' });
  r = await c.post('/contact/index/post/', { form: { name: 'Emma Lopez', email: EMMA, telephone: '', comment: 'Hello there', _csrf } });
  assert.equal(r.status, 302);
  assert.equal((await query(base, 'SELECT count(*) n FROM contact_messages'))[0].n, 1);
  // an admin session cookie (control API) is not a customer on the storefront
  const a = await ctrl(base, '/__rl/login', { user: 'admin' });
  assert.equal(a.ok, true);
  const ac = new Client(base); ac.jar.set(a.cookie.name, a.cookie.value);
  r = await ac.get('/customer/account/');
  assert.equal(r.status, 302);
  assert.match(r.location, /\/customer\/account\/login/);
  await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
});

test('cart, coupon, checkout creates an order; reset restores', async () => {
  const pw = emmaPassword();
  if (!pw) return test.skip('no demo password');
  const c = new Client(base);
  let _csrf = await c.csrf('/customer/account/login/');
  let r = await c.post('/customer/account/loginPost/', { form: { 'login[username]': EMMA, 'login[password]': pw, _csrf } });
  assert.equal(r.status, 302);
  _csrf = await c.csrf('/checkout/cart/'); // the session (and its CSRF token) rotates at login
  const before = (await query(base, 'SELECT count(*) n FROM orders WHERE customer_id = 70'))[0].n;
  const p = (await query(base, "SELECT id, name, price FROM products WHERE source = 'shop' AND status = 1 AND visibility = 4 AND type = 'simple' AND required_options = 0 AND is_in_stock = 1 AND price BETWEEN 10 AND 30 ORDER BY id LIMIT 1"))[0];
  r = await c.post('/checkout/cart/add/', { form: { product: String(p.id), qty: '2', _csrf } });
  assert.equal(r.status, 302);
  r = await c.get('/checkout/cart/');
  assert.match(r.text, /shopping-cart-table/);
  r = await c.post('/checkout/cart/couponPost/', { form: { coupon_code: 'NOPE', _csrf } });
  r = await c.follow(r);
  assert.match(r.text, /The coupon code &quot;NOPE&quot; is not valid|The coupon code "NOPE" is not valid/);
  // configurable product with options
  const tank = (await query(base, "SELECT id FROM products WHERE url_key = 'antonia-racer-tank'"))[0].id;
  const opt = (await query(base, 'SELECT c.size_option_id s, c.color_option_id col FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id = ? AND c.is_in_stock = 1 LIMIT 1', [tank]))[0];
  r = await c.post('/checkout/cart/add/', { form: { product: String(tank), qty: '1', 'super_attribute[size]': String(opt.s), 'super_attribute[color]': String(opt.col), _csrf } });
  assert.equal(r.location, '/checkout/cart/');
  r = await c.get('/checkout/');
  assert.match(r.text, /Shipping Methods/);
  const addr = (/name="address_id" value="(\d+)" checked/.exec(r.text) || [])[1];
  assert.ok(addr);
  r = await c.post('/checkout/shipping/', { form: { address_id: addr, shipping_method: 'flatrate_flatrate', _csrf } });
  assert.equal(r.location, '/checkout/payment/');
  r = await c.get('/checkout/payment/');
  assert.match(r.text, /Place Order/);
  r = await c.post('/checkout/placeOrder/', { form: { payment_method: 'checkmo', billing_same: '1', _csrf } });
  assert.equal(r.location, '/checkout/onepage/success/');
  r = await c.get('/checkout/onepage/success/');
  const num = (/class="order-number"><strong>(\d{9})<\/strong>/.exec(r.text) || [])[1];
  assert.ok(num, 'order number shown');
  const o = (await query(base, 'SELECT * FROM orders WHERE increment_id = ?', [num]))[0];
  assert.equal(o.status, 'pending');
  assert.equal(o.customer_id, 70);
  // flat rate $5 per item, unless the cart rule "Spend $50 or more - shipping is free!" applies
  assert.equal(o.shipping_amount, o.subtotal >= 50 ? 0 : 5 * o.total_qty_ordered);
  const items = await query(base, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [o.id]);
  // Emma's imported cart already holds items; ours are among them
  assert.ok(items.some((i) => i.product_id === p.id && i.qty_ordered === 2));
  assert.ok(items.some((i) => i.product_id === tank && i.product_type === 'configurable') && items.some((i) => i.parent_item_id && i.product_type === 'simple'));
  assert.ok(Math.abs(o.subtotal - items.filter((i) => !i.parent_item_id).reduce((x, i) => x + i.row_total, 0)) < 0.001);
  assert.ok(Math.abs(o.grand_total - (o.subtotal + o.discount_amount + o.shipping_amount)) < 0.001);
  r = await c.get('/sales/order/history/');
  assert.ok(r.text.indexOf(num) > 0 && r.text.indexOf(num) < r.text.indexOf('000001170'), 'newest first');
  r = await c.get(`/sales/order/view/order_id/${o.id}/`);
  assert.match(r.text, /order-details-items ordered/);
  assert.match(r.text, /Pending/);
  r = await c.get('/checkout/cart/');
  assert.match(r.text, /You have no items in your shopping cart/);
  // canceled order view (WebArena task 1170 -> now 000001170)
  r = await c.get('/sales/order/view/order_id/1170/');
  assert.match(r.text, /Canceled/);
  // reset
  await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
  assert.equal((await query(base, 'SELECT count(*) n FROM orders WHERE customer_id = 70'))[0].n, before);
  r = await c.get('/customer/account/');
  assert.equal(r.status, 302, 'sessions reset too');
});

test('customer and admin sessions are separate on one host', async (t) => {
  const pw = emmaPassword();
  const f = path.join(__dirname, '../../../../../3rd-party/webarena/browser_env/env_config.py');
  const am = fs.existsSync(f) && /"shopping_admin":\s*\{\s*"username":\s*"([^"]+)",\s*"password":\s*"([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
  if (!pw || !am || !fs.existsSync(path.join(__dirname, '../../admin/index.js'))) return t.skip('needs the back office and demo passwords');
  const c = new Client(base);
  let _csrf = await c.csrf('/customer/account/login/');
  let r = await c.post('/customer/account/loginPost/', { form: { 'login[username]': EMMA, 'login[password]': pw, _csrf } });
  assert.equal(r.status, 302);
  assert.ok(c.jar.has('wsb_sid'));
  r = await c.get('/admin/dashboard/');
  assert.equal(r.status, 302, 'a customer is not signed in to the admin');
  const lp = await c.get('/admin/admin/auth/login/');
  _csrf = (/name="csrf-token" content="([^"]+)"/.exec(lp.text) || /name="_csrf" value="([^"]+)"/.exec(lp.text) || [])[1];
  r = await c.post('/admin/admin/auth/login/', { form: { 'login[username]': am[1], 'login[password]': am[2], _csrf } });
  assert.equal(r.status, 302);
  assert.ok(c.jar.has('wsb_admin_sid'), 'admin session cookie');
  r = await c.get('/admin/dashboard/');
  assert.equal(r.status, 200);
  r = await c.get('/customer/account/');
  assert.equal(r.status, 200, 'still signed in as the customer');
  assert.match(r.text, /Emma Lopez/);
  // customer logout keeps the admin session
  r = await c.get('/customer/account/logout/');
  r = await c.get('/admin/dashboard/');
  assert.equal(r.status, 200);
  r = await c.get('/customer/account/');
  assert.equal(r.status, 302);
  await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
});

test('listing index follows tenant writes (price, name, visibility) and resets', async () => {
  const t0 = s.tenants.get(0);
  const pid = (await query(base, "SELECT p.id FROM product_categories pc JOIN products p ON p.id = pc.product_id WHERE pc.category_id = (SELECT id FROM categories WHERE url_path = 'video-games/playstation-4/accessories') AND p.status = 1 AND p.visibility = 4 AND p.type = 'simple' ORDER BY p.id LIMIT 1"))[0].id;
  const url = '/video-games/playstation-4/accessories.html?product_list_order=price&product_list_dir=desc';
  const first = (html) => (/class="product-item-link" href="([^"]+)">([^<]*)/.exec(html) || [])[2];
  const c0 = new Client(base); const c1 = new Client(s.url(1));
  const before = first((await c0.get(url)).text);
  await t0.run((db) => db.prepare("UPDATE products SET price = 99999, name = 'ZZ Test Most Expensive' WHERE id = ?").run(pid));
  assert.equal(first((await c0.get(url)).text), 'ZZ Test Most Expensive', 'tenant 0 sees its write');
  assert.equal(first((await c1.get(url)).text), before, 'tenant 1 does not');
  let r = await c0.get('/catalogsearch/result/?q=ZZ+Test+Most+Expensive');
  assert.match(r.text, /ZZ Test Most Expensive/);
  await t0.run((db) => db.prepare('UPDATE products SET status = 2 WHERE id = ?').run(pid));
  assert.notEqual(first((await c0.get(url)).text), 'ZZ Test Most Expensive', 'disabled product leaves the listing');
  await ctrl(base, '/__rl/reset', { frozen: true, now: '2023-06-12T16:00:00Z' });
  assert.equal(first((await c0.get(url)).text), before, 'reset restores');
});
