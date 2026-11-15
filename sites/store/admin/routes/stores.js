'use strict';
// Stores: configuration sections (store_config), all stores, tax rates, product attributes
// (labels, flags, options), attribute sets.
module.exports = (r, ctx) => {
  const { kit, U, grid, view } = ctx;
  const h = kit.escapeHtml;
  const cfg = (p) => kit.sql('SELECT value FROM store_config WHERE path = ?').pluck().get(p);
  const countries = () => kit.sql('SELECT id, name FROM countries ORDER BY name').all().map((c) => [c.id, c.name]);
  const yesno = [[1, 'Yes'], [0, 'No']];

  // ---------------------------------------------------------------- configuration
  const SECTIONS = {
    general: { label: 'General', tab: 'General', groups: [
      ['Country Options', [['general/country/default', 'Default Country', 'select', countries], ['general/country/allow', 'Allow Countries', 'multiselect', countries]]],
      ['State Options', [['general/region/display_all', 'Allow to Choose State if It is Optional for Country', 'select', () => yesno]]],
      ['Locale Options', [['general/locale/timezone', 'Timezone', 'select', () => ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'UTC', 'Europe/London'].map((z) => [z, z])], ['general/locale/code', 'Locale', 'select', () => [['en_US', 'English (United States)'], ['en_GB', 'English (United Kingdom)'], ['fr_FR', 'French (France)'], ['de_DE', 'German (Germany)']]], ['general/locale/weight_unit', 'Weight Unit', 'select', () => [['lbs', 'lbs'], ['kgs', 'kgs']]]]],
      ['Store Information', [['general/store_information/name', 'Store Name'], ['general/store_information/phone', 'Store Phone Number'], ['general/store_information/hours', 'Store Hours of Operation'], ['general/store_information/country_id', 'Country', 'select', countries], ['general/store_information/region_id', 'Region/State'], ['general/store_information/postcode', 'ZIP/Postal Code'], ['general/store_information/city', 'City'], ['general/store_information/street_line1', 'Street Address'], ['general/store_information/street_line2', 'Street Address Line 2'], ['general/store_information/merchant_vat_number', 'VAT Number']]],
      ['Single-Store Mode', [['general/single_store_mode/enabled', 'Enable Single-Store Mode', 'select', () => yesno]]],
    ] },
    web: { label: 'Web', tab: 'General', groups: [
      ['Url Options', [['web/url/use_store', 'Add Store Code to Urls', 'select', () => yesno], ['web/url/redirect_to_base', 'Auto-redirect to Base URL', 'select', () => [[0, 'No'], [1, 'Yes (302 Found)'], [301, 'Yes (301 Moved Permanently)']]]]],
      ['Search Engine Optimization', [['web/seo/use_rewrites', 'Use Web Server Rewrites', 'select', () => yesno]]],
      ['Default Pages', [['web/default/front', 'Default Web URL'], ['web/default/cms_home_page', 'CMS Home Page', 'select', () => kit.sql('SELECT identifier, title FROM cms_pages ORDER BY id').all().map((p) => [p.identifier, p.title])], ['web/default/cms_no_route', 'CMS No Route Page', 'select', () => kit.sql('SELECT identifier, title FROM cms_pages ORDER BY id').all().map((p) => [p.identifier, p.title])]]],
      ['Default Cookie Settings', [['web/cookie/cookie_lifetime', 'Cookie Lifetime'], ['web/cookie/cookie_path', 'Cookie Path'], ['web/cookie/cookie_httponly', 'Use HTTP Only', 'select', () => yesno]]],
    ] },
    currency: { label: 'Currency Setup', tab: 'General', groups: [
      ['Currency Options', [['currency/options/base', 'Base Currency', 'select', () => [['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound']]], ['currency/options/default', 'Default Display Currency', 'select', () => [['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound']]], ['currency/options/allow', 'Allowed Currencies', 'multiselect', () => [['USD', 'US Dollar'], ['EUR', 'Euro'], ['GBP', 'British Pound']]]]],
    ] },
    contact: { label: 'Contacts', tab: 'General', groups: [
      ['Contact Us', [['contact/contact/enabled', 'Enable Contact Us', 'select', () => yesno]]],
      ['Email Options', [['contact/email/recipient_email', 'Send Emails To'], ['contact/email/sender_email_identity', 'Email Sender', 'select', () => [['general', 'General Contact'], ['sales', 'Sales Representative'], ['support', 'Customer Support']]]]],
    ] },
    catalog: { label: 'Catalog', tab: 'Catalog', groups: [
      ['Storefront', [['catalog/frontend/list_mode', 'List Mode', 'select', () => [['grid-list', 'Grid (default) / List'], ['list-grid', 'List (default) / Grid'], ['grid', 'Grid Only'], ['list', 'List Only']]], ['catalog/frontend/grid_per_page', 'Products per Page on Grid Default Value'], ['catalog/frontend/list_per_page', 'Products per Page on List Default Value'], ['catalog/frontend/default_sort_by', 'Product Listing Sort by', 'select', () => [['position', 'Position'], ['name', 'Product Name'], ['price', 'Price']]]]],
      ['Product Reviews', [['catalog/review/allow_guest', 'Allow Guests to Write Reviews', 'select', () => yesno], ['catalog/review/active', 'Enabled', 'select', () => yesno]]],
      ['Price', [['catalog/price/scope', 'Catalog Price Scope', 'select', () => [[0, 'Global'], [1, 'Website']]]]],
    ] },
    cataloginventory: { label: 'Inventory', tab: 'Catalog', groups: [
      ['Stock Options', [['cataloginventory/options/can_subtract', 'Decrease Stock When Order is Placed', 'select', () => yesno], ['cataloginventory/options/can_back_in_stock', 'Set Items\' Status to be In Stock When Order is Cancelled', 'select', () => yesno], ['cataloginventory/options/show_out_of_stock', 'Display Out of Stock Products', 'select', () => yesno]]],
      ['Product Stock Options', [['cataloginventory/item_options/manage_stock', 'Manage Stock', 'select', () => yesno], ['cataloginventory/item_options/backorders', 'Backorders', 'select', () => [[0, 'No Backorders'], [1, 'Allow Qty Below 0'], [2, 'Allow Qty Below 0 and Notify Customer']]], ['cataloginventory/item_options/max_sale_qty', 'Maximum Qty Allowed in Shopping Cart'], ['cataloginventory/item_options/min_qty', 'Out-of-Stock Threshold'], ['cataloginventory/item_options/notify_stock_qty', 'Notify for Quantity Below']]],
    ] },
    customer: { label: 'Customer Configuration', tab: 'Customers', groups: [
      ['Account Sharing Options', [['customer/account_share/scope', 'Share Customer Accounts', 'select', () => [[0, 'Global'], [1, 'Per Website']]]]],
      ['Online Customers Options', [['customer/online_customers/online_minutes_interval', 'Online Minutes Interval']]],
      ['Create New Account Options', [['customer/create_account/default_group', 'Default Group', 'select', () => kit.sql('SELECT id, code FROM customer_groups WHERE id > 0').all().map((g) => [g.id, g.code])], ['customer/create_account/confirm', 'Require Emails Confirmation', 'select', () => yesno]]],
      ['Password Options', [['customer/password/minimum_password_length', 'Minimum Password Length'], ['customer/password/lockout_failures', 'Maximum Login Failures to Lockout Account']]],
    ] },
    newsletter: { label: 'Newsletter', tab: 'Customers', groups: [
      ['General Options', [['newsletter/general/active', 'Enabled', 'select', () => yesno]]],
      ['Subscription Options', [['newsletter/subscription/allow_guest_subscribe', 'Allow Guest Subscription', 'select', () => yesno], ['newsletter/subscription/confirm', 'Need to Confirm', 'select', () => yesno]]],
    ] },
    sales: { label: 'Sales', tab: 'Sales', groups: [
      ['General', [['sales/general/hide_customer_ip', 'Hide Customer IP', 'select', () => yesno]]],
      ['Minimum Order Amount', [['sales/minimum_order/active', 'Enable', 'select', () => yesno], ['sales/minimum_order/amount', 'Minimum Amount'], ['sales/minimum_order/description', 'Description Message']]],
      ['Orders Cron Settings', [['sales/orders/delete_pending_after', 'Pending Payment Order Lifetime (minutes)']]],
      ['Gift Options', [['sales/gift_options/allow_order', 'Allow Gift Messages on Order Level', 'select', () => yesno], ['sales/gift_options/allow_items', 'Allow Gift Messages for Order Items', 'select', () => yesno]]],
    ] },
    carriers: { label: 'Delivery Methods', tab: 'Sales', groups: [
      ['Flat Rate', [['carriers/flatrate/active', 'Enabled', 'select', () => yesno], ['carriers/flatrate/title', 'Title'], ['carriers/flatrate/name', 'Method Name'], ['carriers/flatrate/price', 'Price'], ['carriers/flatrate/type', 'Type', 'select', () => [['', 'None'], ['O', 'Per Order'], ['I', 'Per Item']]]]],
      ['Free Shipping', [['carriers/freeshipping/active', 'Enabled', 'select', () => yesno], ['carriers/freeshipping/free_shipping_subtotal', 'Minimum Order Amount']]],
      ['Table Rates', [['carriers/tablerate/active', 'Enabled', 'select', () => yesno], ['carriers/tablerate/condition_name', 'Condition', 'select', () => [['package_weight', 'Weight vs. Destination'], ['package_value_with_discount', 'Price vs. Destination'], ['package_qty', '# of Items vs. Destination']]]]],
    ] },
    payment: { label: 'Payment Methods', tab: 'Sales', groups: [
      ['Check / Money Order', [['payment/checkmo/active', 'Enabled', 'select', () => yesno], ['payment/checkmo/title', 'Title'], ['payment/checkmo/payable_to', 'Make Check Payable to'], ['payment/checkmo/min_order_total', 'Minimum Order Total'], ['payment/checkmo/max_order_total', 'Maximum Order Total']]],
      ['Cash On Delivery Payment', [['payment/cashondelivery/active', 'Enabled', 'select', () => yesno], ['payment/cashondelivery/title', 'Title']]],
    ] },
  };
  const DEFAULTS = { 'web/default/cms_home_page': 'home', 'web/default/cms_no_route': 'no-route', 'web/default/front': 'cms', 'catalog/frontend/grid_per_page': '12', 'catalog/frontend/list_per_page': '10', 'catalog/frontend/list_mode': 'grid-list', 'catalog/frontend/default_sort_by': 'position', 'catalog/review/active': '1', 'catalog/review/allow_guest': '1', 'contact/contact/enabled': '1', 'contact/email/recipient_email': 'hello@example.com', 'customer/create_account/default_group': '1', 'customer/password/minimum_password_length': '8', 'newsletter/general/active': '1', 'carriers/flatrate/active': '1', 'carriers/flatrate/title': 'Flat Rate', 'carriers/flatrate/name': 'Fixed', 'carriers/flatrate/price': '5.00', 'carriers/flatrate/type': 'I', 'payment/checkmo/active': '1', 'payment/checkmo/title': 'Check / Money order', 'general/country/default': 'US', 'general/locale/weight_unit': 'lbs', 'cataloginventory/options/can_subtract': '1', 'cataloginventory/options/can_back_in_stock': '1', 'cataloginventory/item_options/manage_stock': '1', 'cataloginventory/item_options/max_sale_qty': '10000', 'cataloginventory/item_options/notify_stock_qty': '1', 'sales/minimum_order/active': '0' };
  const cfgOr = (p) => cfg(p) ?? DEFAULTS[p] ?? '';
  const fieldName = (p) => `groups[${p}]`;
  function sectionModel(key, values = {}, errors = {}) {
    const s = SECTIONS[key];
    const tabs = Object.entries(SECTIONS).map(([k, x]) => [`${x.tab}: ${x.label}`, `/admin/admin/system_config/edit/section/${k}/`, k === key]);
    const v = {};
    const sections = s.groups.map(([g, fields]) => ({ title: g, collapsible: true, fields: fields.map(([p, label, type, opts]) => {
      v[fieldName(p) + (type === 'multiselect' ? '[]' : '')] = type === 'multiselect' ? String(cfgOr(p)).split(',').filter(Boolean) : cfgOr(p);
      return { name: fieldName(p) + (type === 'multiselect' ? '[]' : ''), id: p.replace(/\//g, '_'), label, type: type === 'multiselect' ? 'select' : type || 'text', multiple: type === 'multiselect', options: opts ? opts() : undefined, scope: 'store view', note: `<code>${h(p)}</code>` };
    }) }));
    return { title: 'Configuration', sideTabs: tabs, sideTitle: 'Configuration', values: { ...v, ...values }, errors, sections, formId: 'config-edit-form', action: `/admin/admin/system_config/save/section/${key}/`,
      crumbs: [['Stores', null], ['Configuration', null], [s.label, null]], actions: [{ label: 'Save Config', form: 'config-edit-form', primary: true, id: 'save' }] };
  }
  r.get('/admin/system_config', async (req, reply) => reply.redirect('/admin/admin/system_config/edit/section/general/'));
  r.get('/admin/system_config/index', async (req, reply) => reply.redirect('/admin/admin/system_config/edit/section/general/'));
  r.get('/admin/system_config/edit/section/:section', async (req, reply) => {
    if (!SECTIONS[req.params.section]) throw kit.httpError(404, 'Page not found');
    return view(reply, 'form_page', sectionModel(req.params.section));
  });
  r.post('/admin/system_config/save/section/:section', async (req, reply) => {
    const s = SECTIONS[req.params.section];
    if (!s) throw kit.httpError(404, 'Page not found');
    const b = req.body || {};
    let n = 0;
    for (const [, fields] of s.groups) {
      for (const [p, , type] of fields) {
        const k = fieldName(p) + (type === 'multiselect' ? '[]' : '');
        if (!U.has(b, k) && type !== 'multiselect') continue;
        const val = type === 'multiselect' ? U.arr(b[k]).map(String).join(',') : U.str(b[k]);
        if (type === 'multiselect' && !U.has(b, k) && !U.has(b, `${k}__present`)) continue;
        if (String(cfg(p) ?? '') !== val) { kit.sql('INSERT OR REPLACE INTO store_config (path, value) VALUES (?, ?)').run(p, val); n++; }
      }
    }
    req.flash('success', 'You saved the configuration.');
    return reply.redirect(`/admin/admin/system_config/edit/section/${req.params.section}/`);
  });

  // ---------------------------------------------------------------- all stores
  r.get('/admin/system_store', async (req, reply) => {
    const html = `<table class="data-grid" id="storeGrid"><thead><tr><th>Web Site</th><th>Store</th><th>Store View</th></tr></thead><tbody>
      <tr><td><a href="/admin/admin/system_store/editWebsite/website_id/1/">Main Website</a> (Code: base)</td><td><a href="/admin/admin/system_store/editGroup/group_id/1/">Main Website Store</a></td><td><a href="/admin/admin/system_store/editStore/store_id/1/">Default Store View</a> (Code: default)</td></tr></tbody></table>
      <p class="muted">Single-store mode: one website, one store, one store view. Store name: ${h(cfg('general/store_information/name') || 'Main Website Store')}.</p>`;
    return view(reply, 'message_page', { title: 'Stores', html, crumbs: [['Stores', null], ['All Stores', null]] });
  });
  for (const p of ['/admin/system_store/editWebsite/website_id/:id', '/admin/system_store/editGroup/group_id/:id', '/admin/system_store/editStore/store_id/:id']) {
    r.get(p, async (req, reply) => view(reply, 'message_page', { title: 'Store Information', html: '<table class="admin__table-secondary"><tbody><tr><th>Web Site</th><td>Main Website (base)</td></tr><tr><th>Store</th><td>Main Website Store (root category: Default Category)</td></tr><tr><th>Store View</th><td>Default Store View (default), Status: Enabled</td></tr></tbody></table>', actions: [{ label: 'Back', href: '/admin/admin/system_store/' }] }));
  }

  // ---------------------------------------------------------------- tax rates
  const RATES = {
    id: 'tax_rate_grid', url: '/admin/tax/rate/', idCol: 't.id', from: 'tax_rates t', defaultSort: 'code_asc',
    columns: [
      { key: 'code', label: 'Tax Identifier', sql: 't.code', filter: { type: 'text' }, html: (x) => `<a href="/admin/tax/rate/edit/rate/${x._id}/">${h(x.code)}</a>` },
      { key: 'country', label: 'Country', sql: '(SELECT name FROM countries c WHERE c.id = t.country_id)', sort: 't.country_id' },
      { key: 'region', label: 'State/Region', sql: "coalesce((SELECT name FROM regions g WHERE g.id = t.region_id), '*')", sort: false },
      { key: 'postcode', label: 'Zip/Post Code', sql: 't.postcode', filter: { type: 'text' } },
      { key: 'rate', label: 'Rate', sql: 't.rate', cls: 'num', filter: { type: 'range' }, html: (x) => `${U.num(x.rate)}` },
    ],
  };
  r.get('/tax/rate', async (req, reply) => view(reply, 'grid_page', { title: 'Tax Zones and Rates', g: grid.build(req, kit, RATES), crumbs: [['Stores', null], ['Taxes', null], ['Tax Zones and Rates', null]], actions: [{ label: 'Add New Tax Rate', href: '/admin/tax/rate/add/', primary: true, id: 'add' }] }));
  const rateForm = (t, values = {}, errors = {}) => ({
    title: t ? `Edit Tax Rate: ${t.code}` : 'New Tax Rate', action: t ? `/admin/tax/rate/save/rate/${t.id}/` : '/admin/tax/rate/save/', errors,
    values: { code: t ? t.code : '', tax_country_id: t ? t.country_id : 'US', tax_region_id: t ? t.region_id ?? 0 : 0, tax_postcode: t ? t.postcode || '*' : '*', rate: t ? U.num(t.rate) : '', ...values },
    crumbs: [['Stores', null], ['Tax Zones and Rates', '/admin/tax/rate/'], [t ? t.code : 'New', null]],
    actions: [{ label: 'Back', href: '/admin/tax/rate/' }, ...(t ? [{ label: 'Delete Rate', post: `/admin/tax/rate/delete/rate/${t.id}/`, confirm: 'Are you sure?', id: 'delete' }] : []), { label: 'Save Rate', form: 'edit_form', primary: true, id: 'save' }],
    sections: [{ title: 'Tax Rate Information', fields: [{ name: 'code', label: 'Tax Identifier', required: true }, { name: 'tax_country_id', label: 'Country', type: 'select', options: countries() },
      { name: 'tax_region_id', label: 'State', type: 'select', options: [[0, '*'], ...kit.sql("SELECT id, name FROM regions WHERE country_id = 'US' ORDER BY name").all().map((x) => [x.id, x.name])] },
      { name: 'tax_postcode', label: 'Zip/Post Code', note: "'*' - matches any." }, { name: 'rate', label: 'Rate Percent', required: true }] }],
  });
  const loadRate = (id) => { const t = kit.sql('SELECT * FROM tax_rates WHERE id = ?').get(+id); if (!t) throw ctx.notFound('tax rate'); return t; };
  r.get('/tax/rate/add', async (req, reply) => view(reply, 'form_page', rateForm(null)));
  r.get('/tax/rate/edit/rate/:id', async (req, reply) => view(reply, 'form_page', rateForm(loadRate(req.params.id))));
  const rateSave = async (req, reply) => {
    const t = req.params.id ? loadRate(req.params.id) : null;
    const b = req.body || {};
    const v = { code: U.str(b.code), tax_country_id: U.str(b.tax_country_id) || 'US', tax_region_id: parseInt(U.str(b.tax_region_id), 10) || 0, tax_postcode: U.str(b.tax_postcode) || '*', rate: U.str(b.rate) };
    const errors = {};
    if (!v.code) errors.code = 'This is a required field.';
    else if (kit.sql('SELECT 1 FROM tax_rates WHERE code = ? AND id IS NOT ?').get(v.code, t ? t.id : null)) errors.code = 'Code already exists.';
    const rate = U.numOrNull(v.rate);
    if (rate == null || Number.isNaN(rate) || rate < 0) errors.rate = 'Please enter a number 0 or greater in this field.';
    if (Object.keys(errors).length) return view(reply, 'form_page', rateForm(t, v, errors), 422);
    const row = [v.tax_country_id, v.tax_region_id || null, v.tax_postcode, v.code, rate];
    if (t) kit.sql('UPDATE tax_rates SET country_id = ?, region_id = ?, postcode = ?, code = ?, rate = ? WHERE id = ?').run(...row, t.id);
    else kit.sql('INSERT INTO tax_rates (country_id, region_id, postcode, code, rate) VALUES (?, ?, ?, ?, ?)').run(...row);
    req.flash('success', 'You saved the tax rate.');
    return reply.redirect('/admin/tax/rate/');
  };
  r.post('/tax/rate/save', rateSave);
  r.post('/tax/rate/save/rate/:id', rateSave);
  r.post('/tax/rate/delete/rate/:id', async (req, reply) => { const t = loadRate(req.params.id); kit.sql('DELETE FROM tax_rates WHERE id = ?').run(t.id); req.flash('success', 'You deleted the tax rate.'); return reply.redirect('/admin/tax/rate/'); });

  // ---------------------------------------------------------------- product attributes
  const ATTRS = {
    id: 'attributeGrid', url: '/admin/catalog/product_attribute/', idCol: 'a.rowid', from: 'attributes a', defaultSort: 'code_asc',
    keyword: (q) => ({ where: "(a.code LIKE ? ESCAPE '\\' OR a.label LIKE ? ESCAPE '\\')", params: [`%${q}%`, `%${q}%`] }),
    columns: [
      { key: 'code', label: 'Attribute Code', sql: 'a.code', filter: { type: 'text' }, html: (x) => `<a href="/admin/catalog/product_attribute/edit/attribute_id/${x._id}/">${h(x.code)}</a>` },
      { key: 'label', label: 'Default Label', sql: 'a.label', filter: { type: 'text' } },
      { key: 'input', label: 'Catalog Input Type', sql: 'a.input', filter: { type: 'select', options: ['text', 'textarea', 'select', 'multiselect', 'boolean', 'price', 'date', 'weight', 'media_image'].map((x) => [x, x]) } },
      { key: 'is_user_defined', label: 'System', sql: 'a.is_user_defined', html: (x) => (x.is_user_defined ? 'No' : 'Yes'), filter: { type: 'select', options: [[0, 'Yes'], [1, 'No']] } },
      { key: 'is_visible_on_front', label: 'Visible', sql: 'a.is_visible_on_front', html: (x) => (x.is_visible_on_front ? 'Yes' : 'No') },
      { key: 'is_searchable', label: 'Searchable', sql: 'a.is_searchable', html: (x) => (x.is_searchable ? 'Yes' : 'No'), filter: { type: 'select', options: yesno } },
      { key: 'is_filterable', label: 'Use in Layered Navigation', sql: 'a.is_filterable', html: (x) => (x.is_filterable ? 'Filterable' : 'No'), filter: { type: 'select', options: yesno } },
      { key: 'is_comparable', label: 'Comparable', sql: 'a.is_comparable', html: (x) => (x.is_comparable ? 'Yes' : 'No') },
    ],
  };
  r.get('/catalog/product_attribute', async (req, reply) => view(reply, 'grid_page', { title: 'Product Attributes', g: grid.build(req, kit, ATTRS), crumbs: [['Stores', null], ['Attributes', null], ['Product', null]] }));
  const loadAttr = (rowid) => { const a = kit.sql('SELECT rowid AS rid, * FROM attributes WHERE rowid = ?').get(+rowid); if (!a) throw ctx.notFound('attribute'); return a; };
  const attrForm = (a, values = {}, errors = {}) => {
    const opts = kit.sql('SELECT * FROM attribute_options WHERE attribute_code = ? ORDER BY position, id').all(a.code);
    const optHtml = a.input === 'select' || a.input === 'multiselect' ? `<table class="admin__table-primary" id="manage-options-panel"><caption>Manage Options (Values of Your Attribute)</caption><thead><tr><th>Position</th><th>Admin</th><th>Delete</th></tr></thead><tbody>
      ${opts.map((o) => `<tr><td><input type="number" name="option[order][${o.id}]" value="${o.position ?? 0}" size="3" aria-label="Position of ${h(o.label)}"></td><td><input type="text" name="option[value][${o.id}]" value="${h(o.label)}" aria-label="Label of option ${o.id}"></td><td><input type="checkbox" name="option[delete][${o.id}]" value="1" aria-label="Delete ${h(o.label)}"></td></tr>`).join('')}
      <tr><td><input type="number" name="option[order][new]" value="${opts.length + 1}" size="3" aria-label="Position of new option"></td><td><input type="text" name="option[value][new]" placeholder="New option" aria-label="New option label"></td><td class="muted">new</td></tr></tbody></table>` : '';
    return {
      title: a.label || a.code, action: `/admin/catalog/product_attribute/save/attribute_id/${a.rid}/`, errors,
      values: { frontend_label: a.label || '', is_searchable: a.is_searchable ? 1 : 0, is_filterable: a.is_filterable ? 1 : 0, is_comparable: a.is_comparable ? 1 : 0, is_visible_on_front: a.is_visible_on_front ? 1 : 0, used_in_product_listing: a.used_in_listing ? 1 : 0, position: a.position ?? 0, ...values },
      crumbs: [['Stores', null], ['Product Attributes', '/admin/catalog/product_attribute/'], [a.label || a.code, null]],
      actions: [{ label: 'Back', href: '/admin/catalog/product_attribute/' }, { label: 'Save Attribute', form: 'edit_form', primary: true, id: 'save' }],
      sections: [{ title: 'Attribute Properties', fields: [{ name: 'frontend_label', label: 'Default Label', required: true }, { name: '_code', label: 'Attribute Code', type: 'static', value: a.code }, { name: '_input', label: 'Catalog Input Type for Store Owner', type: 'static', value: a.input }], html: optHtml },
        { title: 'Storefront Properties', collapsible: true, fields: [{ name: 'is_searchable', label: 'Use in Search', type: 'select', options: yesno }, { name: 'is_filterable', label: 'Use in Layered Navigation', type: 'select', options: [[0, 'No'], [1, 'Filterable (with results)']] }, { name: 'is_comparable', label: 'Comparable on Storefront', type: 'select', options: yesno }, { name: 'is_visible_on_front', label: 'Visible on Catalog Pages on Storefront', type: 'select', options: yesno }, { name: 'used_in_product_listing', label: 'Used in Product Listing', type: 'select', options: yesno }, { name: 'position', label: 'Position', type: 'number' }] }],
    };
  };
  r.get('/catalog/product_attribute/edit/attribute_id/:id', async (req, reply) => view(reply, 'form_page', attrForm(loadAttr(req.params.id))));
  r.post('/catalog/product_attribute/save/attribute_id/:id', async (req, reply) => {
    const a = loadAttr(req.params.id);
    const b = req.body || {};
    const label = U.str(b.frontend_label);
    if (!label) return view(reply, 'form_page', attrForm(a, { frontend_label: '' }, { frontend_label: 'This is a required field.' }), 422);
    const flag = (k) => (U.str(b[k]) === '1' ? 1 : 0);
    kit.sql('UPDATE attributes SET label = ?, is_searchable = ?, is_filterable = ?, is_comparable = ?, is_visible_on_front = ?, used_in_listing = ?, position = ? WHERE rowid = ?')
      .run(label, flag('is_searchable'), flag('is_filterable'), flag('is_comparable'), flag('is_visible_on_front'), flag('used_in_product_listing'), parseInt(U.str(b.position), 10) || 0, a.rid);
    for (const o of kit.sql('SELECT * FROM attribute_options WHERE attribute_code = ?').all(a.code)) {
      if (U.str(b[`option[delete][${o.id}]`]) === '1') {
        kit.sql('DELETE FROM attribute_options WHERE id = ?').run(o.id);
        kit.sql('DELETE FROM product_attributes WHERE attribute_code = ? AND option_id = ?').run(a.code, o.id);
        continue;
      }
      const nl = U.str(b[`option[value][${o.id}]`]);
      const np = parseInt(U.str(b[`option[order][${o.id}]`]), 10);
      if (nl && (nl !== o.label || (Number.isFinite(np) && np !== o.position))) {
        kit.sql('UPDATE attribute_options SET label = ?, position = ? WHERE id = ?').run(nl, Number.isFinite(np) ? np : o.position, o.id);
        if (nl !== o.label) {
          kit.sql('UPDATE product_attributes SET value = ? WHERE attribute_code = ? AND option_id = ?').run(nl, a.code, o.id);
          if (a.code === 'color' || a.code === 'size') kit.sql(`UPDATE products SET ${a.code} = ? WHERE ${a.code}_option_id = ?`).run(nl, o.id);
        }
      }
    }
    const nv = a.input === 'select' || a.input === 'multiselect' ? U.str(b['option[value][new]']) : '';
    if (nv) {
      if (kit.sql('SELECT 1 FROM attribute_options WHERE attribute_code = ? AND label = ? COLLATE NOCASE').get(a.code, nv)) { req.flash('error', `The value of Admin must be unique (${nv}).`); return reply.redirect(`/admin/catalog/product_attribute/edit/attribute_id/${a.rid}/`); }
      kit.sql('INSERT INTO attribute_options (attribute_code, label, position) VALUES (?, ?, ?)').run(a.code, nv, parseInt(U.str(b['option[order][new]']), 10) || 0);
    }
    req.flash('success', 'You saved the product attribute.');
    return reply.redirect('/admin/catalog/product_attribute/');
  });
  r.get('/catalog/product_set', async (req, reply) => {
    const rows = kit.sql('SELECT s.id, s.name, s.source, c.n FROM (SELECT attribute_set_id, count(*) AS n FROM temp.admin_pgrid GROUP BY attribute_set_id) c JOIN attribute_sets s ON s.id = c.attribute_set_id ORDER BY s.id').all();
    const html = `<table class="data-grid" id="setGrid"><thead><tr><th>ID</th><th>Attribute Set</th><th class="num">Products</th></tr></thead><tbody>${rows.map((s) => `<tr><td>${s.id}</td><td><a href="/admin/catalog/product/?attribute_set=${s.id}">${h(s.name)}${s.source === 'shop' ? ' (shop)' : ''}</a></td><td class="num">${U.num(s.n)}</td></tr>`).join('')}</tbody></table>`;
    return view(reply, 'message_page', { title: 'Attribute Sets', html, crumbs: [['Stores', null], ['Attributes', null], ['Attribute Set', null]] });
  });
};
