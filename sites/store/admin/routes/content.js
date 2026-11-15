'use strict';
// Content: CMS pages and blocks (grid, mass enable / disable / delete, edit), themes, design
// configuration.
const LAYOUTS = [['empty', 'Empty'], ['1column', '1 column'], ['2columns-left', '2 columns with left bar'], ['2columns-right', '2 columns with right bar'], ['3columns', '3 columns'], ['cms-full-width', 'Page -- Full Width'], ['category-full-width', 'Category -- Full Width'], ['product-full-width', 'Product -- Full Width']];

module.exports = (r, ctx) => {
  const { kit, U, grid, view } = ctx;
  const h = kit.escapeHtml;
  const like = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  for (const kind of ['page', 'block']) {
    const T = kind === 'page'
      ? { table: 'cms_pages', idp: 'page_id', title: 'Pages', one: 'page', grid: 'cms_page_listing', base: '/admin/cms/page/' }
      : { table: 'cms_blocks', idp: 'block_id', title: 'Blocks', one: 'block', grid: 'cms_block_listing', base: '/admin/cms/block/' };
    const editUrl = (id) => `${T.base}edit/${T.idp}/${id}/`;
    const SPEC = {
      id: T.grid, url: T.base, idCol: 'x.id', from: `${T.table} x`, defaultSort: 'id_asc',
      keyword: (q) => ({ where: `(x.title LIKE ? ESCAPE '\\' OR x.identifier LIKE ? ESCAPE '\\' OR x.content LIKE ? ESCAPE '\\')`, params: [like(q), like(q), like(q)] }),
      columns: [
        { key: 'id', label: 'ID', sql: 'x.id', cls: 'num', filter: { type: 'range' } },
        { key: 'title', label: 'Title', sql: 'x.title', filter: { type: 'text' }, html: (x) => `<a href="${editUrl(x._id)}">${h(x.title)}</a>` },
        { key: 'identifier', label: kind === 'page' ? 'URL Key' : 'Identifier', sql: 'x.identifier', filter: { type: 'text' } },
        ...(kind === 'page' ? [{ key: 'page_layout', label: 'Layout', sql: 'x.page_layout', filter: { type: 'select', options: LAYOUTS }, html: (x) => h((LAYOUTS.find((l) => l[0] === x.page_layout) || [0, x.page_layout || ''])[1]) }] : []),
        { key: 'store', label: 'Store View', sql: "'All Store Views'", sort: false },
        { key: 'is_active', label: 'Status', sql: 'x.is_active', filter: { type: 'select', options: [[1, 'Enabled'], [0, 'Disabled']] }, html: (x) => (x.is_active ? 'Enabled' : 'Disabled') },
        { key: 'created_at', label: 'Created', sql: 'x.created_at', filter: { type: 'daterange' }, html: (x) => h(U.date.datetime(x.created_at)) },
        { key: 'updated_at', label: 'Modified', sql: 'x.updated_at', filter: { type: 'daterange' }, html: (x) => h(U.date.datetime(x.updated_at)) },
        ...(kind === 'page' ? [{ key: 'meta_title', label: 'Meta Title', sql: 'x.meta_title', visible: false, filter: { type: 'text' } }, { key: 'content_heading', label: 'Content Heading', sql: 'x.content_heading', visible: false }] : []),
      ],
      rowActions: (x) => `<a href="${editUrl(x._id)}">Edit</a>${kind === 'page' ? ` &middot; <a href="/${h(x.identifier || '')}" target="_blank" rel="noopener">View</a>` : ''}`,
      massActions: [{ value: 'delete', label: 'Delete', confirm: 'Are you sure you want to delete selected items?' }, { value: 'disable', label: 'Disable' }, { value: 'enable', label: 'Enable' }],
    };
    SPEC.columns.find((c) => c.key === 'identifier').needed = true;
    const gridPage = async (req, reply) => view(reply, 'grid_page', { title: T.title, g: grid.build(req, kit, SPEC), crumbs: [['Content', null], ['Elements', null], [T.title, null]],
      actions: [{ label: `Add New ${kind === 'page' ? 'Page' : 'Block'}`, href: `${T.base}new/`, primary: true, id: 'add' }] });
    r.get(`/cms/${kind}`, gridPage);
    r.get(`/cms/${kind}/index`, gridPage);
    r.post(`/cms/${kind}/massAction`, async (req, reply) => {
      const ids = grid.selectedIds(req, kit, SPEC);
      const act = U.str(req.body.mass_action);
      const back = ctx.back(req, T.base);
      if (!ids.length) { req.flash('error', 'Please select item(s).'); return reply.redirect(back); }
      if (act === 'delete') for (const id of ids) kit.sql(`DELETE FROM ${T.table} WHERE id = ?`).run(id);
      else if (act === 'enable' || act === 'disable') for (const id of ids) kit.sql(`UPDATE ${T.table} SET is_active = ?, updated_at = ? WHERE id = ?`).run(act === 'enable' ? 1 : 0, kit.nowSql(), id);
      else { req.flash('error', 'Please select an action.'); return reply.redirect(back); }
      req.flash('success', act === 'delete' ? `A total of ${ids.length} record(s) have been deleted.` : `A total of ${ids.length} record(s) have been ${act}d.`);
      return reply.redirect(back);
    });
    for (const [act, val] of [['massEnable', 1], ['massDisable', 0]]) {
      r.post(`/cms/${kind}/${act}`, async (req, reply) => {
        const ids = U.ids(req.body.selected);
        for (const id of ids) kit.sql(`UPDATE ${T.table} SET is_active = ?, updated_at = ? WHERE id = ?`).run(val, kit.nowSql(), id);
        req.flash('success', `A total of ${ids.length} record(s) have been ${val ? 'enabled' : 'disabled'}.`);
        return reply.redirect(T.base);
      });
    }
    const load = (id) => { const x = kit.sql(`SELECT * FROM ${T.table} WHERE id = ?`).get(+id); if (!x) throw ctx.notFound(T.one); return x; };
    const form = (x, values = {}, errors = {}) => {
      const title = x ? x.title : `New ${kind === 'page' ? 'Page' : 'Block'}`;
      const v = kind === 'page'
        ? { is_active: x ? x.is_active : 1, title: x ? x.title : '', content_heading: x ? x.content_heading || '' : '', content: x ? x.content || '' : '', identifier: x ? x.identifier : '', meta_title: x ? x.meta_title || '' : '', meta_keywords: x ? x.meta_keywords || '' : '', meta_description: x ? x.meta_description || '' : '', page_layout: x ? x.page_layout || '1column' : 'cms-full-width', sort_order: x ? x.sort_order ?? 0 : 0, ...values }
        : { is_active: x ? x.is_active : 1, title: x ? x.title : '', identifier: x ? x.identifier : '', content: x ? x.content || '' : '', ...values };
      const sections = kind === 'page' ? [
        { fields: [{ name: 'is_active', label: 'Enable Page', type: 'checkbox', checkLabel: 'Enabled' }, { name: 'title', label: 'Page Title', required: true }] },
        { title: 'Content', collapsible: true, id: 'content', fields: [{ name: 'content_heading', label: 'Content Heading' }, { name: 'content', label: 'Content', type: 'textarea', rows: 14, note: 'HTML (Page Builder content is stored as HTML).' }] },
        { title: 'Search Engine Optimization', collapsible: true, id: 'search_engine_optimisation', fields: [{ name: 'identifier', label: 'URL Key', note: 'Relative to Web Site Base URL; leave empty to build it from the title.' }, { name: 'meta_title', label: 'Meta Title' }, { name: 'meta_keywords', label: 'Meta Keywords', type: 'textarea', rows: 3 }, { name: 'meta_description', label: 'Meta Description', type: 'textarea', rows: 3 }] },
        { title: 'Page in Websites', collapsible: true, open: false, id: 'websites', fields: [{ name: 'store_id', label: 'Store View', type: 'select', multiple: true, options: [[0, 'All Store Views'], [1, 'Default Store View']], value: [0] }] },
        { title: 'Design', collapsible: true, open: false, id: 'design', fields: [{ name: 'page_layout', label: 'Layout', type: 'select', options: LAYOUTS }, { name: 'sort_order', label: 'Sort Order', type: 'number' }] },
      ] : [
        { fields: [{ name: 'is_active', label: 'Enable Block', type: 'checkbox', checkLabel: 'Enabled' }, { name: 'title', label: 'Block Title', required: true }, { name: 'identifier', label: 'Identifier', required: true }, { name: 'store_id', label: 'Store View', type: 'select', multiple: true, options: [[0, 'All Store Views'], [1, 'Default Store View']], value: [0] }, { name: 'content', label: 'Content', type: 'textarea', rows: 14 }] },
      ];
      return {
        title, values: v, errors, sections, formId: 'edit_form', action: `${T.base}save/`, hidden: x ? { [T.idp]: x.id } : {},
        crumbs: [['Content', null], [T.title, T.base], [title, null]],
        actions: [{ label: 'Back', href: T.base, id: 'back' }, ...(x ? [{ label: 'Delete', post: `${T.base}delete/${T.idp}/${x.id}/`, confirm: `Are you sure you want to delete this ${T.one}?`, id: 'delete' }] : []),
          { label: 'Save & Duplicate', form: 'edit_form', name: 'back', value: 'duplicate', id: 'save_and_duplicate' }, { label: 'Save & Close', form: 'edit_form', name: 'back', value: 'close', id: 'save_and_close' }, { label: 'Save', form: 'edit_form', primary: true, id: 'save' }],
      };
    };
    r.get(`/cms/${kind}/new`, async (req, reply) => view(reply, 'form_page', form(null)));
    r.get(`/cms/${kind}/edit/${T.idp}/:id`, async (req, reply) => view(reply, 'form_page', form(load(req.params.id))));
    r.get(`/cms/${kind}/edit`, async (req, reply) => (req.query[T.idp] ? reply.redirect(editUrl(+req.query[T.idp])) : reply.redirect(`${T.base}new/`)));
    r.post(`/cms/${kind}/save`, async (req, reply) => {
      const b = req.body || {};
      const id = parseInt(U.str(b[T.idp]), 10) || null;
      const x = id ? load(id) : null;
      const v = { is_active: U.str(b.is_active) === '1' ? 1 : 0, title: U.str(b.title), identifier: U.str(b.identifier), content: b.content == null ? (x ? x.content : '') : String(Array.isArray(b.content) ? b.content.at(-1) : b.content) };
      if (kind === 'page') Object.assign(v, { content_heading: U.str(b.content_heading) || null, meta_title: U.str(b.meta_title) || null, meta_keywords: U.str(b.meta_keywords) || null, meta_description: U.str(b.meta_description) || null, page_layout: LAYOUTS.some((l) => l[0] === U.str(b.page_layout)) ? U.str(b.page_layout) : (x ? x.page_layout : '1column'), sort_order: parseInt(U.str(b.sort_order), 10) || 0 });
      const errors = {};
      if (!v.title) errors.title = 'This is a required field.';
      if (kind === 'page' && !v.identifier) v.identifier = U.slugify(v.title);
      if (kind === 'page' && v.identifier && !/^[a-z0-9][a-z0-9_\/-]*(\.[a-z0-9_-]+)?$/i.test(v.identifier)) errors.identifier = 'The page URL key contains capital letters or disallowed symbols.';
      if (!v.identifier) errors.identifier = 'This is a required field.';
      else if (kit.sql(`SELECT 1 FROM ${T.table} WHERE identifier = ? AND id IS NOT ?`).get(v.identifier, x ? x.id : null)) errors.identifier = kind === 'page' ? 'The value specified in the URL Key field would generate a URL that already exists.' : 'A block identifier with the same properties already exists in the selected store.';
      if (Object.keys(errors).length) { const m = form(x, v, errors); m.errorsList = ['Please correct the highlighted fields.']; return view(reply, 'form_page', m, 422); }
      const now = kit.nowSql();
      let nid;
      if (x) { kit.db().prepare(`UPDATE ${T.table} SET ${Object.keys(v).map((k) => `${k} = @${k}`).join(', ')}, updated_at = @now WHERE id = @id`).run({ ...v, now, id: x.id }); nid = x.id; }
      else nid = Number(kit.db().prepare(`INSERT INTO ${T.table} (${Object.keys(v).join(', ')}, created_at, updated_at, source) VALUES (${Object.keys(v).map((k) => '@' + k).join(', ')}, @now, @now, 'admin')`).run({ ...v, now }).lastInsertRowid);
      req.flash('success', `You saved the ${T.one}.`);
      const back = U.str(b.back);
      if (back === 'duplicate') {
        let n = 1; while (kit.sql(`SELECT 1 FROM ${T.table} WHERE identifier = ?`).get(`${v.identifier}-${n}`)) n++;
        const dup = { ...v, identifier: `${v.identifier}-${n}`, is_active: 0 };
        const did = Number(kit.db().prepare(`INSERT INTO ${T.table} (${Object.keys(dup).join(', ')}, created_at, updated_at, source) VALUES (${Object.keys(dup).map((k) => '@' + k).join(', ')}, @now, @now, 'admin')`).run({ ...dup, now }).lastInsertRowid);
        req.flash('success', `You duplicated the ${T.one}.`);
        return reply.redirect(editUrl(did));
      }
      return reply.redirect(back === 'close' ? T.base : editUrl(nid));
    });
    r.post(`/cms/${kind}/delete/${T.idp}/:id`, async (req, reply) => {
      const x = load(req.params.id);
      kit.sql(`DELETE FROM ${T.table} WHERE id = ?`).run(x.id);
      req.flash('success', `You deleted the ${T.one}.`);
      return reply.redirect(T.base);
    });
  }

  // ---------------------------------------------------------------- themes
  const themeList = () => kit.sql('SELECT t.*, (SELECT title FROM themes p WHERE p.id = t.parent_id) AS parent_title FROM themes t WHERE t.area = \'frontend\' ORDER BY t.id').all();
  const themesPage = async (req, reply) => {
    const rows = themeList();
    const html = `<table class="data-grid" id="theme_grid"><thead><tr><th>Theme Title</th><th>Parent Theme</th><th>Theme Path</th><th>Action</th></tr></thead><tbody>${rows.map((t) => `<tr><td><a href="/admin/admin/system_design_theme/edit/id/${t.id}/">${h(t.title)}</a></td><td>${h(t.parent_title || '')}</td><td>frontend/${h(t.code)}</td><td><a href="/admin/admin/system_design_theme/edit/id/${t.id}/">Edit</a></td></tr>`).join('')}</tbody></table>`;
    return view(reply, 'message_page', { title: 'Themes', html, crumbs: [['Content', null], ['Design', null], ['Themes', null]] });
  };
  r.get('/admin/system_design_theme', themesPage);
  r.get('/system_design_theme', themesPage);
  const themeEdit = async (req, reply) => {
    const t = kit.sql('SELECT t.*, (SELECT title FROM themes p WHERE p.id = t.parent_id) AS parent_title FROM themes t WHERE t.id = ?').get(+req.params.id);
    if (!t) throw ctx.notFound('theme');
    const current = kit.sql("SELECT value FROM store_config WHERE path = 'design/theme/theme_id'").pluck().get();
    const html = `<section class="admin__page-section"><h2 class="admin__page-section-title">Theme: ${h(t.title)}</h2>
      <table class="admin__table-secondary" id="theme_info"><tbody><tr><th>Theme Title</th><td>${h(t.title)}</td></tr><tr><th>Parent Theme</th><td>${h(t.parent_title || 'N/A')}</td></tr><tr><th>Theme Path</th><td>${h(t.area)}/${h(t.code)}</td></tr><tr><th>Area</th><td>${h(t.area)}</td></tr><tr><th>Applied to Default Store View</th><td>${String(current) === String(t.id) ? 'Yes' : 'No'}</td></tr></tbody></table>
      <h3>Theme Preview Image</h3>${t.preview_image ? `<p class="muted">preview_image: ${h(t.preview_image)}</p>` : '<p class="muted">No preview image.</p>'}
      <p><a href="/" target="_blank" rel="noopener">Preview the storefront</a> &middot; <a href="/admin/theme/design_config/edit/scope/stores/scope_id/1/">Apply this theme (Design Configuration)</a></p></section>`;
    return view(reply, 'message_page', { title: t.title, html, crumbs: [['Content', null], ['Themes', '/admin/admin/system_design_theme/'], [t.title, null]], actions: [{ label: 'Back', href: '/admin/admin/system_design_theme/' }] });
  };
  r.get('/admin/system_design_theme/edit/id/:id', themeEdit);
  r.get('/system_design_theme/edit/id/:id', themeEdit);

  // ---------------------------------------------------------------- design configuration
  r.get('/theme/design_config', async (req, reply) => {
    const id = kit.sql("SELECT value FROM store_config WHERE path = 'design/theme/theme_id'").pluck().get();
    const t = kit.sql('SELECT title FROM themes WHERE id = ?').pluck().get(+id) || '';
    const html = `<table class="data-grid" id="design_config_grid"><thead><tr><th>Website</th><th>Store</th><th>Store View</th><th>Theme Name</th><th>Action</th></tr></thead><tbody>
      <tr><td>Global</td><td></td><td></td><td>${h(t)}</td><td><a href="/admin/theme/design_config/edit/scope/default/">Edit</a></td></tr>
      <tr><td>Main Website</td><td></td><td></td><td>${h(t)}</td><td><a href="/admin/theme/design_config/edit/scope/websites/scope_id/1/">Edit</a></td></tr>
      <tr><td>Main Website</td><td>Main Website Store</td><td>Default Store View</td><td>${h(t)}</td><td><a href="/admin/theme/design_config/edit/scope/stores/scope_id/1/">Edit</a></td></tr></tbody></table>`;
    return view(reply, 'message_page', { title: 'Design Configuration', html, crumbs: [['Content', null], ['Design', null], ['Configuration', null]] });
  });
  const cfg = (p) => kit.sql('SELECT value FROM store_config WHERE path = ?').pluck().get(p);
  const designForm = (values = {}) => ({
    title: 'Main Website / Main Website Store / Default Store View', action: '/admin/theme/design_config/save/', crumbs: [['Content', null], ['Design Configuration', '/admin/theme/design_config/'], ['Edit', null]],
    values: { 'theme_theme_id': cfg('design/theme/theme_id') || 3, head_default_title: cfg('design/head/default_title') || 'Magento Commerce', head_default_description: cfg('design/head/default_description') || '', footer_copyright: cfg('design/footer/copyright') || '', header_welcome: cfg('design/header/welcome') || 'Default welcome msg!', ...values },
    actions: [{ label: 'Back', href: '/admin/theme/design_config/' }, { label: 'Save Configuration', form: 'edit_form', primary: true, id: 'save' }],
    sections: [{ title: 'Default Theme', fields: [{ name: 'theme_theme_id', label: 'Applied Theme', type: 'select', options: themeList().map((t) => [t.id, t.title]) }] },
      { title: 'HTML Head', collapsible: true, fields: [{ name: 'head_default_title', label: 'Default Page Title' }, { name: 'head_default_description', label: 'Default Meta Description', type: 'textarea', rows: 3 }] },
      { title: 'Header', collapsible: true, open: false, fields: [{ name: 'header_welcome', label: 'Welcome Text' }] },
      { title: 'Footer', collapsible: true, open: false, fields: [{ name: 'footer_copyright', label: 'Copyright' }] }],
  });
  r.get('/theme/design_config/edit/*', async (req, reply) => view(reply, 'form_page', designForm()));
  r.get('/theme/design_config/edit', async (req, reply) => view(reply, 'form_page', designForm()));
  r.post('/theme/design_config/save', async (req, reply) => {
    const b = req.body || {};
    const tid = parseInt(U.str(b.theme_theme_id), 10);
    if (tid && kit.sql("SELECT 1 FROM themes WHERE id = ? AND area = 'frontend'").get(tid)) kit.sql("INSERT OR REPLACE INTO store_config (path, value) VALUES ('design/theme/theme_id', ?)").run(String(tid));
    for (const [k, p] of [['head_default_title', 'design/head/default_title'], ['head_default_description', 'design/head/default_description'], ['header_welcome', 'design/header/welcome'], ['footer_copyright', 'design/footer/copyright']]) {
      if (U.has(b, k)) kit.sql('INSERT OR REPLACE INTO store_config (path, value) VALUES (?, ?)').run(p, U.str(b[k]));
    }
    req.flash('success', 'You saved the configuration.');
    return reply.redirect('/admin/theme/design_config/');
  });
};
