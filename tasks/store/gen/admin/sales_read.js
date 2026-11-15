'use strict';
// Back-office read templates on orders and customers: orders grid filters (status + purchase date
// range), order view fields, a customer's orders, customer lookup by phone / ZIP, customer fields.

const ADMIN = 'admin';
const STATUS = { complete: 'Complete', canceled: 'Canceled', pending: 'Pending', processing: 'Processing' };
const dup = (L) => new Set(L.col("SELECT firstname || ' ' || lastname FROM customers GROUP BY 1 HAVING count(*) > 1"));
const custLabel = (L, c, d) => (d.has(`${c.firstname} ${c.lastname}`) ? `${c.firstname} ${c.lastname} (${c.email})` : `${c.firstname} ${c.lastname}`);
// random local date ranges inside the order history (2022-01 .. 2023-05)
function ranges(r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = r.pick([2022, 2022, 2023]);
    const m1 = y === 2023 ? 1 + r.int(4) : 1 + r.int(11);
    const d1 = 1 + r.int(28);
    const span = 15 + r.int(120);
    const a = new Date(Date.UTC(y, m1 - 1, d1));
    const b = new Date(a.getTime() + span * 864e5);
    const end = b > new Date(Date.UTC(2023, 4, 31)) ? new Date(Date.UTC(2023, 4, 31)) : b;
    out.push([a.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]);
  }
  return out;
}

const ordersInRange = {
  id: 'gen-admin-orders-status-daterange', site: 'shopping_admin', kind: 'read', skills: ['filter-sort', 'aggregate'], difficulty: 2, cap: 100,
  phrasings: [
    'How many orders with status "{{status}}" were placed between {{from}} and {{to}} (inclusive)?',
    'Filter the orders grid by purchase date from {{from}} to {{to}} and status {{status}}. How many orders match?',
    'Count the {{status}} orders whose purchase date falls in {{from}} - {{to}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const [a, b] of ranges(r, 320)) {
      const st = r.pick(Object.keys(STATUS));
      const sql = `SELECT count(*) FROM orders WHERE status = ${L.lit(st)} AND admin_local_date(created_at) BETWEEN ${L.lit(a)} AND ${L.lit(b)}`;
      const n = L.one(sql);
      if (n < 1) continue;
      out.push({ slots: { status: STATUS[st], from: L.usDate(a), to: L.usDate(b) }, login_user: ADMIN,
        eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: sql }, wrong_answer: String(n + 1) });
    }
    return out;
  },
};

const OFIELDS = {
  email: ['customer e-mail address', (o) => o.customer_email, (id) => `SELECT customer_email FROM orders WHERE id = ${id}`],
  city: ['ship-to city', (o) => o.ship_city, (id) => `SELECT city FROM order_addresses WHERE order_id = ${id} AND address_type = 'shipping'`],
  phone: ['billing phone number', (o) => o.bill_phone, (id) => `SELECT telephone FROM order_addresses WHERE order_id = ${id} AND address_type = 'billing'`],
  qty: ['total number of units ordered', (o) => String(Math.round(o.total_qty_ordered)), (id) => `SELECT CAST(sum(qty_ordered) AS INTEGER) FROM order_items WHERE order_id = ${id} AND parent_item_id IS NULL`],
  total: ['grand total', (o) => L_money(o.grand_total), (id) => `SELECT ${moneySqlLocal('grand_total')} FROM orders WHERE id = ${id}`],
};
let L_money; let moneySqlLocal;
const orderField = {
  id: 'gen-admin-order-view-field', site: 'shopping_admin', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 100,
  phrasings: [
    'What is the {{field}} of order #{{order}}?',
    'Open order {{order}} in the admin and tell me its {{field}}.',
    'Look up sales order {{order}}: what {{field}} does it show?',
  ],
  sample(L, r) {
    L_money = L.moneyRef; moneySqlLocal = L.moneySql;
    const out = [];
    const os = L.all(`SELECT o.*, (SELECT city FROM order_addresses WHERE order_id = o.id AND address_type = 'shipping') AS ship_city,
      (SELECT telephone FROM order_addresses WHERE order_id = o.id AND address_type = 'billing') AS bill_phone,
      (SELECT sum(qty_ordered) FROM order_items WHERE order_id = o.id AND parent_item_id IS NULL) AS total_qty_ordered FROM orders o ORDER BY o.id`);
    for (const o of r.sample(os, 250)) {
      const k = r.pick(Object.keys(OFIELDS));
      const [label, f, q] = OFIELDS[k];
      const v = f(o);
      if (!v) continue;
      out.push({ slots: { field: label, order: o.increment_id }, login_user: ADMIN,
        eval: { type: 'answer', answer: { must_include: [v] }, answer_sql: q(o.id) }, wrong_answer: k === 'qty' ? String(+v + 1) : 'unknown' });
    }
    return out;
  },
};

function custs(L, min = 1) {
  return L.all('SELECT c.*, (SELECT count(*) FROM orders o WHERE o.customer_id = c.id) AS n FROM customers c ORDER BY c.id').filter((c) => c.n >= min);
}
const customerOrders = {
  id: 'gen-admin-customer-order-count', site: 'shopping_admin', kind: 'read', skills: ['search', 'aggregate'], difficulty: 2, cap: 100,
  phrasings: [
    'How many {{status_word}}orders has the customer {{customer}} placed?',
    'Check the orders of customer {{customer}}: how many {{status_word}}orders are there?',
  ],
  sample(L, r) {
    const out = [];
    const d = dup(L);
    for (const c of custs(L, 2)) {
      for (const st of [null, 'complete', 'canceled']) {
        const sql = `SELECT count(*) FROM orders WHERE customer_id = ${c.id}${st ? ` AND status = ${L.lit(st)}` : ''}`;
        const n = L.one(sql);
        if (st && (n === 0 || n === c.n)) continue;
        out.push({ slots: { customer: custLabel(L, c, d), status_word: st ? `${STATUS[st].toLowerCase()} ` : '' }, login_user: ADMIN, difficulty: st ? 2 : 1,
          eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: sql }, wrong_answer: String(n + 1) });
      }
    }
    return out;
  },
};

const biggestOrder = {
  id: 'gen-admin-customer-biggest-order', site: 'shopping_admin', kind: 'read', skills: ['search', 'filter-sort', 'compare'], difficulty: 2, cap: 90,
  phrasings: [
    'What is the order number of {{customer}}\'s largest {{status_word}}order by grand total?',
    'Among the {{status_word}}orders of {{customer}}, which one has the highest grand total? Give the order #.',
  ],
  sample(L, r) {
    const out = [];
    const d = dup(L);
    for (const c of custs(L, 3)) {
      for (const st of [null, 'complete', 'canceled']) {
        const os = L.all(`SELECT increment_id, grand_total FROM orders WHERE customer_id = ?${st ? ' AND status = ?' : ''} ORDER BY grand_total DESC`, ...(st ? [c.id, st] : [c.id]));
        if (os.length < 2 || Math.abs(os[0].grand_total - os[1].grand_total) < 0.005) continue;
        const sql = `SELECT ${L.orderSql('increment_id')} FROM orders WHERE customer_id = ${c.id}${st ? ` AND status = ${L.lit(st)}` : ''} ORDER BY grand_total DESC LIMIT 1`;
        out.push({ slots: { customer: custLabel(L, c, d), status_word: st ? `${STATUS[st].toLowerCase()} ` : '' }, login_user: ADMIN,
          eval: { type: 'answer', answer: { must_include: [L.orderRef(os[0].increment_id)] }, answer_sql: sql }, wrong_answer: os[1].increment_id });
      }
    }
    return out;
  },
};

const customerLookup = {
  id: 'gen-admin-customer-lookup', site: 'shopping_admin', kind: 'read', skills: ['search', 'filter-sort'], difficulty: 1, cap: 60,
  phrasings: [
    'Which customer has the billing {{what}} {{value}}? Give me their name and e-mail address.',
    'Find the customer whose billing {{what}} is {{value}} and tell me the name and e-mail.',
  ],
  sample(L, r) {
    const out = [];
    const rows = L.all('SELECT c.id, c.firstname, c.lastname, c.email, a.telephone, a.postcode FROM customers c JOIN customer_addresses a ON a.id = c.default_billing_id');
    for (const what of ['telephone', 'postcode']) {
      for (const x of rows) {
        const v = x[what];
        if (!v || rows.filter((y) => y[what] === v).length !== 1) continue;
        // the grid's text filter is a substring match: no other billing value may contain it
        if (rows.some((y) => y.id !== x.id && String(y[what] || '').includes(v))) continue;
        const sql = `SELECT trim(c.firstname || ' ' || c.lastname) FROM customers c JOIN customer_addresses a ON a.id = c.default_billing_id WHERE a.${what} = ${L.lit(v)} UNION ALL SELECT c.email FROM customers c JOIN customer_addresses a ON a.id = c.default_billing_id WHERE a.${what} = ${L.lit(v)}`;
        out.push({ slots: { what: what === 'telephone' ? 'phone number' : 'ZIP code', value: v }, login_user: ADMIN,
          eval: { type: 'answer', answer: { must_include: [`${x.firstname} ${x.lastname}`, x.email] }, answer_sql: sql }, wrong_answer: 'No such customer' });
      }
    }
    return out;
  },
};

const GENDER = { 1: 'Male', 2: 'Female', 3: 'Not Specified' };
const customerField = {
  id: 'gen-admin-customer-field', site: 'shopping_admin', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 100,
  phrasings: [
    'In the admin, what is the {{field}} of customer {{customer}}?',
    'Open the customer {{customer}} and tell me their {{field}}.',
  ],
  sample(L, r) {
    const out = [];
    const d = dup(L);
    for (const c of L.all('SELECT c.*, (SELECT code FROM customer_groups g WHERE g.id = c.group_id) AS grp FROM customers c')) {
      const opts = [];
      if (c.grp) opts.push(['customer group', c.grp, `SELECT code FROM customer_groups WHERE id = (SELECT group_id FROM customers WHERE id = ${c.id})`]);
      if (c.dob) opts.push(['date of birth', L.dateRef(c.dob.slice(0, 10)), `SELECT ${L.dateSql('dob')} FROM customers WHERE id = ${c.id}`]);
      if (c.created_at) opts.push(['account creation date ("Customer Since")', L.dateRef(L.U.localDate(c.created_at)), `SELECT ${L.dateSql('admin_local_date(created_at)')} FROM customers WHERE id = ${c.id}`]);
      for (const [field, v, sql] of r.sample(opts, 2)) {
        out.push({ slots: { field, customer: custLabel(L, c, d) }, login_user: ADMIN,
          eval: { type: 'answer', answer: { must_include: [v] }, answer_sql: sql }, wrong_answer: field === 'customer group' ? (v === 'General' ? 'Wholesale' : 'General') : 'January 1, 1990' });
      }
    }
    return out;
  },
};

module.exports = [ordersInRange, orderField, customerOrders, biggestOrder, customerLookup, customerField];
