'use strict';
// Back-office read templates on the catalog and reviews: product grid filter counts, product
// attributes by SKU, category product counts, reviews by nickname; reports (bestsellers, orders,
// order totals by customer), search terms.
const path = require('node:path');

const ADMIN = 'admin';
const TERMS = ['Hoodie', 'Jacket', 'Tee', 'Short', 'Pant', 'Tank', 'Bra', 'Bag', 'Watch', 'Yoga', 'Running', 'Organic', 'Charger', 'Cable', 'Case', 'Wireless', 'Bluetooth',
  'Coffee', 'Chocolate', 'Shampoo', 'Lamp', 'Pillow', 'Towel', 'Mug', 'Knife', 'Candle', 'Socks', 'Gloves', 'Backpack', 'Keyboard', 'Speaker', 'Headphones', 'Mouse',
  'Notebook', 'Pen', 'Sticker', 'Sweatshirt', 'Jogger', 'Legging', 'Capri', 'Sneaker', 'Sandal', 'Boot', 'Necklace', 'Earring', 'Bracelet', 'Wallet', 'Belt', 'Scarf', 'Hat',
  'Glasses', 'Tripod', 'Camera', 'Lens', 'Battery', 'Adapter', 'Monitor', 'Printer', 'Router', 'Drone', 'Guitar', 'Drum', 'Toy', 'Doll', 'Game', 'Controller', 'Charging',
  'Vitamin', 'Protein', 'Soap', 'Lotion', 'Perfume', 'Razor', 'Comb', 'Mirror', 'Rug', 'Shelf', 'Chair', 'Desk', 'Table', 'Sofa', 'Mattress', 'Frame', 'Clock', 'Vase', 'Puzzle', 'Blanket', 'Curtain', 'Basket', 'Bottle', 'Brush', 'Cream', 'Serum', 'Oil', 'Tea', 'Cookie', 'Sauce', 'Snack'];

const productGridCount = {
  id: 'gen-admin-product-grid-count', site: 'shopping_admin', kind: 'read', skills: ['filter-sort', 'aggregate'], difficulty: 2, cap: 100,
  phrasings: [
    'In the products grid, how many products have "{{term}}" in their name and {{cond}}?',
    'Filter the catalog products by name containing "{{term}}" and {{cond}}. How many records are found?',
    'How many catalog products whose name includes "{{term}}" have {{cond2}}?',
  ],
  sample(L, r) {
    const out = [];
    const all = L.all('SELECT id, lower(name) AS n, price, qty, status, type, visibility FROM products');
    const CONDS = [
      () => { const a = r.pick([10, 20, 25, 30, 50]); const b = a + r.pick([10, 15, 20, 30, 50]); return [`a price between $${a} and $${b}`, `a price from $${a} to $${b}`, `price >= ${a} AND price <= ${b}`, (p) => p.price != null && p.price >= a && p.price <= b]; },
      () => { const q = r.pick([0, 5, 10, 20, 50]); return [`a quantity of ${q} or less`, `at most ${q} units in stock (quantity)`, `qty <= ${q}`, (p) => p.qty != null && p.qty <= q]; },
      () => ['status Disabled', 'the status Disabled', 'status = 2', (p) => p.status === 2],
      () => ['type Configurable Product', 'the product type Configurable Product', "type = 'configurable'", (p) => p.type === 'configurable'],
      () => ['visibility "Not Visible Individually"', 'visibility set to "Not Visible Individually"', 'visibility = 1', (p) => p.visibility === 1],
    ];
    for (const term of TERMS) {
      const t = term.toLowerCase();
      const sub = all.filter((p) => p.n.includes(t));
      // the grid matches substrings; keep terms where that equals the word-start match ("Tee" must not hit "Steel")
      const wordy = (p) => (' ' + p.n.replace(/[-(]/g, ' ')).includes(' ' + t);
      for (const mk of CONDS) {
        const [cond, cond2, where, f] = mk();
        const hit = sub.filter(f);
        const n = hit.length;
        if (n < 1 || n > 3000 || n === sub.length || hit.some((p) => !wordy(p))) continue;
        const sql = `SELECT ${L.intSql('n')} FROM (SELECT count(*) AS n FROM products WHERE instr(lower(name), lower(${L.lit(term)})) > 0 AND ${where})`;
        out.push({ slots: { term, cond, cond2 }, login_user: ADMIN,
          eval: { type: 'answer', answer: { must_include: [L.intRef(n)] }, answer_sql: sql }, wrong_answer: String(n + 1) });
      }
    }
    return out;
  },
};

const ATTRS = {
  weight: ['weight', (p) => (p.weight != null ? String(+p.weight) : null), "CASE WHEN weight = CAST(weight AS INTEGER) THEN CAST(CAST(weight AS INTEGER) AS TEXT) ELSE CAST(weight AS TEXT) END"],
  qty: ['quantity in stock', (p) => (p.type === 'simple' && p.qty != null ? String(Math.round(p.qty)) : null), 'CAST(CAST(qty AS INTEGER) AS TEXT)'],
  url_key: ['URL key', (p) => p.url_key, 'url_key'],
  meta_title: ['meta title', (p) => p.meta_title, 'meta_title'],
  price: ['price', (p) => (p.type === 'simple' && p.price != null ? (Math.round(p.price * 100) / 100).toFixed(2) : null), "printf('%.2f', price)"],
};
const productAttr = {
  id: 'gen-admin-product-attribute', site: 'shopping_admin', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 100,
  phrasings: [
    'What is the {{attr}} of the product with SKU {{sku}}? Answer with the value only.',
    'Open the product {{sku}} in the catalog and tell me its {{attr}} (just the value).',
  ],
  sample(L, r) {
    const out = [];
    const ps = L.all('SELECT id, sku, type, weight, qty, url_key, meta_title, price FROM products WHERE id % 97 = 5 OR id <= 2040 ORDER BY id');
    for (const p of r.sample(ps, 400)) {
      const k = r.pick(Object.keys(ATTRS));
      const [label, f, expr] = ATTRS[k];
      const v = f(p);
      if (v == null || v === '' || String(v).length > 70 || (k === 'meta_title' && v === p.name)) continue;
      if (!/^[\w.-]+$/.test(p.sku)) continue;
      out.push({ slots: { attr: label, sku: p.sku }, login_user: ADMIN,
        // text values: exact (a longer key/title containing the value must not pass); numbers: must_include
        eval: { type: 'answer', answer: k === 'url_key' || k === 'meta_title' ? { exact: v } : { must_include: [v] }, answer_sql: `SELECT ${expr} FROM products WHERE id = ${p.id}` },
        wrong_answer: k === 'qty' || k === 'weight' ? String(+v + 3) : k === 'url_key' ? `${v}-xs` : 'none' });
    }
    return out;
  },
};

const categoryCount = {
  id: 'gen-admin-category-product-count', site: 'shopping_admin', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1, cap: 100,
  phrasings: [
    'How many products are assigned directly to the category "{{category}}"?',
    'In Catalog > Categories, how many products does the "{{category}}" category contain (directly assigned)?',
  ],
  sample(L, r) {
    const out = [];
    for (const c of L.tree().rows) {
      if (c.level < 3) continue;
      const sql = `SELECT ${L.intSql('n')} FROM (SELECT count(*) AS n FROM product_categories WHERE category_id = ${c.id})`;
      const n = L.one(`SELECT count(*) FROM product_categories WHERE category_id = ${c.id}`);
      if (n < 1) continue;
      out.push({ slots: { category: L.catPath(c) }, login_user: ADMIN,
        eval: { type: 'answer', answer: { must_include: [L.intRef(n)] }, answer_sql: sql }, wrong_answer: String(n + 1) });
    }
    return out;
  },
};

const reviewsByNick = {
  id: 'gen-admin-reviews-by-nickname', site: 'shopping_admin', kind: 'read', skills: ['filter-sort', 'aggregate'], difficulty: 1, cap: 80,
  phrasings: [
    'How many product reviews were posted under the nickname "{{nick}}"?',
    'Filter All Reviews by nickname "{{nick}}". How many reviews are there?',
  ],
  sample(L, r) {
    const out = [];
    const nicks = L.col("SELECT nickname FROM reviews WHERE length(nickname) BETWEEN 6 AND 24 AND nickname GLOB '[A-Za-z]*' AND nickname NOT GLOB '*[^A-Za-z0-9 ._-]*' GROUP BY nickname HAVING count(*) BETWEEN 2 AND 40 ORDER BY count(*) DESC LIMIT 400");
    const allNicks = L.col('SELECT lower(nickname) FROM reviews WHERE nickname IS NOT NULL');
    for (const nick of nicks) {
      const n = L.one('SELECT count(*) FROM reviews WHERE nickname = ?', nick);
      const ln = nick.toLowerCase();
      let like = 0; for (const x of allNicks) if (x.includes(ln)) like++;
      if (like !== n) continue;
      out.push({ slots: { nick }, login_user: ADMIN,
        eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: `SELECT count(*) FROM reviews WHERE nickname = ${L.lit(nick)}` }, wrong_answer: String(n + 1) });
    }
    return out;
  },
};

// ---- reports (same aggregation as sites/store/admin/lib/reports.js; cross-checked below)
const REPORTS = require(path.join(__dirname, '..', '..', '..', '..', 'sites', 'store', 'admin', 'lib', 'reports.js')).REPORTS;
const months = (L) => L.col("SELECT DISTINCT substr(admin_local(created_at), 1, 7) FROM orders ORDER BY 1");
const params = (L, ym) => ({ from: `${ym}-01`, to: L.lastDay(ym), period: 'month', dateUsed: 'created_at', statuses: [], showEmpty: false });
const plainItem = (L, s) => L.plain(s);
// report periods: months (monthly rows) and quarters / years (one yearly row for the range)
function periods(L) {
  const out = months(L).map((ym) => ({ label: L.monthName(ym), from: `${ym}-01`, to: L.lastDay(ym), period: 'month' }));
  for (const y of ['2022', '2023']) {
    for (let q = 1; q <= 4; q++) {
      const m1 = String(3 * q - 2).padStart(2, '0'); const m3 = `${y}-${String(3 * q).padStart(2, '0')}`;
      if (`${y}-${m1}` > '2023-05') continue;
      out.push({ label: `Q${q} ${y} (${L.longDate(`${y}-${m1}-01`)} to ${L.longDate(L.lastDay(m3))})`, from: `${y}-${m1}-01`, to: L.lastDay(m3), period: 'year' });
    }
    out.push({ label: `the year ${y}`, from: `${y}-01-01`, to: `${y}-12-31`, period: 'year' });
  }
  return out;
}
const pOf = (x) => ({ from: x.from, to: x.to, period: x.period, dateUsed: 'created_at', statuses: [], showEmpty: false });

const bestseller = {
  id: 'gen-admin-bestseller-units', site: 'shopping_admin', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2, cap: 60,
  regradeNote: 'regrade 2026-11-15 (strict numbers): tie instances set answer.strict_numbers false -- the intent also asks for the product, and product names carry numbers ("9 Elements ...", "Sprite Stasis Ball 75 cm"), so a correct answer naming the tied products would fail the count check.',
  phrasings: [
    'According to the Bestsellers report for {{month}}, which product is the top seller{{and_qty}}',
    'Run the Bestsellers report for {{month}}. What is the number one product{{and_qty}}',
  ],
  sample(L, r) {
    const out = [];
    for (const per of periods(L)) {
      const rows = REPORTS.bestsellers.compute(L.db(), pOf(per));
      if (rows.length < 2 || rows[0].period !== rows[rows.length - 1].period) continue;
      const a = per.from; const b = per.to;
      const base = `FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.state <> 'canceled' AND coalesce(i.product_type, 'simple') NOT IN ('configurable', 'bundle', 'grouped') AND admin_local_date(o.created_at) BETWEEN '${a}' AND '${b}'`;
      const nm = "trim(replace(replace(coalesce((SELECT name FROM products WHERE id = i.product_id), max(i.name)), '&trade;', '™'), '&reg;', '®'))";
      const qty = 'CAST(sum(i.qty_ordered - coalesce(i.qty_canceled, 0)) AS INTEGER)';
      if (rows[0].qty_ordered !== rows[1].qty_ordered) {
        // unique top seller: name (+ units)
        const name = plainItem(L, rows[0].product_name).trim();
        const sql = `SELECT ${nm} ${base} GROUP BY i.product_id ORDER BY sum(i.qty_ordered - coalesce(i.qty_canceled, 0)) DESC LIMIT 1`;
        if (L.plain(L.one(sql)).trim() !== name) throw new Error(`bestseller mismatch ${per.label}`);
        out.push({ slots: { month: per.label, and_qty: '?' }, login_user: ADMIN,
          eval: { type: 'answer', answer: { must_include: [name] }, answer_sql: sql }, wrong_answer: plainItem(L, rows[1].product_name) });
      } else {
        // tie at the top (the report breaks it by price, then product id): ask for the units sold, which is well defined
        const n = Math.round(rows[0].qty_ordered);
        const sql = `SELECT ${qty} ${base} GROUP BY i.product_id ORDER BY 1 DESC LIMIT 1`;
        out.push({ slots: { month: per.label, and_qty: ', and how many units of it were sold? (If several products tie for first place, the unit count is enough.)' }, login_user: ADMIN,
          eval: { type: 'answer', answer: { must_include: [String(n)], strict_numbers: false }, answer_sql: sql }, wrong_answer: String(n + 1) });
      }
    }
    return out;
  },
};

const salesMonth = {
  id: 'gen-admin-orders-report-month', site: 'shopping_admin', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2, cap: 40,
  phrasings: [
    'Using the Orders report, how many orders were counted in {{month}} and what was the Sales Total?',
    'Generate the sales Orders report for {{month}}. Tell me the number of orders and the sales total for that period.',
  ],
  sample(L, r) {
    const out = [];
    for (const per of periods(L)) {
      const rows = REPORTS.sales.compute(L.db(), pOf(per));
      if (rows.length !== 1) continue;
      const x = rows[0];
      const a = per.from; const b = per.to;
      const CANCELED = "(CASE WHEN o.state = 'canceled' THEN coalesce(o.total_canceled, o.grand_total) ELSE coalesce(o.total_canceled, 0) END)";
      const W = `FROM orders o WHERE o.state NOT IN ('new', 'pending_payment') AND admin_local_date(o.created_at) BETWEEN '${a}' AND '${b}'`;
      const sql = `SELECT CAST(count(*) AS TEXT) ${W} UNION ALL SELECT ${L.moneySql('t')} FROM (SELECT sum(o.grand_total - ${CANCELED}) AS t ${W})`;
      out.push({ slots: { month: per.label }, login_user: ADMIN,
        eval: { type: 'answer', answer: { must_include: [String(x.orders_count), L.moneyRef(x.total_income_amount)] }, answer_sql: sql }, wrong_answer: `${x.orders_count + 1} orders, $${(x.total_income_amount + 10).toFixed(2)}` });
    }
    return out;
  },
};

const topCustomer = {
  id: 'gen-admin-top-customer-period', site: 'shopping_admin', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2, cap: 40,
  phrasings: [
    'Which customer had the highest order total in {{period}} according to the "Order Total" customer report?',
    'Run Reports > Customers > Order Total for {{period}}. Who is the top customer?',
    'Who spent the most at the store in {{period}} (Order Total report)?',
  ],
  sample(L, r) {
    const out = [];
    for (const per of periods(L)) {
      const p = pOf(per);
      const rows = REPORTS.customer_totals.compute(L.db(), p);
      if (rows.length < 2 || rows[0].period !== rows[1].period || Math.abs(rows[0].orders_sum_amount - rows[1].orders_sum_amount) < 0.005) continue;
      const sql = `SELECT trim(coalesce(max(o.customer_firstname), '') || ' ' || coalesce(max(o.customer_lastname), '')) FROM orders o WHERE o.state <> 'canceled' AND o.customer_id IS NOT NULL AND admin_local_date(o.created_at) BETWEEN '${p.from}' AND '${p.to}' GROUP BY o.customer_id ORDER BY sum(o.grand_total) DESC LIMIT 1`;
      out.push({ slots: { period: per.label }, login_user: ADMIN,
        eval: { type: 'answer', answer: { must_include: [rows[0].name] }, answer_sql: sql }, wrong_answer: rows[1].name });
    }
    return out;
  },
};

// one number per task: asking for both lets an answer with the two numbers swapped pass must_include
const searchTerm = {
  id: 'gen-admin-search-term-stats', site: 'shopping_admin', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 72,
  phrasings: [
    'In Marketing > Search Terms, find the term "{{q}}": {{what_q}}?',
    'Look up the search term "{{q}}" in the admin: {{what_q}}?',
  ],
  sample(L, r) {
    const out = [];
    for (const t of L.all('SELECT id, query_text, num_results, popularity FROM search_terms WHERE length(query_text) BETWEEN 3 AND 40 ORDER BY id')) {
      if (t.num_results === t.popularity || t.num_results == null || t.popularity == null) continue;
      if (L.one('SELECT count(*) FROM search_terms WHERE instr(lower(query_text), lower(?)) > 0', t.query_text) !== 1) continue;
      const uses = r() < 0.5;
      const [v, other, col] = uses ? [t.popularity, t.num_results, 'popularity'] : [t.num_results, t.popularity, 'num_results'];
      out.push({ slots: { q: t.query_text, what_q: uses ? 'how many times has it been used (Uses)' : 'how many results does it return (Results)' }, login_user: ADMIN,
        eval: { type: 'answer', answer: { must_include: [L.intRef(v)] }, answer_sql: `SELECT ${L.intSql(col)} FROM search_terms WHERE id = ${t.id}` },
        wrong_answer: String(other) });
    }
    return out;
  },
};

module.exports = [productGridCount, productAttr, categoryCount, reviewsByNick, bestseller, salesMonth, topCustomer, searchTerm];
