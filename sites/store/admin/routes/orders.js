'use strict';
// Sales: orders grid + mass actions, order view (information, invoices, credit memos,
// shipments, comments history), comments / status, address edit, cancel / hold / unhold /
// send e-mail, invoices, shipments (tracking numbers), credit memos (offline refunds),
// invoice / shipment / credit-memo grids and views.
const S = require('../lib/sales');

module.exports = (r, ctx) => {
  const { kit, U, grid, view } = ctx;
  const h = kit.escapeHtml;
  const statusOptions = () => kit.sql('SELECT status, label FROM order_statuses ORDER BY label').all().map((s) => [s.status, s.label]);
  const groupOptions = () => kit.sql('SELECT id, code FROM customer_groups ORDER BY id').all().map((g) => [g.id, g.code]);
  const countryName = (id) => (id ? kit.sql('SELECT name FROM countries WHERE id = ?').pluck().get(id) || id : '');
  const addrName = (type) => `(SELECT trim(coalesce(a.firstname, '') || ' ' || coalesce(a.lastname, '')) FROM order_addresses a WHERE a.order_id = o.id AND a.address_type = '${type}' LIMIT 1)`;
  const addrFull = (type) => `(SELECT coalesce(a.street, '') || ', ' || coalesce(a.city, '') || ', ' || coalesce(a.region, '') || ' ' || coalesce(a.postcode, '') FROM order_addresses a WHERE a.order_id = o.id AND a.address_type = '${type}' LIMIT 1)`;
  const loadOrder = (id) => { const o = S.loadOrder(kit, +id); if (!o) throw ctx.notFound('order'); return o; };
  const viewUrl = (id, tab) => `/admin/sales/order/view/order_id/${id}/${tab ? `active_tab/${tab}/` : ''}`;

  // ---------------------------------------------------------------- orders grid
  const ORDERS = {
    id: 'sales_order_grid', url: '/admin/sales/order/', idCol: 'o.id', from: 'orders o', defaultSort: 'created_at_desc',
    keyword: (q) => {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      return { where: `(o.increment_id LIKE ?1 ESCAPE '\\' OR o.customer_email LIKE ?1 ESCAPE '\\' OR (coalesce(o.customer_firstname, '') || ' ' || coalesce(o.customer_lastname, '')) LIKE ?1 ESCAPE '\\' OR o.id IN (SELECT order_id FROM order_addresses WHERE (coalesce(firstname, '') || ' ' || coalesce(lastname, '')) LIKE ?1 ESCAPE '\\' OR street LIKE ?1 ESCAPE '\\' OR telephone LIKE ?1 ESCAPE '\\'))`.replace(/\?1/g, '?'), params: Array(6).fill(like) };
    },
    columns: [
      { key: 'increment_id', label: 'ID', sql: 'o.increment_id', filter: { type: 'text' }, html: (x) => `<a href="${viewUrl(x._id)}">${h(x.increment_id)}</a>` },
      { key: 'store', label: 'Purchase Point', sql: "'Main Website / Main Website Store / Default Store View'", sort: false, html: () => 'Main Website<br>Main Website Store<br>Default Store View' },
      { key: 'created_at', label: 'Purchase Date', sql: 'o.created_at', filter: { type: 'daterange' }, html: (x) => h(U.date.datetime(x.created_at)) },
      { key: 'billing_name', label: 'Bill-to Name', sql: addrName('billing'), filter: { type: 'text' } },
      { key: 'shipping_name', label: 'Ship-to Name', sql: addrName('shipping'), filter: { type: 'text' } },
      { key: 'base_grand_total', label: 'Grand Total (Base)', sql: 'o.grand_total', cls: 'num', filter: { type: 'range' }, html: (x) => U.money(x.base_grand_total) },
      { key: 'grand_total', label: 'Grand Total (Purchased)', sql: 'o.grand_total', cls: 'num', html: (x) => U.money(x.grand_total) },
      { key: 'status', label: 'Status', sql: 'o.status', filter: { type: 'select', options: statusOptions }, html: (x) => h(x.status_label || x.status) },
      { key: 'status_label', label: 'Status label', hidden: true, needed: true, sql: '(SELECT label FROM order_statuses s WHERE s.status = o.status)' },
      { key: 'billing_address', label: 'Billing Address', sql: addrFull('billing'), visible: false, filter: { type: 'text' } },
      { key: 'shipping_address', label: 'Shipping Address', sql: addrFull('shipping'), visible: false, filter: { type: 'text' } },
      { key: 'shipping_information', label: 'Shipping Information', sql: 'o.shipping_description', visible: false },
      { key: 'customer_email', label: 'Customer Email', sql: 'o.customer_email', visible: false, filter: { type: 'text' } },
      { key: 'customer_group', label: 'Customer Group', sql: '(SELECT code FROM customer_groups g WHERE g.id = o.customer_group_id)', sort: 'o.customer_group_id', visible: false, filter: { type: 'select', col: 'o.customer_group_id', options: groupOptions } },
      { key: 'subtotal', label: 'Subtotal', sql: 'o.subtotal', cls: 'num', visible: false, html: (x) => U.money(x.subtotal) },
      { key: 'shipping_and_handling', label: 'Shipping and Handling', sql: 'o.shipping_amount', cls: 'num', visible: false, html: (x) => U.money(x.shipping_and_handling) },
      { key: 'customer_name', label: 'Customer Name', sql: "trim(coalesce(o.customer_firstname, '') || ' ' || coalesce(o.customer_lastname, ''))", visible: false, filter: { type: 'text' } },
      { key: 'payment_method', label: 'Payment Method', sql: "(SELECT json_extract(additional_information, '$.method_title') FROM order_payments p WHERE p.order_id = o.id LIMIT 1)", sort: 'o.payment_method', visible: false },
      { key: 'total_refunded', label: 'Total Refunded', sql: 'o.total_refunded', cls: 'num', visible: false, html: (x) => U.money(x.total_refunded) },
    ],
    rowActions: (x) => `<a href="${viewUrl(x._id)}">View</a>`,
    massActions: [{ value: 'cancel', label: 'Cancel' }, { value: 'hold', label: 'Hold' }, { value: 'unhold', label: 'Unhold' }],
  };
  const ordersPage = async (req, reply) => view(reply, 'grid_page', { title: 'Orders', g: grid.build(req, kit, ORDERS), crumbs: [['Sales', null], ['Orders', null]], actions: [] });
  r.get('/sales/order', ordersPage);
  r.get('/sales/order/index', ordersPage);

  // ---------------------------------------------------------------- operations
  function cancelOrder(o) {
    if (!S.can(o).cancel) return false;
    const now = kit.nowSql();
    for (const i of o.items) {
      const q = Math.max(0, (i.qty_ordered || 0) - (i.qty_invoiced || 0) - (i.qty_canceled || 0));
      if (q <= 0) continue;
      kit.sql('UPDATE order_items SET qty_canceled = coalesce(qty_canceled, 0) + ?, updated_at = ? WHERE id = ?').run(q, now, i.id);
      // return to stock: simple lines (configurable lines return through their child row)
      const isStock = i.product_type !== 'configurable' && i.product_type !== 'bundle' && i.product_type !== 'grouped';
      if (isStock && i.product_id) kit.sql('UPDATE products SET qty = coalesce(qty, 0) + ?, is_in_stock = CASE WHEN coalesce(qty, 0) + ? > 0 THEN 1 ELSE is_in_stock END, updated_at = ? WHERE id = ? AND coalesce(manage_stock, 1) = 1').run(q, q, now, i.product_id);
    }
    const canceled = (o.grand_total || 0) - (o.total_invoiced || 0);
    kit.sql("UPDATE orders SET state = 'canceled', status = 'canceled', total_canceled = ?, subtotal_canceled = coalesce(subtotal, 0) - coalesce(subtotal_invoiced, 0), shipping_canceled = coalesce(shipping_amount, 0) - coalesce(shipping_invoiced, 0), total_due = 0, updated_at = ? WHERE id = ?")
      .run(canceled, now, o.id);
    kit.sql('UPDATE order_payments SET amount_canceled = ? WHERE order_id = ?').run(canceled, o.id);
    return true;
  }
  function holdOrder(o) {
    if (!S.can(o).hold) return false;
    kit.sql("UPDATE orders SET state = 'holded', status = 'holded', updated_at = ? WHERE id = ?").run(kit.nowSql(), o.id);
    return true;
  }
  function unholdOrder(o) {
    if (!S.can(o).unhold) return false;
    const started = (o.total_invoiced || 0) > 0 || o.top.some((i) => (i.qty_shipped || 0) > 0);
    const [state, status] = started ? ['processing', 'processing'] : ['new', 'pending'];
    kit.sql('UPDATE orders SET state = ?, status = ?, updated_at = ? WHERE id = ?').run(state, status, kit.nowSql(), o.id);
    S.recomputeState(kit, o.id);
    return true;
  }
  const OPS = {
    cancel: [cancelOrder, 'You canceled the order.', 'You cannot cancel the order.', 'canceled'],
    hold: [holdOrder, 'You put the order on hold.', 'You have not put the order on hold.', 'put on hold'],
    unhold: [unholdOrder, 'You released the order from holding status.', 'The order was not on hold.', 'released from hold'],
  };
  // POST /sales/order/cancel|hold|unhold/order_id/N/ (Magento) and .../cancelOrder|holdOrder|unholdOrder/...
  for (const [op, [fn, ok, bad]] of Object.entries(OPS)) {
    for (const p of [`/sales/order/${op}/order_id/:id`, `/sales/order/${op}Order/order_id/:id`]) r.post(p, async (req, reply) => {
      const o = loadOrder(req.params.id);
      const done = fn(o);
      req.flash(done ? 'success' : 'error', done ? ok : bad);
      return reply.redirect(viewUrl(o.id));
    });
  }
  r.post('/sales/order/massAction', async (req, reply) => {
    const ids = grid.selectedIds(req, kit, ORDERS);
    const op = OPS[U.str(req.body.mass_action)];
    const back = ctx.back(req, '/admin/sales/order/');
    if (!op) { req.flash('error', 'Please select an action.'); return reply.redirect(back); }
    let n = 0; let bad = 0;
    for (const id of ids) { const o = S.loadOrder(kit, id); if (o && op[0](o)) n++; else bad++; }
    if (n) req.flash('success', `We ${op[3]} ${n} order(s).`);
    if (bad) req.flash('error', `${bad} order(s) cannot be ${op[3]}.`);
    return reply.redirect(back);
  });
  r.post('/sales/order/email/order_id/:id', async (req, reply) => {
    const o = loadOrder(req.params.id);
    S.addHistory(kit, o.id, { status: o.status, comment: 'Order confirmation e-mail sent to the customer.', notify: 1 });
    req.flash('success', 'You sent the order email.');
    return reply.redirect(viewUrl(o.id));
  });

  // ---------------------------------------------------------------- comments / status
  r.post('/sales/order/addComment/order_id/:id', async (req, reply) => {
    const o = loadOrder(req.params.id);
    const b = req.body || {};
    const comment = U.str(b['history[comment]'] ?? b.comment);
    const status = U.str(b['history[status]'] ?? b.status) || o.status;
    const notify = U.str(b['history[is_customer_notified]']) === '1';
    const visible = U.str(b['history[is_visible_on_front]']) === '1';
    const allowed = S.statusesFor(kit, o).map((s) => s.status);
    if (!allowed.includes(status)) { req.flash('error', 'You cannot set this order status for the order.'); return reply.redirect(viewUrl(o.id) + '#order_history_block'); }
    if (!comment && status === o.status) { req.flash('error', 'Please enter a comment.'); return reply.redirect(viewUrl(o.id) + '#order_history_block'); }
    S.addHistory(kit, o.id, { status, comment: comment || null, notify, visible });
    kit.sql('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, kit.nowSql(), o.id);
    req.flash('success', 'The comment has been added to the order.');
    return reply.redirect(viewUrl(o.id) + '#order_history_block');
  });

  // ---------------------------------------------------------------- order view
  const TABS = [['order_info', 'Information'], ['order_invoices', 'Invoices'], ['order_creditmemos', 'Credit Memos'], ['order_shipments', 'Shipments'], ['order_history', 'Comments History']];
  const segs = (rest) => { const a = String(rest || '').split('/').filter(Boolean); const o = {}; for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };
  function orderModel(o, tab) {
    const c = S.can(o);
    const group = kit.sql('SELECT code FROM customer_groups WHERE id = ?').pluck().get(o.customer_group_id) || 'NOT LOGGED IN';
    const customer = o.customer_id ? kit.sql('SELECT id, firstname, lastname, email FROM customers WHERE id = ?').get(o.customer_id) : null;
    const invoices = kit.sql('SELECT * FROM invoices WHERE order_id = ? ORDER BY id').all(o.id);
    const shipments = kit.sql('SELECT s.*, (SELECT group_concat(track_number, \', \') FROM shipment_tracks t WHERE t.shipment_id = s.id) AS tracks FROM shipments s WHERE order_id = ? ORDER BY id').all(o.id);
    const memos = kit.sql('SELECT * FROM credit_memos WHERE order_id = ? ORDER BY id').all(o.id);
    const history = kit.sql('SELECT * FROM order_status_history WHERE order_id = ? ORDER BY created_at DESC, id DESC').all(o.id);
    const statusLabels = Object.fromEntries(kit.sql('SELECT status, label FROM order_statuses').all().map((s) => [s.status, s.label]));
    const payTitle = (() => { try { return JSON.parse(o.payment && o.payment.additional_information || '{}').method_title; } catch { return null; } })() || (o.payment_method === 'checkmo' ? 'Check / Money order' : o.payment_method);
    const actions = [{ label: 'Back', href: '/admin/sales/order/', id: 'back' }];
    if (c.cancel) actions.push({ label: 'Cancel', post: `/admin/sales/order/cancelOrder/order_id/${o.id}/`, confirm: 'Are you sure you want to cancel this order?', id: 'order-view-cancel-button' });
    actions.push({ label: 'Send Email', post: `/admin/sales/order/email/order_id/${o.id}/`, confirm: 'Are you sure you want to send an order email to customer?', id: 'send_notification' });
    if (c.hold) actions.push({ label: 'Hold', post: `/admin/sales/order/holdOrder/order_id/${o.id}/`, id: 'order-view-hold-button' });
    if (c.unhold) actions.push({ label: 'Unhold', post: `/admin/sales/order/unholdOrder/order_id/${o.id}/`, id: 'order-view-unhold-button' });
    if (c.invoice) actions.push({ label: 'Invoice', href: `/admin/sales/order_invoice/new/order_id/${o.id}/`, id: 'order_invoice' });
    if (c.creditmemo) actions.push({ label: 'Credit Memo', href: `/admin/sales/order_creditmemo/new/order_id/${o.id}/`, id: 'order_creditmemo' });
    if (c.ship) actions.push({ label: 'Ship', href: `/admin/admin/order_shipment/new/order_id/${o.id}/`, id: 'order_ship' });
    return {
      title: `#${o.increment_id}`, o, c, tab, tabs: TABS.map(([k, l]) => [l, k === 'order_info' ? viewUrl(o.id) : viewUrl(o.id, k), k === tab]),
      group, customer, invoices, shipments, memos, history, statusLabels, payTitle, statuses: S.statusesFor(kit, o), comments: S.commentsHistory(kit, o),
      billing: S.addressLines(o.billing, countryName), shipping: S.addressLines(o.shipping, countryName), itemOptions: S.itemOptions,
      crumbs: [['Sales', null], ['Orders', '/admin/sales/order/'], [`#${o.increment_id}`, null]], actions,
    };
  }
  const viewPage = async (req, reply) => {
    const o = loadOrder(req.params.id);
    const p = segs(req.params['*']);
    const tab = TABS.some((t) => t[0] === p.active_tab) ? p.active_tab : (TABS.some((t) => t[0] === req.query.active_tab) ? req.query.active_tab : 'order_info');
    return view(reply, 'order_view', orderModel(o, tab));
  };
  r.get('/sales/order/view/order_id/:id', viewPage);
  r.get('/sales/order/commentsHistory/order_id/:id', async (req, reply) => view(reply, 'order_view', orderModel(loadOrder(req.params.id), 'order_history')));

  // ---------------------------------------------------------------- address edit
  const regionsOf = (country) => kit.sql('SELECT id, name FROM regions WHERE country_id = ? ORDER BY name').all(country).map((x) => [x.id, x.name]);
  const ADDR_FIELDS = ['prefix', 'firstname', 'middlename', 'lastname', 'suffix', 'company', 'city', 'postcode', 'country_id', 'telephone', 'fax', 'email'];
  function addressForm(a, o, values = {}, errors = {}) {
    const streets = String(a.street || '').split('\n');
    const v = { ...Object.fromEntries(ADDR_FIELDS.map((k) => [k, a[k] ?? ''])), 'street[0]': streets[0] || '', 'street[1]': streets[1] || '', 'street[2]': streets[2] || '', region_id: a.region_id ?? '', region: a.region || '', ...values };
    const regions = regionsOf(v.country_id || 'US');
    return {
      title: `Edit Order ${o.increment_id} ${a.address_type === 'billing' ? 'Billing' : 'Shipping'} Address`, action: `/admin/sales/order/addressSave/address_id/${a.id}/`, values: v, errors,
      crumbs: [['Sales', null], ['Orders', '/admin/sales/order/'], [`#${o.increment_id}`, viewUrl(o.id)], ['Edit Address', null]],
      actions: [{ label: 'Back', href: viewUrl(o.id) }, { label: 'Save Order Address', form: 'edit_form', primary: true, id: 'save' }],
      sections: [{ title: 'Order Address Information', fields: [
        { name: 'prefix', label: 'Name Prefix' }, { name: 'firstname', label: 'First Name', required: true }, { name: 'middlename', label: 'Middle Name/Initial' },
        { name: 'lastname', label: 'Last Name', required: true }, { name: 'suffix', label: 'Name Suffix' }, { name: 'company', label: 'Company' },
        { name: 'street[0]', label: 'Street Address', required: true }, { name: 'street[1]', label: 'Street Address: Line 2' }, { name: 'street[2]', label: 'Street Address: Line 3' },
        { name: 'city', label: 'City', required: true },
        { name: 'country_id', label: 'Country', type: 'select', options: kit.sql('SELECT id, name FROM countries ORDER BY name').all().map((c) => [c.id, c.name]), required: true },
        ...(regions.length ? [{ name: 'region_id', label: 'State/Province', type: 'select', options: regions, empty: 'Please select a region, state or province.', required: true }] : [{ name: 'region', label: 'State/Province' }]),
        { name: 'postcode', label: 'Zip/Postal Code', required: true }, { name: 'telephone', label: 'Phone Number', required: true }, { name: 'fax', label: 'Fax' },
      ] }],
    };
  }
  const loadAddr = (id) => { const a = kit.sql('SELECT * FROM order_addresses WHERE id = ?').get(+id); if (!a) throw ctx.notFound('address'); return a; };
  r.get('/sales/order/address/address_id/:id', async (req, reply) => { const a = loadAddr(req.params.id); return view(reply, 'form_page', addressForm(a, loadOrder(a.order_id))); });
  r.post('/sales/order/addressSave/address_id/:id', async (req, reply) => {
    const a = loadAddr(req.params.id);
    const o = loadOrder(a.order_id);
    const b = req.body || {};
    const v = Object.fromEntries(ADDR_FIELDS.map((k) => [k, U.str(b[k])]));
    const street = [0, 1, 2].map((i) => U.str(b[`street[${i}]`] ?? (Array.isArray(b['street[]']) ? b['street[]'][i] : i === 0 ? b.street : ''))).filter(Boolean);
    const errors = {};
    for (const k of ['firstname', 'lastname', 'city', 'postcode', 'telephone', 'country_id']) if (!v[k]) errors[k] = 'This is a required field.';
    if (!street.length) errors['street[0]'] = 'This is a required field.';
    if (v.country_id && !kit.sql('SELECT 1 FROM countries WHERE id = ?').get(v.country_id)) errors.country_id = 'Please select a valid country.';
    let regionId = null; let region = U.str(b.region) || null;
    const regions = regionsOf(v.country_id);
    if (regions.length) {
      const rid = parseInt(U.str(b.region_id), 10);
      const row = Number.isFinite(rid) ? kit.sql('SELECT id, name FROM regions WHERE id = ? AND country_id = ?').get(rid, v.country_id) : (region ? kit.sql('SELECT id, name FROM regions WHERE country_id = ? AND (name = ? COLLATE NOCASE OR code = ? COLLATE NOCASE)').get(v.country_id, region, region) : null);
      if (!row) errors.region_id = 'Please select a region, state or province.';
      else { regionId = row.id; region = row.name; }
    }
    if (Object.keys(errors).length) {
      const m = addressForm(a, o, { ...v, 'street[0]': street[0] || '', 'street[1]': street[1] || '', 'street[2]': street[2] || '', region_id: U.str(b.region_id), region: U.str(b.region) }, errors);
      m.errorsList = ['The address could not be saved. Please correct the highlighted fields.'];
      return view(reply, 'form_page', m, 422);
    }
    kit.sql(`UPDATE order_addresses SET prefix = @prefix, firstname = @firstname, middlename = @middlename, lastname = @lastname, suffix = @suffix, company = @company,
      street = @street, city = @city, region = @region, region_id = @region_id, postcode = @postcode, country_id = @country_id, telephone = @telephone, fax = @fax,
      email = coalesce(nullif(@email, ''), email) WHERE id = @id`).run({ ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null])), email: v.email, street: street.join('\n'), region, region_id: regionId, id: a.id });
    kit.sql('UPDATE orders SET updated_at = ? WHERE id = ?').run(kit.nowSql(), o.id);
    req.flash('success', 'You updated the order address.');
    return reply.redirect(viewUrl(o.id));
  });

  // ---------------------------------------------------------------- invoices
  const r4 = (x) => Math.round(x * 10000) / 10000;
  function qtyMap(b, prefix, items, max) {
    const m = new Map();
    let any = false;
    for (const i of items) {
      const k = `${prefix}[${i.id}]`;
      const k2 = `${prefix}[${i.id}][qty]`;
      const raw = U.has(b, k) ? b[k] : U.has(b, k2) ? b[k2] : null;
      const n = raw == null ? max(i) : U.numOrNull(raw);
      if (n == null || Number.isNaN(n) || n < 0) throw kit.httpError(422, `Please enter a valid quantity for ${U.plainName(i.name)}.`);
      if (n > max(i) + 1e-9) throw kit.httpError(422, `The quantity for ${U.plainName(i.name)} cannot exceed ${max(i)}.`);
      if (n > 0) any = true;
      m.set(i.id, n);
    }
    if (!any) throw kit.httpError(422, 'You can\'t create a document without products.');
    return m;
  }
  function docTotals(o, items, qmap, kind) {
    let subtotal = 0; let tax = 0; let discount = 0;
    for (const i of items) {
      const q = qmap.get(i.id) || 0;
      if (!q) continue;
      subtotal += (i.price || 0) * q;
      tax += (i.tax_amount || 0) * q / (i.qty_ordered || 1);
      discount += Math.abs(i.discount_amount || 0) * q / (i.qty_ordered || 1);
    }
    let shipping = 0;
    if (kind === 'invoice') shipping = Math.max(0, (o.shipping_amount || 0) - (o.shipping_invoiced || 0));
    return { subtotal: r4(subtotal), tax: r4(tax), discount: r4(discount), shipping: r4(shipping), grand: r4(subtotal + tax - discount + shipping) };
  }
  function docModel(kind, o, extra = {}) {
    const max = kind === 'invoice' ? S.toInvoice : kind === 'shipment' ? S.toShip : S.toRefund;
    const items = o.top.map((i) => ({ ...i, max: max(i), options: S.itemOptions(i) }));
    const full = new Map(items.map((i) => [i.id, i.max]));
    const totals = docTotals(o, o.top, full, kind === 'shipment' ? 'shipment' : kind);
    if (kind === 'creditmemo') totals.shipping = r4(Math.max(0, (o.shipping_invoiced || 0) - (o.shipping_refunded || 0)));
    totals.grand = r4(totals.subtotal + totals.tax - totals.discount + totals.shipping);
    const T = { invoice: ['New Invoice', `/admin/sales/order_invoice/save/order_id/${o.id}/`, 'Submit Invoice'], shipment: ['New Shipment', `/admin/admin/order_shipment/save/order_id/${o.id}/`, 'Submit Shipment'], creditmemo: ['New Memo', `/admin/sales/order_creditmemo/save/order_id/${o.id}/`, 'Refund Offline'] }[kind];
    return {
      title: T[0], kind, o, items, totals, action: T[1], carriers: S.CARRIERS,
      billing: S.addressLines(o.billing, countryName), shipping: S.addressLines(o.shipping, countryName),
      crumbs: [['Sales', null], ['Orders', '/admin/sales/order/'], [`#${o.increment_id}`, viewUrl(o.id)], [T[0], null]],
      actions: [{ label: 'Back', href: viewUrl(o.id) }, { label: T[2], form: 'edit_form', primary: true, id: 'submit' }], ...extra,
    };
  }
  r.get('/sales/order_invoice/new/order_id/:id', async (req, reply) => {
    const o = loadOrder(req.params.id);
    if (!S.can(o).invoice) { req.flash('error', 'The order does not allow an invoice to be created.'); return reply.redirect(viewUrl(o.id)); }
    return view(reply, 'sales_doc_new', docModel('invoice', o));
  });
  function createShipment(o, b, qmap, comment, notify) {
    const now = kit.nowSql();
    const inc = S.nextIncrement(kit, 'shipments');
    let totalQty = 0; let weight = 0;
    for (const i of o.top) totalQty += qmap.get(i.id) || 0;
    const sid = Number(kit.sql('INSERT INTO shipments (increment_id, order_id, total_qty, total_weight, shipping_address_id, billing_address_id, email_sent, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(inc, o.id, totalQty, o.shipping ? o.shipping.id : null, o.billing ? o.billing.id : null, notify ? 1 : 0, now, now).lastInsertRowid);
    for (const i of o.top) {
      const q = qmap.get(i.id) || 0;
      if (!q) continue;
      weight += (i.weight || 0) * q;
      kit.sql('INSERT INTO shipment_items (shipment_id, order_item_id, product_id, sku, name, qty, price, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sid, i.id, i.product_id, i.sku, i.name, q, i.price, i.weight);
      kit.sql('UPDATE order_items SET qty_shipped = coalesce(qty_shipped, 0) + ?, updated_at = ? WHERE id = ? OR parent_item_id = ?').run(q, now, i.id, i.id);
    }
    kit.sql('UPDATE shipments SET total_weight = ? WHERE id = ?').run(weight || null, sid);
    // tracking numbers: tracking[n][carrier_code|title|number]
    for (let n = 0; n < 10; n++) {
      const num = U.str(b[`tracking[${n}][number]`]);
      if (!num) continue;
      const carrier = U.str(b[`tracking[${n}][carrier_code]`]) || 'custom';
      const title = U.str(b[`tracking[${n}][title]`]) || S.CARRIER_TITLE[carrier] || carrier;
      kit.sql('INSERT INTO shipment_tracks (shipment_id, order_id, carrier_code, title, track_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sid, o.id, carrier, title, num, now, now);
    }
    if (comment) kit.sql("INSERT INTO sales_comments (entity_type, parent_id, comment, is_customer_notified, is_visible_on_front, created_at) VALUES ('shipment', ?, ?, ?, 0, ?)").run(sid, comment, notify ? 1 : 0, now);
    return { id: sid, increment_id: inc };
  }
  r.post('/sales/order_invoice/save/order_id/:id', async (req, reply) => {
    const o = loadOrder(req.params.id);
    const b = req.body || {};
    if (!S.can(o).invoice) { req.flash('error', 'The order does not allow an invoice to be created.'); return reply.redirect(viewUrl(o.id)); }
    let qmap;
    try { qmap = qtyMap(b, 'invoice[items]', o.top, S.toInvoice); } catch (e) { if (e.statusCode !== 422) throw e; req.flash('error', e.message); return reply.redirect(`/admin/sales/order_invoice/new/order_id/${o.id}/`); }
    const t = docTotals(o, o.top, qmap, 'invoice');
    // the last invoice takes the exact remainder (no rounding drift)
    const completes = o.top.every((i) => (qmap.get(i.id) || 0) >= S.toInvoice(i) - 1e-9);
    if (completes) t.grand = r4((o.grand_total || 0) - (o.total_invoiced || 0));
    const now = kit.nowSql();
    const inc = S.nextIncrement(kit, 'invoices');
    const notify = U.str(b['invoice[send_email]']) === '1';
    const totalQty = [...qmap.values()].reduce((a, x) => a + x, 0);
    const iid = Number(kit.sql('INSERT INTO invoices (increment_id, order_id, state, subtotal, discount_amount, shipping_amount, tax_amount, grand_total, total_qty, billing_address_id, shipping_address_id, email_sent, created_at, updated_at) VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(inc, o.id, t.subtotal, -t.discount, t.shipping, t.tax, t.grand, totalQty, o.billing ? o.billing.id : null, o.shipping ? o.shipping.id : null, notify ? 1 : 0, now, now).lastInsertRowid);
    for (const i of o.top) {
      const q = qmap.get(i.id) || 0;
      if (!q) continue;
      kit.sql('INSERT INTO invoice_items (invoice_id, order_item_id, product_id, sku, name, qty, price, row_total, discount_amount, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(iid, i.id, i.product_id, i.sku, i.name, q, i.price, r4((i.price || 0) * q), r4(Math.abs(i.discount_amount || 0) * q / (i.qty_ordered || 1)), r4((i.tax_amount || 0) * q / (i.qty_ordered || 1)));
      kit.sql('UPDATE order_items SET qty_invoiced = coalesce(qty_invoiced, 0) + ?, row_invoiced = coalesce(row_invoiced, 0) + ?, updated_at = ? WHERE id = ?').run(q, r4((i.price || 0) * q), now, i.id);
      kit.sql('UPDATE order_items SET qty_invoiced = coalesce(qty_invoiced, 0) + ?, updated_at = ? WHERE parent_item_id = ?').run(q, now, i.id);
    }
    kit.sql(`UPDATE orders SET total_invoiced = coalesce(total_invoiced, 0) + @g, total_paid = coalesce(total_paid, 0) + @g, total_due = max(0, grand_total - coalesce(total_paid, 0) - @g),
      subtotal_invoiced = coalesce(subtotal_invoiced, 0) + @s, shipping_invoiced = coalesce(shipping_invoiced, 0) + @sh, updated_at = @now WHERE id = @id`).run({ g: t.grand, s: t.subtotal, sh: t.shipping, now, id: o.id });
    kit.sql('UPDATE order_payments SET amount_paid = coalesce(amount_paid, 0) + ? WHERE order_id = ?').run(t.grand, o.id);
    const comment = U.str(b['invoice[comment_text]']);
    if (comment) kit.sql("INSERT INTO sales_comments (entity_type, parent_id, comment, is_customer_notified, is_visible_on_front, created_at) VALUES ('invoice', ?, ?, ?, 0, ?)").run(iid, comment, notify ? 1 : 0, now);
    let after = S.recomputeState(kit, o.id);
    S.addHistory(kit, o.id, { status: after.status, comment: `Captured amount of ${U.money(t.grand)} offline.`, notify, entity: 'invoice' });
    let shipped = false;
    if (U.str(b['invoice[do_shipment]']) === '1' && S.can(after).ship) {
      createShipment(after, b, new Map(after.top.map((i) => [i.id, S.toShip(i)])), '', notify);
      after = S.recomputeState(kit, o.id);
      shipped = true;
    }
    req.flash('success', shipped ? 'You created the invoice and shipment.' : 'The invoice has been created.');
    return reply.redirect(viewUrl(o.id));
  });

  // ---------------------------------------------------------------- shipments
  r.get('/admin/order_shipment/new/order_id/:id', async (req, reply) => {
    const o = loadOrder(req.params.id);
    if (!S.can(o).ship) { req.flash('error', 'The order does not allow a shipment to be created.'); return reply.redirect(viewUrl(o.id)); }
    return view(reply, 'sales_doc_new', docModel('shipment', o));
  });
  r.get('/sales/order_shipment/new/order_id/:id', async (req, reply) => reply.redirect(`/admin/admin/order_shipment/new/order_id/${req.params.id}/`));
  r.post('/admin/order_shipment/save/order_id/:id', async (req, reply) => {
    const o = loadOrder(req.params.id);
    const b = req.body || {};
    if (!S.can(o).ship) { req.flash('error', 'The order does not allow a shipment to be created.'); return reply.redirect(viewUrl(o.id)); }
    let qmap;
    try { qmap = qtyMap(b, 'shipment[items]', o.top, S.toShip); } catch (e) { if (e.statusCode !== 422) throw e; req.flash('error', e.message); return reply.redirect(`/admin/admin/order_shipment/new/order_id/${o.id}/`); }
    for (let n = 0; n < 10; n++) {
      if (U.str(b[`tracking[${n}][number]`]) && U.str(b[`tracking[${n}][carrier_code]`]) === 'custom' && !U.str(b[`tracking[${n}][title]`])) {
        req.flash('error', 'Please enter a title for the custom carrier.');
        return reply.redirect(`/admin/admin/order_shipment/new/order_id/${o.id}/`);
      }
    }
    const notify = U.str(b['shipment[send_email]']) === '1';
    createShipment(o, b, qmap, U.str(b['shipment[comment_text]']), notify);
    S.recomputeState(kit, o.id);
    kit.sql('UPDATE orders SET updated_at = ? WHERE id = ?').run(kit.nowSql(), o.id);
    req.flash('success', 'The shipment has been created.');
    return reply.redirect(viewUrl(o.id));
  });
  const loadShipment = (id) => { const s = kit.sql('SELECT * FROM shipments WHERE id = ?').get(+id); if (!s) throw ctx.notFound('shipment'); return s; };
  r.post('/admin/order_shipment/addTrack/shipment_id/:id', async (req, reply) => {
    const s = loadShipment(req.params.id);
    const b = req.body || {};
    const num = U.str(b.number ?? b['tracking[number]']);
    const carrier = U.str(b.carrier ?? b['tracking[carrier_code]']) || 'custom';
    const title = U.str(b.title ?? b['tracking[title]']) || S.CARRIER_TITLE[carrier] || carrier;
    const back = `/admin/admin/order_shipment/view/shipment_id/${s.id}/`;
    if (!num) { req.flash('error', 'Please enter a tracking number.'); return reply.redirect(back); }
    if (carrier === 'custom' && !U.str(b.title ?? b['tracking[title]'])) { req.flash('error', 'Please enter a title for the custom carrier.'); return reply.redirect(back); }
    const now = kit.nowSql();
    kit.sql('INSERT INTO shipment_tracks (shipment_id, order_id, carrier_code, title, track_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(s.id, s.order_id, carrier, title, num, now, now);
    kit.sql('UPDATE shipments SET updated_at = ? WHERE id = ?').run(now, s.id);
    req.flash('success', 'The tracking number has been added.');
    return reply.redirect(back);
  });
  r.post('/admin/order_shipment/removeTrack/track_id/:id', async (req, reply) => {
    const t = kit.sql('SELECT * FROM shipment_tracks WHERE id = ?').get(+req.params.id);
    if (!t) throw ctx.notFound('tracking number');
    kit.sql('DELETE FROM shipment_tracks WHERE id = ?').run(t.id);
    req.flash('success', 'The tracking number has been removed.');
    return reply.redirect(`/admin/admin/order_shipment/view/shipment_id/${t.shipment_id}/`);
  });

  // ---------------------------------------------------------------- credit memos
  r.get('/sales/order_creditmemo/new/order_id/:id', async (req, reply) => {
    const o = loadOrder(req.params.id);
    if (!S.can(o).creditmemo) { req.flash('error', 'The order does not allow a credit memo to be created (nothing was invoiced or everything was refunded).'); return reply.redirect(viewUrl(o.id)); }
    return view(reply, 'sales_doc_new', docModel('creditmemo', o));
  });
  r.post('/sales/order_creditmemo/save/order_id/:id', async (req, reply) => {
    const o = loadOrder(req.params.id);
    const b = req.body || {};
    const back = `/admin/sales/order_creditmemo/new/order_id/${o.id}/`;
    if (!S.can(o).creditmemo) { req.flash('error', 'The order does not allow a credit memo to be created.'); return reply.redirect(viewUrl(o.id)); }
    let qmap;
    try { qmap = qtyMap(b, 'creditmemo[items]', o.top, S.toRefund); } catch (e) {
      if (e.statusCode !== 422) throw e;
      // a memo with only shipping / adjustments is allowed
      if (!/without products/.test(e.message)) { req.flash('error', e.message); return reply.redirect(back); }
      qmap = new Map();
    }
    const t = docTotals(o, o.top, qmap, 'creditmemo');
    const num = (k, d) => { const n = U.numOrNull(b[k]); return n == null ? d : n; };
    const ship = num('creditmemo[shipping_amount]', Math.max(0, (o.shipping_invoiced || 0) - (o.shipping_refunded || 0)));
    const adjPos = num('creditmemo[adjustment_positive]', 0);
    const adjNeg = num('creditmemo[adjustment_negative]', 0);
    if ([ship, adjPos, adjNeg].some((x) => Number.isNaN(x) || x < 0)) { req.flash('error', 'Please enter valid refund amounts.'); return reply.redirect(back); }
    if (ship > (o.shipping_invoiced || 0) - (o.shipping_refunded || 0) + 1e-9) { req.flash('error', `The maximum shipping amount allowed to refund is: ${U.money((o.shipping_invoiced || 0) - (o.shipping_refunded || 0))}`); return reply.redirect(back); }
    const grand = r4(t.subtotal + t.tax - t.discount + ship + adjPos - adjNeg);
    const avail = r4((o.total_paid || 0) - (o.total_refunded || 0));
    if (grand <= 0) { req.flash('error', 'The credit memo\'s total must be positive.'); return reply.redirect(back); }
    if (grand > avail + 1e-6) { req.flash('error', `The most money available to refund is ${U.money(avail)}.`); return reply.redirect(back); }
    const now = kit.nowSql();
    const inc = S.nextIncrement(kit, 'credit_memos');
    const inv = kit.sql('SELECT id FROM invoices WHERE order_id = ? ORDER BY id DESC LIMIT 1').pluck().get(o.id) || null;
    const cid = Number(kit.sql('INSERT INTO credit_memos (increment_id, order_id, invoice_id, state, subtotal, discount_amount, shipping_amount, tax_amount, adjustment_positive, adjustment_negative, adjustment, grand_total, created_at, updated_at) VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(inc, o.id, inv, t.subtotal, -t.discount, ship, t.tax, adjPos, adjNeg, r4(adjPos - adjNeg), grand, now, now).lastInsertRowid);
    const restock = U.str(b['creditmemo[return_to_stock]']) === '1' || U.str(b['creditmemo[items][return_to_stock]']) === '1';
    for (const i of o.top) {
      const q = qmap.get(i.id) || 0;
      if (!q) continue;
      const row = r4((i.price || 0) * q);
      kit.sql('INSERT INTO credit_memo_items (credit_memo_id, order_item_id, product_id, sku, name, qty, price, row_total, discount_amount, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(cid, i.id, i.product_id, i.sku, i.name, q, i.price, row, r4(Math.abs(i.discount_amount || 0) * q / (i.qty_ordered || 1)), r4((i.tax_amount || 0) * q / (i.qty_ordered || 1)));
      kit.sql('UPDATE order_items SET qty_refunded = coalesce(qty_refunded, 0) + ?, amount_refunded = coalesce(amount_refunded, 0) + ?, updated_at = ? WHERE id = ?').run(q, row, now, i.id);
      kit.sql('UPDATE order_items SET qty_refunded = coalesce(qty_refunded, 0) + ?, updated_at = ? WHERE parent_item_id = ?').run(q, now, i.id);
      if (restock) {
        const stockIds = i.children.length ? i.children.map((c) => c.product_id) : [i.product_id];
        for (const pid of stockIds.filter(Boolean)) kit.sql('UPDATE products SET qty = coalesce(qty, 0) + ?, is_in_stock = CASE WHEN coalesce(qty, 0) + ? > 0 THEN 1 ELSE is_in_stock END, updated_at = ? WHERE id = ?').run(q, q, now, pid);
      }
    }
    kit.sql(`UPDATE orders SET total_refunded = coalesce(total_refunded, 0) + @g, total_offline_refunded = coalesce(total_offline_refunded, 0) + @g, subtotal_refunded = coalesce(subtotal_refunded, 0) + @s,
      shipping_refunded = coalesce(shipping_refunded, 0) + @sh, updated_at = @now WHERE id = @id`).run({ g: grand, s: t.subtotal, sh: ship, now, id: o.id });
    kit.sql('UPDATE order_payments SET amount_refunded = coalesce(amount_refunded, 0) + ? WHERE order_id = ?').run(grand, o.id);
    const comment = U.str(b['creditmemo[comment_text]']);
    const notify = U.str(b['creditmemo[send_email]']) === '1';
    if (comment) kit.sql("INSERT INTO sales_comments (entity_type, parent_id, comment, is_customer_notified, is_visible_on_front, created_at) VALUES ('creditmemo', ?, ?, ?, 0, ?)").run(cid, comment, notify ? 1 : 0, now);
    const after = S.recomputeState(kit, o.id);
    S.addHistory(kit, o.id, { status: after.status, comment: `We refunded ${U.money(grand)} offline.`, notify, entity: 'creditmemo' });
    req.flash('success', 'You created the credit memo.');
    return reply.redirect(viewUrl(o.id));
  });

  // ---------------------------------------------------------------- document grids + views
  const orderLink = (x) => `<a href="${viewUrl(x.order_id)}">${h(x.order_increment)}</a>`;
  const docGrid = (id, url, table, title, viewPath, extraCols) => ({
    id, url, idCol: 'd.id', from: `${table} d`, defaultSort: 'created_at_desc',
    keyword: (q) => { const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`; return { where: "(d.increment_id LIKE ? ESCAPE '\\' OR d.order_id IN (SELECT id FROM orders WHERE increment_id LIKE ? ESCAPE '\\' OR (coalesce(customer_firstname, '') || ' ' || coalesce(customer_lastname, '')) LIKE ? ESCAPE '\\'))", params: [like, like, like] }; },
    columns: [
      { key: 'increment_id', label: title, sql: 'd.increment_id', filter: { type: 'text' }, html: (x) => `<a href="${viewPath}${x._id}/">${h(x.increment_id)}</a>` },
      { key: 'created_at', label: `${title.replace(/ ?#?$/, '')} Date`.replace('Shipment Date', 'Ship Date').replace('Invoice Date', 'Invoice Date'), sql: 'd.created_at', filter: { type: 'daterange' }, html: (x) => h(U.date.datetime(x.created_at)) },
      { key: 'order_increment', label: 'Order #', sql: '(SELECT increment_id FROM orders o WHERE o.id = d.order_id)', filter: { type: 'text' }, html: orderLink },
      { key: 'order_id', label: 'order id', hidden: true, needed: true, sql: 'd.order_id' },
      { key: 'order_date', label: 'Order Date', sql: '(SELECT created_at FROM orders o WHERE o.id = d.order_id)', html: (x) => h(U.date.datetime(x.order_date)) },
      { key: 'name', label: table === 'shipments' ? 'Ship-to Name' : 'Bill-to Name', sql: `(SELECT trim(coalesce(a.firstname, '') || ' ' || coalesce(a.lastname, '')) FROM order_addresses a WHERE a.order_id = d.order_id AND a.address_type = '${table === 'shipments' ? 'shipping' : 'billing'}' LIMIT 1)`, filter: { type: 'text' } },
      ...extraCols,
    ],
    rowActions: (x) => `<a href="${viewPath}${x._id}/">View</a>`,
  });
  const INV = docGrid('sales_order_invoice_grid', '/admin/sales/invoice/', 'invoices', 'Invoice', '/admin/sales/order_invoice/view/invoice_id/', [
    { key: 'state', label: 'Status', sql: 'd.state', filter: { type: 'select', options: [[1, 'Pending'], [2, 'Paid'], [3, 'Canceled']] }, html: (x) => ({ 1: 'Pending', 2: 'Paid', 3: 'Canceled' }[x.state] || '') },
    { key: 'grand_total', label: 'Amount', sql: 'd.grand_total', cls: 'num', filter: { type: 'range' }, html: (x) => U.money(x.grand_total) }]);
  const SHP = docGrid('sales_order_shipment_grid', '/admin/sales/shipment/', 'shipments', 'Shipment', '/admin/admin/order_shipment/view/shipment_id/', [
    { key: 'total_qty', label: 'Total Quantity', sql: 'd.total_qty', cls: 'num', filter: { type: 'range' }, html: (x) => U.num(x.total_qty) },
    { key: 'tracks', label: 'Tracking Numbers', sql: '(SELECT group_concat(track_number, \', \') FROM shipment_tracks t WHERE t.shipment_id = d.id)', sort: false, filter: { type: 'text' } }]);
  const CM = docGrid('sales_order_creditmemo_grid', '/admin/sales/creditmemo/', 'credit_memos', 'Credit Memo', '/admin/sales/order_creditmemo/view/creditmemo_id/', [
    { key: 'state', label: 'Status', sql: 'd.state', filter: { type: 'select', options: [[1, 'Pending'], [2, 'Refunded'], [3, 'Canceled']] }, html: (x) => ({ 1: 'Pending', 2: 'Refunded', 3: 'Canceled' }[x.state] || '') },
    { key: 'grand_total', label: 'Refunded', sql: 'd.grand_total', cls: 'num', filter: { type: 'range' }, html: (x) => U.money(x.grand_total) }]);
  for (const [spec, title, paths] of [[INV, 'Invoices', ['/sales/invoice', '/sales/invoice/index']], [SHP, 'Shipments', ['/sales/shipment', '/sales/shipment/index']], [CM, 'Credit Memos', ['/sales/creditmemo', '/sales/creditmemo/index']]]) {
    for (const p of paths) r.get(p, async (req, reply) => view(reply, 'grid_page', { title, g: grid.build(req, kit, spec), crumbs: [['Sales', null], [title, null]] }));
  }
  function docView(kind, d) {
    const o = loadOrder(d.order_id);
    const table = { invoice: 'invoice_items', shipment: 'shipment_items', creditmemo: 'credit_memo_items' }[kind];
    const fk = { invoice: 'invoice_id', shipment: 'shipment_id', creditmemo: 'credit_memo_id' }[kind];
    const items = kit.sql(`SELECT * FROM ${table} WHERE ${fk} = ? ORDER BY id`).all(d.id);
    const comments = kit.sql('SELECT * FROM sales_comments WHERE entity_type = ? AND parent_id = ? ORDER BY created_at DESC, id DESC').all(kind, d.id);
    const tracks = kind === 'shipment' ? kit.sql('SELECT * FROM shipment_tracks WHERE shipment_id = ? ORDER BY id').all(d.id) : [];
    const T = { invoice: ['Invoice', '/admin/sales/invoice/'], shipment: ['Shipment', '/admin/sales/shipment/'], creditmemo: ['Credit Memo', '/admin/sales/creditmemo/'] }[kind];
    return {
      title: `#${d.increment_id}`, kind, d, o, items, comments, tracks, carriers: S.CARRIERS, kindLabel: T[0],
      billing: S.addressLines(o.billing, countryName), shipping: S.addressLines(o.shipping, countryName),
      commentAction: `/admin/sales/order/addDocComment/kind/${kind}/id/${d.id}/`,
      crumbs: [['Sales', null], [`${T[0]}s`, T[1]], [`#${d.increment_id}`, null]],
      actions: [{ label: 'Back', href: viewUrl(o.id) }],
    };
  }
  r.get('/sales/order_invoice/view/invoice_id/:id', async (req, reply) => { const d = kit.sql('SELECT * FROM invoices WHERE id = ?').get(+req.params.id); if (!d) throw ctx.notFound('invoice'); return view(reply, 'sales_doc_view', docView('invoice', d)); });
  r.get('/sales/invoice/view/invoice_id/:id', async (req, reply) => reply.redirect(`/admin/sales/order_invoice/view/invoice_id/${req.params.id}/`));
  r.get('/admin/order_shipment/view/shipment_id/:id', async (req, reply) => view(reply, 'sales_doc_view', docView('shipment', loadShipment(req.params.id))));
  r.get('/sales/shipment/view/shipment_id/:id', async (req, reply) => reply.redirect(`/admin/admin/order_shipment/view/shipment_id/${req.params.id}/`));
  r.get('/sales/order_creditmemo/view/creditmemo_id/:id', async (req, reply) => { const d = kit.sql('SELECT * FROM credit_memos WHERE id = ?').get(+req.params.id); if (!d) throw ctx.notFound('credit memo'); return view(reply, 'sales_doc_view', docView('creditmemo', d)); });
  r.get('/sales/creditmemo/view/creditmemo_id/:id', async (req, reply) => reply.redirect(`/admin/sales/order_creditmemo/view/creditmemo_id/${req.params.id}/`));
  r.post('/sales/order/addDocComment/kind/:kind/id/:id', async (req, reply) => {
    const kind = req.params.kind;
    const table = { invoice: 'invoices', shipment: 'shipments', creditmemo: 'credit_memos' }[kind];
    if (!table) throw kit.httpError(404, 'Page not found');
    const d = kit.sql(`SELECT * FROM ${table} WHERE id = ?`).get(+req.params.id);
    if (!d) throw ctx.notFound(kind);
    const comment = U.str(req.body && req.body['comment[comment]']);
    const back = { invoice: `/admin/sales/order_invoice/view/invoice_id/${d.id}/`, shipment: `/admin/admin/order_shipment/view/shipment_id/${d.id}/`, creditmemo: `/admin/sales/order_creditmemo/view/creditmemo_id/${d.id}/` }[kind];
    if (!comment) { req.flash('error', 'Please enter a comment.'); return reply.redirect(back); }
    kit.sql('INSERT INTO sales_comments (entity_type, parent_id, comment, is_customer_notified, is_visible_on_front, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, d.id, comment, U.str(req.body['comment[is_customer_notified]']) === '1' ? 1 : 0, U.str(req.body['comment[is_visible_on_front]']) === '1' ? 1 : 0, kit.nowSql());
    req.flash('success', 'The comment has been added.');
    return reply.redirect(back);
  });

  // ---------------------------------------------------------------- order statuses (Stores > Order Status)
  r.get('/sales/order_status', async (req, reply) => {
    const rows = kit.sql('SELECT s.status, s.label, ss.state, ss.is_default, ss.visible_on_front FROM order_statuses s LEFT JOIN order_status_states ss ON ss.status = s.status ORDER BY s.label').all();
    const html = `<table class="data-grid"><thead><tr><th>Status</th><th>Status Code</th><th>Default Status</th><th>State Code and Title</th><th>Visible On Storefront</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${h(x.label)}</td><td>${h(x.status)}</td><td>${x.is_default ? 'Yes' : 'No'}</td><td>${h(x.state || '')}</td><td>${x.visible_on_front ? 'Yes' : 'No'}</td></tr>`).join('')}</tbody></table>`;
    return view(reply, 'message_page', { title: 'Order Status', html, crumbs: [['Stores', null], ['Order Status', null]] });
  });
};
