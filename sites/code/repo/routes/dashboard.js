'use strict';
// Dashboard: home (/), your projects, starred projects, activity.
const code = require('../../lib/code');
const L = require('../lib/lists');

const ACTIVITY_FILTERS = {
  push: "e.action = 'pushed'", merged: "e.action = 'merged'", issue: "e.target_type = 'issue'", comments: "e.action = 'commented'",
  team: "e.action IN ('joined', 'left', 'expired')", wiki: "e.target_type = 'wiki_page'",
};

module.exports = async function (app, kit) {
  const yours = async (req, reply) => {
    const r = L.listProjects(req, L.MEMBER_WHERE, L.memberParams(req.user));
    return reply.render('repo/dashboard_projects', { title: 'Projects', tab: 'yours', list: r, counts: L.counts(req.user) });
  };
  app.get('/', async (req, reply) => {
    if (!req.user) return reply.redirect('/users/sign_in');
    return yours(req, reply);
  });
  app.get('/dashboard', { config: { login: true } }, async (req, reply) => reply.redirect('/dashboard/projects'));
  app.get('/dashboard/projects', { config: { login: true } }, yours);
  app.get('/dashboard/projects/personal', { config: { login: true } }, async (req, reply) => {
    const r = L.listProjects(req, "p.namespace_id IN (SELECT id FROM namespaces WHERE kind = 'user' AND owner_id = ?)", [req.user.id]);
    return reply.render('repo/dashboard_projects', { title: 'Projects', tab: 'yours', personal: true, list: r, counts: L.counts(req.user) });
  });
  app.get('/dashboard/projects/starred', { config: { login: true } }, async (req, reply) => {
    const r = L.listProjects(req, L.STARRED_WHERE, [req.user.id]);
    return reply.render('repo/dashboard_projects', { title: 'Starred Projects', tab: 'starred', list: r, counts: L.counts(req.user) });
  });
  app.get('/dashboard/activity', { config: { login: true } }, async (req, reply) => {
    const u = req.user;
    const filter = ACTIVITY_FILTERS[req.query.filter] ? req.query.filter : 'all';
    const scope = req.query.scope === 'starred' ? 'starred' : req.query.scope === 'mine' ? 'mine' : 'projects';
    let where = scope === 'starred' ? 'e.project_id IN (SELECT project_id FROM stars WHERE user_id = ?)'
      : scope === 'mine' ? 'e.author_id = ?'
        : `e.project_id IN (SELECT p.id FROM projects p WHERE ${L.MEMBER_WHERE})`;
    const params = scope === 'projects' ? L.memberParams(u) : [u.id];
    if (filter !== 'all') where += ' AND ' + ACTIVITY_FILTERS[filter];
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const per = 20;
    const rows = code.loadEvents(where, params, { user: u, limit: per + 1, offset: (page - 1) * per });
    const pager = { prev: page > 1 ? kit.urlWith(req, { page: page === 2 ? null : page - 1 }) : null, next: rows.length > per ? kit.urlWith(req, { page: page + 1 }) : null };
    return reply.render('repo/dashboard_activity', { title: 'Activity', events: rows.slice(0, per), pager, filter, scope });
  });
};
