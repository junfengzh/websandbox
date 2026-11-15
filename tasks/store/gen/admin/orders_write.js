'use strict';
// Back-office order templates (write): hold + comment, invoice with comment, partial shipment with
// tracking, credit memo for one item, cancel a customer's pending orders.

const ADMIN = 'admin';
const COMMENTS = ['Customer asked us to wait for a payment confirmation.', 'Address needs to be verified before shipping.', 'Waiting for the warehouse to restock one item.',
  'Customer requested delivery after the holidays.', 'Fraud check requested by the bank.', 'Gift wrap requested, please hold.', 'Payment received by check, thank you!',
  'Invoice issued after phone confirmation.', 'Paid in full via money order.', 'Customer called to confirm the order.'];
const NEW = (L) => `created_at >= '${L.TODAY}'`;
const open = (L) => L.all("SELECT o.*, trim(o.customer_firstname || ' ' || o.customer_lastname) AS cname FROM orders o WHERE o.status IN ('pending', 'processing') ORDER BY o.id");
const items = (L, oid) => L.all('SELECT id, name, sku, qty_ordered, product_type, price FROM order_items WHERE order_id = ? AND parent_item_id IS NULL ORDER BY id', oid);

const hold = {
  id: 'gen-admin-order-hold-comment', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit', 'multi-step'], difficulty: 2, cap: 40,
  phrasings: [
    'Put order #{{order}} on hold and add the order comment "{{comment}}".',
    'Order {{order}} must not ship yet. Hold it, and leave the note "{{comment}}" in its comments history.',
  ],
  sample(L, r) {
    const out = [];
    for (const o of open(L)) {
      for (const comment of r.sample(COMMENTS.slice(0, 6), 3)) {
        out.push({ slots: { order: o.increment_id, comment }, login_user: ADMIN,
          eval: { type: 'state', state_sql: [`SELECT status FROM orders WHERE id = ${o.id}`, `SELECT count(*) FROM order_status_history WHERE order_id = ${o.id} AND comment = ${L.lit(comment)} AND ${NEW(L)}`],
            state_expect: ['holded', { min: 1 }] } });
      }
    }
    return out;
  },
};

const invoice = {
  id: 'gen-admin-order-invoice', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit', 'create'], difficulty: 2, cap: 40,
  phrasings: [
    'Create an invoice for the whole order #{{order}} with the invoice comment "{{comment}}".',
    'The payment for order {{order}} arrived. Invoice all of its items and add the comment "{{comment}}" to the invoice.',
  ],
  sample(L, r) {
    const out = [];
    for (const o of open(L)) {
      if (o.total_invoiced > 0) continue;
      for (const comment of r.sample(COMMENTS.slice(6), 2)) {
        const qty = items(L, o.id).reduce((s, i) => s + i.qty_ordered, 0);
        out.push({ slots: { order: o.increment_id, comment }, login_user: ADMIN,
          eval: { type: 'state', state_sql: [
            `SELECT count(*), round(sum(total_qty), 2) FROM invoices WHERE order_id = ${o.id}`,
            `SELECT count(*) FROM sales_comments WHERE entity_type = 'invoice' AND parent_id IN (SELECT id FROM invoices WHERE order_id = ${o.id}) AND comment = ${L.lit(comment)}`,
          ], state_expect: [[[1, qty]], 1] } });
      }
    }
    return out;
  },
};

const CARRIERS = { ups: 'United Parcel Service (UPS)', usps: 'United States Postal Service (USPS)', fedex: 'Federal Express', dhl: 'DHL' };
const shipItem = {
  id: 'gen-admin-order-ship-one-item', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit', 'create', 'multi-step'], difficulty: 3, cap: 40,
  regradeNote: 'regrade 2026-11-15: orders that already have a shipment in the base data (no Ship button; their items are shipped) are no longer sampled; the template was re-sampled.',
  phrasings: [
    'Ship only "{{item}}" from order #{{order}} for now (the other items stay unshipped), with {{carrier}} tracking number {{track}}.',
    'Create a partial shipment for order {{order}} containing just "{{item}}" and add the {{carrier}} tracking number {{track}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const o of open(L)) {
      const its = items(L, o.id);
      if (its.length < 2) continue;
      for (const it of its) {
        const c = r.pick(Object.keys(CARRIERS));
        const track = `${c === 'ups' ? '1Z' : ''}${String(100000000 + r.int(899999999))}${r.int(10)}`;
        const SH = `(SELECT id FROM shipments WHERE order_id = ${o.id} ORDER BY id DESC LIMIT 1)`;
        // orders that already have a shipment (base data) cannot be shipped item by item (regrade 2026-11-15)
        if (L.all('SELECT 1 FROM shipments WHERE order_id = ?', o.id).length) continue;
        out.push({ slots: { item: L.plain(it.name), order: o.increment_id, carrier: CARRIERS[c], track }, login_user: ADMIN,
          eval: { type: 'state', state_sql: [
            `SELECT count(*) FROM shipments WHERE order_id = ${o.id}`,
            `SELECT order_item_id, round(qty, 2) FROM shipment_items WHERE shipment_id = ${SH} AND qty > 0`,
            `SELECT carrier_code, track_number FROM shipment_tracks WHERE order_id = ${o.id}`,
          ], state_expect: [1, [[it.id, it.qty_ordered]], [[c, track]]] } });
      }
    }
    return out;
  },
};

const refundItem = {
  id: 'gen-admin-invoice-then-refund-item', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit', 'create', 'multi-step'], difficulty: 3, cap: 40,
  phrasings: [
    'Order #{{order}} was paid, but the customer is returning "{{item}}". Invoice the full order, then create an offline credit memo that refunds only that item and no shipping.',
    'First invoice all items of order {{order}}; then refund just the "{{item}}" with a credit memo (refund offline, shipping not refunded).',
  ],
  sample(L, r) {
    const out = [];
    for (const o of open(L)) {
      if (o.total_invoiced > 0) continue;
      const its = items(L, o.id);
      if (its.length < 2 || new Set(its.map((i) => i.name)).size !== its.length) continue;
      for (const it of its) {
        out.push({ slots: { item: L.plain(it.name), order: o.increment_id }, login_user: ADMIN,
          eval: { type: 'state', state_sql: [
            `SELECT count(*) FROM invoices WHERE order_id = ${o.id}`,
            `SELECT count(*), round(sum(shipping_amount), 2) FROM credit_memos WHERE order_id = ${o.id}`,
            `SELECT ci.order_item_id, round(ci.qty, 2) FROM credit_memo_items ci JOIN credit_memos m ON m.id = ci.credit_memo_id WHERE m.order_id = ${o.id} AND ci.qty > 0`,
          ], state_expect: [1, [[1, 0]], [[it.id, it.qty_ordered]]] } });
      }
    }
    return out;
  },
};

const cancelPending = {
  id: 'gen-admin-cancel-customer-pending', site: 'shopping_admin', kind: 'write', skills: ['search', 'filter-sort', 'form-edit', 'multi-step'], difficulty: 3, cap: 40,
  phrasings: [
    'Cancel all pending orders of the customer {{customer}}{{before_part}}. Do not touch their other orders.',
    '{{customer}} asked us to cancel every order of theirs that is still pending{{before_part}}. Please do that.',
  ],
  sample(L, r) {
    const out = [];
    const d = new Set(L.col("SELECT firstname || ' ' || lastname FROM customers GROUP BY 1 HAVING count(*) > 1"));
    for (const c of L.all("SELECT c.* FROM customers c WHERE c.id IN (SELECT customer_id FROM orders WHERE status = 'pending')")) {
      const pend = L.all("SELECT id, created_at FROM orders WHERE customer_id = ? AND status = 'pending' ORDER BY created_at", c.id);
      const name = d.has(`${c.firstname} ${c.lastname}`) ? `${c.firstname} ${c.lastname} (${c.email})` : `${c.firstname} ${c.lastname}`;
      const variants = [[pend, null]];
      if (pend.length >= 2) {
        const cut = L.U.localDate(pend[pend.length - 1].created_at);
        const before = pend.filter((p) => L.U.localDate(p.created_at) < cut);
        if (before.length && before.length < pend.length) variants.push([before, cut]);
      }
      for (const [ps, cut] of variants) {
        const keep = L.col(`SELECT id FROM orders WHERE customer_id = ${c.id} AND id NOT IN (${ps.map((p) => p.id).join(',')})`);
        const st = L.all(`SELECT id, status FROM orders WHERE id IN (${keep.join(',') || 0}) ORDER BY id`).map((x) => [x.id, x.status]);
        out.push({ slots: { customer: name, before_part: cut ? ` that were placed before ${L.longDate(cut)}` : '' }, login_user: ADMIN, difficulty: cut ? 3 : 2,
          eval: { type: 'state', state_sql: [`SELECT count(*) FROM orders WHERE id IN (${ps.map((p) => p.id).join(',')}) AND status = 'canceled'`, `SELECT id, status FROM orders WHERE id IN (${keep.join(',') || 0}) ORDER BY id`],
            state_expect: [ps.length, st] } });
      }
    }
    return out;
  },
};

module.exports = [hold, invoice, shipItem, refundItem, cancelPending];
