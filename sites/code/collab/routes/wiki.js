'use strict';
// Project wiki (wiki_pages = current version of each page): home, page list, show, new,
// create, edit, delete. Slugs may contain '/' (directories). Developer+ edit (GitLab default).
//   /:ns/:proj/-/wikis  /-/wikis/pages  /-/wikis/new  /-/wikis/<slug>  /-/wikis/<slug>/edit
module.exports = function wiki(app, ctx) {
  const { kit, U, A, I, P, view } = ctx;
  const FORMATS = [['markdown', 'Markdown'], ['rdoc', 'RDoc'], ['asciidoc', 'AsciiDoc'], ['org', 'Org']];
  const slugify = (t) => U.str(t).replace(/\s+/g, '-').replace(/[?#%\\]/g, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  const need = (req, project) => { if (!req.user) throw kit.httpError(401, 'Please sign in.'); if (project.access < A.DEVELOPER) throw kit.httpError(403, 'You need at least the Developer role to edit the wiki.'); if (project.archived) throw kit.httpError(403, 'This project is archived.'); };
  const load = (req) => { const p = A.loadProject(req); if (!p.wiki_enabled) throw kit.httpError(404, 'The wiki is disabled for this project.'); return p; };
  const pages = (pid) => kit.sql('SELECT slug, title, updated_at FROM wiki_pages WHERE project_id = ? ORDER BY slug COLLATE NOCASE').all(pid);
  const base = (p) => `${p.base}/-/wikis`;
  const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');

  app.get(P('wikis'), async (req, reply) => reply.redirect(`${base(load(req))}/home`));
  app.get(P('wikis/pages'), async (req, reply) => {
    const project = load(req);
    const sort = U.str(req.query.sort) === 'created_at' ? 'updated_at' : 'title';
    const dir = U.str(req.query.direction) === 'desc' ? 'DESC' : 'ASC';
    const rows = kit.sql(`SELECT slug, title, updated_at, author_name FROM wiki_pages WHERE project_id = ? ORDER BY ${sort === 'title' ? 'slug COLLATE NOCASE' : 'updated_at'} ${dir}`).all(project.id);
    return view(reply, 'wiki_pages', { title: 'Wiki pages', project, nav: 'wiki', rows, sort, dir, base: base(project), canEdit: project.access >= A.DEVELOPER && !project.archived, enc, crumbs: [['Wiki', `${base(project)}/home`], ['Pages']] });
  });
  app.get(P('wikis/new'), { config: { login: true } }, async (req, reply) => {
    const project = load(req); need(req, project);
    return form(reply, project, null, { title: U.str(req.query.title), format: 'markdown', content: '' }, {});
  });
  function form(reply, project, page, values, errors, status) {
    return view(reply, 'wiki_form', { title: page ? `Edit · ${page.title}` : 'New Wiki Page', project, nav: 'wiki', page, values, errors, formats: FORMATS, base: base(project), enc, pages: pages(project.id), crumbs: [['Wiki', `${base(project)}/home`], [page ? 'Edit' : 'New page']] }, status);
  }
  function save(req, reply, project, page) {
    const b = req.body || {};
    const values = { title: U.str(b.title), content: String(b.content || '').replace(/\r\n/g, '\n'), format: FORMATS.some(([f]) => f === U.str(b.format)) ? U.str(b.format) : 'markdown', message: U.str(b.message) };
    const errors = {};
    const slug = slugify(values.title);
    if (!slug) errors.title = "Title can't be blank";
    else if (slug.split('/').some((s) => s === '.' || s === '..' || !s)) errors.title = 'Title is invalid';
    if (!values.content.trim()) errors.content = "Content can't be blank";
    if (!errors.title && (!page || page.slug !== slug) && kit.sql('SELECT 1 FROM wiki_pages WHERE project_id = ? AND slug = ? COLLATE NOCASE').get(project.id, slug)) errors.title = 'A page with that title already exists';
    if (Object.keys(errors).length) return form(reply, project, page, values, errors, 422);
    const now = kit.nowSql();
    const title = slug.split('/').pop().replace(/-/g, ' ');
    if (page) kit.sql('UPDATE wiki_pages SET slug = ?, title = ?, format = ?, content = ?, updated_at = ?, author_name = ? WHERE project_id = ? AND slug = ?').run(slug, title, values.format, values.content, now, req.user.name, project.id, page.slug);
    else kit.sql('INSERT INTO wiki_pages (project_id, slug, title, format, content, updated_at, author_name) VALUES (?, ?, ?, ?, ?, ?, ?)').run(project.id, slug, title, values.format, values.content, now, req.user.name);
    I.addEvent(project, req.user, page ? 'updated' : 'created', 'wiki_page', null, title);
    req.flash('success', page ? 'Wiki page was successfully updated.' : 'Wiki page was successfully created.');
    return reply.redirect(`${base(project)}/${enc(slug)}`);
  }
  app.post(P('wikis'), { config: { login: true } }, async (req, reply) => { const project = load(req); need(req, project); return save(req, reply, project, null); });

  // /-/wikis/<slug>[/edit|/delete]
  const parse = (req) => {
    const rest = decodeURIComponent(String(req.params['*'] || '')).replace(/\/+$/, '');
    const m = /^(.*?)\/(edit|delete|history)$/.exec(rest);
    return m ? { slug: m[1], action: m[2] } : { slug: rest, action: null };
  };
  const getPage = (project, slug) => kit.sql('SELECT * FROM wiki_pages WHERE project_id = ? AND slug = ? COLLATE NOCASE').get(project.id, slug);
  app.get(P('wikis/*'), async (req, reply) => {
    const project = load(req);
    const { slug, action } = parse(req);
    const page = getPage(project, slug);
    if (action === 'edit') {
      need(req, project);
      if (!page) return form(reply, project, null, { title: slug.replace(/-/g, ' '), format: 'markdown', content: '' }, {});
      return form(reply, project, page, { title: page.slug, format: page.format, content: page.content }, {});
    }
    if (!page) {
      if (slug === 'home') return view(reply, 'wiki_page', { title: 'Wiki', project, nav: 'wiki', page: null, slug, empty: true, base: base(project), enc, pages: pages(project.id), canEdit: project.access >= A.DEVELOPER && !project.archived, crumbs: [['Wiki']] });
      return view(reply, 'wiki_page', { title: slug, project, nav: 'wiki', page: null, slug, missing: true, base: base(project), enc, pages: pages(project.id), canEdit: project.access >= A.DEVELOPER && !project.archived, crumbs: [['Wiki', `${base(project)}/home`], [slug]] }, 404);
    }
    return view(reply, 'wiki_page', { title: page.title, project, nav: 'wiki', page, slug: page.slug, base: base(project), enc, pages: pages(project.id), canEdit: project.access >= A.DEVELOPER && !project.archived, crumbs: [['Wiki', `${base(project)}/home`], [page.title]] });
  });
  app.post(P('wikis/*'), { config: { login: true } }, async (req, reply) => {
    const project = load(req); need(req, project);
    const { slug, action } = parse(req);
    const page = getPage(project, slug);
    if (action === 'delete') {
      if (!page) throw kit.httpError(404, 'Wiki page not found');
      kit.sql('DELETE FROM wiki_pages WHERE project_id = ? AND slug = ?').run(project.id, page.slug);
      I.addEvent(project, req.user, 'destroyed', 'wiki_page', null, page.title);
      req.flash('success', `Wiki page "${page.title}" was successfully deleted.`);
      return reply.redirect(`${base(project)}/pages`);
    }
    if (action === 'edit') return save(req, reply, project, page || null);
    throw kit.httpError(404, 'Not found');
  });
};
