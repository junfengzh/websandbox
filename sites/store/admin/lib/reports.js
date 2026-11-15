'use strict';
// Report definitions for Reports > ... . Each report computes rows from the live sales /
// catalog / review tables (run by the 'admin.report' background job, see ../jobs.js).
//
// Common filter (Magento report filter form): report_from / report_to (M/D/YY, M/D/YYYY or
// YYYY-MM-DD, store-local days, inclusive), report_period day|month|year, report_type
// created_at_order|updated_at_order (date used), show_order_statuses 0 any|1 specified,
// order_statuses (list), show_empty_rows 0|1.
// Sales aggregation follows Magento: orders in state new / pending_payment are not counted;
// canceled orders count (Canceled column) except where noted.
const U = require('./util');

const LEN = { day: 10, month: 7, year: 4 };
const money = (key, label) => ({ key, label, type: 'money' });
const num = (key, label) => ({ key, label, type: 'num' });
const text = (key, label) => ({ key, label, type: 'text' });
const CANCELED = "(CASE WHEN o.state = 'canceled' THEN coalesce(o.total_canceled, o.grand_total) ELSE coalesce(o.total_canceled, 0) END)";

// canonical filter params from a query string object
function params(q, { statuses = true } = {}) {
  const from = U.parseDateInput(q.report_from ?? q.from);
  const to = U.parseDateInput(q.report_to ?? q.to);
  const period = LEN[q.report_period] ? q.report_period : 'day';
  const dateUsed = q.report_type === 'updated_at_order' ? 'updated_at' : 'created_at';
  const st = statuses && String(q.show_order_statuses || '0') === '1' ? U.arr(q.order_statuses ?? q['order_statuses[]']).flatMap((s) => String(s).split(',')).filter(Boolean).sort() : [];
  return { from, to, period, dateUsed, statuses: st, showEmpty: String(q.show_empty_rows || '0') === '1' };
}

function rangeSql(col, p, args) {
  const r = U.localRangeUtc(p.from, p.to);
  const w = [];
  if (r.from) { w.push(`${col} >= ?`); args.push(r.from); }
  if (r.to) { w.push(`${col} < ?`); args.push(r.to); }
  return w.length ? w.join(' AND ') : '1';
}
function statusSql(p, args, col = 'o.status') {
  if (!p.statuses.length) return '1';
  args.push(...p.statuses);
  return `${col} IN (${p.statuses.map(() => '?').join(',')})`;
}
const periodSql = (col, p) => `substr(admin_local(${col}), 1, ${LEN[p.period]})`;

// all periods between from and to (for "Empty Rows: Yes")
function periodsBetween(p) {
  if (!p.from || !p.to || p.from > p.to) return [];
  const out = [];
  let d = new Date(`${p.from}T00:00:00Z`);
  const end = new Date(`${p.to}T00:00:00Z`);
  let guard = 0;
  while (d <= end && guard++ < 4000) {
    const k = d.toISOString().slice(0, LEN[p.period]);
    if (out[out.length - 1] !== k) out.push(k);
    if (p.period === 'day') d = new Date(d.getTime() + 864e5);
    else if (p.period === 'month') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    else d = new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
  }
  return out;
}
function fillEmpty(rows, p, columns) {
  if (!p.showEmpty) return rows;
  const have = new Map(rows.map((r) => [r.period, r]));
  return periodsBetween(p).map((k) => have.get(k) || Object.fromEntries([['period', k], ...columns.filter((c) => c.type !== 'text' && c.key !== 'period').map((c) => [c.key, 0])]));
}
const periodLabel = (k, period) => {
  if (!k) return '';
  const [y, m, d] = String(k).split('-');
  if (period === 'year' || !m) return y;
  if (period === 'month' || !d) return `${+m}/${y}`;
  return `${+m}/${+d}/${y}`;
};
function totalsOf(rows, columns) {
  const t = {};
  for (const c of columns) if (c.type === 'money' || c.type === 'num') t[c.key] = rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0);
  return t;
}
// top N rows per period (Magento's report collections rank within the period)
function topPerPeriod(rows, n) {
  const seen = new Map();
  return rows.filter((r) => { const k = r.period; const c = (seen.get(k) || 0) + 1; seen.set(k, c); return c <= n; });
}

const REPORTS = {
  sales: {
    title: 'Orders Report', crumb: ['Sales', 'Orders'], path: '/admin/reports/report_sales/sales/', filter: 'sales',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, num('orders_count', 'Orders'), num('total_qty_ordered', 'Sales Items'), money('total_income_amount', 'Sales Total'), money('total_invoiced_amount', 'Invoiced'), money('total_refunded_amount', 'Refunded'), money('total_tax_amount', 'Sales Tax'), money('total_shipping_amount', 'Sales Shipping'), money('total_discount_amount', 'Sales Discount'), money('total_canceled_amount', 'Canceled')],
    compute(db, p) {
      const a = [];
      const col = `o.${p.dateUsed}`;
      const per = periodSql(col, p);
      const where = `o.state NOT IN ('new', 'pending_payment') AND ${rangeSql(col, p, a)} AND ${statusSql(p, a)}`;
      return db.prepare(`SELECT ${per} AS period, count(*) AS orders_count,
          sum((SELECT coalesce(sum(i.qty_ordered - coalesce(i.qty_canceled, 0)), 0) FROM order_items i WHERE i.order_id = o.id AND i.parent_item_id IS NULL)) AS total_qty_ordered,
          sum(o.grand_total - ${CANCELED}) AS total_income_amount, sum(coalesce(o.total_invoiced, 0)) AS total_invoiced_amount, sum(coalesce(o.total_refunded, 0)) AS total_refunded_amount,
          sum(CASE WHEN o.state = 'canceled' THEN 0 ELSE coalesce(o.tax_amount, 0) END) AS total_tax_amount,
          sum(CASE WHEN o.state = 'canceled' THEN 0 ELSE coalesce(o.shipping_amount, 0) - coalesce(o.shipping_canceled, 0) END) AS total_shipping_amount,
          sum(CASE WHEN o.state = 'canceled' THEN 0 ELSE abs(coalesce(o.discount_amount, 0)) END) AS total_discount_amount, sum(${CANCELED}) AS total_canceled_amount
        FROM orders o WHERE ${where} GROUP BY period ORDER BY period`).all(...a);
    },
  },
  tax: {
    title: 'Tax Report', crumb: ['Sales', 'Tax'], path: '/admin/reports/report_sales/tax/', filter: 'sales',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, text('code', 'Tax'), { key: 'percent', label: 'Rate', type: 'pct' }, num('orders_count', 'Orders'), money('tax_base_amount_sum', 'Tax Amount')],
    compute(db, p) {
      const a = [];
      const col = `o.${p.dateUsed}`;
      return db.prepare(`SELECT ${periodSql(col, p)} AS period,
          'US-' || coalesce((SELECT r.code FROM order_addresses ad JOIN regions r ON r.id = ad.region_id WHERE ad.order_id = o.id AND ad.address_type = 'shipping'), '*') || '-*-Rate 1' AS code,
          i.tax_percent AS percent, count(DISTINCT o.id) AS orders_count, sum(i.tax_amount) AS tax_base_amount_sum
        FROM orders o JOIN order_items i ON i.order_id = o.id AND i.parent_item_id IS NULL
        WHERE o.state <> 'canceled' AND coalesce(i.tax_amount, 0) > 0 AND ${rangeSql(col, p, a)} AND ${statusSql(p, a)}
        GROUP BY period, code, percent ORDER BY period, code`).all(...a);
    },
  },
  invoiced: {
    title: 'Invoice Report', crumb: ['Sales', 'Invoiced'], path: '/admin/reports/report_sales/invoiced/', filter: 'sales',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, num('orders_count', 'Orders'), num('orders_invoiced', 'Invoiced Orders'), money('invoiced', 'Total Invoiced'), money('invoiced_captured', 'Paid Invoices'), money('invoiced_not_captured', 'Unpaid Invoices')],
    compute(db, p) {
      const a = [];
      const col = `o.${p.dateUsed}`;
      return db.prepare(`SELECT ${periodSql(col, p)} AS period, count(*) AS orders_count, sum(CASE WHEN coalesce(o.total_invoiced, 0) > 0 THEN 1 ELSE 0 END) AS orders_invoiced,
          sum(coalesce(o.total_invoiced, 0)) AS invoiced, sum(min(coalesce(o.total_paid, 0), coalesce(o.total_invoiced, 0))) AS invoiced_captured,
          sum(max(0, coalesce(o.total_invoiced, 0) - coalesce(o.total_paid, 0))) AS invoiced_not_captured
        FROM orders o WHERE o.state <> 'canceled' AND coalesce(o.total_invoiced, 0) > 0 AND ${rangeSql(col, p, a)} AND ${statusSql(p, a)} GROUP BY period ORDER BY period`).all(...a);
    },
  },
  shipping: {
    title: 'Shipping Report', crumb: ['Sales', 'Shipping'], path: '/admin/reports/report_sales/shipping/', filter: 'sales',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, text('shipping_description', 'Carrier/Method'), num('orders_count', 'Orders'), money('total_shipping', 'Total Sales Shipping'), money('total_shipping_actual', 'Total Shipping')],
    compute(db, p) {
      const a = [];
      const col = `o.${p.dateUsed}`;
      return db.prepare(`SELECT ${periodSql(col, p)} AS period, o.shipping_description, count(*) AS orders_count, sum(coalesce(o.shipping_amount, 0)) AS total_shipping,
          sum(coalesce(o.shipping_invoiced, 0) - coalesce(o.shipping_refunded, 0)) AS total_shipping_actual
        FROM orders o WHERE o.state <> 'canceled' AND o.shipping_description IS NOT NULL AND ${rangeSql(col, p, a)} AND ${statusSql(p, a)}
        GROUP BY period, o.shipping_description ORDER BY period, o.shipping_description`).all(...a);
    },
  },
  refunded: {
    title: 'Refunds Report', crumb: ['Sales', 'Refunds'], path: '/admin/reports/report_sales/refunded/', filter: 'sales', dateLabels: ['Order Created', 'Last Credit Memo Created Date'],
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, num('orders_count', 'Refunded Orders'), money('refunded', 'Total Refunded'), money('online_refunded', 'Online Refunds'), money('offline_refunded', 'Offline Refunds')],
    compute(db, p) {
      const a = [];
      const col = p.dateUsed === 'updated_at' ? '(SELECT max(cm.created_at) FROM credit_memos cm WHERE cm.order_id = o.id)' : 'o.created_at';
      return db.prepare(`SELECT ${periodSql(col, p)} AS period, count(*) AS orders_count, sum(o.total_refunded) AS refunded,
          sum(coalesce(o.total_online_refunded, 0)) AS online_refunded, sum(coalesce(o.total_offline_refunded, o.total_refunded)) AS offline_refunded
        FROM orders o WHERE coalesce(o.total_refunded, 0) > 0 AND ${rangeSql(col, p, a)} AND ${statusSql(p, a)} GROUP BY period ORDER BY period`).all(...a);
    },
  },
  coupons: {
    title: 'Coupons Report', crumb: ['Sales', 'Coupons'], path: '/admin/reports/report_sales/coupons/', filter: 'sales',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, text('coupon_code', 'Coupon Code'), text('rule_name', 'Price Rule'), num('coupon_uses', 'Uses'), money('subtotal_amount', 'Sales Subtotal'), money('discount_amount', 'Sales Discount'), money('total_amount', 'Sales Total')],
    compute(db, p) {
      const a = [];
      const col = `o.${p.dateUsed}`;
      return db.prepare(`SELECT ${periodSql(col, p)} AS period, o.coupon_code, (SELECT sr.name FROM coupons c JOIN sales_rules sr ON sr.id = c.rule_id WHERE c.code = o.coupon_code) AS rule_name,
          count(*) AS coupon_uses, sum(coalesce(o.subtotal, 0)) AS subtotal_amount, sum(abs(coalesce(o.discount_amount, 0))) AS discount_amount, sum(coalesce(o.grand_total, 0)) AS total_amount
        FROM orders o WHERE o.coupon_code IS NOT NULL AND o.coupon_code <> '' AND o.state <> 'canceled' AND ${rangeSql(col, p, a)} AND ${statusSql(p, a)}
        GROUP BY period, o.coupon_code ORDER BY period, o.coupon_code`).all(...a);
    },
  },
  bestsellers: {
    title: 'Bestsellers Report', crumb: ['Products', 'Bestsellers'], path: '/admin/reports/report_sales/bestsellers/', filter: 'sales', noDateUsed: true,
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, text('product_name', 'Product'), money('product_price', 'Price'), num('qty_ordered', 'Order Quantity')],
    compute(db, p) {
      // Magento: simple products (configurable / bundle / grouped parents ignored), price of the parent line, top 5 per period, canceled orders excluded
      const a = [];
      const rows = db.prepare(`SELECT ${periodSql('o.created_at', p)} AS period, i.product_id, coalesce((SELECT name FROM products WHERE id = i.product_id), max(i.name)) AS product_name,
          min(CASE WHEN par.id IS NOT NULL AND coalesce(par.price, 0) > 0 THEN par.price ELSE i.price END) AS product_price, sum(i.qty_ordered - coalesce(i.qty_canceled, 0)) AS qty_ordered
        FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN order_items par ON par.id = i.parent_item_id
        WHERE o.state <> 'canceled' AND coalesce(i.product_type, 'simple') NOT IN ('configurable', 'bundle', 'grouped') AND ${rangeSql('o.created_at', p, a)} AND ${statusSql(p, a)}
        GROUP BY period, i.product_id ORDER BY period, qty_ordered DESC, product_price DESC, i.product_id`).all(...a);
      return topPerPeriod(rows, 5);
    },
  },
  sold: {
    title: 'Ordered Products Report', crumb: ['Products', 'Ordered'], path: '/admin/reports/report_product/sold/', filter: 'range',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, text('name', 'Product'), num('qty', 'Ordered Quantity')],
    compute(db, p) {
      const a = [];
      return db.prepare(`SELECT ${periodSql('o.created_at', p)} AS period, i.product_id, max(i.name) AS name, sum(i.qty_ordered) AS qty
        FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.parent_item_id IS NULL AND o.state <> 'canceled' AND ${rangeSql('o.created_at', p, a)}
        GROUP BY period, i.product_id ORDER BY period, qty DESC, i.product_id`).all(...a);
    },
  },
  viewed: {
    title: 'Product Views Report', crumb: ['Products', 'Views'], path: '/admin/reports/report_product/viewed/', filter: 'range',
    columns: [text('name', 'Product'), money('price', 'Price'), num('views', 'Views')],
    compute(db) {
      return db.prepare('SELECT v.product_id, p.name, p.price, v.views FROM (SELECT * FROM report_product_views) v JOIN products p ON p.id = v.product_id ORDER BY v.views DESC, v.product_id').all();
    },
  },
  customer_totals: {
    title: 'Order Total Report', crumb: ['Customers', 'Order Total'], path: '/admin/reports/report_customer/totals/', filter: 'range',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, text('name', 'Customer'), num('orders_count', 'Orders'), money('orders_avg_amount', 'Average'), money('orders_sum_amount', 'Total')],
    compute(db, p) {
      const a = [];
      return topPerPeriod(db.prepare(`SELECT ${periodSql('o.created_at', p)} AS period, o.customer_id, trim(coalesce(max(o.customer_firstname), '') || ' ' || coalesce(max(o.customer_lastname), '')) AS name,
          count(*) AS orders_count, avg(o.grand_total) AS orders_avg_amount, sum(o.grand_total) AS orders_sum_amount
        FROM orders o WHERE o.state <> 'canceled' AND o.customer_id IS NOT NULL AND ${rangeSql('o.created_at', p, a)}
        GROUP BY period, o.customer_id ORDER BY period, orders_sum_amount DESC, o.customer_id`).all(...a), 5);
    },
  },
  customer_orders: {
    title: 'Order Count Report', crumb: ['Customers', 'Order Count'], path: '/admin/reports/report_customer/orders/', filter: 'range',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, text('name', 'Customer'), num('orders_count', 'Orders'), money('orders_avg_amount', 'Average'), money('orders_sum_amount', 'Total')],
    compute(db, p) {
      const a = [];
      return topPerPeriod(db.prepare(`SELECT ${periodSql('o.created_at', p)} AS period, o.customer_id, trim(coalesce(max(o.customer_firstname), '') || ' ' || coalesce(max(o.customer_lastname), '')) AS name,
          count(*) AS orders_count, avg(o.grand_total) AS orders_avg_amount, sum(o.grand_total) AS orders_sum_amount
        FROM orders o WHERE o.state <> 'canceled' AND o.customer_id IS NOT NULL AND ${rangeSql('o.created_at', p, a)}
        GROUP BY period, o.customer_id ORDER BY period, orders_count DESC, orders_sum_amount DESC, o.customer_id`).all(...a), 5);
    },
  },
  customer_accounts: {
    title: 'New Accounts Report', crumb: ['Customers', 'New'], path: '/admin/reports/report_customer/accounts/', filter: 'range',
    columns: [{ key: 'period', label: 'Interval', type: 'period' }, num('accounts', 'New Accounts')],
    compute(db, p) {
      const a = [];
      return db.prepare(`SELECT ${periodSql('c.created_at', p)} AS period, count(*) AS accounts FROM customers c WHERE ${rangeSql('c.created_at', p, a)} GROUP BY period ORDER BY period`).all(...a);
    },
  },
  review_customer: {
    title: 'Customer Reviews Report', crumb: ['Reviews', 'By Customers'], path: '/admin/reports/report_review/customer/', filter: 'none', paged: true,
    columns: [text('name', 'Customer'), num('review_cnt', 'Reviews')],
    compute(db) {
      return db.prepare(`SELECT r.customer_id, trim(coalesce(c.firstname, '') || ' ' || coalesce(c.lastname, '')) AS name, count(*) AS review_cnt
        FROM reviews r JOIN customers c ON c.id = r.customer_id WHERE r.customer_id IS NOT NULL GROUP BY r.customer_id ORDER BY review_cnt DESC, r.customer_id`).all();
    },
  },
  review_product: {
    title: 'Product Reviews Report', crumb: ['Reviews', 'By Products'], path: '/admin/reports/report_review/product/', filter: 'none', paged: true,
    columns: [num('product_id', 'ID'), text('name', 'Product'), num('review_cnt', 'Reviews'), { key: 'avg_rating', label: 'Average', type: 'pct' }, { key: 'avg_rating_approved', label: 'Average (Approved)', type: 'pct' }, { key: 'last_review', label: 'Last Review', type: 'datetime' }],
    compute(db) {
      return db.prepare(`SELECT agg.product_id, p.name, agg.review_cnt, agg.avg_rating, agg.avg_rating_approved, agg.last_review FROM (
          SELECT r.product_id, count(*) AS review_cnt, avg(v.percent) AS avg_rating, avg(CASE WHEN r.status = 'approved' THEN v.percent END) AS avg_rating_approved, max(r.created_at) AS last_review
          FROM reviews r LEFT JOIN review_votes v ON v.review_id = r.id GROUP BY r.product_id) agg
        JOIN products p ON p.id = agg.product_id ORDER BY agg.review_cnt DESC, agg.product_id`).all();
    },
  },
};
for (const [k, d] of Object.entries(REPORTS)) d.type = k;

// signature of the data a report depends on: a cached run is reused only while it matches
function dataSig(db, type) {
  if (type.startsWith('review_')) return db.prepare("SELECT count(*) || ':' || coalesce(max(id), 0) || ':' || (SELECT count(*) FROM review_votes) || ':' || (SELECT count(*) FROM temp.admin_rstat) FROM reviews").pluck().get();
  if (type === 'viewed') return db.prepare("SELECT count(*) || ':' || coalesce(sum(views), 0) FROM report_product_views").pluck().get();
  return db.prepare(`SELECT count(*) || ':' || coalesce(max(updated_at), '') || ':' || coalesce(sum(coalesce(total_invoiced, 0) + coalesce(total_refunded, 0)), 0) || ':' || group_concat(DISTINCT status)
      || ':' || (SELECT count(*) FROM invoices) || ':' || (SELECT count(*) FROM credit_memos) || ':' || (SELECT count(*) || ':' || coalesce(max(updated_at), '') FROM customers) || ':' || (SELECT count(*) FROM order_items) FROM orders`).pluck().get();
}

module.exports = { REPORTS, params, periodLabel, totalsOf, fillEmpty, dataSig, periodsBetween, LEN };
