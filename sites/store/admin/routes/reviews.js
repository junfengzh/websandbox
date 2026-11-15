'use strict';
// Marketing > User Content: All Reviews / Pending Reviews grids (filters, mass delete, mass
// status), review edit (status, nickname, summary, text, ratings), delete, new review;
// Stores > Rating.
// Magento status ids in URLs and forms: status_id 1 Approved, 2 Pending, 3 Not Approved.
const STATUS = [[1, 'Approved'], [2, 'Pending'], [3, 'Not Approved']];
const CODE = { 1: 'approved', 2: 'pending', 3: 'not_approved' };
const ID = { approved: 1, pending: 2, not_approved: 3 };
const LABEL = { approved: 'Approved', pending: 'Pending', not_approved: 'Not Approved' };

module.exports = (r, ctx) => {
  const { kit, U, grid, view } = ctx;
  const h = kit.escapeHtml;
  const tri = (col) => (v) => (v.length >= 3
    ? { where: 'r.product_id IN (SELECT rowid FROM product_search_tri WHERE product_search_tri MATCH ?)', params: [`${col} : "${v.replace(/"/g, '""')}"`] }
    : { where: `r.product_id IN (SELECT id FROM products WHERE ${col} LIKE ? ESCAPE '\\')`, params: [`%${v.replace(/[\\%_]/g, '\\$&')}%`] });
  const statusBuild = (v) => {
    const code = CODE[v] || (ID[v] ? v : null);
    if (!code) return { where: '0', params: [] };
    return code === 'approved' ? { where: 'r.id NOT IN (SELECT id FROM temp.admin_rstat)', params: [] } : { where: 'r.id IN (SELECT id FROM temp.admin_rstat WHERE status = ?)', params: [code] };
  };
  const spec = (pending) => ({
    id: pending ? 'review_pending_grid' : 'review_grid', url: pending ? '/admin/review/product/pending/' : '/admin/review/product/', idCol: 'r.id', from: 'reviews r',
    where: pending ? "r.id IN (SELECT id FROM temp.admin_rstat WHERE status = 'pending')" : '1', defaultSort: 'created_at_desc',
    columns: [
      { key: 'review_id', label: 'ID', sql: 'r.id', cls: 'num', filter: { type: 'range', col: 'r.id' } },
      { key: 'created_at', label: 'Created', sql: 'r.created_at', filter: { type: 'daterange' }, html: (x) => h(U.date.datetime(x.created_at)) },
      ...(pending ? [] : [{ key: 'status', label: 'Status', sql: 'r.status', sort: false, filter: { type: 'select', options: STATUS, build: statusBuild }, html: (x) => LABEL[x.status] || h(x.status) }]),
      { key: 'title', label: 'Title', sql: 'r.title', sort: false, filter: { type: 'text' }, html: (x) => h(x.title || '') },
      { key: 'nickname', label: 'Nickname', sql: 'r.nickname', sort: false, filter: { type: 'text' } },
      { key: 'detail', label: 'Review', sql: 'r.detail', sort: false, filter: { type: 'text' }, html: (x) => h(String(x.detail || '').slice(0, 160)) + (String(x.detail || '').length > 160 ? '&hellip;' : '') },
      { key: 'visibility', label: 'Visibility', sql: "'Main Website / Main Website Store / Default Store View'", sort: false, html: () => 'Main Website<br>Main Website Store<br>Default Store View' },
      { key: 'type', label: 'Type', sql: "CASE WHEN r.customer_id IS NULL THEN 'Guest' ELSE 'Customer' END", sort: false, filter: { type: 'select', options: [['customer', 'Customer'], ['guest', 'Guest']], build: (v) => ({ where: v === 'guest' ? 'r.customer_id IS NULL' : 'r.customer_id IS NOT NULL', params: [] }) } },
      { key: 'name', label: 'Product', sql: '(SELECT name FROM products p WHERE p.id = r.product_id)', sort: false, filter: { type: 'text', build: tri('name') }, html: (x) => `<a href="/admin/catalog/product/edit/id/${x.product_id}/">${U.htmlName(x.name || '')}</a>` },
      { key: 'sku', label: 'SKU', sql: '(SELECT sku FROM products p WHERE p.id = r.product_id)', sort: false, filter: { type: 'text', build: tri('sku') } },
      { key: 'product_id', label: 'Product ID', sql: 'r.product_id', hidden: true, needed: true, filter: { type: 'text', exact: true, build: (v) => ({ where: 'r.product_id = ?', params: [+v || 0] }) } },
      { key: 'customer_id', label: 'Customer ID', sql: 'r.customer_id', hidden: true, filter: { type: 'text', build: (v) => ({ where: 'r.customer_id = ?', params: [+v || 0] }) } },
    ],
    rowActions: (x) => `<a href="/admin/review/product/edit/id/${x._id}/">Edit</a>`,
    massActions: [
      { value: 'delete', label: 'Delete', confirm: 'Are you sure?' },
      { value: 'status_1', label: 'Update Status: Approved' }, { value: 'status_2', label: 'Update Status: Pending' }, { value: 'status_3', label: 'Update Status: Not Approved' },
    ],
    massUrl: '/admin/review/product/massAction/',
  });
  const ALL = spec(false); const PENDING = spec(true);
  const page = (pending) => async (req, reply) => view(reply, 'grid_page', {
    title: pending ? 'Pending Reviews' : 'Reviews', g: grid.build(req, kit, pending ? PENDING : ALL),
    crumbs: [['Marketing', null], ['User Content', null], [pending ? 'Pending Reviews' : 'All Reviews', null]],
    actions: [{ label: 'New Review', href: '/admin/review/product/new/', primary: true, id: 'add' }],
  });
  r.get('/review/product', page(false));
  r.get('/review/product/index', page(false));
  r.get('/review/product/pending', page(true));

  function deleteReviews(ids) {
    for (const id of ids) { kit.sql('DELETE FROM review_votes WHERE review_id = ?').run(id); kit.sql('DELETE FROM reviews WHERE id = ?').run(id); }
  }
  r.post('/review/product/massAction', async (req, reply) => {
    const b = req.body || {};
    const pending = /\/pending/.test(U.str(b.back_url));
    const ids = grid.selectedIds(req, kit, pending ? PENDING : ALL);
    const back = ctx.back(req, '/admin/review/product/');
    if (!ids.length) { req.flash('error', 'Please select review(s).'); return reply.redirect(back); }
    const act = U.str(b.mass_action);
    if (act === 'delete') { deleteReviews(ids); req.flash('success', `A total of ${ids.length} record(s) have been deleted.`); }
    else if (/^status_[123]$/.test(act)) {
      const st = CODE[act.slice(7)];
      for (const id of ids) kit.sql('UPDATE reviews SET status = ? WHERE id = ?').run(st, id);
      req.flash('success', `A total of ${ids.length} record(s) have been updated.`);
    } else req.flash('error', 'Please select an action.');
    return reply.redirect(back);
  });
  // Magento's own mass URLs
  r.post('/review/product/massDelete', async (req, reply) => { const ids = U.ids(req.body && (req.body.reviews ?? req.body.selected)); deleteReviews(ids); req.flash('success', `A total of ${ids.length} record(s) have been deleted.`); return reply.redirect(ctx.back(req, '/admin/review/product/')); });
  r.post('/review/product/massUpdateStatus', async (req, reply) => {
    const ids = U.ids(req.body && (req.body.reviews ?? req.body.selected));
    const st = CODE[U.str(req.body.status)];
    if (!st) { req.flash('error', 'Please select a status.'); return reply.redirect(ctx.back(req, '/admin/review/product/')); }
    for (const id of ids) kit.sql('UPDATE reviews SET status = ? WHERE id = ?').run(st, id);
    req.flash('success', `A total of ${ids.length} record(s) have been updated.`);
    return reply.redirect(ctx.back(req, '/admin/review/product/'));
  });

  // ---------------------------------------------------------------- edit
  const ratings = () => kit.sql('SELECT * FROM ratings WHERE coalesce(is_active, 1) = 1 ORDER BY position, id').all();
  function editModel(rv, { values = {}, errors = {}, isNew = false, product = null } = {}) {
    const p = product || (rv ? kit.sql('SELECT id, name, sku FROM products WHERE id = ?').get(rv.product_id) : null);
    const votes = rv ? kit.sql('SELECT v.*, r.code FROM review_votes v JOIN ratings r ON r.id = v.rating_id WHERE v.review_id = ? ORDER BY r.position, r.id').all(rv.id) : [];
    const customer = rv && rv.customer_id ? kit.sql('SELECT id, firstname, lastname, email FROM customers WHERE id = ?').get(rv.customer_id) : null;
    const summary = votes.length ? Math.round(votes.reduce((a, v) => a + (v.percent || v.value * 20), 0) / votes.length) : null;
    const v = rv ? { status_id: ID[rv.status] || 2, nickname: rv.nickname || '', title: rv.title || '', detail: rv.detail || '', ...values } : { status_id: 1, ...values };
    const voteOf = Object.fromEntries(votes.map((x) => [x.rating_id, x.value]));
    for (const ra of ratings()) if (!(`ratings[${ra.id}]` in v)) v[`ratings[${ra.id}]`] = voteOf[ra.id] ?? '';
    const ratingHtml = (vv) => ratings().map((ra) => `<div class="admin__field-control" role="radiogroup" aria-label="${h(ra.code)} rating"><strong style="display:inline-block;min-width:70px">${h(ra.code)}</strong> ${[1, 2, 3, 4, 5].map((n) => `<label class="choice"><input type="radio" name="ratings[${ra.id}]" value="${n}"${String(vv[`ratings[${ra.id}]`]) === String(n) ? ' checked' : ''}> ${n}</label>`).join('')}</div>`).join('');
    const sections = [{ title: 'Review Details', fields: [
      { name: '_product', label: 'Product', type: 'static', html: p ? `<a href="/admin/catalog/product/edit/id/${p.id}/">${U.htmlName(p.name)}</a> <span class="muted">(SKU ${h(p.sku)})</span>` : '<span class="muted">(no product)</span>' },
      ...(isNew ? [{ name: 'product_id', label: 'Product ID', required: true, value: p ? p.id : '', note: 'The ID of the product being reviewed (see Catalog &gt; Products).' }] : []),
      { name: '_author', label: 'Author', type: 'static', html: customer ? `<a href="/admin/customer/index/edit/id/${customer.id}/">${h(customer.firstname)} ${h(customer.lastname)}</a> (${h(customer.email)})` : isNew ? 'Administrator' : 'Guest' },
      { name: '_summary', label: 'Summary Rating', type: 'static', html: summary == null ? '<span id="rating_summary">Rating isn\'t Available</span>' : `<span id="rating_summary" class="rating-stars" aria-label="${summary}%">${'★'.repeat(Math.round(summary / 20))}${'☆'.repeat(5 - Math.round(summary / 20))}</span> ${summary}%` },
      { name: '_detailed', label: 'Detailed Rating', type: 'html', html: `<div class="admin__field-control">${ratingHtml(v)}</div>` },
      { name: 'status_id', label: 'Status', type: 'select', options: STATUS, required: true },
      { name: 'select_stores[]', label: 'Visibility', type: 'select', multiple: true, options: [[1, 'Default Store View']], value: [1] },
      { name: 'nickname', label: 'Nickname', required: true },
      { name: 'title', label: 'Summary of Review', required: true },
      { name: 'detail', label: 'Review', type: 'textarea', required: true, rows: 8 },
    ] }];
    const title = isNew ? 'New Review' : 'Edit Review';
    return {
      title, values: v, errors, sections, formId: 'edit_form', action: isNew || !rv ? '/admin/review/product/post/' : `/admin/review/product/save/id/${rv.id}/`,
      crumbs: [['Marketing', null], ['All Reviews', '/admin/review/product/'], [title, null]],
      actions: [{ label: 'Back', href: '/admin/review/product/', id: 'back' },
        ...(isNew || !rv ? [] : [{ label: 'Delete Review', post: `/admin/review/product/delete/id/${rv.id}/`, confirm: 'Are you sure you want to do this?', id: 'delete' }]),
        { label: 'Save Review', form: 'edit_form', primary: true, id: 'save_button' }],
    };
  }
  r.get('/review/product/edit/id/:id', async (req, reply) => {
    const rv = kit.sql('SELECT * FROM reviews WHERE id = ?').get(+req.params.id);
    if (!rv) {
      // Magento shows an empty form for a missing review id
      const m = editModel(null, {});
      m.errorsList = ['This review no longer exists.'];
      m.actions = [{ label: 'Back', href: '/admin/review/product/', id: 'back' }];
      m.action = '/admin/review/product/';
      return view(reply, 'form_page', m, 404);
    }
    return view(reply, 'form_page', editModel(rv));
  });
  function readForm(b) {
    const v = { status_id: U.str(b.status_id), nickname: U.str(b.nickname), title: U.str(b.title), detail: U.str(b.detail) };
    const errors = {};
    if (!CODE[v.status_id]) errors.status_id = 'Please select a status.';
    for (const k of ['nickname', 'title', 'detail']) if (!v[k]) errors[k] = 'This is a required field.';
    const votes = {};
    for (const ra of ratings()) { const n = parseInt(U.str(b[`ratings[${ra.id}]`]), 10); if (n >= 1 && n <= 5) votes[ra.id] = n; v[`ratings[${ra.id}]`] = U.str(b[`ratings[${ra.id}]`]); }
    return { v, errors, votes };
  }
  function saveVotes(id, votes) {
    for (const [rid, n] of Object.entries(votes)) {
      const cur = kit.sql('SELECT id FROM review_votes WHERE review_id = ? AND rating_id = ?').get(id, +rid);
      if (cur) kit.sql('UPDATE review_votes SET value = ?, percent = ? WHERE id = ?').run(n, n * 20, cur.id);
      else kit.sql('INSERT INTO review_votes (review_id, rating_id, value, percent) VALUES (?, ?, ?, ?)').run(id, +rid, n, n * 20);
    }
  }
  r.post('/review/product/save/id/:id', async (req, reply) => {
    const rv = kit.sql('SELECT * FROM reviews WHERE id = ?').get(+req.params.id);
    if (!rv) { req.flash('error', 'The review was removed by another user or does not exist.'); return reply.redirect('/admin/review/product/'); }
    const { v, errors, votes } = readForm(req.body || {});
    if (Object.keys(errors).length) { const m = editModel(rv, { values: v, errors }); m.errorsList = ['Please correct the highlighted fields.']; return view(reply, 'form_page', m, 422); }
    kit.sql('UPDATE reviews SET status = ?, nickname = ?, title = ?, detail = ? WHERE id = ?').run(CODE[v.status_id], v.nickname, v.title, v.detail, rv.id);
    saveVotes(rv.id, votes);
    req.flash('success', 'You saved the review.');
    return reply.redirect(ctx.back(req, '/admin/review/product/'));
  });
  r.post('/review/product/delete/id/:id', async (req, reply) => {
    const id = +req.params.id;
    if (!kit.sql('SELECT 1 FROM reviews WHERE id = ?').get(id)) { req.flash('error', 'The review was removed by another user or does not exist.'); return reply.redirect('/admin/review/product/'); }
    deleteReviews([id]);
    req.flash('success', 'The review has been deleted.');
    return reply.redirect('/admin/review/product/');
  });
  r.get('/review/product/new', async (req, reply) => {
    const p = req.query.product_id ? kit.sql('SELECT id, name, sku FROM products WHERE id = ?').get(+req.query.product_id) : null;
    return view(reply, 'form_page', editModel(null, { isNew: true, product: p }));
  });
  r.post('/review/product/post', async (req, reply) => {
    const b = req.body || {};
    const p = kit.sql('SELECT id, name, sku FROM products WHERE id = ?').get(+U.str(b.product_id));
    const { v, errors, votes } = readForm(b);
    if (!p) errors.product_id = 'Please enter a valid product ID.';
    if (Object.keys(errors).length) { const m = editModel(null, { isNew: true, product: p, values: { ...v, product_id: U.str(b.product_id) }, errors }); m.errorsList = ['Please correct the highlighted fields.']; return view(reply, 'form_page', m, 422); }
    const id = Number(kit.sql("INSERT INTO reviews (product_id, customer_id, status, title, detail, nickname, created_at, source) VALUES (?, NULL, ?, ?, ?, ?, ?, 'admin')").run(p.id, CODE[v.status_id], v.title, v.detail, v.nickname, kit.nowSql()).lastInsertRowid);
    saveVotes(id, votes);
    req.flash('success', 'You saved the review.');
    return reply.redirect('/admin/review/product/');
  });

  // ---------------------------------------------------------------- ratings (Stores > Rating)
  r.get('/review/rating', async (req, reply) => {
    const rows = kit.sql('SELECT * FROM ratings ORDER BY position, id').all();
    const html = `<table class="data-grid"><thead><tr><th>ID</th><th>Rating</th><th>Sort Order</th><th>Is Active</th><th>Action</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${x.id}</td><td>${h(x.code)}</td><td>${x.position ?? 0}</td><td>${x.is_active ? 'Active' : 'Inactive'}</td><td><a href="/admin/review/rating/edit/id/${x.id}/">Edit</a></td></tr>`).join('')}</tbody></table>`;
    return view(reply, 'message_page', { title: 'Ratings', html, crumbs: [['Stores', null], ['Rating', null]] });
  });
  const ratingForm = (ra, values = {}, errors = {}) => ({
    title: `Edit Rating: ${ra.code}`, action: `/admin/review/rating/save/id/${ra.id}/`, values: { code: ra.code, position: ra.position ?? 0, is_active: ra.is_active ? 1 : 0, ...values }, errors,
    crumbs: [['Stores', null], ['Rating', '/admin/review/rating/'], [ra.code, null]],
    actions: [{ label: 'Back', href: '/admin/review/rating/' }, { label: 'Save Rating', form: 'edit_form', primary: true, id: 'save' }],
    sections: [{ title: 'Rating Information', fields: [{ name: 'code', label: 'Default Value', required: true }, { name: 'is_active', label: 'Is Active', type: 'checkbox', checkLabel: 'Active' }, { name: 'position', label: 'Sort Order', type: 'number' }] }],
  });
  const loadRating = (id) => { const ra = kit.sql('SELECT * FROM ratings WHERE id = ?').get(+id); if (!ra) throw ctx.notFound('rating'); return ra; };
  r.get('/review/rating/edit/id/:id', async (req, reply) => view(reply, 'form_page', ratingForm(loadRating(req.params.id))));
  r.post('/review/rating/save/id/:id', async (req, reply) => {
    const ra = loadRating(req.params.id);
    const code = U.str(req.body.code);
    if (!code) return view(reply, 'form_page', ratingForm(ra, { code }, { code: 'This is a required field.' }), 422);
    kit.sql('UPDATE ratings SET code = ?, is_active = ?, position = ? WHERE id = ?').run(code, U.str(req.body.is_active) === '1' ? 1 : 0, parseInt(U.str(req.body.position), 10) || 0, ra.id);
    req.flash('success', 'You saved the rating.');
    return reply.redirect('/admin/review/rating/');
  });
};
