'use strict';
// websandbox kit -- see README.md for the guide and API reference.
const { site, SITE_INDEX, fmt } = require('./lib/site');
const { als, ctx, HttpError, httpError, sqlTime, parseTime } = require('./lib/context');
const web = require('./lib/web');
const search = require('./lib/search');
const auth = require('./lib/auth');
const grader = require('./lib/grader');
const build = require('./lib/build');

// Context accessors: valid inside route handlers, jobs and tenant.run().
const tenant = () => ctx().tenant;
const db = () => ctx().db;
const now = () => (als.getStore() ? tenant().now() : new Date());
const nowSql = () => sqlTime(now());
const jobs = { enqueue: (type, payload, o) => tenant().enqueue(type, payload, o) };

// Optional login/logout routes: GET/POST loginPath, POST/GET logoutPath.
function authRoutes(app, { loginPath = '/login', logoutPath = '/logout', view = 'login', after = '/', title = 'Sign in' } = {}) {
  const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : after);
  app.get(loginPath, async (req, reply) => {
    if (req.user) return reply.redirect(safeNext(req.query.next));
    return reply.render(view, { title, next: req.query.next || '', values: {}, error: null });
  });
  app.post(loginPath, async (req, reply) => {
    const { login, password, next } = req.body || {};
    const user = await req.authenticate(login, password);
    if (!user) return reply.render(view, { title, next: next || '', values: { login }, error: 'Invalid username or password.' }, 200);
    await req.login(user);
    return reply.redirect(safeNext(next));
  });
  const out = async (req, reply) => { req.logout(); req.flash('success', 'You have been signed out.'); return reply.redirect(after); };
  app.post(logoutPath, out);
  app.get(logoutPath, { config: { csrf: false } }, out);
}

module.exports = {
  site, SITE_INDEX, fmt,
  tenant, db, now, nowSql, jobs, ctx,
  HttpError, httpError, sqlTime, parseTime,
  ...web, // urlWith, paginate, sorter, filters, validate, escapeHtml
  search, auth, grader, build, authRoutes,
};
