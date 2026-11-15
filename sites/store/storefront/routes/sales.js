'use strict';
// My Orders: history, order view (items / invoices / shipments / refunds), print, reorder,
// guest order lookup ("Orders and Returns").
const S = require('../../shared');
const cart = require('../lib/cart');
const { helpers: H } = require('./customer');

module.exports = async function salesRoutes(app, kit) {
  const db = () => kit.db();
  const LOGIN = { login: true };

  // Visible order statuses only (Magento hides e.g. pending_payment from customers).
  app.get('/sales/order/history', { config: LOGIN }, async (req, reply) => {
    const limits = [10, 20, 50];
    const limit = limits.includes(+req.query.limit) ? +req.query.limit : 10;
    const where = "customer_id = ? AND status IN (SELECT status FROM order_status_states WHERE visible_on_front = 1)";
    const total = db().prepare(`SELECT count(*) FROM orders WHERE ${where}`).pluck().get(req.user.id);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(Math.max(parseInt(req.query.p, 10) || 1, 1), pages);
    const orders = db().prepare(`SELECT * FROM orders WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(req.user.id, limit, (page - 1) * limit);
    for (const o of orders) { o.ship_to = H.shipTo(db(), o.id); o.status_label = S.orderStatusLabel(db(), o.status); }
    return reply.render('sales/history', { title: 'My Orders', orders, total, page, pages, limit, limits, href: (n) => kit.urlWith(req, { p: n > 1 ? n : null }), limitHref: (n) => kit.urlWith(req, { limit: n, p: null }), nav: 'orders' });
  });

  function loadOrder(req) {
    const o = db().prepare('SELECT * FROM orders WHERE id = ?').get(+req.params.id);
    const guest = req.session.get('guest_order_id');
    if (!o || !((req.user && o.customer_id === req.user.id) || (guest && guest === o.id))) return null;
    o.status_label = S.orderStatusLabel(db(), o.status);
    o.items = db().prepare('SELECT * FROM order_items WHERE order_id = ? AND parent_item_id IS NULL ORDER BY id').all(o.id);
    for (const it of o.items) {
      let opts = {};
      try { opts = JSON.parse(it.options_json || '{}') || {}; } catch {}
      it.opts = [...(opts.attributes_info || []), ...(opts.options || [])].map((x) => ({ label: x.label, value: x.print_value ?? x.value }));
      const p = db().prepare('SELECT url_key, status, visibility FROM products WHERE id = ?').get(it.product_id);
      it.url = p && p.status === 1 && p.visibility > 1 && p.url_key ? `/${p.url_key}.html` : null;
    }
    o.shipping = db().prepare("SELECT * FROM order_addresses WHERE order_id = ? AND address_type = 'shipping'").get(o.id);
    o.billing = db().prepare("SELECT * FROM order_addresses WHERE order_id = ? AND address_type = 'billing'").get(o.id);
    o.payment = db().prepare('SELECT * FROM order_payments WHERE order_id = ? ORDER BY id LIMIT 1').get(o.id);
    try { o.payment_title = (JSON.parse((o.payment && o.payment.additional_information) || '{}') || {}).method_title; } catch {}
    o.payment_title = o.payment_title || { checkmo: 'Check / Money order', cashondelivery: 'Cash On Delivery', purchaseorder: 'Purchase Order', free: 'No Payment Information Required' }[o.payment_method] || o.payment_method;
    o.history = db().prepare('SELECT * FROM order_status_history WHERE order_id = ? AND is_visible_on_front = 1 AND comment IS NOT NULL ORDER BY created_at, id').all(o.id);
    o.invoices = db().prepare('SELECT * FROM invoices WHERE order_id = ? ORDER BY id').all(o.id);
    for (const i of o.invoices) i.items = db().prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id').all(i.id);
    o.shipments = db().prepare('SELECT * FROM shipments WHERE order_id = ? ORDER BY id').all(o.id);
    for (const s of o.shipments) { s.items = db().prepare('SELECT * FROM shipment_items WHERE shipment_id = ? ORDER BY id').all(s.id); s.tracks = db().prepare('SELECT * FROM shipment_tracks WHERE shipment_id = ? ORDER BY id').all(s.id); }
    o.creditmemos = db().prepare('SELECT * FROM credit_memos WHERE order_id = ? ORDER BY id').all(o.id);
    for (const m of o.creditmemos) m.items = db().prepare('SELECT * FROM credit_memo_items WHERE credit_memo_id = ? ORDER BY id').all(m.id);
    o.canReorder = !['holded', 'fraud', 'payment_review'].includes(o.status) && o.items.some((i) => i.url);
    return o;
  }
  const view = (tab) => async (req, reply) => {
    const o = loadOrder(req);
    if (!o) {
      if (!req.user && !req.session.get('guest_order_id')) return reply.redirect(`/customer/account/login/?next=${encodeURIComponent(req.url)}`);
      req.flash('error', 'This order no longer exists.');
      return reply.redirect(req.user ? '/sales/order/history/' : '/sales/guest/form/');
    }
    return reply.render('sales/order', { title: `Order # ${o.increment_id}`, o, tab, fmtAddr: (a) => H.formatAddress(db(), a), nav: 'orders', bodyClass: `sales-order-${tab}` });
  };
  for (const [tab, path] of [['view', 'view'], ['invoice', 'invoice'], ['shipment', 'shipment'], ['creditmemo', 'creditmemo']]) {
    app.get(`/sales/order/${path}/order_id/:id`, view(tab));
  }
  app.get('/sales/order/print/order_id/:id', async (req, reply) => {
    const o = loadOrder(req);
    if (!o) throw kit.httpError(404, 'Order not found');
    return reply.render('sales/print', { title: `Order # ${o.increment_id}`, o, fmtAddr: (a) => H.formatAddress(db(), a) });
  });
  app.get('/sales/order/printInvoice/order_id/:id', async (req, reply) => reply.redirect(`/sales/order/invoice/order_id/${+req.params.id}/`));

  app.post('/sales/order/reorder/order_id/:id', async (req, reply) => {
    const o = loadOrder(req);
    if (!o) throw kit.httpError(404, 'Order not found');
    let added = 0;
    for (const it of o.items) {
      const p = db().prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(it.product_id);
      if (!p || !p.is_in_stock) { req.flash('error', `Product "${S.plainName(it.name)}" is not available.`); continue; }
      let opts = {};
      try { opts = JSON.parse(it.options_json || '{}') || {}; } catch {}
      const cartOpts = {};
      if (p.type === 'configurable') {
        const child = db().prepare('SELECT c.id, c.sku, c.name FROM order_items oi JOIN products c ON c.id = oi.product_id WHERE oi.parent_item_id = ?').get(it.id)
          || db().prepare('SELECT id, sku, name FROM products WHERE sku = ?').get(it.sku);
        if (!child) continue;
        Object.assign(cartOpts, { child_id: child.id, child_sku: child.sku, simple_name: child.name, super_attribute: opts.info_buyRequest && opts.info_buyRequest.super_attribute, attributes_info: opts.attributes_info });
      }
      if (opts.options && opts.options.length) {
        cartOpts.options = opts.options.map((x) => {
          const v = db().prepare('SELECT price FROM product_option_values WHERE id = ?').pluck().get(+x.option_value);
          return { label: x.label, value: x.value, print_value: x.print_value ?? x.value, option_id: x.option_id, option_type: x.option_type, option_value: x.option_value, price: Number(v || 0) };
        });
      }
      cart.addItem(req, p, it.qty_ordered || 1, cartOpts);
      added++;
    }
    if (added) req.flash('success', `You added ${added} item${added === 1 ? '' : 's'} to your shopping cart.`);
    return reply.redirect('/checkout/cart/');
  });

  // ---------------------------------------------------------------- guest orders ("Orders and Returns")
  app.get('/sales/guest/form', async (req, reply) => reply.render('sales/guest', { title: 'Orders and Returns', values: {} }));
  app.post('/sales/guest/view', async (req, reply) => {
    const b = req.body || {};
    const num = String(b['oar_order_id'] || b.order_id || '').trim();
    const last = String(b['oar_billing_lastname'] || b.lastname || '').trim();
    const email = String(b['oar_email'] || b.email || '').trim();
    const o = db().prepare(`SELECT o.id FROM orders o JOIN order_addresses a ON a.order_id = o.id AND a.address_type = 'billing'
      WHERE o.increment_id = ? AND lower(a.lastname) = lower(?) AND lower(o.customer_email) = lower(?)`).get(num, last, email);
    if (!o) return reply.render('sales/guest', { title: 'Orders and Returns', values: b, error: 'You entered incorrect data. Please try again.' }, 200);
    req.session.set('guest_order_id', o.id);
    return reply.redirect(`/sales/order/view/order_id/${o.id}/`);
  });
};
