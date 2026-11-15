'use strict';
// Wiki: /wiki/<path>, /wiki/_create|_edit|_history/<path>, /wiki/_all, /wiki/_revision/<id>, /wiki/_lock|_unlock/<path>.
const F = require('../lib/forum');

module.exports = async function (app, kit) {
  const norm = (p) => String(p || '').trim().replace(/^\/+|\/+$/g, '').replace(/\s+/g, '_').toLowerCase();
  const valid = (p) => /^[a-z0-9_\-/]{1,100}$/.test(p) && !p.startsWith('_');
  const pathOf = (req) => decodeURIComponent(String(req.params['*'] || '')).replace(/^\/+|\/+$/g, '') || 'index';
  const page = (p) => kit.sql('SELECT * FROM wiki_pages WHERE normalized_path = ?').get(norm(p));
  const current = (pg) => kit.sql('SELECT r.*, u.username FROM wiki_revisions r JOIN users u ON u.id = r.user_id WHERE r.page_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 1').get(pg.id);
  const canEdit = (req, pg) => !!req.user && (!pg || !pg.locked || F.isAdmin(req.user));
  const crumbs = (p, last) => [['Wiki', '/wiki'], ...(last ? [[p, `/wiki/${p}`], [last]] : [[p]])];

  app.get('/wiki', async (req, reply) => reply.redirect('/wiki/index'));
  app.get('/wiki/_all', async (req, reply) => {
    const rows = kit.sql(`SELECT p.path, p.locked, (SELECT title FROM wiki_revisions r WHERE r.page_id = p.id ORDER BY created_at DESC, id DESC LIMIT 1) AS title,
      (SELECT max(created_at) FROM wiki_revisions r WHERE r.page_id = p.id) AS updated_at FROM wiki_pages p ORDER BY p.normalized_path`).all();
    return reply.render('wiki_all', { title: 'All wiki pages', rows, crumbs: [['Wiki', '/wiki'], ['All pages']] });
  });
  app.get('/wiki/_recent', async (req, reply) => {
    const rows = kit.sql('SELECT r.id, r.title, r.created_at, u.username, p.path FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC, r.id DESC LIMIT 50').all();
    return reply.render('wiki_history', { title: 'Recent wiki changes', rows, pg: null, path: null, crumbs: [['Wiki', '/wiki'], ['Recent changes']] });
  });
  app.get('/wiki/_history/*', async (req, reply) => {
    const p = pathOf(req);
    const pg = page(p);
    if (!pg) throw kit.httpError(404, `There is no wiki page "${p}".`);
    const rows = kit.sql('SELECT r.id, r.title, r.created_at, u.username FROM wiki_revisions r JOIN users u ON u.id = r.user_id WHERE r.page_id = ? ORDER BY r.created_at DESC, r.id DESC').all(pg.id);
    return reply.render('wiki_history', { title: `History of ${pg.path}`, rows, pg, path: pg.path, crumbs: crumbs(pg.path, 'History') });
  });
  app.get('/wiki/_revision/:id', async (req, reply) => {
    const r = kit.sql('SELECT r.*, u.username, p.path FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id JOIN users u ON u.id = r.user_id WHERE r.id = ?').get(+req.params.id || 0);
    if (!r) throw kit.httpError(404, 'No such revision.');
    return reply.render('wiki_page', { title: `${r.title} (revision ${r.id})`, pg: { path: r.path }, rev: r, revision: true, canEdit: false, crumbs: crumbs(r.path, `Revision ${r.id}`) });
  });

  function form(reply, req, { p, pg, values, errors = {}, status }) {
    return reply.render('wiki_form', { title: pg ? `Edit ${pg.path}` : `Create ${p}`, p, pg, values, errors, crumbs: crumbs(p, pg ? 'Edit' : 'Create') }, status);
  }
  const RULES = { title: { required: true, maxLength: 100 }, body: { required: true, maxLength: 50000 } };
  app.get('/wiki/_create/*', { config: { login: true } }, async (req, reply) => {
    const p = pathOf(req);
    if (page(p)) return reply.redirect(`/wiki/_edit/${norm(p)}`);
    return form(reply, req, { p: norm(p), pg: null, values: { path: norm(p), title: '' } });
  });
  app.get('/wiki/_create', { config: { login: true } }, async (req, reply) => form(reply, req, { p: '', pg: null, values: { path: '', title: '' } }));
  app.post('/wiki/_create', { config: { login: true } }, async (req, reply) => {
    const v = kit.validate(req.body, { path: { required: true, maxLength: 100, label: 'Path' }, ...RULES });
    const p = norm(v.values.path);
    if (!v.errors.path && !valid(p)) v.errors.path = 'Path: lower-case letters, digits, _, - and / only.';
    if (!v.errors.path && page(p)) v.errors.path = 'A page with that path already exists.';
    if (Object.keys(v.errors).length) return form(reply, req, { p, pg: null, values: v.values, errors: v.errors, status: 422 });
    const now = kit.nowSql();
    const id = Number(kit.sql('INSERT INTO wiki_pages (path, normalized_path, locked) VALUES (?, ?, 0)').run(p, p).lastInsertRowid);
    kit.sql('INSERT INTO wiki_revisions (page_id, user_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)').run(id, req.user.id, v.values.title, v.values.body, now);
    req.flash('success', 'The wiki page was created.');
    return reply.redirect(`/wiki/${p}`);
  });
  app.get('/wiki/_edit/*', { config: { login: true } }, async (req, reply) => {
    const p = pathOf(req);
    const pg = page(p);
    if (!pg) return reply.redirect(`/wiki/_create/${norm(p)}`);
    if (!canEdit(req, pg)) throw kit.httpError(403, 'This wiki page is locked.');
    const rev = current(pg);
    return form(reply, req, { p: pg.path, pg, values: { title: rev.title, body: rev.body } });
  });
  app.post('/wiki/_edit/*', { config: { login: true } }, async (req, reply) => {
    const p = pathOf(req);
    const pg = page(p);
    if (!pg) throw kit.httpError(404, `There is no wiki page "${p}".`);
    if (!canEdit(req, pg)) throw kit.httpError(403, 'This wiki page is locked.');
    const v = kit.validate(req.body, RULES);
    if (!v.ok) return form(reply, req, { p: pg.path, pg, values: v.values, errors: v.errors, status: 422 });
    kit.sql('INSERT INTO wiki_revisions (page_id, user_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)').run(pg.id, req.user.id, v.values.title, v.values.body, kit.nowSql());
    req.flash('success', 'The wiki page was saved.');
    return reply.redirect(`/wiki/${pg.path}`);
  });
  for (const [name, val] of [['_lock', 1], ['_unlock', 0]]) {
    app.post(`/wiki/${name}/*`, { config: { role: 'admin' } }, async (req, reply) => {
      const pg = page(pathOf(req));
      if (!pg) throw kit.httpError(404, 'No such wiki page.');
      kit.sql('UPDATE wiki_pages SET locked = ? WHERE id = ?').run(val, pg.id);
      req.flash('success', val ? 'The page was locked.' : 'The page was unlocked.');
      return reply.redirect(`/wiki/${pg.path}`);
    });
  }
  app.get('/wiki/*', async (req, reply) => {
    const p = pathOf(req);
    const pg = page(p);
    if (!pg) return reply.render('wiki_page', { title: p, pg: null, path: norm(p), rev: null, canEdit: !!req.user, crumbs: crumbs(p) }, 404);
    const rev = current(pg);
    return reply.render('wiki_page', { title: rev.title, pg, rev, canEdit: canEdit(req, pg), admin: F.isAdmin(req.user), crumbs: crumbs(pg.path) });
  });
};
