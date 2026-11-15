'use strict';
// Storefront background jobs (run on the site clock, inside the tenant transaction).
module.exports = {
  // A newly placed order moves pending -> processing after an hour of site time (payment
  // "captured"), like an order the merchant picked up. Only if still pending (admin may act first).
  'order.process': ({ payload, db, now }) => {
    const ts = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
    const r = db.prepare("UPDATE orders SET state = 'processing', status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'").run(ts, payload.id);
    if (r.changes) db.prepare("INSERT INTO order_status_history (order_id, status, comment, is_customer_notified, is_visible_on_front, entity_name, created_at) VALUES (?, 'processing', NULL, 0, 0, 'order', ?)").run(payload.id, ts);
    return { changed: r.changes };
  },
};
