'use strict';
// Explore: projects (all / trending / most starred), groups, users.
const L = require('../lib/lists');

module.exports = async function (app, kit) {
  app.get('/explore', async (req, reply) => reply.redirect('/explore/projects' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));
  app.get('/explore/projects', async (req, reply) => {
    const r = L.listProjects(req, '1', []);
    return reply.render('repo/explore_projects', { title: 'Explore projects', tab: 'all', list: r });
  });
  app.get('/explore/projects/starred', async (req, reply) => {
    const r = L.listProjects(req, '1', [], { defaultSort: 'stars_desc' });
    return reply.render('repo/explore_projects', { title: 'Explore projects', tab: 'starred', list: r });
  });
  app.get('/explore/projects/trending', async (req, reply) => {
    // trending: most stars gained in the last month (falls back to activity)
    const since = new Date(kit.now().getTime() - 30 * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
    const r = L.listProjects(req, 'p.id IN (SELECT project_id FROM stars WHERE created_at >= ? GROUP BY project_id) OR p.last_activity_at >= ?', [since, since], { defaultSort: 'stars_desc' });
    return reply.render('repo/explore_projects', { title: 'Explore projects', tab: 'trending', list: r });
  });
  app.get('/explore/groups', async (req, reply) => {
    const q = String(req.query.filter || req.query.search || '').trim();
    const sort = kit.sorter(req, { options: { name: 'n.name COLLATE NOCASE', created: 'n.created_at', latest_activity: 'n.updated_at' }, default: 'name_asc', tiebreak: 'n.id' });
    const conds = ["n.kind = 'group'", "(n.visibility = 'public' OR (? IS NOT NULL AND (n.visibility = 'internal' OR n.id IN (SELECT source_id FROM members WHERE source_type = 'namespace' AND user_id = ?))))"];
    const ps = [req.user ? req.user.id : null, req.user ? req.user.id : null];
    if (q) { conds.push('(n.name LIKE ? OR n.path LIKE ?)'); ps.push(`%${q}%`, `%${q}%`); }
    const from = `FROM namespaces n WHERE ${conds.join(' AND ')}`;
    const total = kit.db().prepare(`SELECT count(*) ${from}`).pluck().get(...ps);
    const pager = kit.paginate(req, total, { perPage: 20 });
    const rows = kit.db().prepare(`SELECT n.*, (SELECT count(*) FROM projects WHERE namespace_id = n.id) AS projects_count,
        (SELECT count(*) FROM members WHERE source_type = 'namespace' AND source_id = n.id AND user_id IS NOT NULL AND requested_at IS NULL) AS members_count
      ${from} ORDER BY ${sort.orderBy} LIMIT ? OFFSET ?`).all(...ps, pager.limit, pager.offset);
    return reply.render('repo/explore_groups', { title: 'Explore groups', rows, pager, q, sort });
  });
  app.get('/explore/users', async (req, reply) => {
    const q = String(req.query.search || '').trim();
    const conds = ["u.state = 'active'", 'u.user_type IS NULL'];
    const ps = [];
    if (q) {
      const s = kit.search.prepare(kit.db(), 'users_fts', q, { prefix: 'all' });
      if (s.match) { conds.push('(u.id IN (SELECT rowid FROM users_fts WHERE users_fts MATCH ?) OR u.username LIKE ?)'); ps.push(s.match, `%${q}%`); }
    }
    const sort = kit.sorter(req, { options: { name: 'u.name COLLATE NOCASE', created: 'u.created_at', username: 'u.username COLLATE NOCASE' }, default: 'name_asc', tiebreak: 'u.id' });
    const from = `FROM users u WHERE ${conds.join(' AND ')}`;
    const total = kit.db().prepare(`SELECT count(*) ${from}`).pluck().get(...ps);
    const pager = kit.paginate(req, total, { perPage: 30 });
    const rows = kit.db().prepare(`SELECT u.* ${from} ORDER BY ${sort.orderBy} LIMIT ? OFFSET ?`).all(...ps, pager.limit, pager.offset);
    return reply.render('repo/explore_users', { title: 'Users', rows, pager, q, sort });
  });
};
