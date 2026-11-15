'use strict';
// Catalog > Products: grid (keyword, filters, sort, columns, mass actions), new / edit
// (general, advanced pricing, inventory, categories, attributes, configurable variants,
// images, SEO, related / up-sell / cross-sell), delete, mass "Update attributes".
const TYPES = [['simple', 'Simple Product'], ['configurable', 'Configurable Product'], ['virtual', 'Virtual Product'], ['bundle', 'Bundle Product'], ['grouped', 'Grouped Product'], ['downloadable', 'Downloadable Product']];
const TYPE_LABEL = Object.fromEntries(TYPES);
const VIS = [[1, 'Not Visible Individually'], [2, 'Catalog'], [3, 'Search'], [4, 'Catalog, Search']];
const STATUS = [[1, 'Enabled'], [2, 'Disabled']];
const STOCK = [[1, 'In Stock'], [0, 'Out of Stock']];
const BACKORDERS = [[0, 'No Backorders'], [1, 'Allow Qty Below 0'], [2, 'Allow Qty Below 0 and Notify Customer']];
const SYSTEM_ATTRS = new Set(['price_type', 'price_view', 'shipment_type', 'sku_type', 'weight_type', 'created_at', 'updated_at', 'sku']);
const LINK_TYPES = [['related', 'Related Products'], ['upsell', 'Up-Sell Products'], ['crosssell', 'Cross-Sell Products']];

module.exports = (r, ctx) => {
  const { kit, U, grid, view } = ctx;
  const h = kit.escapeHtml;
  const G = 'temp.admin_pgrid g';

  // ---------------------------------------------------------------- option lists
  // product attribute sets (those used by products; memoized per connection, sets are not editable here)
  const setMemo = new WeakMap();
  const setOptions = () => {
    const db = kit.db();
    if (!setMemo.has(db)) {
      const rows = kit.sql('SELECT id, name, source FROM attribute_sets WHERE id IN (SELECT DISTINCT attribute_set_id FROM temp.admin_pgrid) ORDER BY id').all();
      setMemo.set(db, rows.map((s) => [s.id, s.source === 'shop' ? `${s.name} (${s.id})` : s.name]));
    }
    return setMemo.get(db);
  };
  const taxClasses = () => [[0, 'None'], ...kit.sql("SELECT id, name FROM tax_classes WHERE type = 'PRODUCT' ORDER BY id").all().map((t) => [t.id, t.name])];
  const optionsOf = (code) => kit.sql('SELECT id, label FROM attribute_options WHERE attribute_code = ? ORDER BY position, id').all(code).map((o) => [o.id, o.label]);
  const countries = () => kit.sql('SELECT id, name FROM countries ORDER BY name').all().map((c) => [c.id, c.name]);
  function categoryOptions() {
    const cats = kit.sql('SELECT id, parent_id, name, path, level FROM categories ORDER BY path').all();
    const byId = new Map(cats.map((c) => [c.id, c]));
    const label = (c) => String(c.path).split('/').slice(1).map((x) => byId.get(+x)).filter(Boolean).map((x) => U.plainName(x.name)).join(' / ');
    return cats.filter((c) => c.level >= 1).sort((a, b) => label(a).localeCompare(label(b))).map((c) => [c.id, label(c)]);
  }

  // ---------------------------------------------------------------- grid
  // substring filter on name / sku: trigram FTS (product_search_tri) for >= 3 characters, else LIKE
  const triSql = (col) => (v) => (v.length >= 3
    ? { where: 'g.id IN (SELECT rowid FROM product_search_tri WHERE product_search_tri MATCH ?)', params: [`${col} : "${v.replace(/"/g, '""')}"`] }
    : { where: `g.id IN (SELECT id FROM products WHERE ${col} LIKE ? ESCAPE '\\')`, params: [`%${v.replace(/[\\%_]/g, '\\$&')}%`] });
  const thumb = `(SELECT file FROM product_images i WHERE i.product_id = g.id AND i.file IS NOT NULL AND coalesce(i.disabled, 0) = 0 ORDER BY i.is_thumbnail DESC, i.is_base DESC, i.position LIMIT 1)`;
  const SPEC = {
    id: 'product_listing', url: '/admin/catalog/product/', idCol: 'g.id',
    from: `${G}`, rowFrom: `${G} JOIN products p ON p.id = g.id`,
    defaultSort: 'id_asc',
    keyword: (q) => {
      const s = kit.search.prepare(kit.db(), 'product_search', q, { prefix: 'last' });
      if (!s.match) return null;
      return { where: 'g.id IN (SELECT rowid FROM product_search WHERE product_search MATCH ?)', params: [s.match] };
    },
    keywordPlaceholder: 'Search by keyword',
    columns: [
      { key: 'id', label: 'ID', sql: 'g.id', cls: 'num', filter: { type: 'range' } },
      { key: 'thumbnail', label: 'Thumbnail', sql: thumb, sort: false, cls: 'thumb', html: (x) => (x.thumbnail ? `<img src="${x.thumbnail.startsWith('/') ? '' : '/media/'}${h(x.thumbnail)}" alt="" loading="lazy">` : '') },
      { key: 'name', label: 'Name', sql: 'p.name', sortVia: { from: 'products p INDEXED BY products_name', id: 'p.id', expr: 'p.name' }, filter: { type: 'text', build: triSql('name') }, html: (x) => `<a href="/admin/catalog/product/edit/id/${x._id}/">${U.htmlName(x.name)}</a>` },
      { key: 'type', label: 'Type', sql: 'g.type', filter: { type: 'select', options: TYPES }, html: (x) => h(TYPE_LABEL[x.type] || x.type) },
      { key: 'attribute_set', label: 'Attribute Set', sql: '(SELECT name FROM attribute_sets s WHERE s.id = g.attribute_set_id)', sort: 'g.attribute_set_id', filter: { type: 'select', col: 'g.attribute_set_id', options: setOptions } },
      { key: 'sku', label: 'SKU', sql: 'p.sku', sortVia: { from: 'products p INDEXED BY sqlite_autoindex_products_1', id: 'p.id', expr: 'p.sku' }, filter: { type: 'text', build: triSql('sku') } },
      { key: 'price', label: 'Price', sql: 'g.price', cls: 'num', filter: { type: 'range' }, html: (x) => U.money(x.price) },
      { key: 'qty', label: 'Quantity', sql: 'g.qty', cls: 'num', filter: { type: 'range' }, html: (x) => (x.type === 'configurable' || x.type === 'grouped' || x.type === 'bundle' ? '' : U.num(x.qty)) },
      { key: 'salable_qty', label: 'Salable Quantity', sql: '(g.qty + coalesce((SELECT sum(quantity) FROM stock_reservations sr WHERE sr.sku = p.sku), 0))', sort: false, html: (x) => (x.type === 'configurable' || x.type === 'grouped' || x.type === 'bundle' ? '' : `Default Stock: ${U.num(x.salable_qty)}`) },
      { key: 'visibility', label: 'Visibility', sql: 'g.visibility', filter: { type: 'select', options: VIS }, html: (x) => h((VIS.find((v) => v[0] === x.visibility) || [0, ''])[1]) },
      { key: 'status', label: 'Status', sql: 'g.status', filter: { type: 'select', options: STATUS }, html: (x) => (x.status === 1 ? 'Enabled' : 'Disabled') },
      { key: 'websites', label: 'Websites', sql: "'Main Website'", sort: false },
      { key: 'is_in_stock', label: 'Stock Status', sql: 'g.is_in_stock', visible: false, filter: { type: 'select', options: STOCK }, html: (x) => (x.is_in_stock ? 'In Stock' : 'Out of Stock') },
      { key: 'special_price', label: 'Special Price', sql: 'g.special_price', cls: 'num', visible: false, filter: { type: 'range' }, html: (x) => U.money(x.special_price) },
      { key: 'cost', label: 'Cost', sql: 'g.cost', cls: 'num', visible: false, filter: { type: 'range' }, html: (x) => U.money(x.cost) },
      { key: 'weight', label: 'Weight', sql: 'g.weight', cls: 'num', visible: false, filter: { type: 'range' }, html: (x) => U.num(x.weight) },
      { key: 'color', label: 'Color', sql: 'g.color', visible: false, filter: { type: 'text' } },
      { key: 'size', label: 'Size', sql: 'g.size', visible: false, filter: { type: 'text' } },
      { key: 'brand', label: 'Brand', sql: 'p.brand', sort: false, visible: false, filter: { type: 'text', sql: 'g.id IN (SELECT id FROM products WHERE brand LIKE ? ESCAPE \'\\\')' } },
      { key: 'url_key', label: 'URL Key', sql: 'p.url_key', sort: false, visible: false, filter: { type: 'text', sql: 'g.id IN (SELECT id FROM products WHERE url_key LIKE ? ESCAPE \'\\\')' } },
      { key: 'country_of_manufacture', label: 'Country of Manufacture', sql: 'g.country_of_manufacture', visible: false },
      { key: 'created_at', label: 'Created', sql: 'g.created_at', visible: false, filter: { type: 'daterange' }, html: (x) => h(U.date.datetime(x.created_at)) },
      { key: 'updated_at', label: 'Updated', sql: 'g.updated_at', visible: false, filter: { type: 'daterange' }, html: (x) => h(U.date.datetime(x.updated_at)) },
    ],
    rowActions: (x) => `<a href="/admin/catalog/product/edit/id/${x._id}/">Edit</a>`,
    massActions: [
      { value: 'delete', label: 'Delete', confirm: 'Are you sure you want to delete selected items?' },
      { value: 'status_1', label: 'Change status: Enable' },
      { value: 'status_2', label: 'Change status: Disable' },
      { value: 'update_attributes', label: 'Update attributes' },
      { value: 'price_set', label: 'Update price: set to', needs: 'new price, e.g. 27.00' },
      { value: 'price_adjust', label: 'Update price: adjust by', needs: '-5 or +10 or -10%' },
    ],
  };
  // the type is needed by html() of qty columns
  SPEC.columns.find((c) => c.key === 'type').needed = true;

  const gridPage = async (req, reply) => {
    const g = grid.build(req, kit, SPEC);
    return view(reply, 'grid_page', {
      title: 'Products', g, crumbs: [['Catalog', null], ['Products', null]],
      actions: [{ label: 'Add Product', href: '/admin/catalog/product/new/set/4/type/simple/', primary: true, id: 'add_new_product-button' },
        { label: 'Add product of type', id: 'add_new_product-type', menu: TYPES.map((t) => [t[1], `/admin/catalog/product/new/set/${t[0] === 'configurable' ? 9 : 4}/type/${t[0]}/`]) }],
    });
  };
  r.get('/catalog/product', gridPage);
  r.get('/catalog/product/index', gridPage);

  // ---------------------------------------------------------------- deletes / mass actions
  function deleteProducts(ids) {
    const del = (sql) => { const st = kit.sql(sql); for (const id of ids) st.run(id); };
    del('DELETE FROM review_votes WHERE review_id IN (SELECT id FROM reviews WHERE product_id = ?)');
    for (const t of ['reviews', 'product_categories', 'product_attributes', 'product_images', 'tier_prices', 'product_variant_axes']) del(`DELETE FROM ${t} WHERE product_id = ?`);
    for (const id of ids) {
      for (const o of require('../lib/shadow').productOptions(kit.db(), id)) { kit.sql('DELETE FROM product_option_values WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(o.values.map((v) => v.id))); kit.sql('DELETE FROM product_options WHERE id = ?').run(o.id); }
    }
    del('DELETE FROM product_links WHERE product_id = ?'); del('DELETE FROM product_links WHERE linked_product_id = ?');
    del('DELETE FROM product_variants WHERE parent_id = ?'); del('DELETE FROM product_variants WHERE child_id = ?');
    del("DELETE FROM url_rewrites WHERE entity_type = 'product' AND entity_id = ?");
    del('DELETE FROM products WHERE id = ?');
  }
  function adjust(price, spec) {
    const m = /^([+-]?)\s*\$?(\d+(?:\.\d+)?)\s*(%?)$/.exec(String(spec).trim());
    if (!m) return NaN;
    const v = +m[2];
    const sign = m[1] === '-' ? -1 : 1;
    if (!m[1] && !m[3]) return NaN; // ambiguous: use price_set
    const out = m[3] ? price * (1 + (sign * v) / 100) : price + sign * v;
    return Math.round(Math.max(0, out) * 100) / 100;
  }
  r.post('/catalog/product/massAction', async (req, reply) => {
    const b = req.body || {};
    const ids = grid.selectedIds(req, kit, SPEC);
    const back = ctx.back(req, '/admin/catalog/product/');
    if (!ids.length) { req.flash('error', 'Please select item(s).'); return reply.redirect(back); }
    const act = U.str(b.mass_action);
    const now = kit.nowSql();
    if (act === 'delete') { deleteProducts(ids); req.flash('success', `A total of ${ids.length} record(s) have been deleted.`); }
    else if (act === 'status_1' || act === 'status_2') {
      const st = kit.sql('UPDATE products SET status = ?, updated_at = ? WHERE id = ?');
      for (const id of ids) st.run(act === 'status_1' ? 1 : 2, now, id);
      req.flash('success', `A total of ${ids.length} record(s) have been updated.`);
    } else if (act === 'update_attributes') {
      req.session.set('admin_attr_ids', ids);
      return reply.redirect('/admin/catalog/product_action_attribute/edit/');
    } else if (act === 'price_set' || act === 'price_adjust') {
      const v = U.str(b.mass_value);
      const st = kit.sql('UPDATE products SET price = ?, updated_at = ? WHERE id = ?');
      let n = 0;
      for (const id of ids) {
        const cur = kit.sql('SELECT price FROM products WHERE id = ?').pluck().get(id);
        const np = act === 'price_set' ? U.numOrNull(v) : adjust(cur || 0, v);
        if (np == null || Number.isNaN(np) || np < 0) { req.flash('error', 'Please enter a valid price.'); return reply.redirect(back); }
        st.run(Math.round(np * 10000) / 10000, now, id); n++;
      }
      req.flash('success', `A total of ${n} record(s) have been updated.`);
    } else { req.flash('error', 'Please select an action.'); }
    return reply.redirect(back);
  });
  r.post('/catalog/product/delete/id/:id', async (req, reply) => {
    const id = +req.params.id;
    if (!kit.sql('SELECT 1 FROM products WHERE id = ?').get(id)) throw ctx.notFound('product');
    deleteProducts([id]);
    req.flash('success', 'You deleted the product.');
    return reply.redirect('/admin/catalog/product/');
  });

  // ---------------------------------------------------------------- edit / new
  const load = (id) => {
    const p = kit.sql('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw ctx.notFound('product');
    return p;
  };
  function longTailAttrs(p) {
    const present = p ? kit.sql('SELECT DISTINCT attribute_code FROM product_attributes WHERE product_id = ?').pluck().all(p.id) : [];
    const luma = !p || p.source !== 'shop';
    return kit.sql("SELECT code, label, input FROM attributes WHERE typed_column IS NULL AND code NOT LIKE 'spec\\_%' ESCAPE '\\' ORDER BY position, code").all()
      .filter((a) => !SYSTEM_ATTRS.has(a.code) && (luma || present.includes(a.code)))
      .concat(present.filter((c) => c.startsWith('spec_')).map((c) => kit.sql('SELECT code, label, input FROM attributes WHERE code = ?').get(c)).filter(Boolean));
  }
  function attrValues(p) {
    const out = {};
    if (!p) return out;
    for (const row of kit.sql('SELECT attribute_code, value, option_id FROM product_attributes WHERE product_id = ?').all(p.id)) {
      (out[row.attribute_code] ||= []).push(row.option_id != null ? row.option_id : row.value);
    }
    return out;
  }
  const dateIn = (v) => (v ? String(v).slice(0, 10) : '');
  function valuesOf(p) {
    const cats = p.id ? kit.sql('SELECT category_id FROM product_categories WHERE product_id = ?').pluck().all(p.id) : [];
    const v = {
      'product[status]': p.status, 'product[attribute_set_id]': p.attribute_set_id, 'product[name]': p.name, 'product[sku]': p.sku,
      'product[price]': U.priceInput(p.price), 'product[tax_class_id]': p.tax_class_id ?? 2,
      'product[quantity_and_stock_status][qty]': U.qtyInput(p.qty ?? 0), 'product[quantity_and_stock_status][is_in_stock]': p.is_in_stock ?? 1,
      'product[product_has_weight]': p.type === 'virtual' || p.type === 'downloadable' ? 0 : 1, 'product[weight]': p.weight == null ? '' : U.num(p.weight),
      'product[category_ids][]': cats, 'product[visibility]': p.visibility, 'product[news_from_date]': dateIn(p.news_from), 'product[news_to_date]': dateIn(p.news_to),
      'product[country_of_manufacture]': p.country_of_manufacture || '', 'product[size]': p.size_option_id ?? '', 'product[color]': p.color_option_id ?? '',
      'product[special_price]': U.priceInput(p.special_price), 'product[special_from_date]': dateIn(p.special_from), 'product[special_to_date]': dateIn(p.special_to),
      'product[cost]': U.priceInput(p.cost), 'product[msrp]': U.priceInput(p.msrp),
      'product[stock_data][manage_stock]': p.manage_stock ?? 1, 'product[stock_data][min_qty]': U.qtyInput(p.min_qty ?? 0), 'product[stock_data][min_sale_qty]': U.qtyInput(p.min_sale_qty ?? 1),
      'product[stock_data][max_sale_qty]': U.qtyInput(p.max_sale_qty ?? 10000), 'product[stock_data][backorders]': p.backorders ?? 0, 'product[stock_data][notify_stock_qty]': U.qtyInput(p.notify_stock_qty ?? 1),
      'product[description]': p.description || '', 'product[short_description]': p.short_description || '',
      'product[url_key]': p.url_key || '', 'product[meta_title]': p.meta_title || '', 'product[meta_keyword]': p.meta_keywords || '', 'product[meta_description]': p.meta_description || '',
      'product[gift_message_available]': p.gift_message_available ? 1 : 0,
    };
    const av = attrValues(p);
    for (const a of longTailAttrs(p.id ? p : null)) {
      const vals = av[a.code] || [];
      if (a.input === 'multiselect') v[`product[${a.code}][]`] = vals;
      else v[`product[${a.code}]`] = vals[0] ?? (a.input === 'boolean' ? 0 : '');
    }
    return v;
  }
  function editModel(p, { values, errors = {}, isNew = false } = {}) {
    const vals = { ...valuesOf(p), ...(values || {}) };
    const variants = p.type === 'configurable' && p.id ? kit.sql(`SELECT c.id, c.name, c.sku, c.price, c.qty, c.weight, c.status, c.size, c.color, c.is_in_stock,
        (SELECT file FROM product_images i WHERE i.product_id = c.id AND i.file IS NOT NULL ORDER BY i.is_thumbnail DESC, i.position LIMIT 1) AS thumb
      FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id = ? ORDER BY c.id`).all(p.id) : [];
    const axes = p.type === 'configurable' && p.id ? kit.sql('SELECT attribute_code, label FROM product_variant_axes WHERE product_id = ? ORDER BY position').all(p.id) : [];
    const parents = p.id ? kit.sql('SELECT p.id, p.name, p.sku FROM product_variants v JOIN products p ON p.id = v.parent_id WHERE v.child_id = ?').all(p.id) : [];
    const images = p.id ? kit.sql('SELECT * FROM product_images WHERE product_id = ? ORDER BY position, id').all(p.id) : [];
    const links = {};
    for (const [t] of LINK_TYPES) links[t] = p.id ? kit.sql('SELECT l.linked_product_id AS id, l.position, p.name, p.sku, p.price, p.status FROM product_links l JOIN products p ON p.id = l.linked_product_id WHERE l.product_id = ? AND l.link_type = ? ORDER BY l.position, l.linked_product_id').all(p.id, t) : [];
    const options = p.id ? require('../lib/shadow').productOptions(kit.db(), p.id) : [];
    const tiers = p.id ? kit.sql('SELECT * FROM tier_prices WHERE product_id = ? ORDER BY qty').all(p.id) : [];
    const groups = kit.sql('SELECT id, code FROM customer_groups ORDER BY id').all();
    const attrs = longTailAttrs(p.id ? p : null).map((a) => ({ ...a, options: a.input === 'select' || a.input === 'multiselect' ? optionsOf(a.code) : null }));
    const reviewsCount = p.id ? kit.sql('SELECT count(*) FROM reviews WHERE product_id = ?').pluck().get(p.id) : 0;
    const title = isNew ? 'New Product' : U.plainName(p.name);
    const action = isNew ? `/admin/catalog/product/save/set/${p.attribute_set_id}/type/${p.type}/` : `/admin/catalog/product/save/id/${p.id}/`;
    return {
      title, p, isNew, action, values: vals, errors, variants, axes, parents, images, links, linkTypes: LINK_TYPES, options, tiers, groups, attrs, reviewsCount,
      lists: { status: STATUS, sets: setOptions(), tax: taxClasses(), stock: STOCK, vis: VIS, countries: countries(), sizes: optionsOf('size'), colors: optionsOf('color'), cats: categoryOptions(), backorders: BACKORDERS },
      typeLabel: TYPE_LABEL[p.type] || p.type,
      crumbs: [['Catalog', null], ['Products', '/admin/catalog/product/'], [title, null]],
      actions: [
        { label: 'Back', href: '/admin/catalog/product/', id: 'back' },
        ...(isNew ? [] : [{ label: 'Delete', post: `/admin/catalog/product/delete/id/${p.id}/`, confirm: 'Are you sure you want to delete this product?', id: 'delete' }]),
        ...(isNew ? [] : [{ label: 'Customer View', href: `/${p.url_key}.html`, id: 'preview' }]),
        { label: 'Save & Close', form: 'product_form', name: 'back', value: 'close', id: 'save_and_close' },
        ...(isNew ? [] : [{ label: 'Save & Duplicate', form: 'product_form', name: 'back', value: 'duplicate', id: 'save_and_duplicate' }]),
        { label: 'Save', form: 'product_form', primary: true, id: 'save' },
      ],
    };
  }
  r.get('/catalog/product/edit/id/:id', async (req, reply) => view(reply, 'product_edit', editModel(load(+req.params.id))));
  const newPage = async (req, reply) => {
    const type = TYPE_LABEL[req.params.type] ? req.params.type : 'simple';
    const set = +req.params.set || 4;
    const p = { id: null, type, attribute_set_id: set, status: 1, visibility: 4, qty: 0, is_in_stock: 1, tax_class_id: 2, source: 'admin', name: '', sku: '', price: null, manage_stock: 1 };
    return view(reply, 'product_edit', editModel(p, { isNew: true }));
  };
  r.get('/catalog/product/new/set/:set/type/:type', newPage);
  r.get('/catalog/product/new', async (req, reply) => reply.redirect('/admin/catalog/product/new/set/4/type/simple/'));

  // ---------------------------------------------------------------- save
  const B = (b, k) => b[`product[${k}]`];
  const has = (b, k) => U.has(b, `product[${k}]`);
  function collect(b, p, isNew) {
    const errors = {};
    const set = {};
    const req = (k, label) => { const v = U.str(B(b, k)); if (!v) errors[`product[${k}]`] = 'This is a required field.'; return v; };
    if (has(b, 'name') || isNew) set.name = req('name');
    if (has(b, 'sku') || isNew) {
      set.sku = req('sku');
      if (set.sku && set.sku.length > 64) errors['product[sku]'] = 'SKU length should be 64 characters maximum.';
      if (set.sku && kit.sql('SELECT 1 FROM products WHERE sku = ? AND id IS NOT ?').get(set.sku, p.id ?? null)) errors['product[sku]'] = 'The value specified in the SKU field is already used by another product.';
    }
    const money = (k, col, { required } = {}) => {
      if (!has(b, k)) return;
      const n = U.numOrNull(B(b, k));
      if (n == null) { if (required) errors[`product[${k}]`] = 'This is a required field.'; set[col] = null; return; }
      if (Number.isNaN(n) || n < 0) { errors[`product[${k}]`] = 'Please enter a number 0 or greater in this field.'; return; }
      set[col] = Math.round(n * 10000) / 10000;
    };
    money('price', 'price', { required: isNew && !['configurable', 'grouped', 'bundle'].includes(p.type) });
    money('special_price', 'special_price'); money('cost', 'cost'); money('msrp', 'msrp');
    const date = (k, col) => {
      if (!has(b, k)) return;
      const s = U.str(B(b, k));
      if (!s) { set[col] = null; return; }
      const d = U.parseDateInput(s);
      if (!d) { errors[`product[${k}]`] = 'Please enter a valid date.'; return; }
      set[col] = `${d} 00:00:00`;
    };
    date('special_from_date', 'special_from'); date('special_to_date', 'special_to'); date('news_from_date', 'news_from'); date('news_to_date', 'news_to');
    const int = (k, col, allowed) => { if (!has(b, k)) return; const v = U.str(B(b, k)); if (v === '') return; const n = parseInt(v, 10); if (!Number.isFinite(n) || (allowed && !allowed.includes(n))) { errors[`product[${k}]`] = 'Please select a valid value.'; return; } set[col] = n; };
    int('status', 'status', [1, 2]); int('visibility', 'visibility', [1, 2, 3, 4]); int('tax_class_id', 'tax_class_id');
    if (has(b, 'attribute_set_id')) { const n = parseInt(U.str(B(b, 'attribute_set_id')), 10); if (kit.sql('SELECT 1 FROM attribute_sets WHERE id = ?').get(n)) set.attribute_set_id = n; }
    const qtyK = 'product[quantity_and_stock_status][qty]';
    if (U.has(b, qtyK)) {
      const n = U.numOrNull(b[qtyK]);
      if (n == null) set.qty = 0;
      else if (Number.isNaN(n)) errors[qtyK] = 'Please enter a valid number in this field.';
      else set.qty = n;
    }
    const stK = 'product[quantity_and_stock_status][is_in_stock]';
    if (U.has(b, stK)) set.is_in_stock = U.str(b[stK]) === '1' ? 1 : 0;
    if (has(b, 'weight')) {
      const noWeight = U.str(B(b, 'product_has_weight')) === '0';
      const n = U.numOrNull(B(b, 'weight'));
      if (noWeight) set.weight = null;
      else if (n != null && (Number.isNaN(n) || n < 0)) errors['product[weight]'] = 'Please enter a number 0 or greater in this field.';
      else set.weight = n;
    }
    for (const [k, col] of [['stock_data][min_qty', 'min_qty'], ['stock_data][min_sale_qty', 'min_sale_qty'], ['stock_data][max_sale_qty', 'max_sale_qty'], ['stock_data][notify_stock_qty', 'notify_stock_qty']]) {
      if (!has(b, k)) continue;
      const n = U.numOrNull(B(b, k));
      if (n != null && Number.isNaN(n)) errors[`product[${k}]`] = 'Please enter a valid number in this field.';
      else set[col] = n;
    }
    if (has(b, 'stock_data][manage_stock')) set.manage_stock = U.str(B(b, 'stock_data][manage_stock')) === '1' ? 1 : 0;
    if (has(b, 'stock_data][backorders')) set.backorders = parseInt(U.str(B(b, 'stock_data][backorders')), 10) || 0;
    if (has(b, 'gift_message_available')) set.gift_message_available = U.str(B(b, 'gift_message_available')) === '1' ? 1 : 0;
    for (const [k, col] of [['description', 'description'], ['short_description', 'short_description'], ['meta_title', 'meta_title'], ['meta_keyword', 'meta_keywords'], ['meta_description', 'meta_description']]) {
      if (has(b, k)) { const v = Array.isArray(B(b, k)) ? B(b, k).at(-1) : B(b, k); set[col] = v == null || v === '' ? null : String(v); }
    }
    if (has(b, 'country_of_manufacture')) set.country_of_manufacture = U.str(B(b, 'country_of_manufacture')) || null;
    for (const axis of ['size', 'color']) {
      if (!has(b, axis)) continue;
      const v = U.str(B(b, axis));
      if (!v) { set[axis] = null; set[`${axis}_option_id`] = null; continue; }
      const o = kit.sql('SELECT id, label FROM attribute_options WHERE id = ? AND attribute_code = ?').get(+v, axis);
      if (!o) { errors[`product[${axis}]`] = 'Please select a valid option.'; continue; }
      set[axis] = o.label; set[`${axis}_option_id`] = o.id;
    }
    if (has(b, 'url_key') || isNew) {
      let k = U.slugify(U.str(B(b, 'url_key')) || set.name || p.name || '');
      if (!k) k = U.slugify(set.sku || p.sku || '');
      if (k && kit.sql('SELECT 1 FROM products WHERE url_key = ? AND id IS NOT ?').get(k, p.id ?? null)) {
        if (isNew && !U.str(B(b, 'url_key'))) { let i = 1; while (kit.sql('SELECT 1 FROM products WHERE url_key = ?').get(`${k}-${i}`)) i++; k = `${k}-${i}`; }
        else errors['product[url_key]'] = `The value specified in the URL Key field would generate a URL that already exists.`;
      }
      set.url_key = k || null;
    }
    return { set, errors };
  }

  function applyRelations(b, id, p) {
    // categories (select multiple; the hidden marker tells "present but empty")
    if (U.has(b, 'product[category_ids_present]')) {
      const want = U.ids(b['product[category_ids][]'] ?? b['product[category_ids]']).filter((c) => kit.sql('SELECT 1 FROM categories WHERE id = ?').get(c));
      const cur = kit.sql('SELECT category_id FROM product_categories WHERE product_id = ?').pluck().all(id);
      for (const c of cur) if (!want.includes(c)) kit.sql('DELETE FROM product_categories WHERE product_id = ? AND category_id = ?').run(id, c);
      for (const c of want) if (!cur.includes(c)) kit.sql('INSERT INTO product_categories (product_id, category_id, position) VALUES (?, ?, (SELECT coalesce(max(position), 0) + 1 FROM product_categories WHERE category_id = ?))').run(id, c, c);
    }
    // long-tail attributes
    const shown = U.str(b['product[_attrs]']).split(',').filter(Boolean);
    for (const code of shown) {
      const a = kit.sql('SELECT code, input FROM attributes WHERE code = ?').get(code);
      if (!a) continue;
      const key = a.input === 'multiselect' ? `product[${code}][]` : `product[${code}]`;
      if (!U.has(b, key) && a.input !== 'multiselect') continue;
      kit.sql('DELETE FROM product_attributes WHERE product_id = ? AND attribute_code = ?').run(id, code);
      const ins = kit.sql('INSERT INTO product_attributes (product_id, attribute_code, value, option_id) VALUES (?, ?, ?, ?)');
      if (a.input === 'multiselect' || a.input === 'select') {
        for (const oid of U.ids(b[key])) { const o = kit.sql('SELECT id, label FROM attribute_options WHERE id = ? AND attribute_code = ?').get(oid, code); if (o) ins.run(id, code, o.label, o.id); }
      } else if (a.input === 'boolean') ins.run(id, code, U.str(b[key]) === '1' ? '1' : '0', null);
      else { const v = U.str(b[key]); if (v) ins.run(id, code, v, null); }
    }
    // images: label / role / hide / remove
    for (const img of kit.sql('SELECT id FROM product_images WHERE product_id = ?').all(id)) {
      const pre = `product[media_gallery][images][${img.id}]`;
      if (U.str(b[`${pre}[removed]`]) === '1') { kit.sql('DELETE FROM product_images WHERE id = ?').run(img.id); continue; }
      if (U.has(b, `${pre}[label]`)) kit.sql('UPDATE product_images SET label = ?, disabled = ?, position = coalesce(?, position) WHERE id = ?').run(U.str(b[`${pre}[label]`]) || null, U.str(b[`${pre}[disabled]`]) === '1' ? 1 : 0, U.numOrNull(b[`${pre}[position]`]) ?? null, img.id);
    }
    for (const [role, col] of [['image', 'is_base'], ['small_image', 'is_small'], ['thumbnail', 'is_thumbnail']]) {
      if (!U.has(b, `product[${role}]`)) continue;
      const v = parseInt(U.str(b[`product[${role}]`]), 10);
      kit.sql(`UPDATE product_images SET ${col} = (id = ?) WHERE product_id = ?`).run(Number.isFinite(v) ? v : -1, id);
    }
    // related / up-sell / cross-sell
    for (const [t] of LINK_TYPES) {
      for (const rid of U.ids(b[`product[links][${t}][remove][]`] ?? b[`product[links][${t}][remove]`])) kit.sql('DELETE FROM product_links WHERE product_id = ? AND linked_product_id = ? AND link_type = ?').run(id, rid, t);
      const add = U.str(b[`product[links][${t}][add]`]);
      if (add) {
        const bad = [];
        for (const tok of add.split(/[,\n]+/).map((s) => s.trim()).filter(Boolean)) {
          const lp = /^\d+$/.test(tok) ? kit.sql('SELECT id FROM products WHERE id = ? OR sku = ?').get(+tok, tok) : kit.sql('SELECT id FROM products WHERE sku = ?').get(tok);
          if (!lp || lp.id === id) { bad.push(tok); continue; }
          kit.sql('INSERT OR IGNORE INTO product_links (product_id, linked_product_id, link_type, position) VALUES (?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM product_links WHERE product_id = ? AND link_type = ?))').run(id, lp.id, t, id, t);
        }
        if (bad.length) throw kit.httpError(422, `Product(s) not found: ${bad.join(', ')}`);
      }
    }
    // tier prices
    for (const tid of U.ids(b['product[tier_price][delete][]'] ?? b['product[tier_price][delete]'])) kit.sql('DELETE FROM tier_prices WHERE id = ? AND product_id = ?').run(tid, id);
    const tq = U.numOrNull(b['product[tier_price][new][price_qty]']); const tp = U.numOrNull(b['product[tier_price][new][price]']);
    if (tq != null && tp != null && !Number.isNaN(tq) && !Number.isNaN(tp)) {
      const gsel = U.str(b['product[tier_price][new][cust_group]']);
      const all = gsel === '' || gsel === 'all';
      kit.sql('INSERT INTO tier_prices (product_id, customer_group_id, all_groups, qty, value) VALUES (?, ?, ?, ?, ?)').run(id, all ? 0 : +gsel, all ? 1 : 0, tq, tp);
    }
    void p;
  }

  function writeProduct(p, set, isNew) {
    const now = kit.nowSql();
    if (isNew) {
      const row = { type: p.type, attribute_set_id: p.attribute_set_id, status: 1, visibility: 4, tax_class_id: 2, qty: 0, is_in_stock: 1, manage_stock: 1, min_qty: 0, min_sale_qty: 1, max_sale_qty: 10000, notify_stock_qty: 1, backorders: 0, has_options: 0, required_options: 0, source: 'admin', ...set, created_at: now, updated_at: now };
      const cols = Object.keys(row);
      const res = kit.db().prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
      const id = Number(res.lastInsertRowid);
      if (row.url_key) kit.sql("INSERT INTO url_rewrites (entity_type, entity_id, request_path, target_path, redirect_type, is_autogenerated, source) VALUES ('product', ?, ?, ?, 0, 1, 'admin')").run(id, `${row.url_key}.html`, `catalog/product/view/id/${id}`);
      return id;
    }
    const cols = Object.keys(set);
    if (cols.length) kit.db().prepare(`UPDATE products SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`).run({ ...set, updated_at: now, id: p.id });
    if (set.url_key && set.url_key !== p.url_key) {
      kit.sql("UPDATE url_rewrites SET request_path = ? WHERE entity_type = 'product' AND entity_id = ? AND request_path = ?").run(`${set.url_key}.html`, p.id, `${p.url_key}.html`);
      if (p.url_key) kit.sql("INSERT INTO url_rewrites (entity_type, entity_id, request_path, target_path, redirect_type, is_autogenerated, source) VALUES ('product', ?, ?, ?, 301, 0, 'admin')").run(p.id, `${p.url_key}.html`, `${set.url_key}.html`);
    }
    return p.id;
  }

  const save = async (req, reply) => {
    const b = req.body || {};
    const isNew = !req.params.id;
    const p = isNew ? { id: null, type: TYPE_LABEL[req.params.type] ? req.params.type : 'simple', attribute_set_id: +req.params.set || 4, source: 'admin' } : load(+req.params.id);
    const { set, errors } = collect(b, p, isNew);
    const fail = (errs, msg) => {
      const values = {};
      for (const [k, v] of Object.entries(b)) if (k.startsWith('product[')) values[k] = v;
      const m = editModel(isNew ? { ...p, ...set } : p, { values, errors: errs, isNew });
      m.errorsList = [msg || 'The product could not be saved. Please correct the highlighted fields.'];
      return view(reply, 'product_edit', m, 422);
    };
    if (Object.keys(errors).length) return fail(errors);
    let id;
    try {
      id = writeProduct(p, set, isNew);
      applyRelations(b, id, p);
    } catch (e) {
      if (e.statusCode === 422) return fail({}, e.message);
      throw e;
    }
    const back = U.str(b.back);
    if (back === 'duplicate') {
      const src = load(id);
      const copy = { ...src };
      delete copy.id;
      let n = 1; while (kit.sql('SELECT 1 FROM products WHERE sku = ?').get(`${src.sku}-${n}`)) n++;
      Object.assign(copy, { sku: `${src.sku}-${n}`, url_key: `${src.url_key}-${n}`, status: 2, created_at: kit.nowSql(), updated_at: kit.nowSql() });
      const cols = Object.keys(copy);
      const nid = Number(kit.db().prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(copy).lastInsertRowid);
      kit.sql('INSERT INTO product_categories (product_id, category_id, position) SELECT ?, category_id, position FROM product_categories WHERE product_id = ?').run(nid, id);
      kit.sql('INSERT INTO product_attributes (product_id, attribute_code, value, option_id) SELECT ?, attribute_code, value, option_id FROM product_attributes WHERE product_id = ?').run(nid, id);
      req.flash('success', 'You saved the product.');
      req.flash('success', 'You duplicated the product.');
      return reply.redirect(`/admin/catalog/product/edit/id/${nid}/`);
    }
    req.flash('success', 'You saved the product.');
    if (back === 'close') return reply.redirect('/admin/catalog/product/');
    if (back === 'new') return reply.redirect(`/admin/catalog/product/new/set/${p.attribute_set_id}/type/${p.type}/`);
    return reply.redirect(`/admin/catalog/product/edit/id/${id}/`);
  };
  r.post('/catalog/product/save/id/:id', save);
  r.post('/catalog/product/save/set/:set/type/:type', save);
  r.post('/catalog/product/save', async (req, reply) => { req.params.set = U.str(req.body && req.body.set) || 4; req.params.type = U.str(req.body && req.body.type) || 'simple'; return save(req, reply); });

  // ---------------------------------------------------------------- configurable variants
  r.post('/catalog/product/addVariant/id/:id', async (req, reply) => {
    const p = load(+req.params.id);
    const b = req.body || {};
    const back = `/admin/catalog/product/edit/id/${p.id}/#configurable`;
    if (p.type !== 'configurable') { req.flash('error', 'Only configurable products have configurations.'); return reply.redirect(back); }
    const axes = kit.sql('SELECT attribute_code, label FROM product_variant_axes WHERE product_id = ? ORDER BY position').all(p.id);
    const set = {};
    const labels = [];
    for (const a of axes) {
      const o = kit.sql('SELECT id, label FROM attribute_options WHERE id = ? AND attribute_code = ?').get(+U.str(b[`variant[${a.attribute_code}]`]), a.attribute_code);
      if (!o) { req.flash('error', `Please select a ${a.label || a.attribute_code}.`); return reply.redirect(back); }
      if (a.attribute_code === 'size' || a.attribute_code === 'color') { set[a.attribute_code] = o.label; set[`${a.attribute_code}_option_id`] = o.id; }
      labels.push([a.attribute_code, o]);
    }
    // the same combination may exist only once
    const dupe = kit.sql('SELECT c.id FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id = ? AND coalesce(c.size_option_id, 0) = ? AND coalesce(c.color_option_id, 0) = ?').get(p.id, set.size_option_id || 0, set.color_option_id || 0);
    if (dupe) { req.flash('error', 'A product with this combination of attributes already exists in this configuration.'); return reply.redirect(back); }
    const first = kit.sql('SELECT c.* FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id = ? ORDER BY c.id LIMIT 1').get(p.id) || {};
    const suffix = labels.map(([, o]) => o.label).join('-');
    const name = U.str(b['variant[name]']) || `${p.name}-${suffix}`;
    const sku = U.str(b['variant[sku]']) || `${p.sku}-${suffix}`;
    if (kit.sql('SELECT 1 FROM products WHERE sku = ?').get(sku)) { req.flash('error', `The value specified in the SKU field is already used by another product (${sku}).`); return reply.redirect(back); }
    const price = U.numOrNull(b['variant[price]']) ?? first.price ?? p.price;
    const qty = U.numOrNull(b['variant[qty]']) ?? 0;
    const weight = U.numOrNull(b['variant[weight]']) ?? first.weight ?? p.weight;
    if ([price, qty, weight].some((x) => Number.isNaN(x))) { req.flash('error', 'Please enter valid numbers for price, quantity and weight.'); return reply.redirect(back); }
    let urlKey = U.slugify(name); let n = 1;
    while (kit.sql('SELECT 1 FROM products WHERE url_key = ?').get(urlKey)) urlKey = `${U.slugify(name)}-${n++}`;
    const now = kit.nowSql();
    const row = { sku, type: 'simple', attribute_set_id: p.attribute_set_id, name, url_key: urlKey, status: 1, visibility: 1, price, weight, tax_class_id: p.tax_class_id ?? 2, qty, is_in_stock: qty > 0 ? 1 : 0, manage_stock: 1, min_qty: 0, min_sale_qty: 1, max_sale_qty: 10000, notify_stock_qty: 1, backorders: 0, has_options: 0, required_options: 0, created_at: now, updated_at: now, source: p.source || 'admin', ...set };
    const cols = Object.keys(row);
    const cid = Number(kit.db().prepare(`INSERT INTO products (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row).lastInsertRowid);
    kit.sql('INSERT INTO product_variants (parent_id, child_id) VALUES (?, ?)').run(p.id, cid);
    for (const [code, o] of labels) if (code !== 'size' && code !== 'color') kit.sql('INSERT INTO product_attributes (product_id, attribute_code, value, option_id) VALUES (?, ?, ?, ?)').run(cid, code, o.label, o.id);
    kit.sql('UPDATE products SET updated_at = ? WHERE id = ?').run(now, p.id);
    req.flash('success', `You added the product ${name} (SKU ${sku}) to the configuration.`);
    return reply.redirect(back);
  });
  r.post('/catalog/product/removeVariant/id/:id/child/:child', async (req, reply) => {
    const p = load(+req.params.id);
    const ch = +req.params.child;
    const n = kit.sql('DELETE FROM product_variants WHERE parent_id = ? AND child_id = ?').run(p.id, ch).changes;
    req.flash(n ? 'success' : 'error', n ? 'The product was removed from the configuration.' : 'This product is not part of the configuration.');
    return reply.redirect(`/admin/catalog/product/edit/id/${p.id}/#configurable`);
  });
  r.post('/catalog/product/variantStatus/id/:id/child/:child', async (req, reply) => {
    const p = load(+req.params.id);
    const ch = +req.params.child;
    if (!kit.sql('SELECT 1 FROM product_variants WHERE parent_id = ? AND child_id = ?').get(p.id, ch)) throw ctx.notFound('product');
    kit.sql('UPDATE products SET status = CASE status WHEN 1 THEN 2 ELSE 1 END, updated_at = ? WHERE id = ?').run(kit.nowSql(), ch);
    req.flash('success', 'You saved the product.');
    return reply.redirect(`/admin/catalog/product/edit/id/${p.id}/#configurable`);
  });

  // ---------------------------------------------------------------- image upload
  r.post('/catalog/product/upload/id/:id', async (req, reply) => {
    const p = load(+req.params.id);
    const f = req.body && req.body.image;
    const back = `/admin/catalog/product/edit/id/${p.id}/#media_gallery`;
    if (!f || !f.url) { req.flash('error', 'Please choose an image file.'); return reply.redirect(back); }
    if (!/^image\//.test(f.mimetype || '')) { req.flash('error', 'File validation failed: only image files can be uploaded.'); return reply.redirect(back); }
    const first = !kit.sql('SELECT 1 FROM product_images WHERE product_id = ? AND file IS NOT NULL').get(p.id);
    kit.sql('INSERT INTO product_images (product_id, file, orig_path, position, label, disabled, is_base, is_small, is_thumbnail, is_swatch, bytes) VALUES (?, ?, ?, (SELECT coalesce(max(position), 0) + 1 FROM product_images WHERE product_id = ?), ?, 0, ?, ?, ?, 0, ?)')
      .run(p.id, f.url, f.filename, p.id, U.str(req.body.label) || null, first ? 1 : 0, first ? 1 : 0, first ? 1 : 0, f.size || null);
    req.flash('success', 'The image was uploaded.');
    return reply.redirect(back);
  });

  // ---------------------------------------------------------------- mass "Update attributes"
  const ATTR_FIELDS = () => [
    { name: 'status', label: 'Enable Product', type: 'select', options: STATUS },
    { name: 'visibility', label: 'Visibility', type: 'select', options: VIS },
    { name: 'price', label: 'Price', addon: '$' }, { name: 'special_price', label: 'Special Price', addon: '$' },
    { name: 'special_from_date', label: 'Special Price From', type: 'date' }, { name: 'special_to_date', label: 'Special Price To', type: 'date' },
    { name: 'cost', label: 'Cost', addon: '$' }, { name: 'weight', label: 'Weight', addon: 'lbs' },
    { name: 'tax_class_id', label: 'Tax Class', type: 'select', options: taxClasses() },
    { name: 'color', label: 'Color', type: 'select', options: optionsOf('color'), empty: '' }, { name: 'size', label: 'Size', type: 'select', options: optionsOf('size'), empty: '' },
    { name: 'country_of_manufacture', label: 'Country of Manufacture', type: 'select', options: countries(), empty: '' },
    { name: 'short_description', label: 'Short Description', type: 'textarea' }, { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'meta_title', label: 'Meta Title' }, { name: 'meta_keyword', label: 'Meta Keywords', type: 'textarea' }, { name: 'meta_description', label: 'Meta Description', type: 'textarea' },
    ...kit.sql("SELECT code, label, input FROM attributes WHERE typed_column IS NULL AND input IN ('boolean', 'select', 'multiselect') AND code NOT LIKE 'spec\\_%' ESCAPE '\\' ORDER BY code").all()
      .filter((a) => !SYSTEM_ATTRS.has(a.code))
      .map((a) => ({ name: a.code, label: a.label, type: 'select', multiple: a.input === 'multiselect', options: a.input === 'boolean' ? [[1, 'Yes'], [0, 'No']] : optionsOf(a.code), longTail: a.input })),
  ];
  r.get('/catalog/product_action_attribute/edit', async (req, reply) => {
    const ids = req.session.get('admin_attr_ids') || U.ids(req.query.ids);
    if (!ids.length) { req.flash('error', 'Please select products for attributes update.'); return reply.redirect('/admin/catalog/product/'); }
    if (req.query.ids) req.session.set('admin_attr_ids', ids);
    const sample = kit.sql(`SELECT id, name, sku FROM products WHERE id IN (${ids.slice(0, 20).map(() => '?').join(',')})`).all(...ids.slice(0, 20));
    return view(reply, 'product_attr_mass', {
      title: 'Update Attributes', ids, sample, fields: ATTR_FIELDS(), cats: categoryOptions(),
      qty: { qty: '', is_in_stock: '' },
      crumbs: [['Catalog', null], ['Products', '/admin/catalog/product/'], ['Update Attributes', null]],
      actions: [{ label: 'Back', href: '/admin/catalog/product/' }, { label: 'Save', form: 'attributes-edit-form', primary: true, id: 'save' }],
    });
  });
  r.post('/catalog/product_action_attribute/save', async (req, reply) => {
    const b = req.body || {};
    const ids = req.session.get('admin_attr_ids') || [];
    if (!ids.length) { req.flash('error', 'Please select products for attributes update.'); return reply.redirect('/admin/catalog/product/'); }
    const on = (k) => U.str(b[`toggle[${k}]`]) === '1';
    const set = {};
    const errs = [];
    const fields = ATTR_FIELDS();
    const longTail = [];
    for (const f of fields) {
      if (!on(f.name)) continue;
      const raw = b[`attributes[${f.name}]`] ?? b[`attributes[${f.name}][]`];
      if (f.longTail) { longTail.push([f, f.multiple ? U.ids(raw) : U.str(raw)]); continue; }
      const v = U.str(raw);
      if (['price', 'special_price', 'cost', 'weight'].includes(f.name)) {
        const n = U.numOrNull(v);
        if (n != null && (Number.isNaN(n) || n < 0)) { errs.push(`${f.label}: please enter a number 0 or greater.`); continue; }
        if (f.name === 'price' && n == null) { errs.push('Price: this is a required field.'); continue; }
        set[f.name] = n;
      } else if (f.name === 'special_from_date' || f.name === 'special_to_date') {
        const d = v ? U.parseDateInput(v) : null;
        if (v && !d) { errs.push(`${f.label}: please enter a valid date.`); continue; }
        set[f.name === 'special_from_date' ? 'special_from' : 'special_to'] = d ? `${d} 00:00:00` : null;
      } else if (f.name === 'color' || f.name === 'size') {
        const o = v ? kit.sql('SELECT id, label FROM attribute_options WHERE id = ? AND attribute_code = ?').get(+v, f.name) : null;
        set[f.name] = o ? o.label : null; set[`${f.name}_option_id`] = o ? o.id : null;
      } else if (f.name === 'status' || f.name === 'visibility' || f.name === 'tax_class_id') set[f.name] = parseInt(v, 10) || 0;
      else if (f.name === 'meta_keyword') set.meta_keywords = v || null;
      else set[f.name] = v || null;
    }
    if (on('qty')) { const n = U.numOrNull(b['inventory[qty]']); if (n == null || Number.isNaN(n)) errs.push('Quantity: please enter a valid number.'); else set.qty = n; }
    if (on('is_in_stock')) set.is_in_stock = U.str(b['inventory[is_in_stock]']) === '1' ? 1 : 0;
    if (errs.length) { for (const e of errs) req.flash('error', e); return reply.redirect('/admin/catalog/product_action_attribute/edit/'); }
    const now = kit.nowSql();
    const cols = Object.keys(set);
    const up = cols.length ? kit.db().prepare(`UPDATE products SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @now WHERE id = @id`) : null;
    for (const id of ids) {
      if (up) up.run({ ...set, now, id });
      for (const [f, v] of longTail) {
        kit.sql('DELETE FROM product_attributes WHERE product_id = ? AND attribute_code = ?').run(id, f.name);
        const ins = kit.sql('INSERT INTO product_attributes (product_id, attribute_code, value, option_id) VALUES (?, ?, ?, ?)');
        if (f.longTail === 'boolean') ins.run(id, f.name, v === '1' ? '1' : '0', null);
        else for (const oid of [].concat(v).filter((x) => x !== '')) { const o = kit.sql('SELECT id, label FROM attribute_options WHERE id = ? AND attribute_code = ?').get(+oid, f.name); if (o) ins.run(id, f.name, o.label, o.id); }
      }
      for (const c of U.ids(b['categories[add][]'] ?? b['categories[add]'])) kit.sql('INSERT OR IGNORE INTO product_categories (product_id, category_id, position) VALUES (?, ?, 0)').run(id, c);
      for (const c of U.ids(b['categories[remove][]'] ?? b['categories[remove]'])) kit.sql('DELETE FROM product_categories WHERE product_id = ? AND category_id = ?').run(id, c);
    }
    req.session.set('admin_attr_ids', undefined);
    req.flash('success', `A total of ${ids.length} record(s) were updated.`);
    return reply.redirect('/admin/catalog/product/');
  });
};
