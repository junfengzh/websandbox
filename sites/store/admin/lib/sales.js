'use strict';
// Order domain logic for the back office: what an order allows (cancel / hold / invoice /
// ship / credit memo), state transitions, document numbers, addresses, comments history.
const U = require('./util');

const CARRIERS = [['custom', 'Custom Value'], ['dhl', 'DHL'], ['fedex', 'Federal Express'], ['ups', 'United Parcel Service'], ['usps', 'United States Postal Service']];
const CARRIER_TITLE = Object.fromEntries(CARRIERS);
const NO_SHIP = new Set(['virtual', 'downloadable']);

function loadOrder(kit, id) {
  const o = kit.sql('SELECT * FROM orders WHERE id = ?').get(id);
  if (!o) return null;
  o.items = kit.sql('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(id);
  o.top = o.items.filter((i) => i.parent_item_id == null);
  for (const i of o.top) {
    i.children = o.items.filter((c) => c.parent_item_id === i.id);
    try { i.opts = JSON.parse(i.options_json || '{}'); } catch { i.opts = {}; }
  }
  o.addresses = kit.sql('SELECT * FROM order_addresses WHERE order_id = ? ORDER BY id').all(id);
  o.billing = o.addresses.find((a) => a.address_type === 'billing') || null;
  o.shipping = o.addresses.find((a) => a.address_type === 'shipping') || null;
  o.payment = kit.sql('SELECT * FROM order_payments WHERE order_id = ? ORDER BY id LIMIT 1').get(id) || null;
  o.statusLabel = kit.sql('SELECT label FROM order_statuses WHERE status = ?').pluck().get(o.status) || U.ucfirst(o.status || '');
  return o;
}

const toInvoice = (i) => Math.max(0, (i.qty_ordered || 0) - (i.qty_canceled || 0) - (i.qty_invoiced || 0));
const toShip = (i) => (NO_SHIP.has(i.product_type) ? 0 : Math.max(0, (i.qty_ordered || 0) - (i.qty_shipped || 0) - (i.qty_canceled || 0) - (i.qty_refunded || 0)));
const toRefund = (i) => Math.max(0, (i.qty_invoiced || 0) - (i.qty_refunded || 0));

function can(o) {
  const st = o.state;
  const dead = ['canceled', 'closed', 'complete'].includes(st);
  const held = st === 'holded';
  const review = st === 'payment_review';
  return {
    cancel: !dead && !held && !review && o.top.some((i) => toInvoice(i) > 0),
    hold: ['new', 'pending', 'processing', 'pending_payment'].includes(st),
    unhold: held,
    invoice: !dead && !held && !review && o.top.some((i) => toInvoice(i) > 0),
    ship: !['canceled', 'closed'].includes(st) && !held && !review && o.top.some((i) => toShip(i) > 0),
    creditmemo: !['canceled', 'closed'].includes(st) && !held && (o.total_paid || 0) - (o.total_refunded || 0) > 0.0001,
    comment: true,
  };
}

// state after invoicing / shipping / refunding (Magento: processing until invoiced + shipped)
function recomputeState(kit, orderId) {
  const o = loadOrder(kit, orderId);
  if (['canceled', 'holded'].includes(o.state)) return o;
  const invoicedAll = o.top.every((i) => toInvoice(i) <= 0);
  const shippedAll = o.top.every((i) => toShip(i) <= 0);
  const refundedAll = (o.total_refunded || 0) > 0 && (o.total_refunded || 0) >= (o.total_paid || 0) - 0.0001;
  let state = o.state;
  if (refundedAll && invoicedAll) state = 'closed';
  else if (invoicedAll && shippedAll) state = 'complete';
  else if ((o.total_invoiced || 0) > 0 || o.top.some((i) => (i.qty_shipped || 0) > 0)) state = 'processing';
  if (state !== o.state) {
    const status = kit.sql('SELECT status FROM order_status_states WHERE state = ? AND is_default = 1').pluck().get(state) || state;
    kit.sql('UPDATE orders SET state = ?, status = ?, updated_at = ? WHERE id = ?').run(state, status, kit.nowSql(), orderId);
  }
  return loadOrder(kit, orderId);
}

// statuses offered in "Notes for this Order" (the statuses assigned to the order's state)
function statusesFor(kit, o) {
  const rows = kit.sql('SELECT s.status, s.label FROM order_status_states ss JOIN order_statuses s ON s.status = ss.status WHERE ss.state = ? ORDER BY ss.is_default DESC, s.label').all(o.state);
  if (!rows.some((r) => r.status === o.status)) rows.unshift({ status: o.status, label: o.statusLabel });
  return rows;
}

function nextIncrement(kit, table) {
  const max = kit.sql(`SELECT max(CAST(increment_id AS INTEGER)) FROM ${table}`).pluck().get() || 0;
  return U.pad9(max + 1);
}

function addHistory(kit, orderId, { status, comment, notify = 0, visible = 0, entity = 'order' }) {
  kit.sql('INSERT INTO order_status_history (order_id, status, comment, is_customer_notified, is_visible_on_front, entity_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(orderId, status, comment ?? null, notify ? 1 : 0, visible ? 1 : 0, entity, kit.nowSql());
}

// Comments History tab: comments + document creation + tracking numbers, newest first
function commentsHistory(kit, o) {
  const out = [];
  for (const h of kit.sql('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at, id').all(o.id)) {
    out.push({ at: h.created_at, title: h.comment || '', status: h.status, notified: h.is_customer_notified, kind: h.entity_name || 'order', sort: 1, id: h.id });
  }
  for (const i of kit.sql('SELECT id, increment_id, created_at, email_sent FROM invoices WHERE order_id = ?').all(o.id)) out.push({ at: i.created_at, title: `Invoice #${i.increment_id} created`, notified: i.email_sent, kind: 'invoice', sort: 2, id: i.id });
  for (const s of kit.sql('SELECT id, increment_id, created_at, email_sent FROM shipments WHERE order_id = ?').all(o.id)) out.push({ at: s.created_at, title: `Shipment #${s.increment_id} created`, notified: s.email_sent, kind: 'shipment', sort: 3, id: s.id });
  for (const c of kit.sql('SELECT id, increment_id, created_at FROM credit_memos WHERE order_id = ?').all(o.id)) out.push({ at: c.created_at, title: `Credit memo #${c.increment_id} created`, notified: 0, kind: 'creditmemo', sort: 4, id: c.id });
  for (const t of kit.sql('SELECT * FROM shipment_tracks WHERE order_id = ?').all(o.id)) out.push({ at: t.created_at, title: `Tracking number ${t.track_number} for ${t.title || CARRIER_TITLE[t.carrier_code] || t.carrier_code} assigned`, notified: 0, kind: 'track', sort: 5, id: t.id });
  for (const c of kit.sql("SELECT sc.*, CASE sc.entity_type WHEN 'invoice' THEN (SELECT increment_id FROM invoices WHERE id = sc.parent_id) WHEN 'shipment' THEN (SELECT increment_id FROM shipments WHERE id = sc.parent_id) ELSE (SELECT increment_id FROM credit_memos WHERE id = sc.parent_id) END AS doc FROM sales_comments sc WHERE (sc.entity_type = 'invoice' AND sc.parent_id IN (SELECT id FROM invoices WHERE order_id = ?)) OR (sc.entity_type = 'shipment' AND sc.parent_id IN (SELECT id FROM shipments WHERE order_id = ?)) OR (sc.entity_type = 'creditmemo' AND sc.parent_id IN (SELECT id FROM credit_memos WHERE order_id = ?))").all(o.id, o.id, o.id)) {
    out.push({ at: c.created_at, title: c.comment, notified: c.is_customer_notified, kind: c.entity_type, doc: c.doc, sort: 6, id: c.id });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.sort - a.sort || b.id - a.id));
}

function addressLines(a, countries) {
  if (!a) return [];
  const name = [a.prefix, a.firstname, a.middlename, a.lastname, a.suffix].filter(Boolean).join(' ');
  return [name, a.company, ...String(a.street || '').split('\n'), [a.city, a.region, a.postcode].filter(Boolean).join(', '), countries ? countries(a.country_id) : a.country_id, a.telephone ? `T: ${a.telephone}` : null, a.fax ? `F: ${a.fax}` : null, a.vat_id ? `VAT: ${a.vat_id}` : null].filter(Boolean);
}

// options shown under an order item (configurable attributes, custom options)
function itemOptions(i) {
  const o = i.opts || {};
  return [...(o.attributes_info || []), ...(o.options || [])].map((x) => ({ label: x.label, value: x.print_value || x.value }));
}

module.exports = { CARRIERS, CARRIER_TITLE, loadOrder, can, recomputeState, statusesFor, nextIncrement, addHistory, commentsHistory, addressLines, itemOptions, toInvoice, toShip, toRefund };
