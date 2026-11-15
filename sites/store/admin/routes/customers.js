'use strict';
// Customers: grid (filters, mass delete / newsletter / group), new / edit (customer view,
// account information, addresses, orders, shopping cart, newsletter, product reviews,
// wish list), delete; customer groups.
const GENDER = [[1, 'Male'], [2, 'Female'], [3, 'Not Specified']];
const TABS = [['customer_view', 'Customer View'], ['account', 'Account Information'], ['addresses', 'Addresses'], ['orders', 'Orders'], ['cart', 'Shopping cart'], ['newsletter', 'Newsletter'], ['reviews', 'Product Reviews'], ['wishlist', 'Wish List']];

module.exports = (r, ctx) => {
  const { kit, U, grid, view } = ctx;
  const h = kit.escapeHtml;
  const groups = () => kit.sql('SELECT id, code FROM customer_groups WHERE id > 0 ORDER BY id').all().map((g) => [g.id, g.code]);
  const allGroups = () => kit.sql('SELECT id, code FROM customer_groups ORDER BY id').all().map((g) => [g.id, g.code]);
  const countries = () => kit.sql('SELECT id, name FROM countries ORDER BY name').all().map((c) => [c.id, c.name]);
  const bill = (col) => `(SELECT a.${col} FROM customer_addresses a WHERE a.id = c.default_billing_id)`;
  const editUrl = (id, tab) => `/admin/customer/index/edit/id/${id}/${tab && tab !== 'customer_view' ? `active_tab/${tab}/` : ''}`;

  // ---------------------------------------------------------------- grid
  const SPEC = {
    id: 'customer_listing', url: '/admin/customer/index/', idCol: 'c.id', from: 'customers c', defaultSort: 'entity_id_asc',
    keyword: (q) => {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      // phone numbers match by their digits, whatever the formatting ("+1 2058812302", "555-229-3326"
      // find "2058812302", "(555) 229-3326"), like Magento's full-text keyword search on the phone field
      const digits = q.replace(/\D/g, '');
      const phone = /^[\d\s()+.-]+$/.test(q) && digits.length >= 7 ? digits.slice(-10).replace(/^1(?=\d{10}$)/, '') : null;
      const tel = "replace(replace(replace(replace(replace(replace(telephone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '')";
      return {
        where: `((coalesce(c.firstname, '') || ' ' || coalesce(c.lastname, '')) LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.id IN (SELECT customer_id FROM customer_addresses WHERE telephone LIKE ? ESCAPE '\\' OR street LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\' OR postcode LIKE ? ESCAPE '\\'${phone ? ` OR ${tel} LIKE ?` : ''}))`,
        params: [...Array(6).fill(like), ...(phone ? [`%${phone}%`] : [])],
      };
    },
    columns: [
      { key: 'entity_id', label: 'ID', sql: 'c.id', cls: 'num', filter: { type: 'range' } },
      { key: 'name', label: 'Name', sql: "trim(coalesce(c.prefix || ' ', '') || coalesce(c.firstname, '') || ' ' || coalesce(c.middlename || ' ', '') || coalesce(c.lastname, ''))", filter: { type: 'text' }, html: (x) => `<a href="${editUrl(x._id)}">${h(x.name)}</a>` },
      { key: 'email', label: 'Email', sql: 'c.email', filter: { type: 'text' } },
      { key: 'group_id', label: 'Group', sql: '(SELECT code FROM customer_groups g WHERE g.id = c.group_id)', sort: 'c.group_id', filter: { type: 'select', col: 'c.group_id', options: groups } },
      { key: 'billing_telephone', label: 'Phone', sql: bill('telephone'), filter: { type: 'text' } },
      { key: 'billing_postcode', label: 'ZIP', sql: bill('postcode'), filter: { type: 'text' } },
      { key: 'billing_country_id', label: 'Country', sql: `(SELECT name FROM countries WHERE id = ${bill('country_id')})`, filter: { type: 'select', col: bill('country_id'), options: countries } },
      { key: 'billing_region', label: 'State/Province', sql: bill('region'), filter: { type: 'text' } },
      { key: 'created_at', label: 'Customer Since', sql: 'c.created_at', filter: { type: 'daterange' }, html: (x) => h(U.date.datetime(x.created_at)) },
      { key: 'website_id', label: 'Web Site', sql: "'Main Website'", sort: false },
      { key: 'confirmation', label: 'Confirmed email', sql: "CASE WHEN c.confirmation IS NULL THEN 'Confirmation Not Required' ELSE 'Confirmation Required' END", sort: false },
      { key: 'created_in', label: 'Account Created in', sql: 'c.created_in', visible: false },
      { key: 'billing_full', label: 'Billing Address', sql: `(SELECT replace(a.street, char(10), ' ') || ' ' || coalesce(a.city, '') || ' ' || coalesce(a.region, '') || ' ' || coalesce(a.postcode, '') FROM customer_addresses a WHERE a.id = c.default_billing_id)`, visible: false, filter: { type: 'text' } },
      { key: 'shipping_full', label: 'Shipping Address', sql: `(SELECT replace(a.street, char(10), ' ') || ' ' || coalesce(a.city, '') || ' ' || coalesce(a.region, '') || ' ' || coalesce(a.postcode, '') FROM customer_addresses a WHERE a.id = c.default_shipping_id)`, visible: false, filter: { type: 'text' } },
      { key: 'dob', label: 'Date of Birth', sql: 'c.dob', visible: false, filter: { type: 'daterange', local: false }, html: (x) => h(x.dob ? U.date.medium(x.dob) : '') },
      { key: 'taxvat', label: 'Tax VAT Number', sql: 'c.taxvat', visible: false, filter: { type: 'text' } },
      { key: 'gender', label: 'Gender', sql: 'c.gender', visible: false, filter: { type: 'select', options: GENDER }, html: (x) => h((GENDER.find((g) => g[0] === x.gender) || [0, ''])[1]) },
      { key: 'billing_street', label: 'Street Address', sql: bill('street'), visible: false, filter: { type: 'text' } },
      { key: 'billing_city', label: 'City', sql: bill('city'), visible: false, filter: { type: 'text' } },
      { key: 'billing_company', label: 'Company', sql: bill('company'), visible: false, filter: { type: 'text' } },
      { key: 'lock_expires', label: 'Account Lock', sql: "CASE WHEN c.lock_expires IS NOT NULL AND c.lock_expires > now() THEN 'Locked' ELSE 'Unlocked' END", sort: false, visible: false },
      { key: 'last_login', label: 'Last Logged In', sql: '(SELECT last_login_at FROM customer_log l WHERE l.customer_id = c.id)', visible: false, html: (x) => h(U.date.datetime(x.last_login)) },
    ],
    rowActions: (x) => `<a href="${editUrl(x._id)}">Edit</a>`,
    massActions: [
      { value: 'delete', label: 'Delete', confirm: 'Are you sure you want to delete the selected customers?' },
      { value: 'subscribe', label: 'Subscribe to Newsletter' }, { value: 'unsubscribe', label: 'Unsubscribe from Newsletter' },
    ],
  };
  const gridPage = async (req, reply) => {
    const spec = { ...SPEC, massActions: [...SPEC.massActions, ...groups().map(([id, code]) => ({ value: `group_${id}`, label: `Assign a Customer Group: ${code}` }))] };
    return view(reply, 'grid_page', { title: 'Customers', g: grid.build(req, kit, spec), crumbs: [['Customers', null], ['All Customers', null]],
      actions: [{ label: 'Add New Customer', href: '/admin/customer/index/new/', primary: true, id: 'add' }] });
  };
  r.get('/customer/index', gridPage);
  r.get('/customer/index/index', gridPage);

  function deleteCustomers(ids) {
    for (const id of ids) {
      kit.sql('UPDATE orders SET customer_id = NULL WHERE customer_id = ?').run(id);
      kit.sql('UPDATE reviews SET customer_id = NULL WHERE customer_id = ?').run(id);
      kit.sql('DELETE FROM wishlist_items WHERE wishlist_id IN (SELECT id FROM wishlists WHERE customer_id = ?)').run(id);
      kit.sql('DELETE FROM wishlists WHERE customer_id = ?').run(id);
      kit.sql('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE customer_id = ?)').run(id);
      kit.sql('DELETE FROM carts WHERE customer_id = ?').run(id);
      kit.sql('DELETE FROM newsletter_subscribers WHERE customer_id = ?').run(id);
      kit.sql('DELETE FROM customer_addresses WHERE customer_id = ?').run(id);
      kit.sql('DELETE FROM customer_log WHERE customer_id = ?').run(id);
      kit.sql('DELETE FROM customers WHERE id = ?').run(id);
    }
  }
  function setNewsletter(c, subscribe) {
    const now = kit.nowSql();
    const cur = kit.sql('SELECT * FROM newsletter_subscribers WHERE customer_id = ? OR (customer_id IS NULL AND email = ? COLLATE NOCASE) ORDER BY customer_id IS NULL LIMIT 1').get(c.id, c.email);
    const status = subscribe ? 1 : 3;
    if (cur) { if (cur.status !== status || cur.customer_id !== c.id) kit.sql('UPDATE newsletter_subscribers SET status = ?, customer_id = ?, email = ?, change_status_at = ? WHERE id = ?').run(status, c.id, c.email, now, cur.id); }
    else if (subscribe) kit.sql('INSERT INTO newsletter_subscribers (customer_id, email, status, change_status_at) VALUES (?, ?, 1, ?)').run(c.id, c.email, now);
  }
  r.post('/customer/index/massAction', async (req, reply) => {
    const ids = grid.selectedIds(req, kit, SPEC);
    const act = U.str(req.body.mass_action);
    const back = ctx.back(req, '/admin/customer/index/');
    if (!ids.length) { req.flash('error', 'Please select item(s).'); return reply.redirect(back); }
    if (act === 'delete') { deleteCustomers(ids); req.flash('success', `A total of ${ids.length} record(s) were deleted.`); }
    else if (act === 'subscribe' || act === 'unsubscribe') {
      for (const id of ids) { const c = kit.sql('SELECT * FROM customers WHERE id = ?').get(id); if (c) setNewsletter(c, act === 'subscribe'); }
      req.flash('success', `A total of ${ids.length} record(s) were updated.`);
    } else if (/^group_\d+$/.test(act)) {
      const gid = +act.slice(6);
      if (!kit.sql('SELECT 1 FROM customer_groups WHERE id = ?').get(gid)) { req.flash('error', 'Please select a customer group.'); return reply.redirect(back); }
      for (const id of ids) kit.sql('UPDATE customers SET group_id = ?, updated_at = ? WHERE id = ?').run(gid, kit.nowSql(), id);
      req.flash('success', `A total of ${ids.length} record(s) were updated.`);
    } else req.flash('error', 'Please select an action.');
    return reply.redirect(back);
  });

  // ---------------------------------------------------------------- edit
  const load = (id) => { const c = kit.sql('SELECT * FROM customers WHERE id = ?').get(+id); if (!c) throw ctx.notFound('customer'); return c; };
  const ACCOUNT = () => [
    { name: 'customer[group_id]', label: 'Group', type: 'select', options: groups(), required: true },
    { name: 'customer[prefix]', label: 'Name Prefix' }, { name: 'customer[firstname]', label: 'First Name', required: true },
    { name: 'customer[middlename]', label: 'Middle Name/Initial' }, { name: 'customer[lastname]', label: 'Last Name', required: true },
    { name: 'customer[suffix]', label: 'Name Suffix' }, { name: 'customer[email]', label: 'Email', type: 'email', required: true },
    { name: 'customer[dob]', label: 'Date of Birth', type: 'date' }, { name: 'customer[taxvat]', label: 'Tax/VAT Number' },
    { name: 'customer[gender]', label: 'Gender', type: 'select', options: GENDER, empty: '' },
    { name: 'customer[is_active]', label: 'Account Status', type: 'select', options: [[1, 'Active'], [0, 'Inactive']] },
  ];
  const accountValues = (c) => Object.fromEntries(['group_id', 'prefix', 'firstname', 'middlename', 'lastname', 'suffix', 'email', 'dob', 'taxvat', 'gender', 'is_active'].map((k) => [`customer[${k}]`, k === 'dob' ? (c.dob || '').slice(0, 10) : c[k] ?? (k === 'is_active' ? 1 : '')]));
  function model(c, tab, { values, errors = {}, isNew = false, addrEdit = null } = {}) {
    const name = c ? [c.prefix, c.firstname, c.middlename, c.lastname, c.suffix].filter(Boolean).join(' ') : 'New Customer';
    const m = { title: name, c, tab, isNew, errors, values: { ...(c ? accountValues(c) : { 'customer[group_id]': 1, 'customer[is_active]': 1 }), ...(values || {}) }, accountFields: ACCOUNT(),
      tabs: isNew ? [['Account Information', '/admin/customer/index/new/', true]] : TABS.map(([k, l]) => [l, editUrl(c.id, k), k === tab]),
      crumbs: [['Customers', null], ['All Customers', '/admin/customer/index/'], [name, null]],
      actions: [{ label: 'Back', href: '/admin/customer/index/', id: 'back' }] };
    if (!isNew) {
      m.actions.push({ label: 'Delete Customer', post: `/admin/customer/index/delete/id/${c.id}/`, confirm: 'Are you sure you want to do this?', id: 'customer-edit-delete-button' });
      m.actions.push({ label: 'Create Order', href: `/admin/sales/order/?q=${encodeURIComponent(c.email)}`, id: 'order' });
      m.actions.push({ label: 'Reset Password', post: `/admin/customer/index/resetPassword/customer_id/${c.id}/`, id: 'resetPassword' });
    }
    if (tab === 'account' || isNew) m.actions.push({ label: 'Save and Continue Edit', form: 'customer_form', name: 'back', value: 'edit', id: 'save_and_continue' }, { label: 'Save Customer', form: 'customer_form', primary: true, id: 'save' });
    if (!c) return m;
    m.group = kit.sql('SELECT code FROM customer_groups WHERE id = ?').pluck().get(c.group_id) || '';
    m.addresses = kit.sql('SELECT a.*, (SELECT name FROM countries WHERE id = a.country_id) AS country FROM customer_addresses a WHERE a.customer_id = ? ORDER BY a.id').all(c.id);
    m.lastLogin = kit.sql('SELECT last_login_at FROM customer_log WHERE customer_id = ?').pluck().get(c.id);
    m.subscribed = kit.sql('SELECT status FROM newsletter_subscribers WHERE customer_id = ? ORDER BY id DESC LIMIT 1').pluck().get(c.id) === 1;
    if (tab === 'orders') m.orders = kit.sql(`SELECT o.id, o.increment_id, o.created_at, o.grand_total, o.status, (SELECT label FROM order_statuses s WHERE s.status = o.status) AS status_label,
        (SELECT trim(coalesce(a.firstname, '') || ' ' || coalesce(a.lastname, '')) FROM order_addresses a WHERE a.order_id = o.id AND a.address_type = 'billing') AS bill_to,
        (SELECT trim(coalesce(a.firstname, '') || ' ' || coalesce(a.lastname, '')) FROM order_addresses a WHERE a.order_id = o.id AND a.address_type = 'shipping') AS ship_to
      FROM orders o WHERE o.customer_id = ? ORDER BY o.created_at DESC, o.id DESC`).all(c.id);
    if (tab === 'reviews') m.reviews = kit.sql('SELECT r.id, r.created_at, r.status, r.title, r.nickname, r.detail, p.id AS product_id, p.name, p.sku FROM reviews r LEFT JOIN products p ON p.id = r.product_id WHERE r.customer_id = ? ORDER BY r.created_at DESC, r.id DESC').all(c.id);
    if (tab === 'wishlist') m.wishlist = kit.sql('SELECT i.*, p.name, p.sku, p.price FROM wishlist_items i JOIN wishlists w ON w.id = i.wishlist_id LEFT JOIN products p ON p.id = i.product_id WHERE w.customer_id = ? ORDER BY i.id').all(c.id);
    if (tab === 'cart') m.cart = kit.sql('SELECT i.* FROM cart_items i JOIN carts ct ON ct.id = i.cart_id WHERE ct.customer_id = ? AND ct.is_active = 1 AND i.parent_item_id IS NULL ORDER BY i.id').all(c.id);
    if (tab === 'customer_view') {
      m.stats = kit.sql("SELECT count(*) n, coalesce(sum(CASE WHEN state <> 'canceled' THEN grand_total END), 0) total FROM orders WHERE customer_id = ?").get(c.id);
      m.billing = m.addresses.find((a) => a.id === c.default_billing_id) || null;
    }
    if (tab === 'addresses') {
      const a = addrEdit || {};
      m.addrValues = { ...Object.fromEntries(['prefix', 'firstname', 'middlename', 'lastname', 'suffix', 'company', 'city', 'region', 'region_id', 'postcode', 'country_id', 'telephone', 'fax', 'vat_id'].map((k) => [`address[${k}]`, a[k] ?? ''])),
        'address[street][0]': String(a.street || '').split('\n')[0] || '', 'address[street][1]': String(a.street || '').split('\n')[1] || '',
        'address[default_billing]': a.id && a.id === c.default_billing_id ? 1 : 0, 'address[default_shipping]': a.id && a.id === c.default_shipping_id ? 1 : 0, ...(addrEdit && addrEdit._values || {}) };
      if (!m.addrValues['address[country_id]']) m.addrValues['address[country_id]'] = 'US';
      if (!a.id && !addrEdit) { m.addrValues['address[firstname]'] = c.firstname; m.addrValues['address[lastname]'] = c.lastname; }
      m.addrId = a.id || null;
      m.addrErrors = (addrEdit && addrEdit._errors) || {};
      m.countries = countries();
      m.regions = kit.sql("SELECT id, name FROM regions WHERE country_id = ? ORDER BY name").all(m.addrValues['address[country_id]'] || 'US').map((x) => [x.id, x.name]);
    }
    return m;
  }
  const segs = (rest) => { const a = String(rest || '').split('/').filter(Boolean); const o = {}; for (let i = 0; i + 1 < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };
  r.get('/customer/index/edit/id/:id', async (req, reply) => {
    const c = load(req.params.id);
    const p = segs(req.params['*']);
    const tab = TABS.some((t) => t[0] === p.active_tab) ? p.active_tab : TABS.some((t) => t[0] === req.query.tab) ? req.query.tab : 'customer_view';
    const addrEdit = tab === 'addresses' && req.query.address_id ? kit.sql('SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?').get(+req.query.address_id, c.id) : null;
    return view(reply, 'customer_edit', model(c, tab, { addrEdit }));
  });
  r.get('/customer/index/new', async (req, reply) => view(reply, 'customer_edit', model(null, 'account', { isNew: true })));

  function readAccount(b, c) {
    const v = {}; const set = {}; const errors = {};
    for (const f of ACCOUNT()) {
      const k = f.name.slice(9, -1);
      if (!U.has(b, f.name)) continue;
      v[f.name] = U.str(b[f.name]);
      set[k] = v[f.name] === '' ? null : v[f.name];
    }
    for (const k of ['firstname', 'lastname', 'email']) if (U.has(b, `customer[${k}]`) && !set[k]) errors[`customer[${k}]`] = 'This is a required field.';
    if (!c) for (const k of ['firstname', 'lastname', 'email']) if (!set[k]) errors[`customer[${k}]`] = 'This is a required field.';
    if (set.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(set.email)) errors['customer[email]'] = 'Please enter a valid email address (Ex: johndoe@domain.com).';
    if (set.email && kit.sql('SELECT 1 FROM customers WHERE email = ? COLLATE NOCASE AND id IS NOT ?').get(set.email, c ? c.id : null)) errors['customer[email]'] = 'A customer with the same email address already exists in an associated website.';
    if ('group_id' in set) { set.group_id = parseInt(set.group_id, 10); if (!kit.sql('SELECT 1 FROM customer_groups WHERE id = ?').get(set.group_id)) errors['customer[group_id]'] = 'Please select a customer group.'; }
    if (set.dob) { const d = U.parseDateInput(set.dob); if (!d) errors['customer[dob]'] = 'Please enter a valid date.'; else set.dob = d; }
    if ('gender' in set && set.gender != null) set.gender = parseInt(set.gender, 10) || null;
    if ('is_active' in set) set.is_active = set.is_active === '0' ? 0 : 1;
    return { v, set, errors };
  }
  const saveCustomer = async (req, reply) => {
    const b = req.body || {};
    const c = req.params.id ? load(req.params.id) : null;
    const { v, set, errors } = readAccount(b, c);
    if (Object.keys(errors).length) {
      const m = model(c, 'account', { values: v, errors, isNew: !c });
      m.errorsList = ['Please correct the highlighted fields.'];
      return view(reply, 'customer_edit', m, 422);
    }
    const now = kit.nowSql();
    let id;
    if (c) {
      const cols = Object.keys(set);
      if (cols.length) kit.db().prepare(`UPDATE customers SET ${cols.map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...set, now, id: c.id });
      id = c.id;
    } else {
      const row = { group_id: 1, is_active: 1, ...set, created_at: now, updated_at: now, created_in: 'Admin', source: 'admin', failures_num: 0 };
      const cols = Object.keys(row);
      id = Number(kit.db().prepare(`INSERT INTO customers (${cols.join(', ')}) VALUES (${cols.map((k) => '@' + k).join(', ')})`).run(row).lastInsertRowid);
    }
    if (U.has(b, 'subscription')) setNewsletter(kit.sql('SELECT * FROM customers WHERE id = ?').get(id), U.str(b.subscription) === '1');
    req.flash('success', 'You saved the customer.');
    if (U.str(b.back) === 'edit' || !c) return reply.redirect(editUrl(id, 'account'));
    return reply.redirect(U.has(b, 'subscription') && !U.has(b, 'customer[email]') ? editUrl(id, 'newsletter') : '/admin/customer/index/');
  };
  r.post('/customer/index/save/id/:id', saveCustomer);
  r.post('/customer/index/save', saveCustomer);
  r.post('/customer/index/delete/id/:id', async (req, reply) => {
    const c = load(req.params.id);
    deleteCustomers([c.id]);
    req.flash('success', 'You deleted the customer.');
    return reply.redirect('/admin/customer/index/');
  });
  r.post('/customer/index/resetPassword/customer_id/:id', async (req, reply) => {
    const c = load(req.params.id);
    req.flash('success', `The customer will receive an email with a link to reset password (${c.email}).`);
    return reply.redirect(editUrl(c.id));
  });

  // ---------------------------------------------------------------- addresses
  r.post('/customer/address/save/parent_id/:id', async (req, reply) => {
    const c = load(req.params.id);
    const b = req.body || {};
    const aid = parseInt(U.str(b.address_id), 10) || null;
    const cur = aid ? kit.sql('SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?').get(aid, c.id) : null;
    if (aid && !cur) throw ctx.notFound('address');
    const g = (k) => U.str(b[`address[${k}]`]);
    const v = Object.fromEntries(['prefix', 'firstname', 'middlename', 'lastname', 'suffix', 'company', 'city', 'postcode', 'country_id', 'telephone', 'fax', 'vat_id'].map((k) => [k, g(k) || null]));
    const street = [g('street][0'), g('street][1'), g('street][2')].filter(Boolean);
    const errors = {};
    for (const k of ['firstname', 'lastname', 'city', 'postcode', 'country_id', 'telephone']) if (!v[k]) errors[`address[${k}]`] = 'This is a required field.';
    if (!street.length) errors['address[street][0]'] = 'This is a required field.';
    let regionId = null; let region = g('region') || null;
    const hasRegions = v.country_id && kit.sql('SELECT 1 FROM regions WHERE country_id = ? LIMIT 1').get(v.country_id);
    if (hasRegions) {
      const row = kit.sql('SELECT id, name FROM regions WHERE id = ? AND country_id = ?').get(parseInt(g('region_id'), 10) || 0, v.country_id)
        || (region ? kit.sql('SELECT id, name FROM regions WHERE country_id = ? AND (name = ? COLLATE NOCASE OR code = ? COLLATE NOCASE)').get(v.country_id, region, region) : null);
      if (!row) errors['address[region_id]'] = 'Please select a region, state or province.'; else { regionId = row.id; region = row.name; }
    }
    if (Object.keys(errors).length) {
      const vals = {}; for (const [k, x] of Object.entries(b)) if (k.startsWith('address[')) vals[k] = U.str(x);
      const m = model(c, 'addresses', { addrEdit: { ...(cur || {}), _values: vals, _errors: errors } });
      m.errorsList = ['The address could not be saved. Please correct the highlighted fields.'];
      return view(reply, 'customer_edit', m, 422);
    }
    const now = kit.nowSql();
    const row = { ...v, street: street.join('\n'), region, region_id: regionId };
    let id = aid;
    if (cur) kit.db().prepare(`UPDATE customer_addresses SET ${Object.keys(row).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...row, now, id: aid });
    else id = Number(kit.db().prepare(`INSERT INTO customer_addresses (customer_id, ${Object.keys(row).join(', ')}, is_active, created_at, updated_at) VALUES (@customer_id, ${Object.keys(row).map((k) => '@' + k).join(', ')}, 1, @now, @now)`).run({ ...row, customer_id: c.id, now }).lastInsertRowid);
    const first = !c.default_billing_id && !c.default_shipping_id;
    if (U.str(b['address[default_billing]']) === '1' || (first && !cur)) kit.sql('UPDATE customers SET default_billing_id = ?, updated_at = ? WHERE id = ?').run(id, now, c.id);
    if (U.str(b['address[default_shipping]']) === '1' || (first && !cur)) kit.sql('UPDATE customers SET default_shipping_id = ?, updated_at = ? WHERE id = ?').run(id, now, c.id);
    req.flash('success', 'You saved the address.');
    return reply.redirect(editUrl(c.id, 'addresses'));
  });
  r.post('/customer/address/delete/id/:id', async (req, reply) => {
    const a = kit.sql('SELECT * FROM customer_addresses WHERE id = ?').get(+req.params.id);
    if (!a) throw ctx.notFound('address');
    kit.sql('DELETE FROM customer_addresses WHERE id = ?').run(a.id);
    kit.sql('UPDATE customers SET default_billing_id = CASE WHEN default_billing_id = ?1 THEN NULL ELSE default_billing_id END, default_shipping_id = CASE WHEN default_shipping_id = ?1 THEN NULL ELSE default_shipping_id END WHERE id = ?2'.replace(/\?1/g, '?').replace('?2', '?')).run(a.id, a.id, a.customer_id);
    req.flash('success', 'You deleted the address.');
    return reply.redirect(editUrl(a.customer_id, 'addresses'));
  });
  r.post('/customer/address/default/id/:id/type/:type', async (req, reply) => {
    const a = kit.sql('SELECT * FROM customer_addresses WHERE id = ?').get(+req.params.id);
    if (!a) throw ctx.notFound('address');
    const col = req.params.type === 'shipping' ? 'default_shipping_id' : 'default_billing_id';
    kit.sql(`UPDATE customers SET ${col} = ?, updated_at = ? WHERE id = ?`).run(a.id, kit.nowSql(), a.customer_id);
    req.flash('success', 'You saved the address.');
    return reply.redirect(editUrl(a.customer_id, 'addresses'));
  });

  // ---------------------------------------------------------------- customer groups
  const GROUPS = {
    id: 'customer_group_listing', url: '/admin/customer/group/', idCol: 'g.id', from: 'customer_groups g', defaultSort: 'id_asc',
    keyword: (q) => ({ where: "g.code LIKE ? ESCAPE '\\'", params: [`%${q.replace(/[\\%_]/g, '\\$&')}%`] }),
    columns: [
      { key: 'id', label: 'ID', sql: 'g.id', cls: 'num', filter: { type: 'range' } },
      { key: 'code', label: 'Group', sql: 'g.code', filter: { type: 'text' }, html: (x) => `<a href="/admin/customer/group/edit/id/${x._id}/">${h(x.code)}</a>` },
      { key: 'tax_class', label: 'Tax Class', sql: '(SELECT name FROM tax_classes t WHERE t.id = g.tax_class_id)', sort: 'g.tax_class_id' },
    ],
    rowActions: (x) => `<a href="/admin/customer/group/edit/id/${x._id}/">Edit</a>`,
  };
  r.get('/customer/group', async (req, reply) => view(reply, 'grid_page', { title: 'Customer Groups', g: grid.build(req, kit, GROUPS), crumbs: [['Customers', null], ['Customer Groups', null]], actions: [{ label: 'Add New Customer Group', href: '/admin/customer/group/new/', primary: true, id: 'add' }] }));
  const taxClasses = () => kit.sql("SELECT id, name FROM tax_classes WHERE type = 'CUSTOMER' ORDER BY id").all().map((t) => [t.id, t.name]);
  const groupForm = (g, values = {}, errors = {}) => ({
    title: g ? g.code : 'New Customer Group', action: g ? `/admin/customer/group/save/id/${g.id}/` : '/admin/customer/group/save/', values: { code: g ? g.code : '', tax_class_id: g ? g.tax_class_id : 3, ...values }, errors,
    crumbs: [['Customers', null], ['Customer Groups', '/admin/customer/group/'], [g ? g.code : 'New Customer Group', null]],
    actions: [{ label: 'Back', href: '/admin/customer/group/' }, ...(g && g.id > 1 ? [{ label: 'Delete Customer Group', post: `/admin/customer/group/delete/id/${g.id}/`, confirm: 'Are you sure you want to delete a customer group?', id: 'delete' }] : []), { label: 'Save Customer Group', form: 'edit_form', primary: true, id: 'save' }],
    sections: [{ title: 'Group Information', fields: [{ name: 'code', label: 'Group Name', required: true, note: 'Maximum length must be less then 32 characters.', disabled: g && g.id === 0 }, { name: 'tax_class_id', label: 'Tax Class', type: 'select', options: taxClasses(), required: true }] }],
  });
  const loadGroup = (id) => { const g = kit.sql('SELECT * FROM customer_groups WHERE id = ?').get(+id); if (!g) throw ctx.notFound('customer group'); return g; };
  r.get('/customer/group/new', async (req, reply) => view(reply, 'form_page', groupForm(null)));
  r.get('/customer/group/edit/id/:id', async (req, reply) => view(reply, 'form_page', groupForm(loadGroup(req.params.id))));
  const saveGroup = async (req, reply) => {
    const g = req.params.id != null ? loadGroup(req.params.id) : null;
    const code = U.str(req.body.code) || (g && g.id === 0 ? g.code : '');
    const tax = parseInt(U.str(req.body.tax_class_id), 10) || 3;
    const errors = {};
    if (!code) errors.code = 'This is a required field.';
    else if (code.length >= 32) errors.code = 'Maximum length must be less then 32 characters.';
    else if (kit.sql('SELECT 1 FROM customer_groups WHERE code = ? COLLATE NOCASE AND id IS NOT ?').get(code, g ? g.id : null)) errors.code = 'Customer Group already exists.';
    if (Object.keys(errors).length) return view(reply, 'form_page', groupForm(g, { code, tax_class_id: tax }, errors), 422);
    if (g) kit.sql('UPDATE customer_groups SET code = ?, tax_class_id = ? WHERE id = ?').run(code, tax, g.id);
    else kit.sql('INSERT INTO customer_groups (code, tax_class_id) VALUES (?, ?)').run(code, tax);
    req.flash('success', 'You saved the customer group.');
    return reply.redirect('/admin/customer/group/');
  };
  r.post('/customer/group/save/id/:id', saveGroup);
  r.post('/customer/group/save', saveGroup);
  r.post('/customer/group/delete/id/:id', async (req, reply) => {
    const g = loadGroup(req.params.id);
    if (g.id <= 1) { req.flash('error', 'You can\'t delete a default customer group.'); return reply.redirect('/admin/customer/group/'); }
    kit.sql('UPDATE customers SET group_id = 1 WHERE group_id = ?').run(g.id);
    kit.sql('DELETE FROM customer_groups WHERE id = ?').run(g.id);
    req.flash('success', 'You deleted the customer group.');
    return reply.redirect('/admin/customer/group/');
  });
};
