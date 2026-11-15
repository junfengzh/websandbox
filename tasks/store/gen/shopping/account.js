'use strict';
// Storefront customer-account templates (read): order history and order detail, orders by status
// and month, purchase history aggregates, address book, guest order lookup ("Orders and Returns").

// customers with at least n orders (cheap-login accounts only)
function shoppers(L, n = 3) {
  const ok = new Set(L.customers().map((c) => c.id));
  return L.all('SELECT c.id, c.email, c.firstname, c.lastname, count(o.id) AS n FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id HAVING count(o.id) >= ? ORDER BY c.id', n).filter((c) => ok.has(c.id));
}
const STATUS_LABEL = { complete: 'Complete', canceled: 'Canceled', pending: 'Pending', processing: 'Processing', closed: 'Closed' };

const FIELDS = {
  grand_total: ['order total (grand total)', 'o.grand_total'],
  shipping_amount: ['shipping & handling charge', 'o.shipping_amount'],
  subtotal: ['subtotal', 'o.subtotal'],
};
const orderField = {
  id: 'gen-shopping-order-field', site: 'shopping', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1, cap: 50,
  phrasings: [
    'What was the {{field}} of my order #{{order}}?',
    'Open my order {{order}} and tell me its {{field}}.',
    'Check order number {{order}} in my account: how much was the {{field}}?',
  ],
  sample(L, r) {
    const out = [];
    for (const c of shoppers(L, 2)) {
      const orders = L.all('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at', c.id);
      for (const o of r.sample(orders, 4)) {
        const key = r.pick(Object.keys(FIELDS));
        const v = o[key];
        if (v == null) continue;
        const others = Object.keys(FIELDS).map((k) => o[k]).filter((x) => x != null && Math.abs(x - v) > 0.004);
        if (!others.length && key !== 'grand_total') continue;
        out.push({ slots: { field: FIELDS[key][0], order: o.increment_id }, login_user: c.email,
          eval: { type: 'answer', answer: { must_include: [L.moneyRef(v)] }, answer_sql: `SELECT ${L.moneySql(FIELDS[key][1])} FROM orders o WHERE o.id = ${o.id}` },
          wrong_answer: `$${(others[0] ?? v + 7).toFixed(2)}` });
      }
    }
    return out;
  },
};

const maxInMonth = {
  id: 'gen-shopping-largest-order-in-month', site: 'shopping', kind: 'read', skills: ['navigate', 'aggregate', 'compare'], difficulty: 2, cap: 55,
  phrasings: [
    'Which of my orders placed in {{month}} had the highest order total? Give me the order number.',
    'I placed several orders in {{month}}. What is the order number of the most expensive one?',
    'Find my biggest order (by order total) from {{month}} and tell me its order #.',
  ],
  sample(L, r) {
    const out = [];
    for (const c of shoppers(L, 4)) {
      const rows = L.all(`SELECT substr(admin_local(created_at), 1, 7) AS m, id, increment_id, grand_total FROM orders WHERE customer_id = ? ORDER BY created_at`, c.id);
      const by = new Map();
      for (const x of rows) { if (!by.has(x.m)) by.set(x.m, []); by.get(x.m).push(x); }
      for (const [m, os] of by) {
        if (os.length < 2) continue;
        const s = os.slice().sort((a, b) => b.grand_total - a.grand_total);
        if (Math.abs(s[0].grand_total - s[1].grand_total) < 0.005) continue;
        const sql = `SELECT ${L.orderSql('increment_id')} FROM orders WHERE customer_id = ${c.id} AND substr(admin_local(created_at), 1, 7) = ${L.lit(m)} ORDER BY grand_total DESC LIMIT 1`;
        out.push({ slots: { month: L.monthName(m) }, login_user: c.email, difficulty: os.length > 3 ? 3 : 2,
          eval: { type: 'answer', answer: { must_include: [L.orderRef(s[0].increment_id)] }, answer_sql: sql }, wrong_answer: s[1].increment_id });
      }
    }
    return out;
  },
};

const unitsBought = {
  id: 'gen-shopping-units-bought', site: 'shopping', kind: 'read', skills: ['navigate', 'aggregate', 'read-detail'], difficulty: 2, cap: 50,
  phrasings: [
    'How many units of "{{item}}" have I bought in total, not counting canceled orders?',
    'Across all my orders except the canceled ones, what total quantity of "{{item}}" did I purchase?',
    'Count how many "{{item}}" I have ordered so far (ignore canceled orders).',
  ],
  sample(L, r) {
    const out = [];
    for (const c of shoppers(L, 3)) {
      const items = L.all(`SELECT i.name, count(DISTINCT o.id) AS orders, sum(CASE WHEN o.status <> 'canceled' THEN i.qty_ordered ELSE 0 END) AS units,
          sum(CASE WHEN o.status = 'canceled' THEN 1 ELSE 0 END) AS canceled
        FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.customer_id = ? AND i.parent_item_id IS NULL GROUP BY i.name HAVING count(DISTINCT o.id) >= 2 AND units > 0`, c.id);
      for (const it of r.sample(items, 3)) {
        if (it.name.length > 110 || it.name.includes('&')) continue;
        const sql = `SELECT CAST(coalesce(sum(i.qty_ordered), 0) AS INTEGER) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.customer_id = ${c.id} AND i.parent_item_id IS NULL AND o.status <> 'canceled' AND i.name = ${L.lit(it.name)}`;
        const n = Math.round(it.units);
        out.push({ slots: { item: L.plain(it.name).trim() }, login_user: c.email, difficulty: it.orders > 2 ? 3 : 2,
          eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: sql }, wrong_answer: String(n + 1) });
      }
    }
    return out;
  },
};

const statusCount = {
  id: 'gen-shopping-orders-by-status', site: 'shopping', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 2, cap: 45,
  phrasings: [
    'How many of my orders have the status "{{status}}"?',
    'Go through my order history and count the orders that are {{status}}.',
    'In My Orders, how many orders are marked {{status}}?',
  ],
  sample(L, r) {
    const out = [];
    for (const c of shoppers(L, 4)) {
      for (const st of ['complete', 'canceled', 'pending']) {
        const n = L.one('SELECT count(*) FROM orders WHERE customer_id = ? AND status = ?', c.id, st);
        const tot = L.one('SELECT count(*) FROM orders WHERE customer_id = ?', c.id);
        if (n === tot) continue;
        if (n === 0 && st !== 'pending') continue;
        out.push({ slots: { status: STATUS_LABEL[st] }, login_user: c.email, difficulty: tot > 10 ? 2 : 1,
          eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: `SELECT count(*) FROM orders WHERE customer_id = ${c.id} AND status = ${L.lit(st)}` },
          wrong_answer: String(n + 1) });
      }
    }
    return out;
  },
};

const ADDR = { telephone: 'phone number', postcode: 'ZIP code', city: 'city', street: 'street address' };
const addressField = {
  id: 'gen-shopping-address-field', site: 'shopping', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1, cap: 40,
  phrasings: [
    'What {{field}} is on my default {{which}} address?',
    'Check my address book: which {{field}} is saved in my default {{which}} address?',
  ],
  sample(L, r) {
    const out = [];
    for (const c of L.customers()) {
      for (const which of ['shipping', 'billing']) {
        const aid = which === 'shipping' ? c.default_shipping_id : c.default_billing_id;
        if (!aid) continue;
        const a = L.get('SELECT * FROM customer_addresses WHERE id = ?', aid);
        if (!a) continue;
        const key = r.pick(Object.keys(ADDR));
        const v = String(a[key] || '').split('\n')[0].trim();
        if (!v) continue;
        const sql = key === 'street' ? `SELECT trim(substr(street || char(10), 1, instr(street || char(10), char(10)) - 1)) FROM customer_addresses WHERE id = ${aid}` : `SELECT ${key} FROM customer_addresses WHERE id = ${aid}`;
        out.push({ slots: { field: ADDR[key], which }, login_user: c.email,
          eval: { type: 'answer', answer: { must_include: [v] }, answer_sql: sql }, wrong_answer: 'unknown' });
      }
    }
    return out;
  },
};

const guestLookup = {
  id: 'gen-shopping-guest-order-lookup', site: 'shopping', kind: 'read', skills: ['form-edit', 'read-detail'], difficulty: 2, cap: 50,
  phrasings: [
    'Without signing in, use the store\'s "Orders and Returns" page to look up order {{order}} (billing last name {{lastname}}, e-mail {{email}}). What is its status and order total?',
    'A customer called about order #{{order}}; the billing last name is {{lastname}} and the e-mail is {{email}}. Look it up through "Orders and Returns" and tell me the status and the grand total.',
  ],
  sample(L, r) {
    const out = [];
    const rows = L.all(`SELECT o.id, o.increment_id, o.status, o.grand_total, o.customer_email, a.lastname FROM orders o JOIN order_addresses a ON a.order_id = o.id AND a.address_type = 'billing'
      WHERE o.customer_email IS NOT NULL AND a.lastname IS NOT NULL ORDER BY o.id`);
    for (const o of rows) {
      const label = STATUS_LABEL[o.status];
      if (!label) continue;
      const sql = `SELECT (SELECT label FROM order_statuses WHERE status = o.status) FROM orders o WHERE o.id = ${o.id} UNION ALL SELECT ${L.moneySql('grand_total')} FROM orders WHERE id = ${o.id}`;
      out.push({ slots: { order: o.increment_id, lastname: o.lastname, email: o.customer_email }, login_user: null, start_url: '__SHOPPING__/',
        eval: { type: 'answer', answer: { must_include: [label, L.moneyRef(o.grand_total)] }, answer_sql: sql }, wrong_answer: `${label === 'Complete' ? 'Pending' : 'Complete'}, $${(o.grand_total + 1).toFixed(2)}` });
    }
    return out;
  },
};

module.exports = [orderField, maxInMonth, unitsBought, statusCount, addressField, guestLookup];
module.exports.shoppers = shoppers;
