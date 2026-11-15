'use strict';
// Background jobs of the back office (kit jobs: run on the tenant connection, in the rollout
// transaction, with now() == the job's scheduled time).
//
//  admin.report             {run_id}   compute one report run (Reports > ...): rows go to
//                                      temp.admin_report_rows, the run in temp.admin_report_runs
//  admin.newsletter.send     {queue_id} newsletter queue item reaches its start time: marked sent
//  admin.statistics.refresh {codes, mode: 'lifetime'|'recent'}  Reports > Refresh Statistics:
//                                      rewrites the report_* aggregate tables (source = 'live')
//                                      from orders and records the refresh time in store_config
const R = require('./lib/reports');
const U = require('./lib/util');

function runReport({ payload, db, now }) {
  U.ensureSqlFunctions(db);
  const run = db.prepare('SELECT * FROM temp.admin_report_runs WHERE id = ?').get(payload.run_id);
  if (!run || run.status === 'done') return { skipped: true };
  const def = R.REPORTS[run.type];
  const p = JSON.parse(run.params || '{}');
  db.prepare("UPDATE temp.admin_report_runs SET status = 'running' WHERE id = ?").run(run.id);
  let rows = def.compute(db, p);
  if (def.columns.some((c) => c.type === 'period')) rows = R.fillEmpty(rows, p, def.columns);
  const ins = db.prepare('INSERT INTO temp.admin_report_rows (run_id, n, period, data) VALUES (?, ?, ?, ?)');
  rows.forEach((r, i) => ins.run(run.id, i + 1, r.period ?? null, JSON.stringify(r)));
  const totals = R.totalsOf(rows, def.columns);
  const at = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare("UPDATE temp.admin_report_runs SET status = 'done', finished_at = ?, row_count = ?, totals = ?, columns = ? WHERE id = ?").run(at, rows.length, JSON.stringify(totals), JSON.stringify(def.columns), run.id);
  return { rows: rows.length };
}

// Magento "Refresh Statistics": the aggregate tables the original reports read.
const STAT_CODES = {
  report_order_aggregated: 'Orders', report_tax_aggregated: 'Tax', report_shipping_aggregated: 'Shipping', report_invoiced_aggregated: 'Total Invoiced vs. Paid',
  report_refunded_aggregated: 'Total Refunded', report_coupons_aggregated: 'Coupons', report_bestsellers_aggregated: 'Bestsellers',
};
function refreshStatistics({ payload, db, now }) {
  U.ensureSqlFunctions(db);
  const codes = (payload.codes || Object.keys(STAT_CODES)).filter((c) => STAT_CODES[c]);
  const at = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
  // 'recent' = the last day only (Magento: statistics for the last day); 'lifetime' = everything
  const day = { period: 'day', dateUsed: 'created_at', statuses: [], showEmpty: false, from: payload.mode === 'recent' ? U.localDate(new Date(Date.parse(at.replace(' ', 'T') + 'Z') - 864e5).toISOString()) : null, to: null };
  const out = {};
  const dayRows = (type) => R.REPORTS[type].compute(db, day).map((r) => ({ ...r, period: r.period }));
  const delLive = (table) => {
    if (payload.mode === 'recent' && day.from) db.prepare(`DELETE FROM ${table} WHERE source = 'live' AND period >= ?`).run(day.from);
    else db.prepare(`DELETE FROM ${table} WHERE source = 'live'`).run();
  };
  for (const code of codes) {
    if (code === 'report_order_aggregated') {
      delLive('report_sales');
      // per day and status, like sales_order_aggregated_created
      const a = []; const where = day.from ? 'AND o.created_at >= ?' : '';
      if (day.from) a.push(U.localToUtc(`${day.from} 00:00:00`));
      const rows = db.prepare(`SELECT admin_local_date(o.created_at) AS period, o.status AS order_status, count(*) AS orders_count,
          sum((SELECT coalesce(sum(i.qty_ordered), 0) FROM order_items i WHERE i.order_id = o.id AND i.parent_item_id IS NULL)) AS total_qty_ordered,
          sum((SELECT coalesce(sum(i.qty_invoiced), 0) FROM order_items i WHERE i.order_id = o.id AND i.parent_item_id IS NULL)) AS total_qty_invoiced,
          sum(o.grand_total - (CASE WHEN o.state = 'canceled' THEN coalesce(o.total_canceled, o.grand_total) ELSE coalesce(o.total_canceled, 0) END)) AS total_income_amount,
          sum(coalesce(o.total_invoiced, 0) - coalesce(o.total_refunded, 0)) AS total_revenue_amount, sum(coalesce(o.total_invoiced, 0)) AS total_invoiced_amount,
          sum(CASE WHEN o.state = 'canceled' THEN coalesce(o.total_canceled, o.grand_total) ELSE coalesce(o.total_canceled, 0) END) AS total_canceled_amount,
          sum(coalesce(o.total_paid, 0)) AS total_paid_amount, sum(coalesce(o.total_refunded, 0)) AS total_refunded_amount, sum(coalesce(o.tax_amount, 0)) AS total_tax_amount,
          sum(coalesce(o.shipping_amount, 0)) AS total_shipping_amount, sum(abs(coalesce(o.discount_amount, 0))) AS total_discount_amount
        FROM orders o WHERE o.state NOT IN ('new', 'pending_payment') ${where} GROUP BY period, o.status`).all(...a);
      const ins = db.prepare(`INSERT INTO report_sales (period, order_status, orders_count, total_qty_ordered, total_qty_invoiced, total_income_amount, total_revenue_amount, total_profit_amount,
          total_invoiced_amount, total_canceled_amount, total_paid_amount, total_refunded_amount, total_tax_amount, total_tax_amount_actual, total_shipping_amount, total_shipping_amount_actual,
          total_discount_amount, total_discount_amount_actual, source) VALUES (@period, @order_status, @orders_count, @total_qty_ordered, @total_qty_invoiced, @total_income_amount, @total_revenue_amount, 0,
          @total_invoiced_amount, @total_canceled_amount, @total_paid_amount, @total_refunded_amount, @total_tax_amount, @total_tax_amount, @total_shipping_amount, @total_shipping_amount,
          @total_discount_amount, @total_discount_amount, 'live')`);
      for (const r of rows) ins.run(r);
      out[code] = rows.length;
    } else if (code === 'report_bestsellers_aggregated') {
      if (payload.mode === 'recent' && day.from) db.prepare("DELETE FROM report_bestsellers WHERE source = 'live' AND period >= ?").run(day.from); else db.prepare("DELETE FROM report_bestsellers WHERE source = 'live'").run();
      const ins = db.prepare("INSERT INTO report_bestsellers (period_type, period, product_id, product_name, product_price, qty_ordered, rating_pos, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'live')");
      let n = 0;
      for (const [ptype, period, suffix] of [['daily', 'day', ''], ['monthly', 'month', '-01'], ['yearly', 'year', '-01-01']]) {
        const rows = R.REPORTS.bestsellers.compute(db, { ...day, period });
        const pos = new Map();
        for (const r of rows) { const k = r.period; const rp = (pos.get(k) || 0) + 1; pos.set(k, rp); ins.run(ptype, `${r.period}${suffix}`, r.product_id, r.product_name, r.product_price, r.qty_ordered, rp); n++; }
      }
      out[code] = n;
    } else {
      const map = { report_tax_aggregated: ['report_tax', 'tax', ['period', 'code', 'percent', 'orders_count', 'tax_base_amount_sum']],
        report_shipping_aggregated: ['report_shipping', 'shipping', ['period', 'shipping_description', 'orders_count', 'total_shipping', 'total_shipping_actual']],
        report_invoiced_aggregated: ['report_invoiced', 'invoiced', ['period', 'orders_count', 'orders_invoiced', 'invoiced', 'invoiced_captured', 'invoiced_not_captured']],
        report_refunded_aggregated: ['report_refunded', 'refunded', ['period', 'orders_count', 'refunded', 'online_refunded', 'offline_refunded']],
        report_coupons_aggregated: ['report_coupons', 'coupons', ['period', 'coupon_code', 'coupon_uses', 'subtotal_amount', 'discount_amount', 'total_amount', 'rule_name']] }[code];
      const [table, type, cols] = map;
      delLive(table);
      const rows = dayRows(type);
      const ins = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}, source) VALUES (${cols.map((c) => '@' + c).join(', ')}, 'live')`);
      for (const r of rows) ins.run(Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      out[code] = rows.length;
    }
    db.prepare('INSERT OR REPLACE INTO store_config (path, value) VALUES (?, ?)').run(`reports/statistics/${code}/updated_at`, at);
  }
  return out;
}

// Newsletter queue: "send" at the queue start time = mark it sent to the subscribed recipients
function sendNewsletter({ payload, db, now }) {
  const q = db.prepare('SELECT * FROM temp.newsletter_queue WHERE id = ?').get(payload.queue_id);
  if (!q || q.status !== 0) return { skipped: true };
  const n = db.prepare('SELECT count(*) FROM newsletter_subscribers WHERE status = 1').pluck().get();
  const at = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('UPDATE temp.newsletter_queue SET status = 3, recipients = ?, sent = ?, finish_at = ? WHERE id = ?').run(n, n, at, q.id);
  return { sent: n };
}

module.exports = {
  'admin.report': runReport,
  'admin.newsletter.send': sendNewsletter,
  'admin.statistics.refresh': refreshStatistics,
};
Object.defineProperty(module.exports, 'STAT_CODES', { value: STAT_CODES, enumerable: false });
