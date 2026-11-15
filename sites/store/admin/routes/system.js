'use strict';
// System: admin users (grid, new / edit with role, delete), user roles (resources), cache
// management, index management.
const RESOURCES = [
  ['Magento_Backend::dashboard', 'Dashboard'], ['Magento_Sales::sales', 'Sales'], ['Magento_Sales::sales_order', 'Sales > Orders'], ['Magento_Sales::actions_edit', 'Sales > Orders > Edit'],
  ['Magento_Catalog::catalog', 'Catalog'], ['Magento_Catalog::products', 'Catalog > Products'], ['Magento_Catalog::categories', 'Catalog > Categories'],
  ['Magento_Customer::customer', 'Customers'], ['Magento_Customer::manage', 'Customers > All Customers'], ['Magento_Customer::group', 'Customers > Customer Groups'],
  ['Magento_Backend::marketing', 'Marketing'], ['Magento_CatalogRule::promo', 'Marketing > Promotions'], ['Magento_Newsletter::newsletter', 'Marketing > Communications'], ['Magento_Review::reviews_all', 'Marketing > User Content'],
  ['Magento_Backend::content', 'Content'], ['Magento_Cms::page', 'Content > Pages'], ['Magento_Cms::block', 'Content > Blocks'], ['Magento_Theme::theme', 'Content > Themes'],
  ['Magento_Reports::report', 'Reports'], ['Magento_Backend::stores', 'Stores'], ['Magento_Config::config', 'Stores > Configuration'], ['Magento_Backend::system', 'System'], ['Magento_User::acl', 'System > Permissions'],
];

module.exports = (r, ctx) => {
  const { kit, U, grid, view } = ctx;
  const h = kit.escapeHtml;
  const roles = () => kit.sql("SELECT id, name FROM admin_roles WHERE role_type = 'G' ORDER BY id").all().map((x) => [x.id, x.name]);

  // ---------------------------------------------------------------- users
  const USERS = {
    id: 'permissionsUserGrid', url: '/admin/admin/user/', idCol: 'u.id', from: 'admin_users u', defaultSort: 'user_id_asc',
    columns: [
      { key: 'user_id', label: 'ID', sql: 'u.id', cls: 'num', filter: { type: 'range', col: 'u.id' } },
      { key: 'username', label: 'User Name', sql: 'u.username', filter: { type: 'text' }, html: (x) => `<a href="/admin/admin/user/edit/user_id/${x._id}/">${h(x.username)}</a>` },
      { key: 'firstname', label: 'First Name', sql: 'u.firstname', filter: { type: 'text' } }, { key: 'lastname', label: 'Last Name', sql: 'u.lastname', filter: { type: 'text' } },
      { key: 'email', label: 'Email', sql: 'u.email', filter: { type: 'text' } },
      { key: 'role', label: 'Role', sql: '(SELECT name FROM admin_roles r WHERE r.id = u.role_id)', sort: 'u.role_id' },
      { key: 'is_active', label: 'Status', sql: 'u.is_active', filter: { type: 'select', options: [[1, 'Active'], [0, 'Inactive']] }, html: (x) => (x.is_active ? 'Active' : 'Inactive') },
    ],
    rowActions: (x) => `<a href="/admin/admin/user/edit/user_id/${x._id}/">Edit</a>`,
  };
  r.get('/admin/user', async (req, reply) => view(reply, 'grid_page', { title: 'Users', g: grid.build(req, kit, USERS), crumbs: [['System', null], ['Permissions', null], ['All Users', null]], actions: [{ label: 'Add New User', href: '/admin/admin/user/new/', primary: true, id: 'add' }] }));
  r.get('/admin/user/index', async (req, reply) => reply.redirect('/admin/admin/user/'));
  const userForm = (u, values = {}, errors = {}) => ({
    title: u ? `Edit User '${u.username}'` : 'New User', action: u ? `/admin/admin/user/save/user_id/${u.id}/` : '/admin/admin/user/save/', errors,
    values: { username: u ? u.username : '', firstname: u ? u.firstname : '', lastname: u ? u.lastname : '', email: u ? u.email : '', interface_locale: u ? u.interface_locale || 'en_US' : 'en_US', is_active: u ? u.is_active : 1, roles: u ? u.role_id ?? '' : '', ...values, password: '', password_confirmation: '', current_password: '' },
    crumbs: [['System', null], ['All Users', '/admin/admin/user/'], [u ? u.username : 'New User', null]],
    actions: [{ label: 'Back', href: '/admin/admin/user/' }, { label: 'Reset', href: u ? `/admin/admin/user/edit/user_id/${u.id}/` : '/admin/admin/user/new/' },
      ...(u ? [{ label: 'Delete User', post: `/admin/admin/user/delete/user_id/${u.id}/`, confirm: 'Are you sure you want to do this?', id: 'delete' }] : []), { label: 'Save User', form: 'edit_form', primary: true, id: 'save' }],
    sections: [
      { title: 'Account Information', fields: [{ name: 'username', label: 'User Name', required: true }, { name: 'firstname', label: 'First Name', required: true }, { name: 'lastname', label: 'Last Name', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'password', label: 'Password', type: 'password', required: !u, note: 'Must include both numeric and alphabetic characters, 7 or more.' },
        { name: 'password_confirmation', label: 'Password Confirmation', type: 'password', required: !u }, { name: 'interface_locale', label: 'Interface Locale', type: 'select', options: [['en_US', 'English (United States)'], ['en_GB', 'English (United Kingdom)'], ['fr_FR', 'French (France)'], ['de_DE', 'German (Germany)']] },
        { name: 'is_active', label: 'This account is', type: 'select', options: [[1, 'Active'], [0, 'Inactive']] }] },
      { title: 'User Role', fields: [{ name: 'roles', label: 'Role', type: 'radios', options: roles() }] },
      { title: 'Current User Identity Verification', fields: [{ name: 'current_password', label: 'Your Password', type: 'password', required: true }] },
    ],
  });
  const loadUser = (id) => { const u = kit.sql('SELECT * FROM admin_users WHERE id = ?').get(+id); if (!u) throw ctx.notFound('user'); return u; };
  r.get('/admin/user/new', async (req, reply) => view(reply, 'form_page', userForm(null)));
  r.get('/admin/user/edit/user_id/:id', async (req, reply) => view(reply, 'form_page', userForm(loadUser(req.params.id))));
  const userSave = async (req, reply) => {
    const u = req.params.id ? loadUser(req.params.id) : null;
    const b = req.body || {};
    const v = Object.fromEntries(['username', 'firstname', 'lastname', 'email', 'password', 'password_confirmation', 'interface_locale', 'is_active', 'roles'].map((k) => [k, U.str(b[k])]));
    const errors = {};
    for (const k of ['username', 'firstname', 'lastname', 'email']) if (!v[k]) errors[k] = 'This is a required field.';
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = 'Please enter a valid email address.';
    if (!u && !v.password) errors.password = 'This is a required field.';
    if (v.password && (v.password.length < 7 || !/[a-z]/i.test(v.password) || !/\d/.test(v.password))) errors.password = 'Your password must include both numeric and alphabetic characters, 7 or more.';
    if (v.password && v.password !== v.password_confirmation) errors.password_confirmation = 'Your password confirmation must match your password.';
    if (v.username && kit.sql('SELECT 1 FROM admin_users WHERE (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) AND id IS NOT ?').get(v.username, v.email, u ? u.id : null)) errors.username = 'A user with the same user name or email already exists.';
    const roleId = parseInt(v.roles, 10);
    if (v.roles && !kit.sql("SELECT 1 FROM admin_roles WHERE id = ? AND role_type = 'G'").get(roleId)) errors.roles = 'Please select a valid role.';
    if (!(await kit.auth.verifyPassword(U.str(b.current_password), req.user.password_hash))) errors.current_password = 'The password entered for the current user is invalid. Verify the password and try again.';
    if (u && u.id === req.user.id && v.is_active === '0') errors.is_active = 'You cannot deactivate your own account.';
    if (Object.keys(errors).length) { const m = userForm(u, v, errors); m.errorsList = ['Please correct the highlighted fields.']; return view(reply, 'form_page', m, 422); }
    const now = kit.nowSql();
    const row = { username: v.username, firstname: v.firstname, lastname: v.lastname, email: v.email, interface_locale: v.interface_locale || 'en_US', is_active: v.is_active === '0' ? 0 : 1, role_id: Number.isFinite(roleId) ? roleId : (u ? u.role_id : null) };
    if (v.password) row.password_hash = kit.auth.hashPassword(v.password);
    let id;
    if (u) { kit.db().prepare(`UPDATE admin_users SET ${Object.keys(row).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...row, now, id: u.id }); id = u.id; }
    else id = Number(kit.db().prepare(`INSERT INTO admin_users (${Object.keys(row).join(', ')}, created_at, updated_at, lognum) VALUES (${Object.keys(row).map((k) => '@' + k).join(', ')}, @now, @now, 0)`).run({ ...row, now }).lastInsertRowid);
    req.flash('success', 'You saved the user.');
    return reply.redirect('/admin/admin/user/');
  };
  r.post('/admin/user/save', userSave);
  r.post('/admin/user/save/user_id/:id', userSave);
  r.post('/admin/user/delete/user_id/:id', async (req, reply) => {
    const u = loadUser(req.params.id);
    if (u.id === req.user.id) { req.flash('error', 'You cannot delete your own account.'); return reply.redirect(`/admin/admin/user/edit/user_id/${u.id}/`); }
    kit.sql('DELETE FROM admin_users WHERE id = ?').run(u.id);
    req.flash('success', 'You deleted the user.');
    return reply.redirect('/admin/admin/user/');
  });

  // ---------------------------------------------------------------- roles
  const ROLES = {
    id: 'roleGrid', url: '/admin/admin/user_role/', idCol: 'r.id', from: 'admin_roles r', where: "r.role_type = 'G'", defaultSort: 'role_id_asc',
    columns: [
      { key: 'role_id', label: 'ID', sql: 'r.id', cls: 'num' },
      { key: 'name', label: 'Role', sql: 'r.name', filter: { type: 'text' }, html: (x) => `<a href="/admin/admin/user_role/editrole/rid/${x._id}/">${h(x.name)}</a>` },
      { key: 'users', label: 'Users', sql: '(SELECT count(*) FROM admin_users u WHERE u.role_id = r.id)', cls: 'num' },
    ],
    rowActions: (x) => `<a href="/admin/admin/user_role/editrole/rid/${x._id}/">Edit</a>`,
  };
  r.get('/admin/user_role', async (req, reply) => view(reply, 'grid_page', { title: 'Roles', g: grid.build(req, kit, ROLES), crumbs: [['System', null], ['Permissions', null], ['User Roles', null]], actions: [{ label: 'Add New Role', href: '/admin/admin/user_role/editrole/', primary: true, id: 'add' }] }));
  const roleForm = (ro, values = {}, errors = {}) => {
    const rules = ro ? kit.sql("SELECT resource_id FROM admin_role_rules WHERE role_id = ? AND permission = 'allow'").pluck().all(ro.id) : [];
    const all = rules.includes('Magento_Backend::all');
    return {
      title: ro ? ro.name : 'New Role', action: ro ? `/admin/admin/user_role/saverole/rid/${ro.id}/` : '/admin/admin/user_role/saverole/', errors,
      values: { rolename: ro ? ro.name : '', all: ro ? (all ? 1 : 0) : 0, 'resource[]': rules, current_password: '', ...values },
      crumbs: [['System', null], ['User Roles', '/admin/admin/user_role/'], [ro ? ro.name : 'New Role', null]],
      actions: [{ label: 'Back', href: '/admin/admin/user_role/' }, ...(ro && ro.id !== 1 ? [{ label: 'Delete Role', post: `/admin/admin/user_role/delete/rid/${ro.id}/`, confirm: 'Are you sure you want to do this?', id: 'delete' }] : []), { label: 'Save Role', form: 'edit_form', primary: true, id: 'save' }],
      sections: [
        { title: 'Role Information', fields: [{ name: 'rolename', label: 'Role Name', required: true }] },
        { title: 'Role Resources', fields: [{ name: 'all', label: 'Resource Access', type: 'select', options: [[0, 'Custom'], [1, 'All']] }, { name: 'resource[]', label: 'Resources', type: 'checkboxes', options: RESOURCES, showWhen: 'all=0' }] },
        { title: 'Current User Identity Verification', fields: [{ name: 'current_password', label: 'Your Password', type: 'password', required: true }] },
      ],
    };
  };
  const loadRole = (id) => { const ro = kit.sql("SELECT * FROM admin_roles WHERE id = ? AND role_type = 'G'").get(+id); if (!ro) throw ctx.notFound('role'); return ro; };
  r.get('/admin/user_role/editrole', async (req, reply) => view(reply, 'form_page', roleForm(req.query.rid ? loadRole(req.query.rid) : null)));
  r.get('/admin/user_role/editrole/rid/:id', async (req, reply) => view(reply, 'form_page', roleForm(loadRole(req.params.id))));
  const roleSave = async (req, reply) => {
    const ro = req.params.id ? loadRole(req.params.id) : null;
    const b = req.body || {};
    const name = U.str(b.rolename);
    const all = U.str(b.all) === '1';
    const res = U.arr(b['resource[]'] ?? b.resource).map(String).filter((x) => RESOURCES.some((y) => y[0] === x));
    const errors = {};
    if (!name) errors.rolename = 'This is a required field.';
    if (!(await kit.auth.verifyPassword(U.str(b.current_password), req.user.password_hash))) errors.current_password = 'The password entered for the current user is invalid. Verify the password and try again.';
    if (Object.keys(errors).length) return view(reply, 'form_page', roleForm(ro, { rolename: name, all: all ? 1 : 0, 'resource[]': res }, errors), 422);
    let id = ro && ro.id;
    if (ro) kit.sql('UPDATE admin_roles SET name = ? WHERE id = ?').run(name, ro.id);
    else id = Number(kit.sql("INSERT INTO admin_roles (name, parent_id, role_type) VALUES (?, 0, 'G')").run(name).lastInsertRowid);
    kit.sql('DELETE FROM admin_role_rules WHERE role_id = ?').run(id);
    for (const x of all ? ['Magento_Backend::all'] : res) kit.sql("INSERT INTO admin_role_rules (role_id, resource_id, permission) VALUES (?, ?, 'allow')").run(id, x);
    req.flash('success', 'You saved the role.');
    return reply.redirect('/admin/admin/user_role/');
  };
  r.post('/admin/user_role/saverole', roleSave);
  r.post('/admin/user_role/saverole/rid/:id', roleSave);
  r.post('/admin/user_role/delete/rid/:id', async (req, reply) => {
    const ro = loadRole(req.params.id);
    if (kit.sql('SELECT 1 FROM admin_users WHERE role_id = ?').get(ro.id)) { req.flash('error', 'This role has users assigned; reassign them first.'); return reply.redirect(`/admin/admin/user_role/editrole/rid/${ro.id}/`); }
    kit.sql('DELETE FROM admin_role_rules WHERE role_id = ?').run(ro.id);
    kit.sql('DELETE FROM admin_roles WHERE id = ?').run(ro.id);
    req.flash('success', 'You deleted the role.');
    return reply.redirect('/admin/admin/user_role/');
  });

  // ---------------------------------------------------------------- cache / index management
  const CACHES = [['config', 'Configuration', 'Various XML configurations that were collected across modules and merged'], ['layout', 'Layouts', 'Layout building instructions'], ['block_html', 'Blocks HTML output', 'Page blocks HTML'], ['collections', 'Collections Data', 'Collection data files'], ['eav', 'EAV types and attributes', 'Entity types declaration cache'], ['full_page', 'Page Cache', 'Full page caching'], ['translate', 'Translations', 'Translation files']];
  r.get('/admin/cache', async (req, reply) => {
    const html = `<form method="post" action="/admin/admin/cache/flushAll/" class="inline"><input type="hidden" name="_csrf" value="${h(req.csrfToken())}"><button type="submit" class="action-primary" id="flush_magento">Flush Magento Cache</button></form>
      <table class="data-grid" id="cache_grid" style="margin-top:12px"><thead><tr><th>Cache Type</th><th>Description</th><th>Tags</th><th>Status</th></tr></thead><tbody>
      ${CACHES.map(([k, l, d]) => `<tr><td>${h(l)}</td><td>${h(d)}</td><td>${k.toUpperCase()}</td><td><span class="grid-severity-notice">Enabled</span></td></tr>`).join('')}</tbody></table>`;
    return view(reply, 'message_page', { title: 'Cache Management', html, crumbs: [['System', null], ['Tools', null], ['Cache Management', null]] });
  });
  for (const p of ['/admin/cache/flushAll', '/admin/cache/flushSystem']) r.post(p, async (req, reply) => { req.flash('success', 'The Magento cache storage has been flushed.'); return reply.redirect('/admin/admin/cache/'); });
  const INDEXERS = [['design_config_grid', 'Design Config Grid'], ['customer_grid', 'Customer Grid'], ['catalog_category_product', 'Category Products'], ['catalog_product_category', 'Product Categories'], ['catalogrule_rule', 'Catalog Rule Product'], ['catalog_product_attribute', 'Product EAV'], ['inventory', 'Inventory'], ['catalog_product_price', 'Product Price'], ['catalogsearch_fulltext', 'Catalog Search'], ['salesrule_rule', 'Sales Rule']];
  r.get('/indexer/indexer/list', async (req, reply) => {
    const html = `<table class="data-grid" id="gridIndexer"><thead><tr><th>Indexer</th><th>Description</th><th>Mode</th><th>Status</th><th>Schedule Status</th><th>Updated</th></tr></thead><tbody>
      ${INDEXERS.map(([k, l]) => `<tr><td>${h(l)}</td><td>${h(l)} index (${k})</td><td>Update on Save</td><td><span class="grid-severity-notice">Ready</span></td><td></td><td>${h(U.date.datetime(kit.nowSql()))}</td></tr>`).join('')}</tbody></table>
      <p class="muted">The lite store keeps its indexes (search, categories) current on every save.</p>`;
    return view(reply, 'message_page', { title: 'Index Management', html, crumbs: [['System', null], ['Tools', null], ['Index Management', null]] });
  });
};
