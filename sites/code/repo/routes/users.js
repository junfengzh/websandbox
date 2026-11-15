'use strict';
// User profiles (/:username and /users/:username/*), follow/unfollow; /:group dispatch.
const code = require('../../lib/code');
const L = require('../lib/lists');

module.exports = async function (app, kit, { collab }) {
  const loadUser = (username) => {
    const u = code.userByUsername(username);
    if (!u || u.state === 'blocked') throw kit.httpError(404, 'User not found');
    return u;
  };
  const profileCtx = (req, u, tab) => {
    const counts = kit.sql(`SELECT (SELECT count(*) FROM follows WHERE followee_id = ?) AS followers, (SELECT count(*) FROM follows WHERE follower_id = ?) AS following,
      (SELECT count(*) FROM stars s JOIN projects p ON p.id = s.project_id WHERE s.user_id = ?) AS starred`).get(u.id, u.id, u.id);
    const following = req.user && req.user.id !== u.id ? !!kit.sql('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, u.id) : false;
    const status = kit.sql('SELECT * FROM user_statuses WHERE user_id = ?').get(u.id) || null;
    const hidden = u.private_profile && !(req.user && (req.user.id === u.id || req.user.is_admin));
    return { profile: u, tab, counts, following, status, hidden, title: `${u.name} (@${u.username})`, isMe: !!(req.user && req.user.id === u.id) };
  };
  const PERSONAL = "p.namespace_id IN (SELECT id FROM namespaces WHERE kind = 'user' AND owner_id = ?)";
  const CONTRIB = `p.id IN (SELECT DISTINCT project_id FROM events WHERE author_id = ? AND project_id IS NOT NULL AND action IN ('pushed', 'created', 'commented', 'merged', 'closed', 'reopened', 'approved', 'updated'))`;

  // calendar: events per day for the last 365 days
  const calendar = (u) => {
    const end = kit.now();
    const start = new Date(end.getTime() - 364 * 86400e3);
    const rows = kit.sql('SELECT substr(created_at, 1, 10) AS d, count(*) AS n FROM events WHERE author_id = ? AND created_at >= ? GROUP BY d').all(u.id, start.toISOString().slice(0, 10));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), days: Object.fromEntries(rows.map((r) => [r.d, r.n])) };
  };

  const overview = async (req, reply, u) => {
    const ctx = profileCtx(req, u, 'overview');
    const personal = ctx.hidden ? { rows: [] } : L.listProjects(req, PERSONAL, [u.id], { perPage: 10 });
    const events = ctx.hidden ? [] : code.loadEvents('e.author_id = ?', [u.id], { user: req.user, limit: 10 });
    return reply.render('repo/user_overview', { ...ctx, personal, events, cal: ctx.hidden ? null : calendar(u) });
  };

  app.get('/:ns', async (req, reply) => {
    const name = req.params.ns;
    const ns = code.namespaceByPath(name);
    if (ns && ns.kind === 'group') {
      if (collab && typeof collab.groupPage === 'function') return collab.groupPage(req, reply, ns);
      return reply.redirect('/groups/' + ns.full_path);
    }
    const u = code.userByUsername(name);
    if (!u) throw kit.httpError(404, 'Page not found');
    if (u.username !== name && !ns) return reply.redirect('/' + u.username);
    return overview(req, reply, loadUser(u.username));
  });
  app.get('/users/:u', async (req, reply) => reply.redirect('/' + encodeURIComponent(req.params.u)));

  const tabs = {
    activity: async (req, reply, u, ctx) => {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const rows = ctx.hidden ? [] : code.loadEvents('e.author_id = ?', [u.id], { user: req.user, limit: 21, offset: (page - 1) * 20 });
      const pager = { prev: page > 1 ? kit.urlWith(req, { page: page === 2 ? null : page - 1 }) : null, next: rows.length > 20 ? kit.urlWith(req, { page: page + 1 }) : null };
      return reply.render('repo/user_tab', { ...ctx, events: rows.slice(0, 20), pager });
    },
    projects: async (req, reply, u, ctx) => reply.render('repo/user_tab', { ...ctx, list: ctx.hidden ? null : L.listProjects(req, PERSONAL, [u.id]) }),
    contributed: async (req, reply, u, ctx) => reply.render('repo/user_tab', { ...ctx, list: ctx.hidden ? null : L.listProjects(req, CONTRIB, [u.id]) }),
    starred: async (req, reply, u, ctx) => reply.render('repo/user_tab', { ...ctx, list: ctx.hidden ? null : L.listProjects(req, L.STARRED_WHERE, [u.id], { defaultSort: 'name_asc' }) }),
    groups: async (req, reply, u, ctx) => {
      const rows = ctx.hidden ? [] : kit.sql(`SELECT n.*, m.access_level FROM members m JOIN namespaces n ON n.id = m.source_id WHERE m.source_type = 'namespace' AND m.user_id = ? AND m.requested_at IS NULL
        AND (n.visibility = 'public' OR ? IS NOT NULL) ORDER BY n.name COLLATE NOCASE`).all(u.id, req.user ? req.user.id : null);
      return reply.render('repo/user_tab', { ...ctx, groups: rows });
    },
    followers: async (req, reply, u, ctx) => {
      const total = ctx.counts.followers;
      const pager = kit.paginate(req, total, { perPage: 20 });
      const rows = kit.sql('SELECT u.* FROM follows f JOIN users u ON u.id = f.follower_id WHERE f.followee_id = ? ORDER BY u.name COLLATE NOCASE LIMIT ? OFFSET ?').all(u.id, pager.limit, pager.offset);
      return reply.render('repo/user_tab', { ...ctx, people: rows, pager });
    },
    following: async (req, reply, u, ctx) => {
      const total = ctx.counts.following;
      const pager = kit.paginate(req, total, { perPage: 20 });
      const rows = kit.sql('SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? ORDER BY u.name COLLATE NOCASE LIMIT ? OFFSET ?').all(u.id, pager.limit, pager.offset);
      return reply.render('repo/user_tab', { ...ctx, people: rows, pager });
    },
    snippets: async (req, reply, u, ctx) => reply.render('repo/user_tab', { ...ctx, snippets: true }),
  };
  for (const [tab, fn] of Object.entries(tabs)) {
    app.get(`/users/:u/${tab}`, async (req, reply) => {
      const u = loadUser(req.params.u);
      return fn(req, reply, u, profileCtx(req, u, tab));
    });
  }
  app.get('/users/:u/calendar.json', async (req) => calendar(loadUser(req.params.u)).days);

  const follow = (on) => async (req, reply) => {
    const u = loadUser(req.params.u);
    if (u.id === req.user.id) throw kit.httpError(422, 'You cannot follow yourself.');
    if (on) kit.sql('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(req.user.id, u.id, kit.nowSql());
    else kit.sql('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, u.id);
    if (/json/.test(req.headers.accept || '')) return { following: on };
    const next = req.body && req.body.next;
    return reply.redirect(typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/' + u.username);
  };
  app.post('/users/:u/follow', { config: { login: true } }, follow(true));
  app.post('/users/:u/unfollow', { config: { login: true } }, follow(false));
};
