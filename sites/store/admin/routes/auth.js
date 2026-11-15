'use strict';
// Sign in / out, account settings, menu section pages, global search, notifications.
module.exports = (r, { kit, U, view, menu }) => {
  const safeNext = (n) => (typeof n === 'string' && /^\/admin(\/|$)/.test(n) && !n.startsWith('//') && !/\/auth\/(login|logout)/.test(n) ? n : '/admin/dashboard/');
  const loginPage = async (req, reply) => {
    if (req.user) return reply.redirect(safeNext(req.query.next));
    // Magento shows the sign-in form on any admin URL; keep where the user wanted to go
    const next = req.query.next || (req.url.startsWith('/admin/admin/auth') ? '' : req.url);
    return view(reply, 'login', { title: 'Magento Admin', next });
  };
  r.get('/', loginPage, { public: true });
  r.get('/admin', loginPage, { public: true });
  r.get('/admin/index/index', loginPage, { public: true });
  r.get('/admin/auth/login', loginPage, { public: true });
  r.post('/admin/auth/login', async (req, reply) => {
    const b = req.body || {};
    const username = U.str(b['login[username]'] ?? b.username ?? b.login);
    const password = U.str(b['login[password]'] ?? b.password);
    const user = username && password ? await req.authenticate(username, password) : null;
    if (!user || user.kind === 'customer') {
      return view(reply, 'login', { title: 'Magento Admin', next: b.next || '', username, error: 'The account sign-in was incorrect or your account is disabled temporarily. Please wait and try again later.' }, 200);
    }
    await req.login(user);
    kit.sql('UPDATE admin_users SET logdate = ?, lognum = coalesce(lognum, 0) + 1 WHERE id = ?').run(kit.nowSql(), user.id);
    return reply.redirect(safeNext(b.next));
  }, { public: true });
  const logout = async (req, reply) => {
    req.logout();
    req.flash('success', 'You have logged out.');
    return reply.redirect('/admin/admin/auth/login/');
  };
  r.post('/admin/auth/logout', logout, { public: true });
  r.get('/admin/auth/logout', logout, { public: true, csrf: false });
  r.get('/admin/auth/forgotpassword', async (req, reply) => view(reply, 'message_page', { title: 'Password Help',
    html: '<section class="login-box"><h1>Password Help</h1><p>Password reset e-mails are not available in this store. Ask an administrator (System &gt; Permissions &gt; All Users) to set a new password.</p><p><a href="/admin/admin/auth/login/">Back to Sign in</a></p></section>' }), { public: true });

  // ---- sidebar section pages (no-JS fallback of the flyout menus)
  r.get('/admin/menu/:id', async (req, reply) => {
    const m = menu.MENU.find((x) => x.id === req.params.id && x.groups);
    if (!m) throw kit.httpError(404, 'Page not found');
    return view(reply, 'menu_section', { title: m.label, m });
  });

  // ---- account settings (own user)
  r.get('/admin/system_account/index', async (req, reply) => view(reply, 'form_page', accountForm(req.user, {}, {})));
  r.post('/admin/system_account/save', async (req, reply) => {
    const b = req.body || {};
    const vals = { username: U.str(b.username), firstname: U.str(b.firstname), lastname: U.str(b.lastname), email: U.str(b.email), password: U.str(b.password), password_confirmation: U.str(b.password_confirmation) };
    const errors = {};
    for (const k of ['username', 'firstname', 'lastname', 'email']) if (!vals[k]) errors[k] = 'This is a required field.';
    if (vals.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vals.email)) errors.email = 'Please enter a valid email address.';
    if (vals.password && vals.password !== vals.password_confirmation) errors.password_confirmation = 'Your password confirmation must match your password.';
    if (vals.password && vals.password.length < 7) errors.password = 'Your password must include at least 7 characters.';
    const ok = await kit.auth.verifyPassword(U.str(b.current_password), req.user.password_hash);
    if (!ok) errors.current_password = 'The password entered for the current user is invalid. Verify the password and try again.';
    if (vals.username && kit.sql('SELECT 1 FROM admin_users WHERE username = ? COLLATE NOCASE AND id <> ?').get(vals.username, req.user.id)) errors.username = 'A user with the same user name or email already exists.';
    if (Object.keys(errors).length) return view(reply, 'form_page', accountForm(req.user, vals, errors), 422);
    const hash = vals.password ? kit.auth.hashPassword(vals.password) : null;
    kit.sql('UPDATE admin_users SET username = ?, firstname = ?, lastname = ?, email = ?, password_hash = coalesce(?, password_hash), updated_at = ? WHERE id = ?')
      .run(vals.username, vals.firstname, vals.lastname, vals.email, hash, kit.nowSql(), req.user.id);
    req.flash('success', 'You saved the account.');
    return reply.redirect('/admin/admin/system_account/index/');
  });
  function accountForm(u, values, errors) {
    return {
      title: 'Account Setting', action: '/admin/admin/system_account/save/', values: { username: u.username, firstname: u.firstname, lastname: u.lastname, email: u.email, ...values, password: '', password_confirmation: '' }, errors,
      actions: [{ label: 'Save Account', form: 'edit_form', primary: true, id: 'save' }],
      sections: [{ title: 'Account Information', fields: [
        { name: 'username', label: 'User Name', required: true }, { name: 'firstname', label: 'First Name', required: true }, { name: 'lastname', label: 'Last Name', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'password', label: 'New Password', type: 'password' }, { name: 'password_confirmation', label: 'Password Confirmation', type: 'password' },
      ] }, { title: 'Current User Identity Verification', fields: [{ name: 'current_password', label: 'Your Password', type: 'password', required: true }] }],
    };
  }

  r.get('/admin/notification', async (req, reply) => view(reply, 'message_page', { title: 'Notifications', message: 'You have no new system messages.' }));
  r.get('/admin/notification/index', async (req, reply) => reply.redirect('/admin/admin/notification/'));

  // ---- global search (header): products, customers, orders, pages
  r.get('/admin/index/globalSearch', async (req, reply) => {
    const q = U.str(req.query.query || req.query.q);
    const res = { products: [], customers: [], orders: [], pages: [] };
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const s = kit.search.prepare(kit.db(), 'product_search', q, { prefix: 'last' });
      if (s.match) res.products = kit.sql(`SELECT p.id, p.name, p.sku FROM product_search JOIN products p ON p.id = product_search.rowid WHERE product_search MATCH ? ORDER BY bm25(product_search, 10, 5, 3, 2, 1) LIMIT 10`).all(s.match);
      res.customers = kit.sql(`SELECT id, firstname, lastname, email FROM customers WHERE (firstname || ' ' || lastname) LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' ORDER BY id LIMIT 10`).all(like, like);
      res.orders = kit.sql(`SELECT id, increment_id, customer_firstname, customer_lastname, grand_total FROM orders WHERE increment_id LIKE ? ESCAPE '\\' OR (customer_firstname || ' ' || customer_lastname) LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 10`).all(like, like);
      res.pages = kit.sql(`SELECT id, title, identifier FROM cms_pages WHERE title LIKE ? ESCAPE '\\' OR identifier LIKE ? ESCAPE '\\' LIMIT 10`).all(like, like);
    }
    const h = kit.escapeHtml;
    const sec = (t, rows, f) => `<section class="admin__page-section"><h2 class="admin__page-section-title">${t} (${rows.length})</h2>${rows.length ? `<ul>${rows.map((x) => `<li>${f(x)}</li>`).join('')}</ul>` : '<p class="muted">No matches.</p>'}</section>`;
    const html = q ? sec('Products', res.products, (p) => `<a href="/admin/catalog/product/edit/id/${p.id}/">${U.htmlName(p.name)}</a> <span class="muted">SKU ${h(p.sku)}</span>`)
      + sec('Customers', res.customers, (c) => `<a href="/admin/customer/index/edit/id/${c.id}/">${h(c.firstname)} ${h(c.lastname)}</a> <span class="muted">${h(c.email)}</span>`)
      + sec('Orders', res.orders, (o) => `<a href="/admin/sales/order/view/order_id/${o.id}/">Order #${h(o.increment_id)}</a> <span class="muted">${h(o.customer_firstname)} ${h(o.customer_lastname)}, ${U.money(o.grand_total)}</span>`)
      + sec('Pages', res.pages, (p) => `<a href="/admin/cms/page/edit/page_id/${p.id}/">${h(p.title)}</a> <span class="muted">${h(p.identifier)}</span>`)
      : '<p>Enter a search term in the header search box.</p>';
    return view(reply, 'message_page', { title: q ? `Global Search: ${q}` : 'Global Search', html });
  });
};
