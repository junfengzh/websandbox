'use strict';
// Shopping cart (Magento quote) on the carts / cart_items tables: guest carts are
// tied to the session (session key cart_id), customer carts to customers.id
// (one active cart per customer). Totals with cart price rules and shipping.
const kit = require('../../../../kit');
const S = require('../../shared');
const rules = require('./rules');
const { PRICE } = require('./catalog');

const FLAT_RATE = 5; // carriers/flatrate: $5.00 per item (the orders in the data use it)

const now = () => kit.nowSql();
const today = () => kit.nowSql().slice(0, 10);

function findCart(req) {
  const db = kit.db();
  if (req.user) return db.prepare('SELECT * FROM carts WHERE customer_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1').get(req.user.id) || null;
  const id = req.session.get('cart_id');
  return id ? db.prepare('SELECT * FROM carts WHERE id = ? AND customer_id IS NULL AND is_active = 1').get(id) || null : null;
}
function ensureCart(req) {
  let c = findCart(req);
  if (c) return c;
  const db = kit.db();
  const r = db.prepare("INSERT INTO carts (customer_id, is_active, items_count, items_qty, subtotal, grand_total, created_at, updated_at, source) VALUES (?, 1, 0, 0, 0, 0, ?, ?, 'live')").run(req.user ? req.user.id : null, now(), now());
  if (!req.user) req.session.set('cart_id', Number(r.lastInsertRowid));
  return db.prepare('SELECT * FROM carts WHERE id = ?').get(r.lastInsertRowid);
}
// On login: move the guest cart's items into the customer's cart.
function mergeGuestCart(req, guestCartId) {
  if (!guestCartId || !req.user) return;
  const db = kit.db();
  const g = db.prepare('SELECT * FROM carts WHERE id = ? AND customer_id IS NULL AND is_active = 1').get(guestCartId);
  if (!g) return;
  const items = db.prepare('SELECT * FROM cart_items WHERE cart_id = ?').all(g.id);
  if (items.length) {
    const c = ensureCart(req);
    for (const it of items) {
      const same = db.prepare('SELECT id FROM cart_items WHERE cart_id = ? AND product_id = ? AND coalesce(options_json, \'\') = coalesce(?, \'\')').get(c.id, it.product_id, it.options_json);
      if (same) db.prepare('UPDATE cart_items SET qty = qty + ?, updated_at = ? WHERE id = ?').run(it.qty, now(), same.id);
      else db.prepare('UPDATE cart_items SET cart_id = ? WHERE id = ?').run(c.id, it.id);
    }
    db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(g.id);
    if (g.coupon_code && !c.coupon_code) db.prepare('UPDATE carts SET coupon_code = ? WHERE id = ?').run(g.coupon_code, c.id);
    recalc(c.id);
  }
  db.prepare('UPDATE carts SET is_active = 0, updated_at = ? WHERE id = ?').run(now(), g.id);
  req.session.set('cart_id', undefined);
}

const parse = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

// Lines with product info; price = current final price (+ custom option prices).
function lines(cartId) {
  const db = kit.db();
  const rows = db.prepare(`SELECT ci.*, p.url_key, p.name AS product_name, p.type, p.status, p.is_in_stock, p.qty AS stock_qty, p.weight, p.price AS regular_price,
      ${PRICE} AS final_price,
      (SELECT file FROM product_images i WHERE i.product_id = coalesce(json_extract(ci.options_json, '$.child_id'), ci.product_id) AND i.file IS NOT NULL ORDER BY i.is_small DESC, i.is_base DESC, i.position LIMIT 1) AS image,
      (SELECT file FROM product_images i WHERE i.product_id = ci.product_id AND i.file IS NOT NULL ORDER BY i.is_small DESC, i.is_base DESC, i.position LIMIT 1) AS parent_image
    FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = ? AND ci.parent_item_id IS NULL ORDER BY ci.id`).all(cartId);
  for (const r of rows) {
    r.opts = parse(r.options_json);
    r.image = r.image || r.parent_image;
    r.url = r.url_key ? `/${r.url_key}.html` : `/catalog/product/view/id/${r.product_id}`;
    r.plain = S.plainName(r.name);
  }
  return rows;
}

// Unit price of a line: configurable -> the chosen child's final price; + custom option prices.
function unitPrice(db, productId, opts) {
  const pid = opts.child_id || productId;
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
  let price = S.finalPrice(p, today()) ?? 0;
  for (const o of opts.options || []) price += Number(o.price || 0);
  return Math.round(price * 100) / 100;
}

function activeRules(db, groupId) {
  const d = today();
  const rs = db.prepare('SELECT * FROM sales_rules WHERE is_active = 1 AND (from_date IS NULL OR substr(from_date, 1, 10) <= ?) AND (to_date IS NULL OR substr(to_date, 1, 10) >= ?) ORDER BY sort_order, id').all(d, d);
  const codes = db.prepare('SELECT rule_id, lower(code) code FROM coupons WHERE expiration_date IS NULL OR substr(expiration_date, 1, 10) >= ?').all(d);
  return rs.filter((r) => list(r.customer_group_ids).includes(String(groupId))).map((r) => ({ ...r, coupon_codes: codes.filter((c) => c.rule_id === r.id).map((c) => c.code) }));
}
const list = (v) => String(v ?? '').split(',').map((x) => x.trim());

function helpers(db) {
  const cats = new Map(); const attrs = new Map();
  return {
    categoryIds: (pid) => { if (!cats.has(pid)) cats.set(pid, db.prepare('SELECT category_id FROM product_categories WHERE product_id = ?').pluck().all(pid).map(String)); return cats.get(pid); },
    attribute: (pid, code) => {
      const k = pid + ':' + code;
      if (!attrs.has(k)) {
        const col = db.prepare('SELECT typed_column FROM attributes WHERE code = ?').pluck().get(code);
        let v;
        if (col && /^[a-z_]+$/.test(col)) v = db.prepare(`SELECT ${col} FROM products WHERE id = ?`).pluck().get(pid);
        else { const vs = db.prepare('SELECT coalesce(option_id, value) FROM product_attributes WHERE product_id = ? AND attribute_code = ?').pluck().all(pid, code); v = vs.length > 1 ? vs.map(String) : vs[0]; }
        attrs.set(k, v);
      }
      return attrs.get(k);
    },
  };
}

// Full totals for a cart; shipping only when a method is chosen (checkout).
function totals(cart, { customerGroupId = 0, address = null, shippingMethod = null } = {}) {
  const db = kit.db();
  const ls = lines(cart.id);
  for (const l of ls) { l.price = unitPrice(db, l.product_id, l.opts); l.row_total = Math.round(l.price * l.qty * 100) / 100; }
  const subtotal = rules.round(ls.reduce((s, l) => s + l.row_total, 0));
  const qty = ls.reduce((s, l) => s + l.qty, 0);
  const weight = ls.reduce((s, l) => s + (l.weight || 0) * l.qty, 0);
  const res = rules.apply(activeRules(db, customerGroupId), { items: ls, subtotal, qty, weight, address, shippingMethod, coupon: cart.coupon_code }, helpers(db));
  for (const l of ls) l.discount = res.perItem.get(l.id) || 0;
  let shipping = null;
  if (shippingMethod) shipping = res.freeShipping ? 0 : shippingRate(shippingMethod, { qty, subtotal: subtotal - res.discount, address });
  const discount = res.discount;
  const grand = rules.round(subtotal - discount + (shipping || 0));
  return { lines: ls, subtotal, qty, weight, discount, applied: res.applied, couponValid: res.couponValid, freeShipping: res.freeShipping, shipping, tax: 0, grand_total: grand };
}

const SHIPPING_METHODS = [
  { code: 'flatrate_flatrate', carrier: 'Flat Rate', method: 'Fixed', title: 'Flat Rate - Fixed' },
  { code: 'tablerate_bestway', carrier: 'Best Way', method: 'Table Rate', title: 'Best Way - Table Rate' },
];
function shippingRate(code, { qty, subtotal, address }) {
  if (code === 'flatrate_flatrate') return FLAT_RATE * qty;
  if (code === 'tablerate_bestway') {
    const db = kit.db();
    const rid = (address && address.region_id) || 0;
    const r = db.prepare("SELECT price FROM shipping_table_rates WHERE dest_country_id = ? AND (dest_region_id = ? OR dest_region_id = 0) AND condition_value <= ? ORDER BY dest_region_id DESC, condition_value DESC LIMIT 1")
      .get((address && address.country_id) || 'US', rid, subtotal);
    return r ? r.price : null;
  }
  return null;
}
function shippingOptions(t, address) {
  return SHIPPING_METHODS.map((m) => ({ ...m, price: t.freeShipping ? 0 : shippingRate(m.code, { qty: t.qty, subtotal: t.subtotal - t.discount, address }) })).filter((m) => m.price != null);
}

function recalc(cartId) {
  const db = kit.db();
  const c = db.prepare('SELECT * FROM carts WHERE id = ?').get(cartId);
  if (!c) return;
  const ls = db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND parent_item_id IS NULL').all(cartId);
  let subtotal = 0; let qty = 0;
  for (const l of ls) {
    const price = unitPrice(db, l.product_id, parse(l.options_json));
    const row = Math.round(price * l.qty * 100) / 100;
    if (price !== l.price || row !== l.row_total) db.prepare('UPDATE cart_items SET price = ?, row_total = ? WHERE id = ?').run(price, row, l.id);
    subtotal += row; qty += l.qty;
  }
  db.prepare('UPDATE carts SET items_count = ?, items_qty = ?, subtotal = ?, grand_total = ?, updated_at = ? WHERE id = ?').run(ls.length, qty, rules.round(subtotal), rules.round(subtotal), now(), cartId);
}

// Add a product. opts: { child_id, attributes_info, super_attribute, options: [{option_id, option_value, label, value, price}] }
function addItem(req, product, qty, opts) {
  const db = kit.db();
  const c = ensureCart(req);
  const json = JSON.stringify(opts);
  const same = db.prepare("SELECT * FROM cart_items WHERE cart_id = ? AND product_id = ? AND coalesce(options_json, '') = ? AND parent_item_id IS NULL").get(c.id, product.id, json);
  const sku = opts.child_sku || product.sku;
  if (same) db.prepare('UPDATE cart_items SET qty = qty + ?, updated_at = ? WHERE id = ?').run(qty, now(), same.id);
  else {
    const price = unitPrice(db, product.id, opts);
    db.prepare('INSERT INTO cart_items (cart_id, parent_item_id, product_id, product_type, sku, name, qty, price, row_total, options_json, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, product.id, product.type, sku, product.name, qty, price, Math.round(price * qty * 100) / 100, json, now(), now());
  }
  recalc(c.id);
  return c;
}

// Stable guest id for compare lists (kept in the session data, survives login rotation).
function visitorId(req) {
  let v = req.session.get('vid');
  if (!v) { v = 'v' + String(req.session.ensure().id).slice(0, 16); req.session.set('vid', v); }
  return v;
}

function count(req) {
  const c = findCart(req);
  if (!c) return 0;
  return kit.db().prepare('SELECT coalesce(sum(qty), 0) FROM cart_items WHERE cart_id = ? AND parent_item_id IS NULL').pluck().get(c.id);
}

module.exports = { visitorId, findCart, ensureCart, mergeGuestCart, lines, totals, recalc, addItem, count, shippingOptions, shippingRate, SHIPPING_METHODS, unitPrice, activeRules, FLAT_RATE };
