'use strict';
// Dashboard: lifetime sales, average order, last orders, last/top search terms,
// orders chart + revenue/tax/shipping/quantity for a period, bestsellers, most viewed,
// new customers, top customers.
const PERIODS = { '24h': ['Last 24 Hours', 1, 'hour', 24], '7d': ['Last 7 Days', 7, 'day', 7], '1m': ['Current Month', 0, 'day', 0], '1y': ['YTD', 0, 'month', 0], '2y': ['2YTD', 0, 'month', 0] };

module.exports = (r, { kit, U, view }) => {
  const page = async (req, reply) => {
    U.ensureSqlFunctions(kit.db());
    const life = kit.sql(`SELECT count(*) n, coalesce(sum(grand_total - coalesce(total_refunded, 0)), 0) total FROM orders WHERE state NOT IN ('canceled')`).get();
    const lastOrders = kit.sql(`SELECT o.id, o.increment_id, trim(coalesce(o.customer_firstname, '') || ' ' || coalesce(o.customer_lastname, '')) AS customer,
        (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.parent_item_id IS NULL) AS items, o.grand_total, o.created_at
      FROM orders o ORDER BY o.created_at DESC, o.id DESC LIMIT 5`).all();
    const lastTerms = kit.sql('SELECT id, query_text, num_results, popularity FROM search_terms ORDER BY updated_at DESC, id DESC LIMIT 5').all();
    const topTerms = kit.sql('SELECT id, query_text, num_results, popularity FROM search_terms ORDER BY popularity DESC, id LIMIT 5').all();
    const best = kit.sql(`SELECT i.product_id, max(i.name) AS name, max(i.price) AS price, sum(i.qty_ordered) AS qty
      FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.state <> 'canceled' AND i.parent_item_id IS NULL
      GROUP BY i.product_id ORDER BY qty DESC, i.product_id LIMIT 5`).all();
    const viewed = kit.sql(`SELECT v.product_id, p.name, p.price, v.views FROM (SELECT * FROM report_product_views ORDER BY views DESC LIMIT 5) v JOIN products p ON p.id = v.product_id ORDER BY v.views DESC`).all();
    const newCustomers = kit.sql(`SELECT c.id, c.firstname, c.lastname, (SELECT count(*) FROM orders o WHERE o.customer_id = c.id) AS orders,
        (SELECT coalesce(avg(grand_total), 0) FROM orders o WHERE o.customer_id = c.id AND o.state <> 'canceled') AS avg_amount,
        (SELECT coalesce(sum(grand_total), 0) FROM orders o WHERE o.customer_id = c.id AND o.state <> 'canceled') AS total
      FROM customers c ORDER BY c.created_at DESC, c.id DESC LIMIT 5`).all();
    const topCustomers = kit.sql(`SELECT c.id, c.firstname, c.lastname, count(o.id) AS orders, avg(o.grand_total) AS avg_amount, sum(o.grand_total) AS total
      FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.state <> 'canceled' GROUP BY c.id ORDER BY total DESC LIMIT 5`).all();

    // chart period (store-local buckets)
    const pkey = PERIODS[req.query.period] ? req.query.period : '24h';
    const nowLocal = U.toLocal(kit.nowSql());
    let fromLocal; let bucket;
    const today = nowLocal.slice(0, 10);
    if (pkey === '24h') { fromLocal = U.toLocal(new Date(Date.parse(kit.nowSql().replace(' ', 'T') + 'Z') - 864e5).toISOString().slice(0, 19).replace('T', ' ')); bucket = 13; }
    else if (pkey === '7d') { fromLocal = new Date(Date.parse(today + 'T00:00:00Z') - 6 * 864e5).toISOString().slice(0, 10) + ' 00:00:00'; bucket = 10; }
    else if (pkey === '1m') { fromLocal = today.slice(0, 8) + '01 00:00:00'; bucket = 10; }
    else if (pkey === '1y') { fromLocal = today.slice(0, 5) + '01-01 00:00:00'; bucket = 7; }
    else { fromLocal = (+today.slice(0, 4) - 1) + '-01-01 00:00:00'; bucket = 7; }
    const fromUtc = pkey === '24h' ? new Date(Date.parse(kit.nowSql().replace(' ', 'T') + 'Z') - 864e5).toISOString().slice(0, 19).replace('T', ' ') : U.localToUtc(fromLocal);
    const series = kit.sql(`SELECT substr(admin_local(created_at), 1, ${bucket}) AS b, count(*) AS n, sum(grand_total) AS amount
      FROM orders WHERE created_at >= ? AND created_at <= ? AND state <> 'canceled' GROUP BY b ORDER BY b`).all(fromUtc, kit.nowSql());
    const tot = kit.sql(`SELECT coalesce(sum(grand_total), 0) revenue, coalesce(sum(tax_amount), 0) tax, coalesce(sum(shipping_amount), 0) shipping, coalesce(sum(total_qty_ordered), 0) qty
      FROM orders WHERE created_at >= ? AND created_at <= ? AND state <> 'canceled'`).get(fromUtc, kit.nowSql());
    const chartMax = Math.max(1, ...series.map((s) => (req.query.chart === 'amounts' ? s.amount : s.n)));
    return view(reply, 'dashboard', {
      title: 'Dashboard', life, avg: life.n ? life.total / life.n : 0, lastOrders, lastTerms, topTerms, best, viewed, newCustomers, topCustomers,
      periods: PERIODS, pkey, series, tot, chartMax, chart: req.query.chart === 'amounts' ? 'amounts' : 'orders', fromLocal, nowLocal,
      actions: [{ label: 'Reload Data', href: '/admin/dashboard/', primary: false, id: 'reload' }],
    });
  };
  for (const p of ['/dashboard', '/dashboard/index', '/admin/dashboard', '/admin/dashboard/index']) r.get(p, page);
};
