'use strict';
// Catalog > Categories: tree (with product counts), edit (general, content, display settings,
// SEO, products in category, parent / move), add subcategory / root category, delete.
module.exports = (r, ctx) => {
  const { kit, U, view } = ctx;
  const h = kit.escapeHtml;
  const MODES = [['PRODUCTS', 'Products only'], ['PAGE', 'Static block only'], ['PRODUCTS_AND_PAGE', 'Static block and products']];

  function tree(current) {
    const cats = kit.sql('SELECT id, parent_id, name, level, position, is_active, path FROM categories ORDER BY level, position, id').all();
    const counts = new Map(kit.sql('SELECT category_id, count(*) n FROM product_categories GROUP BY category_id').all().map((x) => [x.category_id, x.n]));
    const kids = new Map();
    for (const c of cats) { if (!kids.has(c.parent_id)) kids.set(c.parent_id, []); kids.get(c.parent_id).push(c); }
    const open = new Set(String(current ? current.path : '1/2').split('/').map(Number));
    const render = (pid, depth) => {
      const list = kids.get(pid) || [];
      if (!list.length) return '';
      return `<ul class="tree"${depth === 0 ? ' role="tree" aria-label="Categories"' : ' role="group"'}>${list.map((c) => {
        const sub = kids.get(c.id) || [];
        const expanded = open.has(c.id) || depth < 1;
        return `<li role="treeitem"${sub.length ? ` aria-expanded="${expanded}"` : ''}><a href="/admin/catalog/category/edit/id/${c.id}/"${current && current.id === c.id ? ' aria-current="page"' : ''}${c.is_active ? '' : ' class="muted"'}>${U.htmlName(c.name)} (${counts.get(c.id) || 0})</a>${sub.length ? (expanded ? render(c.id, depth + 1) : ` <a class="muted" href="/admin/catalog/category/edit/id/${c.id}/" aria-label="Expand ${h(U.plainName(c.name))}">[+${sub.length}]</a>`) : ''}</li>`;
      }).join('')}</ul>`;
    };
    return render(0, 0) || render(null, 0);
  }
  const load = (id) => { const c = kit.sql('SELECT * FROM categories WHERE id = ?').get(+id); if (!c) throw ctx.notFound('category'); return c; };
  const parentOptions = (exclude) => {
    const cats = kit.sql('SELECT id, name, path FROM categories ORDER BY path').all();
    const byId = new Map(cats.map((c) => [c.id, c]));
    return cats.filter((c) => !exclude || !(`/${c.path}/`.includes(`/${exclude.id}/`))).map((c) => [c.id, String(c.path).split('/').map((x) => byId.get(+x)).filter(Boolean).map((x) => U.plainName(x.name)).join(' / ')]).sort((a, b) => a[1].localeCompare(b[1]));
  };
  function model(c, { values = {}, errors = {}, parent = null, req } = {}) {
    const isNew = !c;
    const v = isNew
      ? { is_active: 1, include_in_menu: 1, name: '', description: '', display_mode: 'PRODUCTS', is_anchor: 1, url_key: '', meta_title: '', meta_keywords: '', meta_description: '', parent_id: parent ? parent.id : 1, position: '' }
      : { is_active: c.is_active, include_in_menu: c.include_in_menu, name: c.name, description: c.description || '', display_mode: c.display_mode || 'PRODUCTS', is_anchor: c.is_anchor, url_key: c.url_key || '', meta_title: c.meta_title || '', meta_keywords: c.meta_keywords || '', meta_description: c.meta_description || '', parent_id: c.parent_id, position: c.position ?? 0 };
    Object.assign(v, values);
    let products = []; let pager = null;
    if (c) {
      const total = kit.sql('SELECT count(*) FROM product_categories WHERE category_id = ?').pluck().get(c.id);
      pager = kit.paginate(req, total, { perPage: 20, maxPerPage: 200 });
      products = kit.sql('SELECT p.id, p.name, p.sku, p.price, p.status, p.visibility, pc.position FROM product_categories pc JOIN products p ON p.id = pc.product_id WHERE pc.category_id = ? ORDER BY pc.position, p.id LIMIT ? OFFSET ?').all(c.id, pager.limit, pager.offset);
    }
    const title = isNew ? 'New Category' : `${U.plainName(c.name)} (ID: ${c.id})`;
    const prodHtml = c ? `<p class="muted">${U.num(pager.total)} product(s) in this category${c.is_anchor ? ' (anchor: the storefront also lists the products of its subcategories)' : ''}.</p>
      <table class="admin__table-primary" id="catalog_category_products"><thead><tr><th>ID</th><th>Name</th><th>SKU</th><th>Visibility</th><th>Status</th><th class="num">Price</th><th>Position</th><th>Remove</th></tr></thead><tbody>
      ${products.map((p) => `<tr><td>${p.id}</td><td><a href="/admin/catalog/product/edit/id/${p.id}/">${U.htmlName(p.name)}</a></td><td>${h(p.sku)}</td><td>${{ 1: 'Not Visible Individually', 2: 'Catalog', 3: 'Search', 4: 'Catalog, Search' }[p.visibility] || ''}</td><td>${p.status === 1 ? 'Enabled' : 'Disabled'}</td><td class="num">${U.money(p.price)}</td>
        <td><input type="number" name="category_products[position][${p.id}]" value="${p.position ?? 0}" size="4" aria-label="Position of ${h(p.sku)}"></td><td><input type="checkbox" name="category_products[remove][]" value="${p.id}" aria-label="Remove ${h(p.sku)}"></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No products.</td></tr>'}
      </tbody></table>${pager.pages > 1 ? `<p>Page ${pager.page} of ${pager.pages}: ${pager.prev ? `<a href="${pager.prev}#products">&laquo; Previous</a>` : ''} ${pager.next ? `<a href="${pager.next}#products">Next &raquo;</a>` : ''}</p>` : ''}` : '<p class="muted">Save the category first, then assign products.</p>';
    return {
      title, c, values: v, errors, formId: 'category_edit_form', action: isNew ? '/admin/catalog/category/save/' : `/admin/catalog/category/save/id/${c.id}/`,
      treeHtml: tree(c || parent), crumbs: [['Catalog', null], ['Categories', '/admin/catalog/category/'], [title, null]],
      actions: [
        { label: 'Add Root Category', href: '/admin/catalog/category/add/parent/1/', id: 'add_root_category_button' },
        ...(c ? [{ label: 'Add Subcategory', href: `/admin/catalog/category/add/parent/${c.id}/`, id: 'add_subcategory_button' }] : []),
        ...(c && c.id > 2 ? [{ label: 'Delete', post: `/admin/catalog/category/delete/id/${c.id}/`, confirm: 'Are you sure you want to delete this category?', id: 'delete' }] : []),
        { label: 'Save', form: 'category_edit_form', primary: true, id: 'save' },
      ],
      sections: [
        { fields: [{ name: 'is_active', label: 'Enable Category', type: 'checkbox', checkLabel: 'Yes' }, { name: 'include_in_menu', label: 'Include in Menu', type: 'checkbox', checkLabel: 'Yes' }, { name: 'name', label: 'Category Name', required: true },
          ...(c && c.id <= 2 ? [] : [{ name: 'parent_id', label: 'Parent Category', type: 'select', options: parentOptions(c), note: 'Moving a category moves its subcategories; storefront URL paths are rebuilt.' }])] },
        { title: 'Content', collapsible: true, open: false, id: 'content', fields: [{ name: 'description', label: 'Description', type: 'textarea', rows: 6 }] },
        { title: 'Display Settings', collapsible: true, open: false, id: 'display_settings', fields: [{ name: 'display_mode', label: 'Display Mode', type: 'select', options: MODES }, { name: 'is_anchor', label: 'Anchor', type: 'checkbox', checkLabel: 'Yes' }, { name: 'position', label: 'Position', type: 'number' }] },
        { title: 'Search Engine Optimization', collapsible: true, open: false, id: 'search_engine_optimization', fields: [{ name: 'url_key', label: 'URL Key', note: c && c.url_path ? `Storefront URL: /${h(c.url_path)}.html` : '' }, { name: 'meta_title', label: 'Meta Title' }, { name: 'meta_keywords', label: 'Meta Keywords', type: 'textarea', rows: 3 }, { name: 'meta_description', label: 'Meta Description', type: 'textarea', rows: 3 }] },
        { title: 'Products in Category', collapsible: true, open: !!(req.query.page), id: 'products', fields: c ? [{ name: 'category_products[add]', label: 'Add Products', placeholder: 'SKUs or IDs, comma separated', value: '' }] : [], html: prodHtml },
      ],
    };
  }
  const page = (m) => (reply, status) => view(reply, 'category_edit', m, status);
  r.get('/catalog/category', async (req, reply) => page(model(load(2), { req }))(reply));
  r.get('/catalog/category/index', async (req, reply) => reply.redirect('/admin/catalog/category/'));
  r.get('/catalog/category/edit/id/:id', async (req, reply) => page(model(load(req.params.id), { req }))(reply));
  r.get('/catalog/category/add/parent/:pid', async (req, reply) => page(model(null, { parent: load(req.params.pid), req }))(reply));
  r.get('/catalog/category/add/store/:s/parent/:pid', async (req, reply) => reply.redirect(`/admin/catalog/category/add/parent/${req.params.pid}/`));

  // rebuild path / level of a category and its subtree; url_path: the category's own last
  // segment / prefix changes are applied to the whole subtree (other url_paths are kept as they
  // are: the Luma department's children keep their original top-level paths)
  function rebuild(id, oldUrl, newUrl) {
    const c = load(id);
    const p = c.parent_id ? kit.sql('SELECT * FROM categories WHERE id = ?').get(c.parent_id) : null;
    const path = p ? `${p.path}/${c.id}` : `1/${c.id}`;
    const level = p ? p.level + 1 : 1;
    let urlPath = c.url_path;
    if (level <= 1) urlPath = null;
    else if (oldUrl != null && c.url_path && (c.url_path === oldUrl || c.url_path.startsWith(`${oldUrl}/`))) urlPath = newUrl + c.url_path.slice(oldUrl.length);
    else if (!c.url_path) urlPath = p && p.level >= 2 && p.url_path ? `${p.url_path}/${c.url_key}` : c.url_key;
    kit.sql('UPDATE categories SET path = ?, level = ?, url_path = ?, updated_at = ? WHERE id = ?').run(path, level, urlPath, kit.nowSql(), c.id);
    for (const k of kit.sql('SELECT id FROM categories WHERE parent_id = ?').pluck().all(c.id)) rebuild(k, oldUrl, newUrl);
  }
  // the url_path a category gets under a parent (Magento: parent path + url key; the top level and
  // the Luma department, whose children kept their paths, start fresh)
  const lumaDept = () => +(kit.sql("SELECT value FROM build_info WHERE key = 'luma_department_category_id'").pluck().get() || 0);
  const urlPathUnder = (parent, key) => (parent && parent.level >= 2 && parent.url_path && parent.id !== lumaDept() ? `${parent.url_path}/${key}` : key);
  function refreshCounts(...ids) {
    for (const id of ids.filter(Boolean)) kit.sql('UPDATE categories SET children_count = (SELECT count(*) FROM categories x WHERE x.path LIKE (SELECT path FROM categories WHERE id = ?) || \'/%\') WHERE id = ?').run(id, id);
  }
  const save = async (req, reply) => {
    const c = req.params.id ? load(req.params.id) : null;
    const b = req.body || {};
    const v = {
      is_active: U.str(b.is_active) === '1' ? 1 : 0, include_in_menu: U.str(b.include_in_menu) === '1' ? 1 : 0, name: U.str(b.name), description: b.description == null ? (c ? c.description : null) : String(Array.isArray(b.description) ? b.description.at(-1) : b.description),
      display_mode: MODES.some((m) => m[0] === U.str(b.display_mode)) ? U.str(b.display_mode) : (c ? c.display_mode : 'PRODUCTS'), is_anchor: U.str(b.is_anchor) === '1' ? 1 : 0,
      url_key: U.slugify(U.str(b.url_key) || U.str(b.name)), meta_title: U.str(b.meta_title) || null, meta_keywords: U.str(b.meta_keywords) || null, meta_description: U.str(b.meta_description) || null,
    };
    const parentId = c && c.id <= 2 ? c.parent_id : parseInt(U.str(b.parent_id), 10) || (c ? c.parent_id : 1);
    const errors = {};
    if (!v.name) errors.name = 'This is a required field.';
    const parent = kit.sql('SELECT * FROM categories WHERE id = ?').get(parentId);
    if (!parent && parentId !== 0) errors.parent_id = 'Please select a valid parent category.';
    if (c && parent && `/${parent.path}/`.includes(`/${c.id}/`)) errors.parent_id = 'A category cannot be moved into its own subcategory.';
    if (parent && parent.level >= 1 && v.url_key && (!c || v.url_key !== c.url_key || parentId !== c.parent_id)) {
      const urlPath = urlPathUnder(parent, v.url_key);
      if (kit.sql('SELECT 1 FROM categories WHERE url_path = ? AND id IS NOT ?').get(urlPath, c ? c.id : null)) errors.url_key = 'The value specified in the URL Key field would generate a URL that already exists.';
    }
    if (Object.keys(errors).length) { const m = model(c, { values: { ...v, parent_id: parentId }, errors, parent, req }); m.errorsList = ['Please correct the highlighted fields.']; return page(m)(reply, 422); }
    const now = kit.nowSql();
    let id;
    const position = U.str(b.position) === '' ? null : parseInt(U.str(b.position), 10) || 0;
    if (c) {
      const moved = parentId !== c.parent_id;
      kit.db().prepare(`UPDATE categories SET ${Object.keys(v).map((k) => `${k} = @${k}`).join(', ')}, parent_id = @parent_id, position = coalesce(@position, position), updated_at = @now WHERE id = @id`).run({ ...v, parent_id: parentId, position, now, id: c.id });
      id = c.id;
      if (moved || v.url_key !== c.url_key) {
        const nu = moved ? urlPathUnder(parent, v.url_key) : (c.url_path ? c.url_path.replace(/[^/]*$/, v.url_key) : urlPathUnder(parent, v.url_key));
        rebuild(id, c.url_path, nu);
      }
      if (moved) refreshCounts(c.parent_id, parentId);
    } else {
      const pos = position ?? (kit.sql('SELECT coalesce(max(position), 0) + 1 FROM categories WHERE parent_id = ?').pluck().get(parentId));
      id = Number(kit.db().prepare(`INSERT INTO categories (${Object.keys(v).join(', ')}, parent_id, position, path, level, children_count, created_at, updated_at, source) VALUES (${Object.keys(v).map((k) => '@' + k).join(', ')}, @parent_id, @position, '', 0, 0, @now, @now, 'admin')`).run({ ...v, parent_id: parentId, position: pos, now }).lastInsertRowid);
      kit.sql('UPDATE categories SET url_path = ? WHERE id = ?').run(parent && parent.level >= 1 ? urlPathUnder(parent, v.url_key) : null, id);
      rebuild(id);
      refreshCounts(parentId);
    }
    // products in category
    if (c) {
      for (const pid of U.ids(b['category_products[remove][]'] ?? b['category_products[remove]'])) kit.sql('DELETE FROM product_categories WHERE product_id = ? AND category_id = ?').run(pid, id);
      for (const [k, val] of Object.entries(b)) {
        const m = /^category_products\[position\]\[(\d+)\]$/.exec(k);
        if (m) { const n = parseInt(U.str(val), 10); if (Number.isFinite(n)) kit.sql('UPDATE product_categories SET position = ? WHERE product_id = ? AND category_id = ? AND coalesce(position, -1) <> ?').run(n, +m[1], id, n); }
      }
      const add = U.str(b['category_products[add]']);
      if (add) {
        const bad = [];
        for (const tok of add.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)) {
          const p = /^\d+$/.test(tok) ? kit.sql('SELECT id FROM products WHERE id = ? OR sku = ?').get(+tok, tok) : kit.sql('SELECT id FROM products WHERE sku = ?').get(tok);
          if (!p) { bad.push(tok); continue; }
          kit.sql('INSERT OR IGNORE INTO product_categories (product_id, category_id, position) VALUES (?, ?, (SELECT coalesce(max(position), 0) + 1 FROM product_categories WHERE category_id = ?))').run(p.id, id, id);
        }
        if (bad.length) req.flash('error', `Products not found: ${bad.join(', ')}`);
      }
    }
    req.flash('success', 'You saved the category.');
    return reply.redirect(`/admin/catalog/category/edit/id/${id}/`);
  };
  r.post('/catalog/category/save', save);
  r.post('/catalog/category/save/id/:id', save);
  r.post('/catalog/category/delete/id/:id', async (req, reply) => {
    const c = load(req.params.id);
    if (c.id <= 2) { req.flash('error', 'You cannot delete the root category.'); return reply.redirect(`/admin/catalog/category/edit/id/${c.id}/`); }
    const ids = kit.sql("SELECT id FROM categories WHERE id = ? OR path LIKE ? || '/%'").pluck().all(c.id, c.path);
    for (const id of ids) { kit.sql('DELETE FROM product_categories WHERE category_id = ?').run(id); kit.sql('DELETE FROM categories WHERE id = ?').run(id); }
    refreshCounts(c.parent_id);
    req.flash('success', 'You deleted the category.');
    return reply.redirect(`/admin/catalog/category/edit/id/${c.parent_id}/`);
  });
};
