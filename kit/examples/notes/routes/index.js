'use strict';
// Notes routes. Every handler runs inside the tenant transaction (kit wraps them):
// req.tenant, req.user, req.session, kit.db(), kit.now() are ready to use.
module.exports = async function routes(app, kit) {
  kit.authRoutes(app, { loginPath: '/login', logoutPath: '/logout' });

  const SORT = { options: { created: 'n.created_at', title: 'n.title COLLATE NOCASE', likes: 'n.likes' }, default: 'created_desc', tiebreak: 'n.id', labels: { created_desc: 'Newest', created_asc: 'Oldest', title_asc: 'Title A-Z', title_desc: 'Title Z-A', likes_desc: 'Most liked', likes_asc: 'Least liked' } };
  const FILTERS = {
    tag: { col: 'n.tag', label: 'Tag' },
    status: { col: 'n.status', label: 'Status' },
    author: { sql: 'n.user_id IN (SELECT id FROM users WHERE username = ?)', label: 'Author' },
    likes_min: { col: 'n.likes', op: '>=', type: 'int', label: 'Min likes' },
  };
  const TAGS = ['work', 'personal', 'ideas', 'travel', 'food', 'music', 'tech', 'finance'];

  // GET /?q=&tag=&status=&author=&likes_min=&sort=created_desc&page=&per_page=
  app.get('/', async (req, reply) => {
    const db = kit.db();
    const f = kit.filters(req, FILTERS);
    const sort = kit.sorter(req, SORT);
    const q = String(req.query.q || '').trim();
    const s = q ? kit.search.prepare(db, 'notes_fts', q, { weights: { title: 5, body: 1 }, synonyms: 'synonyms' }) : null;
    const from = s && s.match ? 'notes_fts JOIN notes n ON n.id = notes_fts.rowid' : 'notes n';
    const where = s && s.match ? `notes_fts MATCH ? AND ${f.where}` : f.where;
    const params = s && s.match ? [s.match, ...f.params] : f.params;
    const total = kit.countCapped(db, `FROM ${from} WHERE ${where}`, params, 10000);
    const pager = kit.paginate(req, total, { perPage: 20, cap: 10000 });
    // relevance first when searching unless the user picked a sort
    const order = s && s.match && !req.query.sort ? `${s.rank}, n.id` : sort.orderBy;
    const rows = kit.sql(`SELECT n.id, n.title, n.tag, n.status, n.likes, n.created_at, (SELECT username FROM users WHERE id = n.user_id) AS username,
        ${s && s.match ? s.snippet('body', 14) : "substr(n.body, 1, 120)"} AS snip
      FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, pager.limit, pager.offset);
    const suggestion = q && !total ? kit.search.didYouMean(db, 'notes_fts', q) : null;
    return reply.render('list', { title: q ? `Search: ${q}` : 'Notes', rows, pager, sort, f, q, suggestion, tags: TAGS, searching: !!(s && s.match), crumbs: [['Home', '/'], ['Notes']] });
  });

  const load = (id) => {
    const n = kit.sql('SELECT n.*, u.username, u.display_name FROM notes n JOIN users u ON u.id = n.user_id WHERE n.id = ?').get(id);
    if (!n) throw kit.httpError(404, `Note ${id} not found`);
    return n;
  };
  const canEdit = (req, n) => req.user && (req.user.id === n.user_id || req.hasRole('admin'));

  const RULES = {
    title: { required: true, maxLength: 200 },
    body: { required: true, maxLength: 20000 },
    tag: { required: true, oneOf: TAGS },
    likes: { type: 'int', min: 0, max: 1000000, default: 0, label: 'Likes' },
  };

  app.get('/notes/new', { config: { login: true } }, async (req, reply) =>
    reply.render('form', { title: 'New note', note: null, values: { tag: 'personal' }, errors: {}, tags: TAGS, crumbs: [['Home', '/'], ['New note']] }));

  app.post('/notes', { config: { login: true } }, async (req, reply) => {
    const v = kit.validate(req.body, RULES);
    if (!v.ok) return reply.render('form', { title: 'New note', note: null, values: v.values, errors: v.errors, tags: TAGS }, 422);
    const att = req.body.attachment && req.body.attachment.url ? req.body.attachment.url : null;
    const now = kit.nowSql();
    const r = kit.db().prepare("INSERT INTO notes (user_id, title, body, tag, status, likes, attachment, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)")
      .run(req.user.id, v.values.title, v.values.body, v.values.tag, v.values.likes, att, now, now);
    req.flash('success', 'Note created.');
    return reply.redirect(`/notes/${r.lastInsertRowid}`);
  });

  app.get('/notes/:id', async (req, reply) => {
    const n = load(+req.params.id);
    return reply.render('note', { title: n.title, n, canEdit: canEdit(req, n), crumbs: [['Home', '/'], ['Notes', '/'], [n.title]] });
  });

  app.get('/notes/:id/edit', { config: { login: true } }, async (req, reply) => {
    const n = load(+req.params.id);
    if (!canEdit(req, n)) throw kit.httpError(403, 'You can only edit your own notes.');
    return reply.render('form', { title: `Edit: ${n.title}`, note: n, values: n, errors: {}, tags: TAGS, crumbs: [['Home', '/'], [n.title, `/notes/${n.id}`], ['Edit']] });
  });

  app.post('/notes/:id/edit', { config: { login: true } }, async (req, reply) => {
    const n = load(+req.params.id);
    if (!canEdit(req, n)) throw kit.httpError(403, 'You can only edit your own notes.');
    const v = kit.validate(req.body, RULES);
    if (!v.ok) return reply.render('form', { title: `Edit: ${n.title}`, note: n, values: v.values, errors: v.errors, tags: TAGS }, 422);
    kit.db().prepare('UPDATE notes SET title = ?, body = ?, tag = ?, likes = ?, updated_at = now() WHERE id = ?').run(v.values.title, v.values.body, v.values.tag, v.values.likes, n.id);
    req.flash('success', 'Note saved.');
    return reply.redirect(`/notes/${n.id}`);
  });

  app.post('/notes/:id/delete', { config: { login: true } }, async (req, reply) => {
    const n = load(+req.params.id);
    if (!canEdit(req, n)) throw kit.httpError(403, 'You can only delete your own notes.');
    kit.db().prepare('DELETE FROM notes WHERE id = ?').run(n.id);
    req.flash('success', `Deleted "${n.title}".`);
    return reply.redirect('/');
  });

  // schedule publishing in 10 minutes of site time (a background job)
  app.post('/notes/:id/publish', { config: { login: true } }, async (req, reply) => {
    const n = load(+req.params.id);
    if (!canEdit(req, n)) throw kit.httpError(403);
    kit.db().prepare("UPDATE notes SET status = 'scheduled' WHERE id = ?").run(n.id);
    kit.jobs.enqueue('note.publish', { id: n.id }, { delay: 600 });
    req.flash('success', 'Publishing scheduled in 10 minutes.');
    return reply.redirect(`/notes/${n.id}`);
  });

  // XHR endpoint (CSRF token comes from the X-CSRF-Token header, see kit.js)
  app.post('/api/notes/:id/like', async (req) => {
    const db = kit.db();
    load(+req.params.id);
    db.prepare('UPDATE notes SET likes = likes + 1 WHERE id = ?').run(+req.params.id);
    return { likes: db.prepare('SELECT likes FROM notes WHERE id = ?').pluck().get(+req.params.id) };
  });

  app.get('/admin', { config: { role: 'admin' } }, async (req, reply) => {
    const db = kit.db();
    const stats = db.prepare('SELECT status, count(*) AS n FROM notes GROUP BY status ORDER BY status').all();
    const jobs = db.prepare('SELECT * FROM kit_jobs ORDER BY id DESC LIMIT 50').all();
    return reply.render('admin', { title: 'Admin', stats, jobs, crumbs: [['Home', '/'], ['Admin']] });
  });

  // demo/test: writes, then throws -> the write is rolled back, the rollout transaction survives
  app.post('/debug/fail', { config: { csrf: false } }, async () => {
    kit.db().prepare("UPDATE notes SET title = 'POISON' WHERE id = 1").run();
    throw new Error('simulated handler failure');
  });
};
