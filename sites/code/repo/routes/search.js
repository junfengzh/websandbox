'use strict';
// Search: /search?search=..&scope=projects|issues|merge_requests|users|commits|blobs[&project_id=]
const code = require('../../lib/code');
const git = require('../lib/git');

module.exports = async function (app, kit) {
  const PER = 20;
  app.get('/search', async (req, reply) => {
    const q = String(req.query.search || '').trim();
    const project = req.query.project_id ? code.projectById(Number(req.query.project_id)) : null;
    if (project) {
      project.access = code.accessLevel(req.user, project);
      if (!code.canRead(req.user, project, project.access)) throw kit.httpError(404, 'Project not found');
      project.url = '/' + project.full_path;
    }
    const scopes = project ? ['blobs', 'issues', 'merge_requests', 'commits'] : ['projects', 'issues', 'merge_requests', 'users'];
    const scope = scopes.includes(req.query.scope) ? req.query.scope : scopes[0];
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const base = { title: q ? `${q} · Search` : 'Search', q, scope, scopes, project, nav: project ? 'project' : undefined, crumbs: [['Search']], results: [], counts: {}, pager: null };
    if (!q) return reply.render('repo/search', base);
    const vis = code.visibleWhere('p');
    const vp = code.visibleParams(req.user);
    const counts = {};
    const issuable = (table, fts) => {
      const s = kit.search.prepare(kit.db(), fts, q, { weights: { title: 10, description: 1 } });
      const iid = /^[#!]?(\d+)$/.exec(q);
      if (!s.match && !iid) return { rows: [], total: 0 };
      const conds = [vis];
      const ps = [...vp];
      if (project) { conds.push('x.project_id = ?'); ps.push(project.id); }
      if (table === 'issues') conds.push('(x.confidential = 0 OR ? = 1)'), ps.push(req.user && req.user.is_admin ? 1 : 0);
      if (req.query.state === 'opened' || req.query.state === 'closed' || req.query.state === 'merged') { conds.push('x.state = ?'); ps.push(req.query.state); }
      const match = s.match ? `x.id IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?)` : '0';
      const mps = s.match ? [s.match] : [];
      const iidCond = iid && project ? ' OR x.iid = ' + Number(iid[1]) : '';
      const from = `FROM ${table} x JOIN projects p ON p.id = x.project_id JOIN namespaces n ON n.id = p.namespace_id WHERE (${match}${iidCond}) AND ${conds.join(' AND ')}`;
      const total = kit.countCapped(kit.db(), from, [...mps, ...ps], 1000);
      const rows = kit.db().prepare(`SELECT x.id, x.iid, x.title, x.state, x.created_at, x.updated_at, substr(x.description, 1, 300) AS snippet, p.full_path, p.name AS project_name, n.name AS ns_name ${from}
        ORDER BY x.updated_at DESC LIMIT ? OFFSET ?`).all(...mps, ...ps, PER, (page - 1) * PER);
      return { rows, total };
    };
    let r = { rows: [], total: 0 };
    if (scope === 'projects') {
      const s = kit.search.prepare(kit.db(), 'projects_fts', q, { weights: { name: 10, path: 8, full_path: 4, description: 1 } });
      const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      const from = `FROM projects p JOIN namespaces n ON n.id = p.namespace_id WHERE (${s.match ? 'p.id IN (SELECT rowid FROM projects_fts WHERE projects_fts MATCH ?) OR ' : ''}p.full_path LIKE ? ESCAPE '\\') AND ${vis}`;
      const ps = [...(s.match ? [s.match] : []), like, ...vp];
      const total = kit.db().prepare(`SELECT count(*) ${from}`).pluck().get(...ps);
      const rows = kit.db().prepare(`SELECT p.*, n.name AS ns_name ${from} ORDER BY (p.name LIKE ? ESCAPE '\\') DESC, p.star_count DESC, p.last_activity_at DESC LIMIT ? OFFSET ?`).all(...ps, like, PER, (page - 1) * PER);
      r = { rows, total };
    } else if (scope === 'issues') r = issuable('issues', 'issues_fts');
    else if (scope === 'merge_requests') r = issuable('merge_requests', 'merge_requests_fts');
    else if (scope === 'users') {
      const s = kit.search.prepare(kit.db(), 'users_fts', q, { prefix: 'all' });
      const from = `FROM users u WHERE u.state = 'active' AND (${s.match ? 'u.id IN (SELECT rowid FROM users_fts WHERE users_fts MATCH ?) OR ' : ''}u.username LIKE ?)`;
      const ps = [...(s.match ? [s.match] : []), `%${q}%`];
      const total = kit.db().prepare(`SELECT count(*) ${from}`).pluck().get(...ps);
      const rows = kit.db().prepare(`SELECT u.* ${from} ORDER BY (u.username = ? COLLATE NOCASE) DESC, u.name COLLATE NOCASE LIMIT ? OFFSET ?`).all(...ps, q, PER, (page - 1) * PER);
      r = { rows, total };
    } else if (scope === 'commits') {
      const ref = git.resolveRef(project, req.query.repository_ref || project.default_branch);
      if (ref) {
        const sha = /^[0-9a-f]{7,40}$/i.test(q) ? git.findCommit(project.id, q) : null;
        const rows = git.history(project, ref, { search: q, offset: (page - 1) * PER, limit: PER + 1 });
        if (sha && !rows.some((c) => c.sha === sha.sha) && page === 1) rows.unshift(sha);
        r = { rows: rows.slice(0, PER), total: (page - 1) * PER + rows.length, more: rows.length > PER };
      }
    } else if (scope === 'blobs') {
      const ref = git.resolveRef(project, req.query.repository_ref || project.default_branch);
      const rows = [];
      if (ref && ref.commit && ref.commit.has_tree) {
        const needle = q.toLowerCase();
        const paths = git.allPaths(ref.commit.tree_sha, 20000);
        let scanned = 0;
        for (const pth of paths) {
          if (rows.length >= 200 || scanned > 4000) break;
          const e = git.entryAt(ref.commit.tree_sha, pth);
          if (!e || e.type !== 'blob') continue;
          const nameHit = pth.toLowerCase().includes(needle);
          const o = git.getObject(e.sha);
          scanned++;
          if (!o || !o.data || o.binary || o.data.length > 512 * 1024) { if (nameHit) rows.push({ path: pth, lines: [] }); continue; }
          const text = o.data.toString('utf8');
          const lower = text.toLowerCase();
          if (!lower.includes(needle) && !nameHit) continue;
          const lines = [];
          const all = text.split('\n');
          for (let i = 0; i < all.length && lines.length < 3; i++) if (all[i].toLowerCase().includes(needle)) lines.push({ n: i + 1, s: all[i].slice(0, 300) });
          rows.push({ path: pth, lines, ref: ref.name });
        }
      }
      r = { rows: rows.slice((page - 1) * PER, page * PER), total: rows.length, ref: ref ? ref.name : null };
    }
    counts[scope] = r.total;
    const pager = { prev: page > 1 ? kit.urlWith(req, { page: page === 2 ? null : page - 1 }) : null, next: r.more || page * PER < r.total ? kit.urlWith(req, { page: page + 1 }) : null };
    return reply.render('repo/search', { ...base, results: r.rows, total: r.total, counts, pager, blobRef: r.ref });
  });
};
