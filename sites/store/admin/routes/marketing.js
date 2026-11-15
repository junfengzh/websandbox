'use strict';
// Marketing: cart price rules (conditions, actions, coupons incl. auto-generated codes),
// catalog price rules, newsletter templates / queue / subscribers, search terms, search
// synonyms.
const C = require('../lib/conditions');

const ACTIONS_CART = [['by_percent', 'Percent of product price discount'], ['by_fixed', 'Fixed amount discount'], ['cart_fixed', 'Fixed amount discount for whole cart'], ['buy_x_get_y', 'Buy X get Y free (discount amount is Y)']];
const ACTIONS_CATALOG = [['by_percent', 'Apply as percentage of original'], ['by_fixed', 'Apply as fixed amount'], ['to_percent', 'Adjust final price to this percentage'], ['to_fixed', 'Adjust final price to discount value']];
const COUPON_TYPES = [[1, 'No Coupon'], [2, 'Specific Coupon'], [3, 'Auto']];
const FREE_SHIP = [[0, 'No'], [1, 'For matching items only'], [2, 'For shipment with matching items']];
const NL_STATUS = [[1, 'Subscribed'], [2, 'Not Activated'], [3, 'Unsubscribed'], [4, 'Unconfirmed']];
const Q_STATUS = { 0: 'Not Sent', 1: 'Sending', 2: 'Cancelled', 3: 'Sent', 4: 'Paused' };

module.exports = (r, ctx) => {
  const { kit, U, grid, view } = ctx;
  const h = kit.escapeHtml;
  const groups = () => kit.sql('SELECT id, code FROM customer_groups ORDER BY id').all().map((g) => [g.id, g.code]);
  const dateOrNull = (v) => { const s = U.str(v); if (!s) return null; return U.parseDateInput(s) || NaN; };
  const like = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  // ================================================================ cart price rules
  const QUOTE = {
    id: 'sales_rule_grid', url: '/admin/sales_rule/promo_quote/', idCol: 'r.id', from: 'sales_rules r', defaultSort: 'rule_id_desc',
    keyword: (q) => ({ where: "(r.name LIKE ? ESCAPE '\\' OR r.id IN (SELECT rule_id FROM coupons WHERE code LIKE ? ESCAPE '\\'))", params: [like(q), like(q)] }),
    columns: [
      { key: 'rule_id', label: 'ID', sql: 'r.id', cls: 'num', filter: { type: 'range', col: 'r.id' } },
      { key: 'name', label: 'Rule', sql: 'r.name', filter: { type: 'text' }, html: (x) => `<a href="/admin/sales_rule/promo_quote/edit/id/${x._id}/">${h(x.name)}</a>` },
      { key: 'coupon_code', label: 'Coupon Code', sql: '(SELECT code FROM coupons c WHERE c.rule_id = r.id AND coalesce(c.is_primary, 0) = 1 LIMIT 1)', filter: { type: 'text', build: (v) => ({ where: "r.id IN (SELECT rule_id FROM coupons WHERE code LIKE ? ESCAPE '\\')", params: [like(v)] }) } },
      { key: 'sort_order', label: 'Priority', sql: 'r.sort_order', cls: 'num', filter: { type: 'range' } },
      { key: 'is_active', label: 'Status', sql: 'r.is_active', filter: { type: 'select', options: [[1, 'Active'], [0, 'Inactive']] }, html: (x) => (x.is_active ? 'Active' : 'Inactive') },
      { key: 'website', label: 'Web Site', sql: "'Main Website'", sort: false },
      { key: 'from_date', label: 'Start', sql: 'r.from_date', filter: { type: 'daterange', local: false }, html: (x) => h(x.from_date ? U.date.medium(x.from_date) : '') },
      { key: 'to_date', label: 'End', sql: 'r.to_date', filter: { type: 'daterange', local: false }, html: (x) => h(x.to_date ? U.date.medium(x.to_date) : '') },
    ],
    rowActions: (x) => `<a href="/admin/sales_rule/promo_quote/edit/id/${x._id}/">Edit</a>`,
  };
  const quoteGrid = async (req, reply) => view(reply, 'grid_page', { title: 'Cart Price Rules', g: grid.build(req, kit, QUOTE), crumbs: [['Marketing', null], ['Cart Price Rules', null]], actions: [{ label: 'Add New Rule', href: '/admin/sales_rule/promo_quote/new/', primary: true, id: 'add' }] });
  r.get('/sales_rule/promo_quote', quoteGrid);
  r.get('/sales_rule/promo_quote/index', quoteGrid);

  function quoteForm(rule, { values = {}, errors = {} } = {}) {
    const isNew = !rule;
    const coupon = rule ? kit.sql('SELECT code FROM coupons WHERE rule_id = ? AND coalesce(is_primary, 0) = 1 LIMIT 1').pluck().get(rule.id) : '';
    const v = {
      name: rule ? rule.name : '', description: rule ? rule.description || '' : '', is_active: rule ? rule.is_active : 1, 'website_ids[]': [1],
      'customer_group_ids[]': rule ? String(rule.customer_group_ids || '').split(',').filter((x) => x !== '') : [], coupon_type: rule ? rule.coupon_type || 1 : 1, coupon_code: coupon || '',
      use_auto_generation: rule ? rule.use_auto_generation || 0 : 0, uses_per_coupon: rule ? rule.uses_per_coupon ?? 0 : 0, uses_per_customer: rule ? rule.uses_per_customer ?? 0 : 0,
      from_date: rule && rule.from_date ? String(rule.from_date).slice(0, 10) : '', to_date: rule && rule.to_date ? String(rule.to_date).slice(0, 10) : '', sort_order: rule ? rule.sort_order ?? 0 : 0, is_rss: rule ? rule.is_rss ?? 1 : 1,
      simple_action: rule ? rule.simple_action : 'by_percent', discount_amount: rule ? U.num(rule.discount_amount ?? 0) : 0, discount_qty: rule && rule.discount_qty != null ? U.num(rule.discount_qty) : '', discount_step: rule ? rule.discount_step ?? 0 : 0,
      apply_to_shipping: rule ? rule.apply_to_shipping || 0 : 0, stop_rules_processing: rule ? rule.stop_rules_processing || 0 : 0, simple_free_shipping: rule ? rule.simple_free_shipping || 0 : 0,
      store_label: rule ? rule.store_label || '' : '', ...values,
    };
    const cond = C.parse(rule && rule.conditions_json, 'cart');
    const act = C.parse(rule && rule.actions_json, 'cart', 'pcombine');
    const coupons = rule ? kit.sql('SELECT * FROM coupons WHERE rule_id = ? ORDER BY id').all(rule.id) : [];
    const title = isNew ? 'New Cart Price Rule' : rule.name;
    return {
      title, values: v, errors, formId: 'sales_rule_form', action: isNew ? '/admin/sales_rule/promo_quote/save/' : `/admin/sales_rule/promo_quote/save/id/${rule.id}/`,
      crumbs: [['Marketing', null], ['Cart Price Rules', '/admin/sales_rule/promo_quote/'], [title, null]],
      actions: [{ label: 'Back', href: '/admin/sales_rule/promo_quote/', id: 'back' },
        ...(isNew ? [] : [{ label: 'Delete Rule', post: `/admin/sales_rule/promo_quote/delete/id/${rule.id}/`, confirm: 'Are you sure you want to delete this?', id: 'delete' }]),
        { label: 'Save and Continue Edit', form: 'sales_rule_form', name: 'back', value: 'edit', id: 'save_and_continue' }, { label: 'Save', form: 'sales_rule_form', primary: true, id: 'save' }],
      sections: [
        { title: 'Rule Information', fields: [
          { name: 'name', label: 'Rule Name', required: true }, { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
          { name: 'is_active', label: 'Active', type: 'checkbox', checkLabel: 'Active' },
          { name: 'website_ids[]', id: 'website_ids', index: 'website_ids', label: 'Websites', type: 'select', multiple: true, options: [[1, 'Main Website']], required: true },
          { name: 'customer_group_ids[]', id: 'customer_group_ids', index: 'customer_group_ids', label: 'Customer Groups', type: 'select', multiple: true, options: groups(), required: true },
          { name: 'coupon_type', label: 'Coupon', type: 'select', options: COUPON_TYPES },
          { name: 'coupon_code', label: 'Coupon Code', showWhen: 'coupon_type=2', required: true },
          { name: 'use_auto_generation', label: 'Use Auto Generation', type: 'checkbox', showWhen: 'coupon_type=2', note: 'If you select and save the rule you will be able to generate multiple coupon codes.' },
          { name: 'uses_per_coupon', label: 'Uses per Coupon', type: 'number' }, { name: 'uses_per_customer', label: 'Uses per Customer', type: 'number', note: 'Usage limit enforced for logged in customers only.' },
          { name: 'from_date', label: 'From', type: 'date' }, { name: 'to_date', label: 'To', type: 'date' },
          { name: 'sort_order', label: 'Priority', type: 'number' }, { name: 'is_rss', label: 'Public In RSS Feed', type: 'checkbox' },
        ] },
        { title: 'Conditions', collapsible: true, id: 'conditions', html: `<p>Apply the rule only if the following conditions are met (leave blank for all products).</p>${C.editor('conditions', cond, 'cart')}` },
        { title: 'Actions', collapsible: true, id: 'actions', fields: [
          { name: 'simple_action', label: 'Apply', type: 'select', options: ACTIONS_CART }, { name: 'discount_amount', label: 'Discount Amount', required: true },
          { name: 'discount_qty', label: 'Maximum Qty Discount is Applied To' }, { name: 'discount_step', label: 'Discount Qty Step (Buy X)' },
          { name: 'apply_to_shipping', label: 'Apply to Shipping Amount', type: 'checkbox' }, { name: 'stop_rules_processing', label: 'Discard subsequent rules', type: 'checkbox' },
          { name: 'simple_free_shipping', label: 'Free Shipping', type: 'select', options: FREE_SHIP },
        ], html: `<h3>Apply the rule only to cart items matching the following conditions (leave blank for all items).</h3>${C.editor('actions', act, 'cart', { productOnly: true })}` },
        { title: 'Labels', collapsible: true, open: false, id: 'labels', fields: [{ name: 'store_label', label: 'Default Rule Label for All Store Views' }] },
        ...(rule && rule.coupon_type !== 1 ? [{ title: 'Manage Coupon Codes', collapsible: true, id: 'manage_coupon_codes', html: couponsHtml(rule, coupons) }] : []),
      ],
      after: rule ? `<form id="coupon_generate_form" method="post" action="/admin/sales_rule/promo_quote/generate/id/${rule.id}/"><input type="hidden" name="_csrf" value="__CSRF__"></form><form id="coupon_delete_form" method="post" action="/admin/sales_rule/promo_quote/couponsMassDelete/id/${rule.id}/"><input type="hidden" name="_csrf" value="__CSRF__"></form>` : '',
    };
  }
  function couponsHtml(rule, coupons) {
    const f = (n, l, v, extra = '') => `<div class="admin__form-field"><label for="cg_${n}">${l}</label><input id="cg_${n}" name="${n}" value="${h(v)}" form="coupon_generate_form"${extra}></div>`;
    return `<p class="muted">Generated coupons stay with this rule (Uses per Coupon applies to each).</p>
      <div class="inline-fields" role="group" aria-label="Generate coupons">${f('qty', 'Coupon Qty', 1, ' type="number" min="1" max="1000"')}${f('length', 'Code Length', 12, ' type="number" min="4" max="32"')}
      <div class="admin__form-field"><label for="cg_format">Code Format</label><select id="cg_format" name="format" form="coupon_generate_form"><option value="alphanum">Alphanumeric</option><option value="alpha">Alphabetical</option><option value="num">Numeric</option></select></div>
      ${f('prefix', 'Code Prefix', '')}${f('suffix', 'Code Suffix', '')}${f('dash', 'Dash Every X Characters', 0, ' type="number" min="0"')}
      <button type="submit" class="action-secondary" form="coupon_generate_form">Generate</button></div>
      <table class="data-grid" id="couponCodesGrid"><thead><tr><th><span class="sr-only">Select</span></th><th>Coupon Code</th><th>Created</th><th>Used</th><th class="num">Times Used</th></tr></thead><tbody>
      ${coupons.length ? coupons.map((c) => `<tr><td><input type="checkbox" name="ids" value="${c.id}" form="coupon_delete_form" aria-label="Select ${h(c.code)}"></td><td>${h(c.code)}</td><td>${h(U.date.datetime(c.created_at))}</td><td>${c.times_used ? 'Yes' : 'No'}</td><td class="num">${c.times_used || 0}</td></tr>`).join('') : '<tr class="data-grid-tr-no-data"><td colspan="5">We couldn\'t find any records.</td></tr>'}
      </tbody></table><button type="submit" class="action-secondary" form="coupon_delete_form">Delete selected coupons</button>`;
  }
  const loadRule = (t, id) => { const x = kit.sql(`SELECT * FROM ${t} WHERE id = ?`).get(+id); if (!x) throw ctx.notFound('rule'); return x; };
  const render = (req, reply, m, status) => { m.after = String(m.after || '').replace(/__CSRF__/g, kit.escapeHtml(req.csrfToken())); return view(reply, 'form_page', m, status); };
  r.get('/sales_rule/promo_quote/new', async (req, reply) => { const m = quoteForm(null); m.after = ''; return view(reply, 'form_page', m); });
  r.get('/sales_rule/promo_quote/edit/id/:id', async (req, reply) => render(req, reply, quoteForm(loadRule('sales_rules', req.params.id))));

  function readRule(b, kind) {
    const v = {}; const errors = {}; const set = {};
    const s = (k) => U.str(b[k]);
    v.name = s('name'); set.name = v.name; if (!v.name) errors.name = 'This is a required field.';
    v.description = s('description'); set.description = v.description || null;
    set.is_active = s('is_active') === '1' ? 1 : 0; v.is_active = set.is_active;
    const gids = U.arr(b['customer_group_ids[]'] ?? b.customer_group_ids).map(String).filter((x) => x !== '' && kit.sql('SELECT 1 FROM customer_groups WHERE id = ?').get(+x));
    v['customer_group_ids[]'] = gids; set.customer_group_ids = gids.join(',');
    if (!gids.length) errors['customer_group_ids[]'] = 'This is a required field.';
    const ws = U.arr(b['website_ids[]'] ?? b.website_ids).map(String).filter(Boolean);
    v['website_ids[]'] = ws.length ? ws : [];
    if (!ws.length) errors['website_ids[]'] = 'This is a required field.';
    for (const k of ['from_date', 'to_date']) { v[k] = s(k); const d = dateOrNull(b[k]); if (Number.isNaN(d)) errors[k] = 'Please enter a valid date.'; else set[k] = d; }
    if (set.from_date && set.to_date && set.from_date > set.to_date) errors.to_date = 'End Date must follow Start Date.';
    v.sort_order = s('sort_order'); set.sort_order = parseInt(v.sort_order, 10) || 0;
    const acts = kind === 'cart' ? ACTIONS_CART : ACTIONS_CATALOG;
    v.simple_action = s('simple_action') || 'by_percent'; set.simple_action = acts.some((a) => a[0] === v.simple_action) ? v.simple_action : 'by_percent';
    v.discount_amount = s('discount_amount'); const da = U.numOrNull(v.discount_amount);
    if (da == null) errors.discount_amount = 'This is a required field.'; else if (Number.isNaN(da) || da < 0) errors.discount_amount = 'Please enter a number 0 or greater in this field.'; else set.discount_amount = da;
    if (set.simple_action && set.simple_action.endsWith('percent') && da > 100) errors.discount_amount = 'Percentage discount should be between 0 and 100.';
    set.stop_rules_processing = s('stop_rules_processing') === '1' ? 1 : 0; v.stop_rules_processing = set.stop_rules_processing;
    if (kind === 'cart') {
      v.coupon_type = s('coupon_type') || '1'; set.coupon_type = [1, 2, 3].includes(+v.coupon_type) ? +v.coupon_type : 1;
      v.coupon_code = s('coupon_code');
      set.use_auto_generation = set.coupon_type === 3 || s('use_auto_generation') === '1' ? 1 : 0; v.use_auto_generation = set.use_auto_generation;
      if (set.coupon_type === 2 && !set.use_auto_generation && !v.coupon_code) errors.coupon_code = 'This is a required field.';
      for (const k of ['uses_per_coupon', 'uses_per_customer', 'discount_step']) { v[k] = s(k); set[k] = parseInt(v[k], 10) || 0; }
      v.discount_qty = s('discount_qty'); set.discount_qty = U.numOrNull(v.discount_qty); if (Number.isNaN(set.discount_qty)) set.discount_qty = null;
      set.apply_to_shipping = s('apply_to_shipping') === '1' ? 1 : 0; v.apply_to_shipping = set.apply_to_shipping;
      v.simple_free_shipping = s('simple_free_shipping'); set.simple_free_shipping = parseInt(v.simple_free_shipping, 10) || 0;
      set.is_rss = s('is_rss') === '1' ? 1 : 0; v.is_rss = set.is_rss;
      v.store_label = s('store_label'); set.store_label = v.store_label || null;
    }
    return { v, errors, set };
  }
  function saveQuote(rule, b) {
    const { v, errors, set } = readRule(b, 'cart');
    if (set.coupon_type === 2 && v.coupon_code && kit.sql('SELECT 1 FROM coupons WHERE code = ? AND rule_id IS NOT ?').get(v.coupon_code, rule ? rule.id : null)) errors.coupon_code = 'The coupon code has been used already.';
    if (Object.keys(errors).length) return { errors, v };
    set.conditions_json = C.apply(b, 'conditions', C.parse(rule && rule.conditions_json, 'cart'), 'cart');
    set.actions_json = C.apply(b, 'actions', C.parse(rule && rule.actions_json, 'cart', 'pcombine'), 'cart');
    let id;
    if (rule) { kit.db().prepare(`UPDATE sales_rules SET ${Object.keys(set).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...set, id: rule.id }); id = rule.id; }
    else { const row = { ...set, times_used: 0, source: 'admin' }; id = Number(kit.db().prepare(`INSERT INTO sales_rules (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((k) => '@' + k).join(', ')})`).run(row).lastInsertRowid); }
    // the rule's specific coupon (is_primary)
    const primary = kit.sql('SELECT * FROM coupons WHERE rule_id = ? AND coalesce(is_primary, 0) = 1').get(id);
    if (set.coupon_type === 2 && !set.use_auto_generation && v.coupon_code) {
      if (primary) kit.sql('UPDATE coupons SET code = ?, usage_limit = ?, usage_per_customer = ? WHERE id = ?').run(v.coupon_code, set.uses_per_coupon || null, set.uses_per_customer || null, primary.id);
      else kit.sql('INSERT INTO coupons (rule_id, code, usage_limit, usage_per_customer, times_used, is_primary, created_at, type) VALUES (?, ?, ?, ?, 0, 1, ?, 0)').run(id, v.coupon_code, set.uses_per_coupon || null, set.uses_per_customer || null, kit.nowSql());
    } else if (primary && set.coupon_type === 1) kit.sql('DELETE FROM coupons WHERE id = ?').run(primary.id);
    return { id };
  }
  const quoteSave = async (req, reply) => {
    const rule = req.params.id ? loadRule('sales_rules', req.params.id) : null;
    const res = saveQuote(rule, req.body || {});
    if (res.errors) { const m = quoteForm(rule, { values: res.v, errors: res.errors }); m.errorsList = ['Please correct the highlighted fields.']; return render(req, reply, m, 422); }
    req.flash('success', 'You saved the rule.');
    return reply.redirect(U.str(req.body.back) === 'edit' ? `/admin/sales_rule/promo_quote/edit/id/${res.id}/` : '/admin/sales_rule/promo_quote/');
  };
  r.post('/sales_rule/promo_quote/save', quoteSave);
  r.post('/sales_rule/promo_quote/save/id/:id', quoteSave);
  r.post('/sales_rule/promo_quote/delete/id/:id', async (req, reply) => {
    const rule = loadRule('sales_rules', req.params.id);
    kit.sql('DELETE FROM coupons WHERE rule_id = ?').run(rule.id);
    kit.sql('DELETE FROM sales_rule_usage WHERE rule_id = ?').run(rule.id);
    kit.sql('DELETE FROM sales_rules WHERE id = ?').run(rule.id);
    req.flash('success', 'You deleted the rule.');
    return reply.redirect('/admin/sales_rule/promo_quote/');
  });
  r.post('/sales_rule/promo_quote/generate/id/:id', async (req, reply) => {
    const rule = loadRule('sales_rules', req.params.id);
    const b = req.body || {};
    const qty = Math.min(1000, Math.max(1, parseInt(U.str(b.qty), 10) || 1));
    const len = Math.min(32, Math.max(4, parseInt(U.str(b.length), 10) || 12));
    const fmt = U.str(b.format) || 'alphanum';
    const dash = Math.max(0, parseInt(U.str(b.dash), 10) || 0);
    const chars = fmt === 'alpha' ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : fmt === 'num' ? '0123456789' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const n0 = kit.sql('SELECT count(*) FROM coupons').pluck().get();
    const rnd = U.prng(`coupon:${rule.id}:${n0}`); // deterministic per rollout state
    let made = 0; let guard = 0;
    while (made < qty && guard++ < qty * 20) {
      let code = Array.from({ length: len }, () => chars[Math.floor(rnd() * chars.length)]).join('');
      if (dash) code = code.match(new RegExp(`.{1,${dash}}`, 'g')).join('-');
      code = `${U.str(b.prefix)}${code}${U.str(b.suffix)}`;
      if (kit.sql('SELECT 1 FROM coupons WHERE code = ?').get(code)) continue;
      kit.sql('INSERT INTO coupons (rule_id, code, usage_limit, usage_per_customer, times_used, is_primary, created_at, type) VALUES (?, ?, ?, ?, 0, 0, ?, 1)').run(rule.id, code, rule.uses_per_coupon || null, rule.uses_per_customer || null, kit.nowSql());
      made++;
    }
    if (rule.coupon_type !== 3 || !rule.use_auto_generation) kit.sql('UPDATE sales_rules SET use_auto_generation = 1, coupon_type = CASE WHEN coupon_type = 1 THEN 3 ELSE coupon_type END WHERE id = ?').run(rule.id);
    req.flash('success', `${made} coupon(s) have been generated.`);
    return reply.redirect(`/admin/sales_rule/promo_quote/edit/id/${rule.id}/#manage_coupon_codes`);
  });
  r.post('/sales_rule/promo_quote/couponsMassDelete/id/:id', async (req, reply) => {
    const rule = loadRule('sales_rules', req.params.id);
    const ids = U.ids(req.body.ids);
    for (const id of ids) kit.sql('DELETE FROM coupons WHERE id = ? AND rule_id = ?').run(id, rule.id);
    req.flash('success', `A total of ${ids.length} coupon(s) have been deleted.`);
    return reply.redirect(`/admin/sales_rule/promo_quote/edit/id/${rule.id}/#manage_coupon_codes`);
  });

  // ================================================================ catalog price rules
  const CATALOG = {
    id: 'catalog_rule_grid', url: '/admin/catalog_rule/promo_catalog/', idCol: 'r.id', from: 'catalog_rules r', defaultSort: 'rule_id_desc',
    keyword: (q) => ({ where: "r.name LIKE ? ESCAPE '\\'", params: [like(q)] }),
    columns: [
      { key: 'rule_id', label: 'ID', sql: 'r.id', cls: 'num', filter: { type: 'range', col: 'r.id' } },
      { key: 'name', label: 'Rule', sql: 'r.name', filter: { type: 'text' }, html: (x) => `<a href="/admin/catalog_rule/promo_catalog/edit/id/${x._id}/">${h(x.name)}</a>` },
      { key: 'from_date', label: 'Start', sql: 'r.from_date', filter: { type: 'daterange', local: false }, html: (x) => h(x.from_date ? U.date.medium(x.from_date) : '') },
      { key: 'to_date', label: 'End', sql: 'r.to_date', filter: { type: 'daterange', local: false }, html: (x) => h(x.to_date ? U.date.medium(x.to_date) : '') },
      { key: 'is_active', label: 'Status', sql: 'r.is_active', filter: { type: 'select', options: [[1, 'Active'], [0, 'Inactive']] }, html: (x) => (x.is_active ? 'Active' : 'Inactive') },
      { key: 'website', label: 'Web Site', sql: "'Main Website'", sort: false },
      { key: 'sort_order', label: 'Priority', sql: 'r.sort_order', cls: 'num' },
    ],
    rowActions: (x) => `<a href="/admin/catalog_rule/promo_catalog/edit/id/${x._id}/">Edit</a>`,
  };
  const catGrid = async (req, reply) => view(reply, 'grid_page', { title: 'Catalog Price Rule', g: grid.build(req, kit, CATALOG), crumbs: [['Marketing', null], ['Catalog Price Rule', null]],
    actions: [{ label: 'Apply Rules', post: '/admin/catalog_rule/promo_catalog/applyRules/', id: 'apply_rules' }, { label: 'Add New Rule', href: '/admin/catalog_rule/promo_catalog/new/', primary: true, id: 'add' }] });
  r.get('/catalog_rule/promo_catalog', catGrid);
  r.get('/catalog_rule/promo_catalog/index', catGrid);
  function catalogForm(rule, { values = {}, errors = {} } = {}) {
    const isNew = !rule;
    const v = { name: rule ? rule.name : '', description: rule ? rule.description || '' : '', is_active: rule ? rule.is_active : 1, 'website_ids[]': [1],
      'customer_group_ids[]': rule ? String(rule.customer_group_ids || '').split(',').filter((x) => x !== '') : [], from_date: rule && rule.from_date ? String(rule.from_date).slice(0, 10) : '',
      to_date: rule && rule.to_date ? String(rule.to_date).slice(0, 10) : '', sort_order: rule ? rule.sort_order ?? 0 : 0, simple_action: rule ? rule.simple_action : 'by_percent',
      discount_amount: rule ? U.num(rule.discount_amount ?? 0) : '', stop_rules_processing: rule ? rule.stop_rules_processing || 0 : 0, ...values };
    const cond = C.parse(rule && rule.conditions_json, 'catalog');
    const title = isNew ? 'New Catalog Price Rule' : rule.name;
    return {
      title, values: v, errors, formId: 'catalog_rule_form', action: isNew ? '/admin/catalog_rule/promo_catalog/save/' : `/admin/catalog_rule/promo_catalog/save/id/${rule.id}/`,
      crumbs: [['Marketing', null], ['Catalog Price Rule', '/admin/catalog_rule/promo_catalog/'], [title, null]],
      actions: [{ label: 'Back', href: '/admin/catalog_rule/promo_catalog/', id: 'back' },
        ...(isNew ? [] : [{ label: 'Delete Rule', post: `/admin/catalog_rule/promo_catalog/delete/id/${rule.id}/`, confirm: 'Are you sure you want to do this?', id: 'delete' }]),
        { label: 'Save and Apply', form: 'catalog_rule_form', name: 'auto_apply', value: '1', id: 'save_and_apply' },
        { label: 'Save and Continue Edit', form: 'catalog_rule_form', name: 'back', value: 'edit', id: 'save_and_continue' }, { label: 'Save', form: 'catalog_rule_form', primary: true, id: 'save' }],
      sections: [
        { title: 'Rule Information', fields: [
          { name: 'name', label: 'Rule Name', required: true }, { name: 'description', label: 'Description', type: 'textarea', rows: 3 },
          { name: 'is_active', label: 'Active', type: 'checkbox', checkLabel: 'Active' },
          { name: 'website_ids[]', id: 'website_ids', index: 'website_ids', label: 'Websites', type: 'select', multiple: true, options: [[1, 'Main Website']], required: true },
          { name: 'customer_group_ids[]', id: 'customer_group_ids', index: 'customer_group_ids', label: 'Customer Groups', type: 'select', multiple: true, options: groups(), required: true },
          { name: 'from_date', label: 'From', type: 'date' }, { name: 'to_date', label: 'To', type: 'date' }, { name: 'sort_order', label: 'Priority', type: 'number' },
        ] },
        { title: 'Conditions', collapsible: true, id: 'conditions', html: `<p>Apply the rule only if the following conditions are met (leave blank for all products).</p>${C.editor('conditions', cond, 'catalog')}` },
        { title: 'Actions', collapsible: true, id: 'actions', fields: [
          { name: 'simple_action', label: 'Apply', type: 'select', options: ACTIONS_CATALOG }, { name: 'discount_amount', label: 'Discount Amount', required: true },
          { name: 'stop_rules_processing', label: 'Discard subsequent rules', type: 'checkbox' },
        ] },
      ],
    };
  }
  r.get('/catalog_rule/promo_catalog/new', async (req, reply) => view(reply, 'form_page', catalogForm(null)));
  r.get('/catalog_rule/promo_catalog/edit/id/:id', async (req, reply) => view(reply, 'form_page', catalogForm(loadRule('catalog_rules', req.params.id))));
  const catSave = async (req, reply) => {
    const rule = req.params.id ? loadRule('catalog_rules', req.params.id) : null;
    const b = req.body || {};
    const { v, errors, set } = readRule(b, 'catalog');
    if (Object.keys(errors).length) { const m = catalogForm(rule, { values: v, errors }); m.errorsList = ['Please correct the highlighted fields.']; return view(reply, 'form_page', m, 422); }
    set.conditions_json = C.apply(b, 'conditions', C.parse(rule && rule.conditions_json, 'catalog'), 'catalog');
    if (!rule) set.actions_json = '{"type":"Magento\\\\CatalogRule\\\\Model\\\\Rule\\\\Action\\\\Collection","attribute":null,"operator":"=","value":null}';
    let id;
    if (rule) { kit.db().prepare(`UPDATE catalog_rules SET ${Object.keys(set).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...set, id: rule.id }); id = rule.id; }
    else { const row = { ...set, source: 'admin' }; id = Number(kit.db().prepare(`INSERT INTO catalog_rules (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map((k) => '@' + k).join(', ')})`).run(row).lastInsertRowid); }
    req.flash('success', 'You saved the rule.');
    if (U.str(b.auto_apply) === '1') req.flash('success', 'Updated rules applied.');
    return reply.redirect(U.str(b.back) === 'edit' ? `/admin/catalog_rule/promo_catalog/edit/id/${id}/` : '/admin/catalog_rule/promo_catalog/');
  };
  r.post('/catalog_rule/promo_catalog/save', catSave);
  r.post('/catalog_rule/promo_catalog/save/id/:id', catSave);
  r.post('/catalog_rule/promo_catalog/delete/id/:id', async (req, reply) => {
    const rule = loadRule('catalog_rules', req.params.id);
    kit.sql('DELETE FROM catalog_rules WHERE id = ?').run(rule.id);
    req.flash('success', 'You deleted the rule.');
    return reply.redirect('/admin/catalog_rule/promo_catalog/');
  });
  r.post('/catalog_rule/promo_catalog/applyRules', async (req, reply) => { req.flash('success', 'Updated rules applied.'); return reply.redirect('/admin/catalog_rule/promo_catalog/'); });

  // ================================================================ newsletter
  const SUBS = {
    id: 'newsletter_subscriber_grid', url: '/admin/newsletter/subscriber/', idCol: 's.id', from: 'newsletter_subscribers s', defaultSort: 'id_desc',
    keyword: (q) => ({ where: "(s.email LIKE ? ESCAPE '\\' OR s.customer_id IN (SELECT id FROM customers WHERE (coalesce(firstname, '') || ' ' || coalesce(lastname, '')) LIKE ? ESCAPE '\\'))", params: [like(q), like(q)] }),
    columns: [
      { key: 'id', label: 'ID', sql: 's.id', cls: 'num', filter: { type: 'range' } },
      { key: 'email', label: 'Email', sql: 's.email', filter: { type: 'text' } },
      { key: 'type', label: 'Type', sql: "CASE WHEN s.customer_id IS NULL THEN 'Guest' ELSE 'Customer' END", sort: false, filter: { type: 'select', options: [['1', 'Guest'], ['2', 'Customer']], build: (v) => ({ where: v === '1' ? 's.customer_id IS NULL' : 's.customer_id IS NOT NULL', params: [] }) } },
      { key: 'firstname', label: 'Customer First Name', sql: '(SELECT firstname FROM customers c WHERE c.id = s.customer_id)', filter: { type: 'text' } },
      { key: 'lastname', label: 'Customer Last Name', sql: '(SELECT lastname FROM customers c WHERE c.id = s.customer_id)', filter: { type: 'text' } },
      { key: 'status', label: 'Status', sql: 's.status', filter: { type: 'select', options: NL_STATUS }, html: (x) => h((NL_STATUS.find((y) => y[0] === x.status) || [0, ''])[1]) },
      { key: 'website', label: 'Web Site', sql: "'Main Website'", sort: false }, { key: 'store', label: 'Store', sql: "'Main Website Store'", sort: false }, { key: 'store_view', label: 'Store View', sql: "'Default Store View'", sort: false },
    ],
    massActions: [{ value: 'unsubscribe', label: 'Unsubscribe' }, { value: 'delete', label: 'Delete', confirm: 'Are you sure?' }],
  };
  r.get('/newsletter/subscriber', async (req, reply) => view(reply, 'grid_page', { title: 'Newsletter Subscribers', g: grid.build(req, kit, SUBS), crumbs: [['Marketing', null], ['Newsletter Subscribers', null]] }));
  r.post('/newsletter/subscriber/massAction', async (req, reply) => {
    const ids = grid.selectedIds(req, kit, SUBS);
    const act = U.str(req.body.mass_action);
    const back = ctx.back(req, '/admin/newsletter/subscriber/');
    if (!ids.length) { req.flash('error', 'Please select one or more subscribers.'); return reply.redirect(back); }
    if (act === 'delete') for (const id of ids) kit.sql('DELETE FROM newsletter_subscribers WHERE id = ?').run(id);
    else if (act === 'unsubscribe') for (const id of ids) kit.sql('UPDATE newsletter_subscribers SET status = 3, change_status_at = ? WHERE id = ?').run(kit.nowSql(), id);
    else { req.flash('error', 'Please select an action.'); return reply.redirect(back); }
    req.flash('success', `A total of ${ids.length} record(s) were ${act === 'delete' ? 'deleted' : 'updated'}.`);
    return reply.redirect(back);
  });
  const TPL = {
    id: 'newsletter_template_grid', url: '/admin/newsletter/template/', idCol: 't.id', from: 'temp.newsletter_templates t', defaultSort: 'id_desc',
    columns: [
      { key: 'id', label: 'ID', sql: 't.id', cls: 'num' },
      { key: 'code', label: 'Template', sql: 't.code', filter: { type: 'text' }, html: (x) => `<a href="/admin/newsletter/template/edit/id/${x._id}/">${h(x.code)}</a>` },
      { key: 'added_at', label: 'Added', sql: 't.added_at', html: (x) => h(U.date.datetime(x.added_at)) }, { key: 'modified_at', label: 'Updated', sql: 't.modified_at', html: (x) => h(U.date.datetime(x.modified_at)) },
      { key: 'subject', label: 'Subject', sql: 't.subject', filter: { type: 'text' } }, { key: 'sender_name', label: 'Sender', sql: 't.sender_name' },
    ],
    rowActions: (x) => `<a href="/admin/newsletter/template/edit/id/${x._id}/">Edit</a> &middot; <a href="/admin/newsletter/queue/edit/template_id/${x._id}/">Queue Newsletter&hellip;</a>`,
  };
  r.get('/newsletter/template', async (req, reply) => view(reply, 'grid_page', { title: 'Newsletter Templates', g: grid.build(req, kit, TPL), crumbs: [['Marketing', null], ['Newsletter Templates', null]], actions: [{ label: 'Add New Template', href: '/admin/newsletter/template/new/', primary: true, id: 'add' }] }));
  const tplForm = (t, values = {}, errors = {}) => ({
    title: t ? `Edit Newsletter Template: ${t.code}` : 'New Newsletter Template', action: t ? `/admin/newsletter/template/save/id/${t.id}/` : '/admin/newsletter/template/save/', errors,
    values: { code: t ? t.code : '', subject: t ? t.subject : '', sender_name: t ? t.sender_name : 'Owner', sender_email: t ? t.sender_email : 'owner@example.com', text: t ? t.text : '', styles: t ? t.styles || '' : '', ...values },
    crumbs: [['Marketing', null], ['Newsletter Templates', '/admin/newsletter/template/'], [t ? t.code : 'New Template', null]],
    actions: [{ label: 'Back', href: '/admin/newsletter/template/' }, ...(t ? [{ label: 'Delete Template', post: `/admin/newsletter/template/delete/id/${t.id}/`, confirm: 'Are you sure?', id: 'delete' }, { label: 'Queue Newsletter', href: `/admin/newsletter/queue/edit/template_id/${t.id}/` }] : []), { label: 'Save Template', form: 'edit_form', primary: true, id: 'save' }],
    sections: [{ title: 'Template Information', fields: [{ name: 'code', label: 'Template Name', required: true }, { name: 'subject', label: 'Template Subject', required: true }, { name: 'sender_name', label: 'Sender Name', required: true }, { name: 'sender_email', label: 'Sender Email', type: 'email', required: true }, { name: 'text', label: 'Template Content', type: 'textarea', rows: 12, required: true }, { name: 'styles', label: 'Template Styles', type: 'textarea', rows: 4 }] }],
  });
  const loadTpl = (id) => { const t = kit.sql('SELECT * FROM temp.newsletter_templates WHERE id = ?').get(+id); if (!t) throw ctx.notFound('newsletter template'); return t; };
  r.get('/newsletter/template/new', async (req, reply) => view(reply, 'form_page', tplForm(null)));
  r.get('/newsletter/template/edit/id/:id', async (req, reply) => view(reply, 'form_page', tplForm(loadTpl(req.params.id))));
  const tplSave = async (req, reply) => {
    const t = req.params.id ? loadTpl(req.params.id) : null;
    const b = req.body || {};
    const v = Object.fromEntries(['code', 'subject', 'sender_name', 'sender_email', 'text', 'styles'].map((k) => [k, U.str(b[k])]));
    const errors = {};
    for (const k of ['code', 'subject', 'sender_name', 'sender_email', 'text']) if (!v[k]) errors[k] = 'This is a required field.';
    if (v.sender_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.sender_email)) errors.sender_email = 'Please enter a valid email address.';
    if (Object.keys(errors).length) return view(reply, 'form_page', tplForm(t, v, errors), 422);
    const now = kit.nowSql();
    if (t) kit.sql('UPDATE temp.newsletter_templates SET code = ?, subject = ?, sender_name = ?, sender_email = ?, text = ?, styles = ?, modified_at = ? WHERE id = ?').run(v.code, v.subject, v.sender_name, v.sender_email, v.text, v.styles, now, t.id);
    else kit.sql('INSERT INTO temp.newsletter_templates (code, subject, sender_name, sender_email, text, styles, is_active, added_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)').run(v.code, v.subject, v.sender_name, v.sender_email, v.text, v.styles, now, now);
    req.flash('success', 'The newsletter template has been saved.');
    return reply.redirect('/admin/newsletter/template/');
  };
  r.post('/newsletter/template/save', tplSave);
  r.post('/newsletter/template/save/id/:id', tplSave);
  r.post('/newsletter/template/delete/id/:id', async (req, reply) => { const t = loadTpl(req.params.id); kit.sql('DELETE FROM temp.newsletter_templates WHERE id = ?').run(t.id); req.flash('success', 'The newsletter template has been deleted.'); return reply.redirect('/admin/newsletter/template/'); });
  const QUEUE = {
    id: 'newsletter_queue_grid', url: '/admin/newsletter/queue/', idCol: 'q.id', from: 'temp.newsletter_queue q', defaultSort: 'id_desc',
    columns: [
      { key: 'id', label: 'ID', sql: 'q.id', cls: 'num' },
      { key: 'start_at', label: 'Queue Start', sql: 'q.start_at', html: (x) => h(U.date.datetime(x.start_at)) }, { key: 'finish_at', label: 'Queue End', sql: 'q.finish_at', html: (x) => h(U.date.datetime(x.finish_at)) },
      { key: 'subject', label: 'Subject', sql: 'q.subject', filter: { type: 'text' } },
      { key: 'status', label: 'Status', sql: 'q.status', filter: { type: 'select', options: Object.entries(Q_STATUS) }, html: (x) => Q_STATUS[x.status] || '' },
      { key: 'recipients', label: 'Processed', sql: 'q.sent', cls: 'num' }, { key: 'total', label: 'Recipients', sql: 'q.recipients', cls: 'num' },
    ],
    rowActions: (x) => (x.status === 0 ? `<form method="post" class="inline" action="/admin/newsletter/queue/cancel/id/${x._id}/"><input type="hidden" name="_csrf" value="__CSRF__"><button class="link" type="submit">Cancel</button></form>` : ''),
  };
  r.get('/newsletter/queue', async (req, reply) => {
    const g = grid.build(req, kit, QUEUE);
    const tok = kit.escapeHtml(req.csrfToken());
    g.rowActions = (x) => QUEUE.rowActions(x).replace('__CSRF__', tok);
    return view(reply, 'grid_page', { title: 'Newsletter Queue', g, crumbs: [['Marketing', null], ['Newsletter Queue', null]] });
  });
  r.get('/newsletter/queue/edit/template_id/:id', async (req, reply) => {
    const t = loadTpl(req.params.id);
    return view(reply, 'form_page', {
      title: `Queue Newsletter: ${t.code}`, action: `/admin/newsletter/queue/save/template_id/${t.id}/`, values: { start_at: '', subject: t.subject, sender_name: t.sender_name, sender_email: t.sender_email, text: t.text },
      crumbs: [['Marketing', null], ['Newsletter Queue', '/admin/newsletter/queue/'], ['Queue Newsletter', null]],
      actions: [{ label: 'Back', href: '/admin/newsletter/template/' }, { label: 'Save Newsletter', form: 'edit_form', primary: true, id: 'save' }],
      sections: [{ title: 'Queue Information', fields: [{ name: 'start_at', label: 'Queue Date Start', type: 'datetime-local', note: 'Empty = send now. Store time (America/New_York).' }, { name: 'stores', label: 'Subscribers From', type: 'select', options: [[1, 'Default Store View']] }, { name: 'subject', label: 'Subject', required: true }, { name: 'sender_name', label: 'Sender Name', required: true }, { name: 'sender_email', label: 'Sender Email', required: true }, { name: 'text', label: 'Message', type: 'textarea', rows: 10, required: true }] }],
    });
  });
  r.post('/newsletter/queue/save/template_id/:id', async (req, reply) => {
    const t = loadTpl(req.params.id);
    const b = req.body || {};
    const startLocal = U.str(b.start_at).replace('T', ' ');
    const startUtc = startLocal && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(startLocal) ? U.localToUtc(startLocal.length === 16 ? `${startLocal}:00` : startLocal) : kit.nowSql();
    const recipients = kit.sql('SELECT count(*) FROM newsletter_subscribers WHERE status = 1').pluck().get();
    const id = Number(kit.sql('INSERT INTO temp.newsletter_queue (template_id, subject, sender_name, sender_email, text, status, start_at, recipients, sent) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0)')
      .run(t.id, U.str(b.subject) || t.subject, U.str(b.sender_name) || t.sender_name, U.str(b.sender_email) || t.sender_email, U.str(b.text) || t.text, startUtc, recipients).lastInsertRowid);
    const jid = kit.jobs.enqueue('admin.newsletter.send', { queue_id: id }, { at: startUtc > kit.nowSql() ? startUtc : kit.nowSql() });
    kit.sql('UPDATE temp.newsletter_queue SET job_id = ? WHERE id = ?').run(jid, id);
    req.flash('success', 'You saved the newsletter queue.');
    return reply.redirect('/admin/newsletter/queue/');
  });
  r.post('/newsletter/queue/cancel/id/:id', async (req, reply) => {
    const n = kit.sql('UPDATE temp.newsletter_queue SET status = 2 WHERE id = ? AND status = 0').run(+req.params.id).changes;
    req.flash(n ? 'success' : 'error', n ? 'The newsletter queue has been cancelled.' : 'This newsletter cannot be cancelled.');
    return reply.redirect('/admin/newsletter/queue/');
  });

  // ================================================================ search terms + synonyms
  const TERMS = {
    id: 'search_term_grid', url: '/admin/search/term/index/', idCol: 't.id', from: 'search_terms t', defaultSort: 'id_asc',
    keyword: (q) => ({ where: "t.query_text LIKE ? ESCAPE '\\'", params: [like(q)] }),
    columns: [
      { key: 'id', label: 'ID', sql: 't.id', cls: 'num', filter: { type: 'range' } },
      { key: 'query_text', label: 'Search Query', sql: 't.query_text', filter: { type: 'text' }, html: (x) => `<a href="/admin/search/term/edit/id/${x._id}/">${h(x.query_text)}</a>` },
      { key: 'store', label: 'Store', sql: "'Default Store View'", sort: false },
      { key: 'num_results', label: 'Results', sql: 't.num_results', cls: 'num', filter: { type: 'range' } },
      { key: 'popularity', label: 'Uses', sql: 't.popularity', cls: 'num', filter: { type: 'range' } },
      { key: 'redirect', label: 'Redirect URL', sql: 't.redirect', filter: { type: 'text' } },
      { key: 'display_in_terms', label: 'Suggested Terms', sql: 't.display_in_terms', filter: { type: 'select', options: [[1, 'Yes'], [0, 'No']] }, html: (x) => (x.display_in_terms ? 'Yes' : 'No') },
    ],
    rowActions: (x) => `<a href="/admin/search/term/edit/id/${x._id}/">Edit</a>`,
    massActions: [{ value: 'delete', label: 'Delete', confirm: 'Are you sure?' }],
  };
  const termsGrid = async (req, reply) => view(reply, 'grid_page', { title: 'Search Terms', g: grid.build(req, kit, TERMS), crumbs: [['Marketing', null], ['SEO & Search', null], ['Search Terms', null]], actions: [{ label: 'Add New Search Term', href: '/admin/search/term/new/', primary: true, id: 'add' }] });
  r.get('/search/term/index', termsGrid);
  r.get('/search/term', termsGrid);
  const termForm = (t, values = {}, errors = {}) => ({
    title: t ? t.query_text : 'New Search', action: t ? `/admin/search/term/save/id/${t.id}/` : '/admin/search/term/save/', errors,
    values: { query_text: t ? t.query_text : '', num_results: t ? t.num_results ?? 0 : 0, popularity: t ? t.popularity ?? 0 : 0, redirect: t ? t.redirect || '' : '', display_in_terms: t ? t.display_in_terms ?? 1 : 1, ...values },
    crumbs: [['Marketing', null], ['Search Terms', '/admin/search/term/index/'], [t ? t.query_text : 'New Search', null]],
    actions: [{ label: 'Back', href: '/admin/search/term/index/' }, ...(t ? [{ label: 'Delete Search', post: `/admin/search/term/delete/id/${t.id}/`, confirm: 'Are you sure you want to do this?', id: 'delete' }] : []), { label: 'Save Search', form: 'edit_form', primary: true, id: 'save' }],
    sections: [{ title: 'General Information', fields: [{ name: 'query_text', label: 'Search Query', required: true }, { name: 'store_id', label: 'Store', type: 'select', options: [[1, 'Default Store View']] }, { name: 'num_results', label: 'Number of results', type: 'number', note: 'For the last time placed.' }, { name: 'popularity', label: 'Number of Uses', type: 'number' }, { name: 'redirect', label: 'Redirect URL', note: 'ex. http://domain.com' }, { name: 'display_in_terms', label: 'Display in Suggested Terms', type: 'select', options: [[1, 'Yes'], [0, 'No']] }] }],
  });
  const loadTerm = (id) => { const t = kit.sql('SELECT * FROM search_terms WHERE id = ?').get(+id); if (!t) throw ctx.notFound('search term'); return t; };
  r.get('/search/term/new', async (req, reply) => view(reply, 'form_page', termForm(null)));
  r.get('/search/term/edit/id/:id', async (req, reply) => view(reply, 'form_page', termForm(loadTerm(req.params.id))));
  const termSave = async (req, reply) => {
    const t = req.params.id ? loadTerm(req.params.id) : null;
    const b = req.body || {};
    const v = { query_text: U.str(b.query_text), num_results: parseInt(U.str(b.num_results), 10) || 0, popularity: parseInt(U.str(b.popularity), 10) || 0, redirect: U.str(b.redirect) || null, display_in_terms: U.str(b.display_in_terms) === '0' ? 0 : 1 };
    const errors = {};
    if (!v.query_text) errors.query_text = 'This is a required field.';
    else if (kit.sql('SELECT 1 FROM search_terms WHERE query_text = ? AND id IS NOT ?').get(v.query_text, t ? t.id : null)) errors.query_text = 'You already have an identical search term query.';
    if (Object.keys(errors).length) return view(reply, 'form_page', termForm(t, v, errors), 422);
    if (t) kit.sql('UPDATE search_terms SET query_text = @query_text, num_results = @num_results, popularity = @popularity, redirect = @redirect, display_in_terms = @display_in_terms, updated_at = @now WHERE id = @id').run({ ...v, now: kit.nowSql(), id: t.id });
    else kit.sql("INSERT INTO search_terms (query_text, num_results, popularity, redirect, display_in_terms, is_active, updated_at, source) VALUES (@query_text, @num_results, @popularity, @redirect, @display_in_terms, 1, @now, 'admin')").run({ ...v, now: kit.nowSql() });
    req.flash('success', 'You saved the search term.');
    return reply.redirect('/admin/search/term/index/');
  };
  r.post('/search/term/save', termSave);
  r.post('/search/term/save/id/:id', termSave);
  r.post('/search/term/delete/id/:id', async (req, reply) => { const t = loadTerm(req.params.id); kit.sql('DELETE FROM search_terms WHERE id = ?').run(t.id); req.flash('success', 'You deleted the search.'); return reply.redirect('/admin/search/term/index/'); });
  r.post('/search/term/index/massAction', async (req, reply) => {
    const ids = grid.selectedIds(req, kit, TERMS);
    if (U.str(req.body.mass_action) !== 'delete' || !ids.length) { req.flash('error', 'Please select searches.'); return reply.redirect(ctx.back(req, '/admin/search/term/index/')); }
    for (const id of ids) kit.sql('DELETE FROM search_terms WHERE id = ?').run(id);
    req.flash('success', `Total of ${ids.length} record(s) were deleted.`);
    return reply.redirect(ctx.back(req, '/admin/search/term/index/'));
  });
  const SYN = {
    id: 'search_synonyms_grid', url: '/admin/search/synonyms/', idCol: 's.id', from: 'search_synonyms s', defaultSort: 'id_asc',
    columns: [
      { key: 'id', label: 'ID', sql: 's.id', cls: 'num' },
      { key: 'synonyms', label: 'Synonyms', sql: 's.synonyms', filter: { type: 'text' }, html: (x) => `<a href="/admin/search/synonyms/edit/group_id/${x._id}/">${h(x.synonyms)}</a>` },
      { key: 'scope', label: 'Scope', sql: "'All Websites'", sort: false },
    ],
    rowActions: (x) => `<a href="/admin/search/synonyms/edit/group_id/${x._id}/">Edit</a>`,
  };
  r.get('/search/synonyms', async (req, reply) => view(reply, 'grid_page', { title: 'Search Synonyms', g: grid.build(req, kit, SYN), crumbs: [['Marketing', null], ['SEO & Search', null], ['Search Synonyms', null]], actions: [{ label: 'New Synonym Group', href: '/admin/search/synonyms/new/', primary: true, id: 'add' }] }));
  const synForm = (s, values = {}, errors = {}) => ({
    title: s ? 'Edit Synonym Group' : 'New Synonym Group', action: s ? `/admin/search/synonyms/save/group_id/${s.id}/` : '/admin/search/synonyms/save/', errors, values: { synonyms: s ? s.synonyms : '', ...values },
    crumbs: [['Marketing', null], ['Search Synonyms', '/admin/search/synonyms/'], [s ? 'Edit' : 'New', null]],
    actions: [{ label: 'Back', href: '/admin/search/synonyms/' }, ...(s ? [{ label: 'Delete Synonym Group', post: `/admin/search/synonyms/delete/group_id/${s.id}/`, confirm: 'Are you sure?', id: 'delete' }] : []), { label: 'Save Synonym Group', form: 'edit_form', primary: true, id: 'save' }],
    sections: [{ title: 'Synonyms Details', fields: [{ name: 'synonyms', label: 'Synonyms', required: true, type: 'textarea', rows: 3, note: 'Comma-separated list of synonyms. The words (or phrases) are interchangeable in searches.' }] }],
  });
  const loadSyn = (id) => { const s = kit.sql('SELECT * FROM search_synonyms WHERE id = ?').get(+id); if (!s) throw ctx.notFound('synonym group'); return s; };
  r.get('/search/synonyms/new', async (req, reply) => view(reply, 'form_page', synForm(null)));
  r.get('/search/synonyms/edit/group_id/:id', async (req, reply) => view(reply, 'form_page', synForm(loadSyn(req.params.id))));
  const synSave = async (req, reply) => {
    const s = req.params.id ? loadSyn(req.params.id) : null;
    const v = U.str(req.body.synonyms).split(',').map((x) => x.trim()).filter(Boolean).join(',');
    if (!v.includes(',')) return view(reply, 'form_page', synForm(s, { synonyms: U.str(req.body.synonyms) }, { synonyms: 'Please enter at least two comma-separated terms.' }), 422);
    if (s) kit.sql('UPDATE search_synonyms SET synonyms = ? WHERE id = ?').run(v, s.id); else kit.sql('INSERT INTO search_synonyms (synonyms) VALUES (?)').run(v);
    req.flash('success', 'You saved the synonym group.');
    return reply.redirect('/admin/search/synonyms/');
  };
  r.post('/search/synonyms/save', synSave);
  r.post('/search/synonyms/save/group_id/:id', synSave);
  r.post('/search/synonyms/delete/group_id/:id', async (req, reply) => { const s = loadSyn(req.params.id); kit.sql('DELETE FROM search_synonyms WHERE id = ?').run(s.id); req.flash('success', 'The synonym group has been deleted.'); return reply.redirect('/admin/search/synonyms/'); });
};
