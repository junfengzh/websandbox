'use strict';
// Customer account: login / logout / register, dashboard, account information,
// address book, newsletter subscriptions, forgot password.
const S = require('../../shared');
const cart = require('../lib/cart');

const field = (b, ...names) => { for (const n of names) if (b[n] != null && b[n] !== '') return String(b[n]); return ''; };
// Magento form names: login[username] -> body['login[username]'] (formbody keeps the literal key)
const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/admin') ? n : null);

module.exports = async function customerRoutes(app, kit) {
  const db = () => kit.db();
  const LOGIN = { login: true };

  // ---------------------------------------------------------------- login / logout
  const loginPage = async (req, reply) => {
    if (req.user) return reply.redirect('/customer/account/');
    return reply.render('customer/login', { title: 'Customer Login', next: safeNext(req.query.next) || '', values: {}, crumbs: null });
  };
  app.get('/customer/account/login', loginPage);
  app.get('/customer/account/login/referer/*', loginPage);
  app.post('/customer/account/loginPost', async (req, reply) => {
    const b = req.body || {};
    const email = field(b, 'login[username]', 'email', 'login');
    const pw = field(b, 'login[password]', 'password');
    const next = safeNext(b.next);
    if (!email || !pw) { req.flash('error', 'A login and a password are required.'); return reply.redirect('/customer/account/login/'); }
    const user = await req.authenticate(email, pw);
    if (!user || user.kind !== 'customer' || user.is_active === 0) {
      return reply.render('customer/login', { title: 'Customer Login', next: next || '', values: { email }, error: 'The account sign-in was incorrect or your account is disabled temporarily. Please wait and try again later.' }, 200);
    }
    const guestCart = req.session.get('cart_id');
    await req.login(user);
    cart.mergeGuestCart(req, guestCart);
    db().prepare('INSERT INTO customer_log (customer_id, last_login_at) VALUES (?, ?) ON CONFLICT(customer_id) DO UPDATE SET last_login_at = excluded.last_login_at').run(user.id, kit.nowSql());
    return reply.redirect(next || '/customer/account/');
  });
  // also accept a POST to the login URL itself
  app.post('/customer/account/login', async (req, reply) => reply.code(307).redirect('/customer/account/loginPost/'));
  const logout = async (req, reply) => {
    if (req.user) db().prepare('INSERT INTO customer_log (customer_id, last_logout_at) VALUES (?, ?) ON CONFLICT(customer_id) DO UPDATE SET last_logout_at = excluded.last_logout_at').run(req.user.id, kit.nowSql());
    req.logout();
    return reply.redirect('/customer/account/logoutSuccess/');
  };
  app.get('/customer/account/logout', { config: { csrf: false } }, logout);
  app.post('/customer/account/logout', logout);
  app.get('/customer/account/logoutSuccess', async (req, reply) => reply.render('message', { title: 'You are signed out', message: 'You have signed out and will go to our homepage in 5 seconds.', link: ['/', 'Continue to the homepage'] }));

  // ---------------------------------------------------------------- register
  app.get('/customer/account/create', async (req, reply) => {
    if (req.user) return reply.redirect('/customer/account/');
    return reply.render('customer/create', { title: 'Create New Customer Account', values: {}, errors: {} });
  });
  app.post('/customer/account/createpost', async (req, reply) => {
    const b = req.body || {};
    const v = kit.validate(b, {
      firstname: { required: true, maxLength: 255, label: 'First Name' },
      lastname: { required: true, maxLength: 255, label: 'Last Name' },
      email: { required: true, type: 'email', label: 'Email' },
      password: { required: true, minLength: 8, label: 'Password' },
      password_confirmation: { required: true, label: 'Confirm Password', check: (x, vals) => (x !== vals.password ? 'Please enter the same value again.' : null) },
    });
    if (v.ok && !/(?=.*[a-z])(?=.*[A-Z0-9\W])/.test(v.values.password)) v.errors.password = 'Minimum of different classes of characters in password is 3. Classes of characters: Lower Case, Upper Case, Digits, Special Characters.';
    if (v.ok && db().prepare('SELECT 1 FROM customers WHERE email = ? COLLATE NOCASE').get(v.values.email)) v.errors.email = 'There is already an account with this email address. If you are sure that it is your email address, click here to get your password and access your account.';
    if (Object.keys(v.errors).length) return reply.render('customer/create', { title: 'Create New Customer Account', values: { ...b, password: '', password_confirmation: '' }, errors: v.errors }, 422);
    const now = kit.nowSql();
    const hash = await kit.auth.hashPassword(v.values.password);
    const r = db().prepare("INSERT INTO customers (email, firstname, lastname, group_id, is_active, password_hash, created_at, updated_at, created_in, gender, source) VALUES (?, ?, ?, 1, 1, ?, ?, ?, 'Default Store View', 0, 'live')")
      .run(v.values.email, v.values.firstname, v.values.lastname, hash, now, now);
    const id = Number(r.lastInsertRowid);
    if (b.is_subscribed) subscribe(db(), id, v.values.email, now);
    const user = S.customerById(db(), id);
    const guestCart = req.session.get('cart_id');
    await req.login(user);
    cart.mergeGuestCart(req, guestCart);
    req.flash('success', 'Thank you for registering with One Stop Market.');
    return reply.redirect('/customer/account/');
  });

  app.get('/customer/account/forgotpassword', async (req, reply) => reply.render('customer/forgot', { title: 'Forgot Your Password?' }));
  app.post('/customer/account/forgotpasswordpost', async (req, reply) => {
    const email = field(req.body || {}, 'email');
    req.flash('success', `If there is an account associated with ${email} you will receive an email with a link to reset your password.`);
    return reply.redirect('/customer/account/login/');
  });

  // ---------------------------------------------------------------- dashboard
  const dashboard = async (req, reply) => {
    const u = req.user;
    const addr = addresses(db(), u);
    const news = newsletterStatus(db(), u.id);
    const recent = db().prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 5').all(u.id);
    for (const o of recent) { o.ship_to = shipTo(db(), o.id); o.status_label = S.orderStatusLabel(db(), o.status); }
    const reviews = db().prepare(`SELECT r.*, p.name AS product_name, p.url_key FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.customer_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 3`).all(u.id);
    return reply.render('customer/dashboard', { title: 'My Account', u, billing: addr.billing, shipping: addr.shipping, news, recent, reviews, nav: 'account' });
  };
  app.get('/customer/account', { config: LOGIN }, dashboard);
  app.get('/customer/account/index', { config: LOGIN }, dashboard);

  // ---------------------------------------------------------------- account information
  app.get('/customer/account/edit', { config: LOGIN }, async (req, reply) =>
    reply.render('customer/edit', { title: 'Edit Account Information', values: { ...req.user, change_email: req.query.changeemail ? 1 : 0, change_password: req.query.changepass ? 1 : 0 }, errors: {}, nav: 'edit' }));
  app.post('/customer/account/editPost', { config: LOGIN }, async (req, reply) => {
    const b = req.body || {};
    const u = req.user;
    const changeEmail = !!b.change_email; const changePass = !!b.change_password;
    const v = kit.validate(b, {
      firstname: { required: true, maxLength: 255, label: 'First Name' },
      lastname: { required: true, maxLength: 255, label: 'Last Name' },
      email: { required: changeEmail, type: 'email', label: 'Email' },
    });
    const errors = { ...v.errors };
    if (changeEmail || changePass) {
      if (!b.current_password || !(await kit.auth.verifyPassword(String(b.current_password), u.password_hash))) errors.current_password = "The password doesn't match this account. Verify the password and try again.";
    }
    if (changeEmail && !errors.email && db().prepare('SELECT 1 FROM customers WHERE email = ? COLLATE NOCASE AND id != ?').get(b.email, u.id)) errors.email = 'A customer with the same email address already exists in an associated website.';
    if (changePass) {
      if (!b.password || String(b.password).length < 8) errors.password = 'The password needs at least 8 characters. Create a new password and try again.';
      else if (b.password !== b.password_confirmation) errors.password_confirmation = 'Please enter the same value again.';
    }
    if (Object.keys(errors).length) return reply.render('customer/edit', { title: 'Edit Account Information', values: { ...u, ...b, change_email: changeEmail ? 1 : 0, change_password: changePass ? 1 : 0 }, errors, nav: 'edit' }, 422);
    const now = kit.nowSql();
    db().prepare('UPDATE customers SET firstname = ?, lastname = ?, updated_at = ? WHERE id = ?').run(v.values.firstname, v.values.lastname, now, u.id);
    if (b.middlename != null) db().prepare('UPDATE customers SET middlename = ? WHERE id = ?').run(String(b.middlename) || null, u.id);
    if (changeEmail) {
      db().prepare('UPDATE customers SET email = ? WHERE id = ?').run(v.values.email, u.id);
      db().prepare('UPDATE newsletter_subscribers SET email = ? WHERE customer_id = ?').run(v.values.email, u.id);
    }
    if (changePass) db().prepare('UPDATE customers SET password_hash = ? WHERE id = ?').run(await kit.auth.hashPassword(String(b.password)), u.id);
    req.flash('success', 'You saved the account information.');
    return reply.redirect('/customer/account/');
  });

  // ---------------------------------------------------------------- address book
  app.get('/customer/address', { config: LOGIN }, async (req, reply) => {
    const all = db().prepare('SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY id').all(req.user.id);
    const { billing, shipping } = addresses(db(), req.user);
    const extra = all.filter((a) => a.id !== req.user.default_billing_id && a.id !== req.user.default_shipping_id);
    return reply.render('customer/addresses', { title: 'Address Book', billing, shipping, extra, fmtAddr: (a) => formatAddress(db(), a), nav: 'address' });
  });
  app.get('/customer/address/index', { config: LOGIN }, async (req, reply) => reply.redirect('/customer/address/'));
  const addrForm = (req, reply, a, errors = {}, status) => {
    const countries = db().prepare("SELECT id, name FROM countries WHERE coalesce(name, '') <> '' ORDER BY name").all();
    const regions = db().prepare('SELECT id, country_id, code, name FROM regions ORDER BY country_id, name').all();
    return reply.render('customer/address_form', { title: a && a.id ? 'Edit Address' : 'Add New Address', a: a || { country_id: 'US', firstname: req.user.firstname, lastname: req.user.lastname }, countries, regions, errors, nav: 'address',
      isDefaultBilling: a && a.id && a.id === req.user.default_billing_id, isDefaultShipping: a && a.id && a.id === req.user.default_shipping_id }, status);
  };
  app.get('/customer/address/new', { config: LOGIN }, async (req, reply) => addrForm(req, reply, null));
  app.get('/customer/address/edit/id/:id', { config: LOGIN }, async (req, reply) => {
    const a = db().prepare('SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?').get(+req.params.id, req.user.id);
    if (!a) { req.flash('error', 'We can\'t find the address.'); return reply.redirect('/customer/address/'); }
    return addrForm(req, reply, a);
  });
  app.get('/customer/address/edit', { config: LOGIN }, async (req, reply) => (req.query.id ? reply.redirect(`/customer/address/edit/id/${+req.query.id}/`) : reply.redirect('/customer/address/new/')));
  const saveAddress = async (req, reply) => {
    const b = req.body || {};
    const id = +(req.params.id || b.id || 0) || null;
    const parsed = parseAddress(db(), b);
    if (Object.keys(parsed.errors).length) return addrForm(req, reply, { ...parsed.values, id }, parsed.errors, 422);
    const a = parsed.values;
    const now = kit.nowSql();
    let aid = id;
    if (id) {
      const own = db().prepare('SELECT id FROM customer_addresses WHERE id = ? AND customer_id = ?').get(id, req.user.id);
      if (!own) throw kit.httpError(404, 'Address not found');
      db().prepare('UPDATE customer_addresses SET firstname = ?, middlename = ?, lastname = ?, company = ?, street = ?, city = ?, region = ?, region_id = ?, postcode = ?, country_id = ?, telephone = ?, fax = ?, vat_id = ?, updated_at = ? WHERE id = ?')
        .run(a.firstname, a.middlename, a.lastname, a.company, a.street, a.city, a.region, a.region_id, a.postcode, a.country_id, a.telephone, a.fax, a.vat_id, now, id);
    } else {
      aid = Number(db().prepare('INSERT INTO customer_addresses (customer_id, firstname, middlename, lastname, company, street, city, region, region_id, postcode, country_id, telephone, fax, vat_id, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .run(req.user.id, a.firstname, a.middlename, a.lastname, a.company, a.street, a.city, a.region, a.region_id, a.postcode, a.country_id, a.telephone, a.fax, a.vat_id, now, now).lastInsertRowid);
    }
    const u = req.user;
    const first = !u.default_billing_id && !u.default_shipping_id;
    if (b.default_billing || first || !u.default_billing_id) db().prepare('UPDATE customers SET default_billing_id = ?, updated_at = ? WHERE id = ?').run(aid, now, u.id);
    if (b.default_shipping || first || !u.default_shipping_id) db().prepare('UPDATE customers SET default_shipping_id = ?, updated_at = ? WHERE id = ?').run(aid, now, u.id);
    req.flash('success', 'You saved the address.');
    return reply.redirect('/customer/address/');
  };
  app.post('/customer/address/formPost', { config: LOGIN }, saveAddress);
  app.post('/customer/address/formPost/id/:id', { config: LOGIN }, saveAddress);
  app.post('/customer/address/delete/id/:id', { config: LOGIN }, async (req, reply) => {
    const id = +req.params.id;
    const u = req.user;
    if (id === u.default_billing_id || id === u.default_shipping_id) { req.flash('error', 'We can\'t delete the default address.'); return reply.redirect('/customer/address/'); }
    const r = db().prepare('DELETE FROM customer_addresses WHERE id = ? AND customer_id = ?').run(id, u.id);
    req.flash(r.changes ? 'success' : 'error', r.changes ? 'You deleted the address.' : 'We can\'t delete the address right now.');
    return reply.redirect('/customer/address/');
  });

  // ---------------------------------------------------------------- newsletter
  app.get('/newsletter/manage', { config: LOGIN }, async (req, reply) =>
    reply.render('customer/newsletter', { title: 'Newsletter Subscription', subscribed: newsletterStatus(db(), req.user.id) === 1, nav: 'newsletter' }));
  app.get('/newsletter/manage/index', { config: LOGIN }, async (req, reply) => reply.redirect('/newsletter/manage/'));
  app.post('/newsletter/manage/save', { config: LOGIN }, async (req, reply) => {
    const on = !!(req.body && req.body.is_subscribed);
    const now = kit.nowSql();
    const cur = newsletterStatus(db(), req.user.id);
    if (on) { subscribe(db(), req.user.id, req.user.email, now); req.flash('success', cur === 1 ? 'We have updated your subscription.' : 'We have saved your subscription.'); }
    else if (cur === 1) { db().prepare('UPDATE newsletter_subscribers SET status = 3, change_status_at = ? WHERE customer_id = ?').run(now, req.user.id); req.flash('success', 'We have removed your newsletter subscription.'); }
    else req.flash('success', 'We have updated your subscription.');
    return reply.redirect('/customer/account/');
  });
  // footer form (guests and customers)
  app.post('/newsletter/subscriber/new', async (req, reply) => {
    const email = field(req.body || {}, 'email').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { req.flash('error', 'Please enter a valid email address.'); return reply.redirect(require('./catalog').safeBack(req, '/')); }
    const now = kit.nowSql();
    const cust = db().prepare('SELECT id FROM customers WHERE email = ? COLLATE NOCASE').get(email);
    const ex = db().prepare('SELECT * FROM newsletter_subscribers WHERE email = ? COLLATE NOCASE').get(email);
    if (ex && ex.status === 1) req.flash('error', 'This email address is already subscribed.');
    else {
      if (cust && req.user && req.user.id === cust.id) subscribe(db(), cust.id, email, now);
      else if (ex) db().prepare('UPDATE newsletter_subscribers SET status = 1, change_status_at = ? WHERE id = ?').run(now, ex.id);
      else db().prepare('INSERT INTO newsletter_subscribers (customer_id, email, status, change_status_at) VALUES (?, ?, 1, ?)').run(cust && req.user && req.user.id === cust.id ? cust.id : 0, email, now);
      req.flash('success', 'Thank you for your subscription.');
    }
    return reply.redirect(require('./catalog').safeBack(req, '/'));
  });

  // ---------------------------------------------------------------- empty sections of My Account
  app.get('/downloadable/customer/products', { config: LOGIN }, async (req, reply) => reply.render('customer/empty', { title: 'My Downloadable Products', message: 'You have not purchased any downloadable products yet.', nav: 'downloadable' }));
  app.get('/vault/cards/listaction', { config: LOGIN }, async (req, reply) => reply.render('customer/empty', { title: 'Stored Payment Methods', message: 'You have no stored payment methods.', nav: 'vault' }));
};

// ---------------------------------------------------------------- helpers (also used by checkout)
function subscribe(db, customerId, email, now) {
  const ex = db.prepare('SELECT id FROM newsletter_subscribers WHERE customer_id = ?').get(customerId) || db.prepare('SELECT id FROM newsletter_subscribers WHERE email = ? COLLATE NOCASE').get(email);
  if (ex) db.prepare('UPDATE newsletter_subscribers SET status = 1, customer_id = ?, email = ?, change_status_at = ? WHERE id = ?').run(customerId, email, now, ex.id);
  else db.prepare('INSERT INTO newsletter_subscribers (customer_id, email, status, change_status_at) VALUES (?, ?, 1, ?)').run(customerId, email, now);
}
function newsletterStatus(db, customerId) {
  return db.prepare('SELECT status FROM newsletter_subscribers WHERE customer_id = ? ORDER BY id DESC LIMIT 1').pluck().get(customerId) || 0;
}
function addresses(db, u) {
  const get = (id) => (id ? db.prepare('SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?').get(id, u.id) : null);
  return { billing: get(u.default_billing_id), shipping: get(u.default_shipping_id) };
}
function regionName(db, a) {
  if (a.region) return a.region;
  return a.region_id ? db.prepare('SELECT name FROM regions WHERE id = ?').pluck().get(a.region_id) : '';
}
// Magento address block: name / company / street lines / "City, Region, Postcode" / country / T: phone
function formatAddress(db, a) {
  if (!a) return [];
  const country = a.country_id ? db.prepare('SELECT name FROM countries WHERE id = ?').pluck().get(a.country_id) || a.country_id : '';
  const lines = [[a.prefix, a.firstname, a.middlename, a.lastname, a.suffix].filter(Boolean).join(' ')];
  if (a.company) lines.push(a.company);
  for (const s of String(a.street || '').split('\n')) if (s.trim()) lines.push(s.trim());
  lines.push([a.city, regionName(db, a), a.postcode].filter(Boolean).join(', '));
  if (country) lines.push(country);
  if (a.telephone) lines.push(`T: ${a.telephone}`);
  return lines;
}
function shipTo(db, orderId) {
  const a = db.prepare("SELECT firstname, lastname FROM order_addresses WHERE order_id = ? AND address_type = 'shipping'").get(orderId);
  return a ? `${a.firstname || ''} ${a.lastname || ''}`.trim() : '';
}
// Address form fields (Magento names: street[] lines, region_id or region text).
function parseAddress(db, b) {
  const street = [].concat(b['street[]'] ?? b.street ?? []).concat([b['street[0]'], b['street[1]'], b['street[2]']].filter((x) => x != null)).map((s) => String(s).trim()).filter(Boolean);
  const values = {
    firstname: field(b, 'firstname').trim(), middlename: field(b, 'middlename').trim() || null, lastname: field(b, 'lastname').trim(), company: field(b, 'company').trim() || null,
    street: street.join('\n'), city: field(b, 'city').trim(), postcode: field(b, 'postcode').trim(), country_id: field(b, 'country_id') || 'US',
    telephone: field(b, 'telephone').trim(), fax: field(b, 'fax').trim() || null, vat_id: field(b, 'vat_id').trim() || null, region_id: null, region: null,
  };
  const rid = +field(b, 'region_id') || null;
  if (rid) {
    const r = db.prepare('SELECT * FROM regions WHERE id = ?').get(rid);
    if (r) { values.region_id = r.id; values.region = r.name; }
  } else if (field(b, 'region')) {
    const txt = field(b, 'region').trim();
    const r = db.prepare('SELECT * FROM regions WHERE country_id = ? AND (lower(name) = lower(?) OR lower(code) = lower(?))').get(values.country_id, txt, txt);
    if (r) { values.region_id = r.id; values.region = r.name; } else values.region = txt;
  }
  const errors = {};
  for (const [k, label] of [['firstname', 'First Name'], ['lastname', 'Last Name'], ['city', 'City'], ['telephone', 'Phone Number'], ['postcode', 'Zip/Postal Code']]) if (!values[k]) errors[k] = `"${label}" is a required value.`;
  if (!values.street) errors.street = '"Street Address" is a required value.';
  const needRegion = String(db.prepare("SELECT value FROM store_config WHERE path = 'general/region/state_required'").pluck().get() || '').split(',').includes(values.country_id);
  if (needRegion && !values.region) errors.region_id = '"State/Province" is a required value.';
  return { values, errors };
}

module.exports.helpers = { subscribe, newsletterStatus, addresses, formatAddress, regionName, shipTo, parseAddress };
