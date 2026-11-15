'use strict';
// Branches and tags: list, search, create, delete.
const code = require('../../lib/code');
const git = require('../lib/git');
const write = require('../lib/write');
const R = require('../lib/repo');

module.exports = async function (app, kit) {
  const STALE_DAYS = 90;
  // ---------------------------------------------------------------- branches
  const branchesPage = async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const state = ['active', 'stale', 'all'].includes(req.params.state) ? req.params.state : 'overview';
    const q = String(req.query.search || '').trim();
    const sort = ['name_asc', 'updated_asc', 'updated_desc'].includes(req.query.sort) ? req.query.sort : state === 'all' ? 'name_asc' : 'updated_desc';
    const staleBefore = new Date(kit.now().getTime() - STALE_DAYS * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
    const conds = ["r.project_id = ?", "r.kind = 'branch'"];
    const ps = [p.id];
    if (q) { conds.push("r.name LIKE ? ESCAPE '\\'"); ps.push(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`); }
    const order = sort === 'name_asc' ? 'r.name' : sort === 'updated_asc' ? 'c.committed_at, r.name' : 'c.committed_at DESC, r.name';
    const all = kit.db().prepare(`SELECT r.name, r.sha, c.title, c.committed_at, c.author_name FROM refs r LEFT JOIN commits c ON c.sha = r.sha WHERE ${conds.join(' AND ')} ORDER BY r.name = ? DESC, ${order}`).all(...ps, p.default_branch || '');
    for (const b of all) { b.stale = (b.committed_at || '') < staleBefore; b.protected = R.isProtected(p.id, b.name); b.isDefault = b.name === p.default_branch; }
    let sections;
    const perPage = 20;
    if (state === 'overview') {
      sections = [{ title: 'Active branches', rows: all.filter((b) => !b.stale).slice(0, 5), more: all.filter((b) => !b.stale).length > 5 ? 'active' : null },
        { title: 'Stale branches', rows: all.filter((b) => b.stale).slice(0, 5), more: all.filter((b) => b.stale).length > 5 ? 'stale' : null }];
    } else {
      const rows = state === 'all' ? all : all.filter((b) => (state === 'stale' ? b.stale : !b.stale));
      const pager = kit.paginate(req, rows.length, { perPage });
      sections = [{ title: { active: 'Active branches', stale: 'Stale branches', all: 'All branches' }[state], rows: rows.slice(pager.offset, pager.offset + perPage), pager }];
    }
    const mrs = kit.sql("SELECT source_branch, iid, state FROM merge_requests WHERE source_project_id = ? AND state = 'opened'").all(p.id);
    const mrBy = Object.fromEntries(mrs.map((m) => [m.source_branch, m]));
    return reply.render('repo/branches', { project: p, nav: 'repo.branches', title: 'Branches', crumbs: [['Repository', R.treeUrl(p, p.default_branch || 'main')], ['Branches']],
      state, q, sort, sections, total: all.length, canPush: R.canPush(req.user, p, null), canAdmin: (p.access || 0) >= code.ACCESS.MAINTAINER, mrBy });
  };
  app.get('/:ns/:proj/-/branches', branchesPage);
  app.get('/:ns/:proj/-/branches/:state', async (req, reply) => {
    if (req.params.state === 'new') return newBranch(req, reply);
    if (!['active', 'stale', 'all', 'overview'].includes(req.params.state)) throw kit.httpError(404, 'Page not found');
    return branchesPage(req, reply);
  });
  const newBranch = async (req, reply, { values, errors = {}, status = 200 } = {}) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!R.canPush(req.user, p, null)) throw kit.httpError(req.user ? 403 : 401, "You don't have permission to create branches in this project.");
    return reply.render('repo/branch_new', { project: p, nav: 'repo.branches', title: 'New branch', crumbs: [['Repository', R.treeUrl(p, p.default_branch || 'main')], ['Branches', `${p.url}/-/branches`], ['New']],
      values: values || { branch_name: String(req.query.branch_name || ''), ref: String(req.query.ref || p.default_branch || '') }, errors, refs: R.refOptions(p) }, status);
  };
  app.post('/:ns/:proj/-/branches', { config: { login: true } }, async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!R.canPush(req.user, p, null)) throw kit.httpError(403, "You don't have permission to create branches in this project.");
    const b = req.body || {};
    const values = { branch_name: String(b.branch_name || '').trim(), ref: String(b.ref || p.default_branch || '').trim() };
    const errors = {};
    if (!values.branch_name) errors.branch_name = 'Branch name is required';
    else if (!write.validRefName(values.branch_name)) errors.branch_name = 'Branch name is invalid';
    else if (git.getRef(p.id, 'branch', values.branch_name)) errors.branch_name = 'Branch already exists';
    if (!git.resolveRef(p, values.ref)) errors.ref = 'Invalid reference name: ' + values.ref;
    if (Object.keys(errors).length) return newBranch(req, reply, { values, errors, status: 422 });
    write.createBranch(p, req.user, values.branch_name, values.ref);
    req.flash('success', `Branch ${values.branch_name} was created.`);
    return reply.redirect(R.treeUrl(p, values.branch_name));
  });
  const delBranch = async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const name = String((req.body && req.body.branch_name) || req.params['*'] || '');
    if (!R.canPush(req.user, p, { kind: 'branch', name })) throw kit.httpError(403, 'You are not allowed to delete this branch.');
    if (R.isProtected(p.id, name) && (p.access || 0) < code.ACCESS.MAINTAINER) throw kit.httpError(403, 'You are not allowed to delete a protected branch.');
    try { write.deleteBranch(p, req.user, name); }
    catch (e) { if (e.statusCode !== 422 && e.statusCode !== 404) throw e; req.flash('error', e.message); return reply.redirect(`${p.url}/-/branches`); }
    req.flash('success', `Branch '${name}' was deleted.`);
    return reply.redirect(String((req.body && req.body.next) || '').startsWith(p.url + '/-/branches') ? req.body.next : `${p.url}/-/branches`);
  };
  app.post('/:ns/:proj/-/branches/delete', { config: { login: true } }, delBranch);
  app.post('/:ns/:proj/-/branches/destroy/*', { config: { login: true } }, delBranch);

  // ---------------------------------------------------------------- tags
  app.get('/:ns/:proj/-/tags', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const q = String(req.query.search || '').trim();
    const sort = ['name_asc', 'updated_asc', 'updated_desc', 'name_desc'].includes(req.query.sort) ? req.query.sort : 'updated_desc';
    const conds = ['r.project_id = ?', "r.kind = 'tag'"];
    const ps = [p.id];
    if (q) { conds.push("r.name LIKE ? ESCAPE '\\'"); ps.push(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`); }
    const order = { name_asc: 'r.name', name_desc: 'r.name DESC', updated_asc: 'c.committed_at, r.name', updated_desc: 'c.committed_at DESC, r.name' }[sort];
    const total = kit.db().prepare(`SELECT count(*) FROM refs r WHERE ${conds.join(' AND ')}`).pluck().get(...ps);
    const pager = kit.paginate(req, total, { perPage: 20 });
    const rows = kit.db().prepare(`SELECT r.*, c.title, c.committed_at FROM refs r LEFT JOIN commits c ON c.sha = r.sha WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...ps, pager.limit, pager.offset);
    return reply.render('repo/tags', { project: p, nav: 'repo.tags', title: 'Tags', crumbs: [['Repository', R.treeUrl(p, p.default_branch || 'main')], ['Tags']], rows, pager, q, sort, canPush: R.canPush(req.user, p, null), canAdmin: (p.access || 0) >= code.ACCESS.MAINTAINER });
  });
  const newTag = async (req, reply, { values, errors = {}, status = 200 } = {}) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!R.canPush(req.user, p, null)) throw kit.httpError(req.user ? 403 : 401, "You don't have permission to create tags in this project.");
    return reply.render('repo/tag_new', { project: p, nav: 'repo.tags', title: 'New tag', crumbs: [['Repository', R.treeUrl(p, p.default_branch || 'main')], ['Tags', `${p.url}/-/tags`], ['New']],
      values: values || { tag_name: '', ref: String(req.query.ref || p.default_branch || ''), message: '' }, errors, refs: R.refOptions(p) }, status);
  };
  app.get('/:ns/:proj/-/tags/new', { config: { login: true } }, async (req, reply) => newTag(req, reply));
  app.post('/:ns/:proj/-/tags', { config: { login: true } }, async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if (!R.canPush(req.user, p, null)) throw kit.httpError(403, "You don't have permission to create tags in this project.");
    const b = req.body || {};
    const values = { tag_name: String(b.tag_name || '').trim(), ref: String(b.ref || '').trim(), message: String(b.message || '') };
    const errors = {};
    if (!values.tag_name) errors.tag_name = 'Tag name is required';
    else if (!write.validRefName(values.tag_name)) errors.tag_name = 'Tag name invalid';
    else if (git.getRef(p.id, 'tag', values.tag_name)) errors.tag_name = `Tag ${values.tag_name} already exists`;
    if (!git.resolveRef(p, values.ref)) errors.ref = 'Target ' + values.ref + ' is invalid';
    if (Object.keys(errors).length) return newTag(req, reply, { values, errors, status: 422 });
    write.createTag(p, req.user, { name: values.tag_name, ref: values.ref, message: values.message });
    req.flash('success', `Tag ${values.tag_name} was created.`);
    return reply.redirect(`${p.url}/-/tags/${code.encPath(values.tag_name)}`);
  });
  app.post('/:ns/:proj/-/tags/delete', { config: { login: true } }, async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    if ((p.access || 0) < code.ACCESS.MAINTAINER) throw kit.httpError(403, 'You are not allowed to delete tags.');
    const name = String((req.body && req.body.tag_name) || '');
    try { write.deleteTag(p, req.user, name); } catch (e) { if (e.statusCode !== 404) throw e; req.flash('error', e.message); return reply.redirect(`${p.url}/-/tags`); }
    req.flash('success', `Tag ${name} was deleted.`);
    return reply.redirect(`${p.url}/-/tags`);
  });
  app.get('/:ns/:proj/-/tags/*', async (req, reply) => {
    const p = code.loadProject(req, req.params.ns, req.params.proj);
    const name = req.params['*'];
    const t = git.getRef(p.id, 'tag', name);
    if (!t) throw kit.httpError(404, 'Tag not found');
    const c = git.commitBySha(t.sha);
    return reply.render('repo/tag', { project: p, nav: 'repo.tags', title: name, crumbs: [['Repository', R.treeUrl(p, p.default_branch || 'main')], ['Tags', `${p.url}/-/tags`], [name]], t, c });
  });
};
