'use strict';
// Sign in / sign out / register (GitLab paths /users/sign_in, /users/sign_out, /users/sign_up).
const code = require('../../lib/code');

module.exports = async function (app, kit) {
  const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/users/sign_') ? n : '/');
  const signIn = async (req, reply) => {
    if (req.user) return reply.redirect(safeNext(req.query.next));
    return reply.render('repo/sign_in', { title: 'Sign in', next: req.query.next || '', values: {}, error: null });
  };
  app.get('/users/sign_in', signIn);
  app.get('/login', async (req, reply) => reply.redirect('/users/sign_in' + (req.query.next ? '?next=' + encodeURIComponent(req.query.next) : '')));
  app.post('/users/sign_in', async (req, reply) => {
    const b = req.body || {};
    const login = String(b.login || b['user[login]'] || '').trim();
    const pw = String(b.password || b['user[password]'] || '');
    const user = login && pw ? await req.authenticate(login, pw) : null;
    if (!user) return reply.render('repo/sign_in', { title: 'Sign in', next: b.next || '', values: { login }, error: 'Invalid login or password.' }, 200);
    await req.login(user);
    kit.sql('UPDATE users SET last_sign_in_at = ? WHERE id = ?').run(kit.nowSql(), user.id);
    return reply.redirect(safeNext(b.next));
  });
  const out = async (req, reply) => { req.logout(); req.flash('success', 'Signed out successfully.'); return reply.redirect('/users/sign_in'); };
  app.post('/users/sign_out', out);
  app.get('/users/sign_out', { config: { csrf: false } }, out);
  app.post('/logout', out);

  app.get('/users/sign_up', async (req, reply) => {
    if (req.user) return reply.redirect('/');
    return reply.render('repo/sign_up', { title: 'Register', values: {}, errors: {} });
  });
  app.post('/users/sign_up', async (req, reply) => {
    const b = req.body || {};
    const values = { first_name: String(b.first_name || '').trim(), last_name: String(b.last_name || '').trim(), username: String(b.username || '').trim(), email: String(b.email || '').trim() };
    const v = kit.validate({ ...values, password: b.password }, {
      first_name: { required: true, maxLength: 127, label: 'First name' }, last_name: { required: true, maxLength: 127, label: 'Last name' },
      username: { required: true, maxLength: 255, pattern: /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/, message: "Username can contain only letters, digits, '_', '-' and '.'.", check: (x) => (code.userByUsername(x) || code.namespaceByPath(x) ? 'Username is already taken.' : null) },
      email: { required: true, type: 'email', check: (x) => (kit.sql('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(x) ? 'Email has already been taken' : null) },
      password: { required: true, check: (x) => (String(x).length < 8 ? 'Password is too short (minimum is 8 characters)' : null) },
    });
    if (!v.ok) return reply.render('repo/sign_up', { title: 'Register', values, errors: v.errors }, 422);
    const now = kit.nowSql();
    const hash = await kit.auth.hashPassword(String(b.password));
    const r = kit.sql(`INSERT INTO users (username, name, email, password_hash, state, is_admin, created_at, updated_at, projects_limit, can_create_group)
      VALUES (?, ?, ?, ?, 'active', 0, ?, ?, 100000, 1)`).run(values.username, `${values.first_name} ${values.last_name}`, values.email, hash, now, now);
    const id = Number(r.lastInsertRowid);
    kit.sql("INSERT INTO namespaces (kind, path, name, full_path, owner_id, visibility, created_at, updated_at) VALUES ('user', ?, ?, ?, ?, 'public', ?, ?)")
      .run(values.username, values.username, values.username, id, now, now);
    await req.login(code.userById(id));
    req.flash('success', 'Welcome! Your account has been created.');
    return reply.redirect('/dashboard/projects');
  });
};
