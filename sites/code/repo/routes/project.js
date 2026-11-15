'use strict';
// Project overview, project activity, stars, forks, new project.
const code = require('../../lib/code');
const git = require('../lib/git');
const write = require('../lib/write');
const R = require('../lib/repo');
const L = require('../lib/lists');

module.exports = async function (app, kit, { collab }) {
  const overview = async (req, reply, p) => {
    const starred = req.user ? !!kit.sql('SELECT 1 FROM stars WHERE user_id = ? AND project_id = ?').get(req.user.id, p.id) : false;
    const forkedFrom = p.forked_from_id ? code.projectById(p.forked_from_id) : null;
    const base = { project: p, nav: 'project', title: null, starred, forkedFrom, sshUrl: code.setting('ssh_clone_prefix') + p.full_path + '.git', httpUrl: code.setting('http_clone_prefix') + p.full_path + '.git', overview: true };
    if (!p.default_branch) return reply.render('repo/project_empty', base);
    const ref = git.resolveRef(p, p.default_branch);
    if (!ref) return reply.render('repo/project_empty', base);
    const view = R.treeView(req, p, ref, '');
    return reply.render('repo/tree', { ...base, ...view });
  };

  app.get('/:ns/:proj', async (req, reply) => {
    const { ns, proj } = req.params;
    if (proj.endsWith('.git')) return reply.redirect(`/${ns}/${proj.slice(0, -4)}`);
    const p = code.loadProject(req, ns, proj);
    return overview(req, reply, p);
  });

  app.get('/:ns/:proj/activity', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const F = { push: "e.action = 'pushed'", merged: "e.action = 'merged'", issue: "e.target_type = 'issue'", comments: "e.action = 'commented'", team: "e.action IN ('joined', 'left', 'expired')", wiki: "e.target_type = 'wiki_page'" };
    const filter = F[req.query.event_filter] ? req.query.event_filter : 'all';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = code.loadEvents('e.project_id = ?' + (filter !== 'all' ? ' AND ' + F[filter] : ''), [p.id], { user: req.user, limit: 21, offset: (page - 1) * 20 });
    const pager = { prev: page > 1 ? kit.urlWith(req, { page: page === 2 ? null : page - 1 }) : null, next: rows.length > 20 ? kit.urlWith(req, { page: page + 1 }) : null };
    return reply.render('repo/project_activity', { project: p, nav: 'activity', title: 'Activity', crumbs: [['Activity']], events: rows.slice(0, 20), pager, filter });
  });
  app.get('/:ns/:proj/-/activity', async (req, reply) => reply.redirect(`/${req.params.ns}/${req.params.proj}/activity`));

  // ---------------------------------------------------------------- stars
  const toggleStar = async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const has = !!kit.sql('SELECT 1 FROM stars WHERE user_id = ? AND project_id = ?').get(req.user.id, p.id);
    const want = req.body && req.body.star != null ? !['0', 'false', 'unstar'].includes(String(req.body.star)) : !has;
    const n = write.setStar(p, req.user, want);
    if (/json/.test(req.headers.accept || '') || req.url.includes('.json')) return { star_count: n, starred: want };
    return reply.redirect(String((req.body && req.body.next) || p.url).startsWith('/') ? (req.body && req.body.next) || p.url : p.url);
  };
  app.post('/:ns/:proj/-/toggle_star', { config: { login: true } }, toggleStar);
  app.post('/:ns/:proj/toggle_star', { config: { login: true } }, toggleStar);
  app.post('/:ns/:proj/toggle_star.json', { config: { login: true } }, toggleStar);
  app.get('/:ns/:proj/-/starrers', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const q = String(req.query.search || '').trim();
    const sort = kit.sorter(req, { options: { name: 'u.name COLLATE NOCASE', created: 's.created_at' }, default: 'name_asc', tiebreak: 'u.id' });
    const where = 's.project_id = ?' + (q ? ' AND (u.name LIKE ? OR u.username LIKE ?)' : '');
    const ps = q ? [p.id, `%${q}%`, `%${q}%`] : [p.id];
    const total = kit.db().prepare(`SELECT count(*) FROM stars s JOIN users u ON u.id = s.user_id WHERE ${where}`).pluck().get(...ps);
    const pager = kit.paginate(req, total, { perPage: 30 });
    const rows = kit.db().prepare(`SELECT u.*, s.created_at AS starred_at FROM stars s JOIN users u ON u.id = s.user_id WHERE ${where} ORDER BY ${sort.orderBy} LIMIT ? OFFSET ?`).all(...ps, pager.limit, pager.offset);
    return reply.render('repo/starrers', { project: p, nav: 'project', title: 'Starrers', crumbs: [['Starrers']], rows, pager, q, sort });
  });

  // ---------------------------------------------------------------- forks
  app.get('/:ns/:proj/-/forks', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const r = L.listProjects(req, 'p.forked_from_id = ?', [p.id], { defaultSort: 'created_desc' });
    return reply.render('repo/forks', { project: p, nav: 'project', title: 'Forks', crumbs: [['Forks']], list: r });
  });
  const forkTargets = (user) => {
    const own = code.userNamespace(user.id);
    const groups = kit.sql(`SELECT n.* FROM namespaces n WHERE n.kind = 'group' AND n.id IN (SELECT source_id FROM members WHERE source_type = 'namespace' AND user_id = ? AND access_level >= 30 AND requested_at IS NULL) ORDER BY n.full_path`).all(user.id);
    if (user.is_admin) for (const g of kit.sql("SELECT * FROM namespaces WHERE kind = 'group' ORDER BY full_path").all()) if (!groups.some((x) => x.id === g.id)) groups.push(g);
    return [own, ...groups].filter(Boolean);
  };
  app.get('/:ns/:proj/-/forks/new', { config: { login: true } }, async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!p.forking_enabled) throw kit.httpError(403, 'Forking is disabled for this project.');
    const targets = forkTargets(req.user);
    return reply.render('repo/fork_new', { project: p, nav: 'project', title: 'Fork project', crumbs: [['Fork project']], targets, values: { name: p.name, path: p.path, namespace_id: '', description: p.description || '', visibility: p.visibility === 'public' ? 'public' : p.visibility }, errors: {} });
  });
  app.post('/:ns/:proj/-/forks', { config: { login: true } }, async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!p.forking_enabled) throw kit.httpError(403, 'Forking is disabled for this project.');
    const b = req.body || {};
    const targets = forkTargets(req.user);
    const values = { name: String(b.name ?? p.name).trim(), path: String(b.path ?? p.path).trim(), namespace_id: String(b.namespace_id || ''), description: String(b.description ?? p.description ?? ''), visibility: String(b.visibility || p.visibility) };
    const ns = targets.find((t) => String(t.id) === values.namespace_id || t.full_path === b.namespace_path) || (b.namespace_id == null && b.namespace_path == null ? targets[0] : null);
    const errors = write.validateProjectPath(ns ? ns.full_path : '', values.path, values.name);
    if (!ns) errors.namespace_id = 'Please select a namespace';
    if (!['private', 'internal', 'public'].includes(values.visibility)) errors.visibility = 'Select a visibility level';
    const rank = { private: 0, internal: 1, public: 2 };
    if (!errors.visibility && rank[values.visibility] > rank[p.visibility]) errors.visibility = `The visibility level is higher than the source project (${p.visibility}).`;
    if (Object.keys(errors).length) return reply.render('repo/fork_new', { project: p, nav: 'project', title: 'Fork project', crumbs: [['Fork project']], targets, values, errors }, 422);
    const f = write.forkProject(p, req.user, ns, values);
    req.flash('success', `The project '${f.name}' was successfully forked.`);
    return reply.redirect('/' + f.full_path);
  });
  app.post('/:ns/:proj/-/fork', { config: { login: true } }, async (req, reply) => reply.redirect(`/${req.params.ns}/${req.params.proj}/-/forks/new`));

  // ---------------------------------------------------------------- new project
  const newProjectTargets = (user) => {
    const own = code.userNamespace(user.id);
    const groups = kit.sql(`SELECT n.* FROM namespaces n WHERE n.kind = 'group' AND (? = 1 OR n.id IN (SELECT source_id FROM members WHERE source_type = 'namespace' AND user_id = ? AND access_level >= 30 AND requested_at IS NULL)) ORDER BY n.full_path`).all(user.is_admin ? 1 : 0, user.id);
    return [own, ...groups].filter(Boolean);
  };
  const renderNew = (req, reply, extra = {}, status = 200) => {
    const templates = kit.sql('SELECT name, title, description FROM project_templates ORDER BY title').all();
    const targets = newProjectTargets(req.user);
    const nsParam = req.query.namespace_id ? String(req.query.namespace_id) : '';
    return reply.render('repo/project_new', { title: 'New Project', crumbs: [['Your work', '/dashboard/projects'], ['Projects', '/dashboard/projects'], ['New project']], templates, targets, values: { namespace_id: nsParam || String(targets[0] ? targets[0].id : ''), visibility: 'private', readme: '1', template: req.query.template || '' }, errors: {}, ...extra }, status);
  };
  app.get('/projects/new', { config: { login: true } }, async (req, reply) => renderNew(req, reply));
  app.post('/projects', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    const targets = newProjectTargets(req.user);
    const values = { name: String(b.name || '').trim(), path: String(b.path || '').trim(), namespace_id: String(b.namespace_id || (targets[0] && targets[0].id) || ''), description: String(b.description || ''),
      visibility: String(b.visibility || 'private'), readme: b.readme === '1' || b.readme === 'on' ? '1' : '', template: String(b.template || ''), mode: String(b.mode || (b.template ? 'template' : 'blank')) };
    if (!values.path && values.name) values.path = write.slugPath(values.name);
    const ns = targets.find((t) => String(t.id) === values.namespace_id);
    const errors = write.validateProjectPath(ns ? ns.full_path : '', values.path, values.name);
    if (!ns) errors.namespace_id = 'Please select a namespace';
    if (!['private', 'internal', 'public'].includes(values.visibility)) errors.visibility = 'Select a visibility level';
    if (values.mode === 'template' && !values.template) errors.template = 'Choose a template';
    if (Object.keys(errors).length) return renderNew(req, reply, { values, errors }, 422);
    const p = write.createProject(req.user, ns, { name: values.name, path: values.path, description: values.description, visibility: values.visibility, readme: values.mode !== 'template' && !!values.readme, template: values.mode === 'template' ? values.template : null });
    req.flash('success', `Project '${p.name}' was successfully created.`);
    return reply.redirect('/' + p.full_path);
  });

  void collab;
};
