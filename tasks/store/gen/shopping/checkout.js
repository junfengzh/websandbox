'use strict';
// Storefront checkout templates (write): buy with a specific new shipping address, shipping and
// payment method; multi-step "buy the cheapest well-rated product in a category".

function cartless(L) {
  const busy = new Set(L.col('SELECT customer_id FROM carts WHERE is_active = 1 AND customer_id IS NOT NULL AND id IN (SELECT cart_id FROM cart_items)'));
  return L.customers().filter((c) => !busy.has(c.id) && c.default_shipping_id);
}
const SHIP = { flatrate_flatrate: 'Flat Rate', tablerate_bestway: 'Best Way (table rate)' };
const PAY = { checkmo: 'Check / Money order', cashondelivery: 'Cash On Delivery' };

const buyNewAddress = {
  id: 'gen-shopping-checkout-new-address', site: 'shopping', kind: 'write', skills: ['search', 'form-edit', 'create', 'multi-step'], difficulty: 3, cap: 90,
  phrasings: [
    'Buy {{qty}} "{{product}}" and ship {{it}} to {{address}} (phone {{phone}}). Use {{ship}} shipping and pay by {{pay}}.',
    'Order {{qty}} of "{{product}}" for delivery to {{address}}, phone {{phone}}, with {{ship}} shipping; payment method: {{pay}}.',
    'Place an order for "{{product}}" (quantity {{qty}}). Send it to this new address: {{address}}, phone {{phone}}. Shipping: {{ship}}. Payment: {{pay}}.',
  ],
  sample(L, r) {
    const out = [];
    const custs = cartless(L);
    const ps = r.shuffle(L.all(`SELECT p.id, p.name FROM products p WHERE p.status = 1 AND p.visibility = 4 AND p.is_in_stock = 1 AND p.type = 'simple' AND length(p.name) BETWEEN 15 AND 80
      AND p.name NOT LIKE '%&%' AND p.price BETWEEN 3 AND 300 AND p.id NOT IN (SELECT product_id FROM product_options) AND p.id % 11 = 4 LIMIT 3000`));
    for (const p of ps) {
      if (out.length >= 140) break;
      const m = L.searchMatch(L.plain(p.name));
      if (!m || L.one('SELECT count(*) FROM product_search WHERE product_search MATCH ?', m) > 30) continue;
      const c = r.pick(custs);
      const a = L.fakeAddress(r);
      const qty = 1 + r.int(3);
      const ship = r.pick(Object.keys(SHIP));
      const pay = r.pick(Object.keys(PAY));
      const O = L.NEW_ORDER(c.id);
      out.push({ slots: { qty, product: L.plain(p.name), it: qty > 1 ? 'them' : 'it', address: a.text, phone: a.telephone, ship: SHIP[ship], pay: PAY[pay] }, login_user: c.email,
        eval: { type: 'state', state_sql: [
          `SELECT CAST(sum(qty_ordered) AS INTEGER) FROM order_items WHERE order_id = ${O} AND product_id = ${p.id} AND parent_item_id IS NULL`,
          `SELECT count(*) FROM order_addresses x WHERE x.order_id = ${O} AND x.address_type = 'shipping' AND ${L.addrMatch('x', a)}`,
          `SELECT shipping_method, payment_method FROM orders WHERE id = ${O}`,
        ], state_expect: [qty, 1, [[ship, pay]]] } });
    }
    return out;
  },
};

const buyCheapestRated = {
  id: 'gen-shopping-buy-cheapest-rated', site: 'shopping', kind: 'write', skills: ['navigate', 'filter-sort', 'compare', 'create', 'multi-step'], difficulty: 3, cap: 90,
  phrasings: [
    'Buy the cheapest product in the "{{category}}" category that has a rating of at least {{stars}} stars. Ship it to my default address with Flat Rate shipping and pay by check / money order.',
    'In {{category}}, find the lowest-priced item rated {{stars}} stars or more and order one of it (my default address, flat rate, check / money order).',
    'Order one unit of the least expensive {{category}} product whose customer rating is {{stars}} out of 5 or higher. Use my saved address, Flat Rate shipping and Check / Money order.',
  ],
  sample(L, r) {
    const out = [];
    const custs = cartless(L);
    const t = L.tree();
    for (const c of t.rows) {
      if (c.level < 3 || !c.is_active) continue;
      const n = L.one(`SELECT count(*) FROM (${L.listedSql(c)})`);
      if (n < 4 || n > 300) continue;
      const rows = L.all(`SELECT p.id, p.type, p.is_in_stock, (SELECT count(*) FROM product_options o WHERE o.product_id = p.id) AS nopt, ${L.LPRICE('p')} AS price, ${L.RATING('p')} AS pct
        FROM products p WHERE p.id IN (${L.listedSql(c)})`);
      for (const stars of [4, 3.5, 4.5]) {
        // the listing shows the rounded percent; stars = pct / 20
        const ok = rows.filter((x) => x.pct != null && Math.round(x.pct) >= stars * 20 && x.price != null).sort((a, b) => a.price - b.price || a.id - b.id);
        if (ok.length < 2 || ok.length === rows.length) continue;
        if (Math.abs(ok[0].price - ok[1].price) < 0.005) continue;
        const best = ok[0];
        if (best.type !== 'simple' || !best.is_in_stock || best.nopt > 0) continue;
        // a cheaper product with a lower rating must exist (else the rating filter does not matter)
        if (!rows.some((x) => x.price != null && x.price < best.price)) continue;
        const cu = r.pick(custs);
        const O = L.NEW_ORDER(cu.id);
        out.push({ slots: { category: L.catPath(c), stars }, login_user: cu.email,
          eval: { type: 'state', state_sql: [
            `SELECT count(*) FROM order_items WHERE order_id = ${O} AND product_id = ${best.id} AND parent_item_id IS NULL`,
            `SELECT x.customer_address_id = (SELECT default_shipping_id FROM customers WHERE id = ${cu.id}) OR x.street = (SELECT street FROM customer_addresses WHERE id = (SELECT default_shipping_id FROM customers WHERE id = ${cu.id})) FROM order_addresses x WHERE x.order_id = ${O} AND x.address_type = 'shipping'`,
            `SELECT shipping_method, payment_method FROM orders WHERE id = ${O}`,
          ], state_expect: [1, 1, [['flatrate_flatrate', 'checkmo']]] } });
      }
    }
    return out;
  },
};

module.exports = [buyNewAddress, buyCheapestRated];
