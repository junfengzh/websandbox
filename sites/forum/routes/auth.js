'use strict';
// Login / logout (kit) and registration.
module.exports = async function (app, kit) {
  kit.authRoutes(app, { loginPath: '/login', logoutPath: '/logout', view: 'login', after: '/', title: 'Log in' });

  const RULES = {
    username: { required: true, minLength: 3, maxLength: 25, pattern: /^[A-Za-z0-9_-]+$/, message: 'Username may only contain letters, numbers, underscores and hyphens.' },
    email: { type: 'email', maxLength: 200, label: 'Email address' },
    password: { required: true, minLength: 8, maxLength: 72 },
    password_repeat: { required: true, label: 'Repeat password' },
  };
  app.get('/registration', async (req, reply) => {
    if (req.user) return reply.redirect('/');
    return reply.render('registration', { title: 'Sign up', values: {}, errors: {} });
  });
  app.post('/registration', async (req, reply) => {
    const v = kit.validate(req.body, RULES);
    if (!v.errors.username && kit.sql('SELECT 1 FROM users WHERE normalized_username = lower(?)').get(v.values.username)) v.errors.username = 'That username is already taken.';
    if (!v.errors.password_repeat && v.values.password !== v.values.password_repeat) v.errors.password_repeat = 'The passwords do not match.';
    if (Object.keys(v.errors).length) return reply.render('registration', { title: 'Sign up', values: { ...v.values, password: '', password_repeat: '' }, errors: v.errors }, 422);
    const hash = await kit.auth.hashPassword(v.values.password);
    const now = kit.nowSql();
    const r = kit.sql(`INSERT INTO users (username, normalized_username, email, normalized_email, password_hash, role, created_at, last_seen_at)
      VALUES (?, lower(?), ?, lower(?), ?, 'user', ?, ?)`).run(v.values.username, v.values.username, v.values.email, v.values.email, hash, now, now);
    const user = kit.sql('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
    await req.login(user);
    req.flash('success', `Welcome, ${user.username}! Your account was created.`);
    return reply.redirect('/');
  });
};
