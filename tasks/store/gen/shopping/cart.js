'use strict';
// Storefront cart and wish-list templates (write): add with custom options / configurable
// swatches and quantity, edit the existing cart, coupon codes, search -> add, wish list from
// listings and orders, reorder.
const { shoppers } = require('./account');

// customers without an active cart (so the cart state is only what the task adds)
function cartless(L) {
  const busy = new Set(L.col('SELECT customer_id FROM carts WHERE is_active = 1 AND customer_id IS NOT NULL AND id IN (SELECT cart_id FROM cart_items)'));
  return L.customers().filter((c) => !busy.has(c.id));
}
const findableName = (L, name) => {
  const m = L.searchMatch(L.plain(name));
  if (!m) return false;
  const n = L.one('SELECT count(*) FROM product_search WHERE product_search MATCH ?', m);
  return n >= 1 && n <= 40;
};

const addOptions = {
  id: 'gen-shopping-cart-add-options', site: 'shopping', kind: 'write', skills: ['search', 'form-edit', 'create'], difficulty: 2, cap: 90,
  phrasings: [
    'Add {{qty}} of "{{product}}" to my cart, choosing {{choice}}.',
    'Put "{{product}}" in my shopping cart with {{choice}}, quantity {{qty}}.',
    'I need {{qty}} units of "{{product}}" ({{choice}}). Add them to the cart.',
  ],
  sample(L, r) {
    const out = [];
    const custs = cartless(L);
    const ps = r.shuffle(L.all(`SELECT p.id, p.name FROM products p WHERE p.status = 1 AND p.visibility = 4 AND p.is_in_stock = 1 AND p.type = 'simple' AND length(p.name) BETWEEN 15 AND 90
      AND p.name NOT LIKE '%&%' AND p.id IN (SELECT product_id FROM product_options) AND p.id % 5 = 2 LIMIT 4000`));
    for (const p of ps) {
      if (out.length >= 160) break;
      const opts = L.all('SELECT id, title FROM product_options WHERE product_id = ? ORDER BY position, id', p.id);
      const picks = [];
      let ok = true;
      for (const o of opts) {
        const vals = L.all('SELECT id, title FROM product_option_values WHERE option_id = ? ORDER BY position, id', o.id);
        const titles = vals.map((v) => v.title);
        if (vals.length < 2 || new Set(titles.map((t) => t.toLowerCase())).size !== titles.length || titles.some((t) => !t || t.length > 40 || t.includes('&'))) { ok = false; break; }
        picks.push({ o, v: r.pick(vals) });
      }
      if (!ok || !picks.length || picks.length > 2 || !findableName(L, p.name)) continue;
      const qty = 1 + r.int(4);
      const c = r.pick(custs);
      const choice = picks.map((x) => `${x.o.title}: ${x.v.title}`).join(' and ');
      const optChecks = picks.map((x) => `EXISTS (SELECT 1 FROM json_each(ci.options_json, '$.options') j WHERE json_extract(j.value, '$.option_id') = '${x.o.id}' AND json_extract(j.value, '$.option_value') = '${x.v.id}')`).join(' AND ');
      out.push({ slots: { qty, product: L.plain(p.name), choice }, login_user: c.email,
        eval: { type: 'state', state_sql: `SELECT CAST(sum(ci.qty) AS INTEGER) FROM ${L.CART(c.id)} AND ci.product_id = ${p.id} AND ${optChecks}`, state_expect: qty } });
    }
    return out;
  },
};

const addVariant = {
  id: 'gen-shopping-cart-add-variant', site: 'shopping', kind: 'write', skills: ['search', 'form-edit', 'create'], difficulty: 2, cap: 90,
  phrasings: [
    'Add {{qty}} {{product}} in size {{size}} and color {{color}} to my cart.',
    'I\'d like the {{product}} in {{color}}, size {{size}}. Put {{qty}} in my shopping cart.',
    'Please add the {{color}} {{product}} (size {{size}}) to my cart, quantity {{qty}}.',
  ],
  sample(L, r) {
    const out = [];
    const custs = cartless(L);
    const kids = L.all(`SELECT v.parent_id, k.id, k.sku, so.label AS size, co.label AS color, p.name FROM product_variants v JOIN products k ON k.id = v.child_id JOIN products p ON p.id = v.parent_id
        JOIN attribute_options so ON so.id = k.size_option_id JOIN attribute_options co ON co.id = k.color_option_id
      WHERE p.status = 1 AND p.visibility IN (2, 3, 4) AND k.status = 1 AND k.is_in_stock = 1 AND p.type = 'configurable' ORDER BY v.parent_id, k.id`);
    for (const k of r.sample(kids, 200)) {
      const qty = 1 + r.int(3);
      const c = r.pick(custs);
      out.push({ slots: { qty, product: L.plain(k.name).replace(/\s+/g, " ").trim(), size: k.size, color: k.color }, login_user: c.email,
        eval: { type: 'state', state_sql: `SELECT CAST(sum(ci.qty) AS INTEGER) FROM ${L.CART(c.id)} AND ci.product_id = ${k.parent_id} AND json_extract(ci.options_json, '$.child_id') = ${k.id}`, state_expect: qty } });
    }
    return out;
  },
};

const cartEdit = {
  id: 'gen-shopping-cart-edit', site: 'shopping', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 1, cap: 40,
  phrasings: [
    'Update my shopping cart: {{change}}.',
    'Please edit the items already in my cart so that {{change}}.',
  ],
  sample(L, r) {
    const out = [];
    const ok = new Set(L.customers().map((c) => c.id));
    const carts = L.all('SELECT c.id, c.customer_id, cu.email FROM carts c JOIN customers cu ON cu.id = c.customer_id WHERE c.is_active = 1 AND c.id IN (SELECT cart_id FROM cart_items)').filter((c) => ok.has(c.customer_id));
    for (const c of carts) {
      const items = L.all('SELECT id, product_id, name, qty FROM cart_items WHERE cart_id = ? AND parent_item_id IS NULL ORDER BY id', c.id);
      if (items.length < 2) continue;
      for (const it of items) {
        const name = L.shortName(it.name, 10);
        const others = items.filter((x) => x.id !== it.id);
        const keep = `(SELECT count(*) FROM ${L.CART(c.customer_id)} AND ci.product_id IN (${others.map((x) => x.product_id).join(',')}))`;
        for (const q of [2, 3, 4, 5, 6]) {
          out.push({ slots: { change: `the quantity of "${name}" becomes ${q}` }, login_user: c.email,
            eval: { type: 'state', state_sql: [`SELECT CAST(sum(ci.qty) AS INTEGER) FROM ${L.CART(c.customer_id)} AND ci.product_id = ${it.product_id}`, `SELECT ${keep}`], state_expect: [q, others.length] } });
        }
        out.push({ slots: { change: `"${name}" is removed and the other items stay` }, login_user: c.email,
          eval: { type: 'state', state_sql: [`SELECT count(*) FROM ${L.CART(c.customer_id)} AND ci.product_id = ${it.product_id}`, `SELECT ${keep}`], state_expect: [0, others.length] } });
      }
    }
    return out;
  },
};

const coupon = {
  id: 'gen-shopping-cart-coupon', site: 'shopping', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'Add {{qty}} {{product}} to my cart and apply the discount code {{code}}.',
    'I have the coupon {{code}}. Put {{qty}} of the {{product}} in my cart and use the code on it.',
  ],
  sample(L, r) {
    const out = [];
    for (const cp of L.all("SELECT c.code, c.rule_id FROM coupons c JOIN sales_rules s ON s.id = c.rule_id WHERE s.is_active = 1")) {
      // rule 4: a water bottle SKU condition; take the products the rule's action conditions name
      const skus = [...String(L.one('SELECT actions_json FROM sales_rules WHERE id = ?', cp.rule_id) || '').matchAll(/"value":"([^"]+)"/g)].map((m) => m[1]).filter((s) => /^[\w-]+$/.test(s));
      for (const sku of skus) {
        const p = L.get('SELECT id, name FROM products WHERE sku = ? AND status = 1 AND is_in_stock = 1', sku);
        if (!p) continue;
        for (const c of cartless(L)) {
          const qty = 1 + r.int(4);
          out.push({ slots: { qty, product: L.plain(p.name).trim(), code: cp.code }, login_user: c.email,
            eval: { type: 'state', state_sql: [`SELECT CAST(sum(ci.qty) AS INTEGER) FROM ${L.CART(c.id)} AND ci.product_id = ${p.id}`, `SELECT upper(coupon_code) FROM carts WHERE customer_id = ${c.id} AND is_active = 1 ORDER BY id DESC LIMIT 1`], state_expect: [qty, cp.code.toUpperCase()] } });
        }
      }
    }
    return out;
  },
};

const searchAddCheapest = {
  id: 'gen-shopping-search-add-cheapest', site: 'shopping', kind: 'write', skills: ['search', 'filter-sort', 'create', 'multi-step'], difficulty: 2, cap: 80,
  phrasings: [
    'Search for "{{q}}" and add the cheapest result to my cart (quantity {{qty}}).',
    'Find the lowest-priced product in the search results for "{{q}}" and put {{qty}} of it in my shopping cart.',
  ],
  sample(L, r) {
    const out = [];
    const custs = cartless(L);
    const { QUERIES } = require('./catalog');
    for (const q of QUERIES) {
      const m = L.searchMatch(q);
      const rows = L.all(`SELECT p.id, p.type, p.is_in_stock, p.has_options, (SELECT count(*) FROM product_options o WHERE o.product_id = p.id) AS nopt, ${L.LPRICE('p')} AS price
        FROM product_search s JOIN products p ON p.id = s.rowid WHERE product_search MATCH ? AND p.status = 1 AND p.visibility IN (3, 4)`, m).filter((x) => x.price != null);
      if (rows.length < 4) continue;
      rows.sort((a, b) => a.price - b.price || a.id - b.id);
      const [a, b] = rows;
      if (Math.abs(a.price - b.price) < 0.005 || a.type !== 'simple' || !a.is_in_stock || a.nopt > 0) continue;
      // the cheapest result must really be a "<q>" (search also matches descriptions: "gloves" -> a hair-color kit)
      const nm = L.plain(L.one('SELECT name FROM products WHERE id = ?', a.id)).toLowerCase();
      if (!q.toLowerCase().split(/\s+/).every((w) => nm.includes(w.replace(/(es|s)$/, '')))) continue;
      for (let k = 0; k < 3; k++) {
        const c = r.pick(custs);
        const qty = 1 + r.int(3);
        out.push({ slots: { q, qty }, login_user: c.email,
          eval: { type: 'state', state_sql: `SELECT CAST(sum(ci.qty) AS INTEGER) FROM ${L.CART(c.id)} AND ci.product_id = ${a.id}`, state_expect: qty } });
      }
    }
    return out;
  },
};

// wish list: the brand's most-reviewed product in a category
const wishMostReviewed = {
  id: 'gen-shopping-wishlist-most-reviewed', site: 'shopping', kind: 'write', skills: ['navigate', 'filter-sort', 'compare', 'create', 'multi-step'], difficulty: 3, cap: 90,
  phrasings: [
    'Among the {{brand}} products in the "{{category}}" category, add the one with the most reviews to my wish list.',
    'Go to {{category}}, look at the items from {{brand}}, and save the most-reviewed one to my wish list.',
    'Which {{brand}} product in {{category}} has the most customer reviews? Add it to my wishlist.',
  ],
  sample(L, r) {
    const out = [];
    const t = L.tree();
    for (const c of t.rows) {
      if (c.level < 3 || !c.is_active) continue;
      const rows = L.all(`SELECT p.id, p.brand, ${L.NREV('p')} AS n FROM products p WHERE p.id IN (${L.listedSql(c)}) AND p.brand IS NOT NULL`);
      if (rows.length < 20 || rows.length > 4000) continue;
      const by = new Map();
      for (const x of rows) { if (!by.has(x.brand)) by.set(x.brand, []); by.get(x.brand).push(x); }
      // the brand must be listed in the category's Brand facet (top 30 by count, then name)
      const shown = new Set([...by.entries()].sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1)).slice(0, 30).map(([b]) => b));
      for (const [brand, ps] of by) {
        if (!shown.has(brand)) continue;
        if (ps.length < 3 || ps.length > 8 || !/^[A-Za-z0-9][A-Za-z0-9 &'.+-]{1,28}[A-Za-z0-9.]$/.test(brand)) continue;
        const s = ps.slice().sort((a, b) => b.n - a.n);
        if (s[0].n === 0 || s[0].n === s[1].n) continue;
        const cu = r.pick(L.customers());
        out.push({ slots: { brand, category: L.catPath(c) }, login_user: cu.email,
          eval: { type: 'state', state_sql: `SELECT count(*) FROM ${L.WISH(cu.id)} AND wi.product_id = ${s[0].id}`, state_expect: { min: 1 } } });
      }
    }
    return out;
  },
};

// wish list: every product of an order
const wishFromOrder = {
  id: 'gen-shopping-wishlist-from-order', site: 'shopping', kind: 'write', skills: ['navigate', 'read-detail', 'create', 'multi-step'], difficulty: 2, cap: 90,
  phrasings: [
    'Add every product from my order #{{order}} to my wish list.',
    'I want to keep track of the items I bought in order {{order}}: save all of them to my wishlist.',
  ],
  sample(L, r) {
    const out = [];
    for (const c of shoppers(L, 2)) {
      for (const o of L.all('SELECT id, increment_id FROM orders WHERE customer_id = ?', c.id)) {
        const pids = L.col('SELECT DISTINCT i.product_id FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ? AND i.parent_item_id IS NULL AND p.status = 1 AND p.visibility IN (2, 3, 4)', o.id);
        const n = L.one('SELECT count(DISTINCT product_id) FROM order_items WHERE order_id = ? AND parent_item_id IS NULL', o.id);
        if (n < 2 || n > 4 || pids.length !== n) continue;
        out.push({ slots: { order: o.increment_id }, login_user: c.email,
          eval: { type: 'state', state_sql: `SELECT count(DISTINCT wi.product_id) FROM ${L.WISH(c.id)} AND wi.product_id IN (${pids.join(',')})`, state_expect: pids.length } });
      }
    }
    return out;
  },
};

// reorder the biggest order of a month (multi-step: find it, then Reorder)
const reorderBiggest = {
  id: 'gen-shopping-reorder-biggest', site: 'shopping', kind: 'write', skills: ['navigate', 'compare', 'create', 'multi-step'], difficulty: 3, cap: 75,
  phrasings: [
    'Put everything from my most expensive order of {{month}} back into my shopping cart.',
    'Reorder my largest {{month}} order (the one with the highest total).',
    'I want to buy again what I ordered in my priciest order from {{month}}. Add those items to my cart.',
  ],
  sample(L, r) {
    const out = [];
    const custs = new Set(cartless(L).map((c) => c.id));
    for (const c of shoppers(L, 4)) {
      if (!custs.has(c.id)) continue;
      const rows = L.all('SELECT substr(admin_local(created_at), 1, 7) AS m, id, grand_total FROM orders WHERE customer_id = ?', c.id);
      const by = new Map();
      for (const x of rows) { if (!by.has(x.m)) by.set(x.m, []); by.get(x.m).push(x); }
      for (const [m, os] of by) {
        if (os.length < 2) continue;
        const s = os.slice().sort((a, b) => b.grand_total - a.grand_total);
        if (Math.abs(s[0].grand_total - s[1].grand_total) < 0.005) continue;
        const items = L.all('SELECT DISTINCT i.product_id FROM order_items i WHERE i.order_id = ? AND i.parent_item_id IS NULL', s[0].id);
        const avail = L.col(`SELECT id FROM products WHERE id IN (${items.map((x) => x.product_id).join(',') || 0}) AND status = 1 AND is_in_stock = 1`);
        if (!items.length || avail.length !== items.length || items.length > 6) continue;
        // the cheaper order's products must differ (else the wrong order would pass)
        const other = L.col('SELECT DISTINCT product_id FROM order_items WHERE order_id = ? AND parent_item_id IS NULL', s[1].id);
        if (other.length && other.every((x) => avail.includes(x)) && avail.every((x) => other.includes(x))) continue;
        out.push({ slots: { month: L.monthName(m) }, login_user: c.email, difficulty: os.length > 3 ? 3 : 2,
          eval: { type: 'state', state_sql: `SELECT count(DISTINCT ci.product_id) FROM ${L.CART(c.id)} AND ci.product_id IN (${avail.join(',')})`, state_expect: avail.length } });
      }
    }
    return out;
  },
};

module.exports = [addOptions, addVariant, cartEdit, coupon, searchAddCheapest, wishMostReviewed, wishFromOrder, reorderBiggest];
