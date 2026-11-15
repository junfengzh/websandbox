'use strict';
// Back-office marketing / content templates (write): coupon cart price rule with a subtotal
// condition and usage limits, catalog price rule for a customer group and dates, CMS page,
// search term redirect.

const ADMIN = 'admin';
const GROUPS = { 0: 'NOT LOGGED IN', 1: 'General', 2: 'Wholesale', 3: 'Retailer' };
const groupsSql = (col, ids) => ids.map((g) => `(',' || replace(${col}, ' ', '') || ',') LIKE '%,${g},%'`).join(' AND ');
const groupsOnly = (col, ids) => `(${groupsSql(col, ids)}) AND length(replace(${col}, ' ', '')) = ${ids.join(',').length}`;
// a condition {attribute, operator, value} anywhere in a Magento conditions JSON tree
const condSql = (json, attr, op, val) => `EXISTS (SELECT 1 FROM json_tree(${json}) a JOIN json_tree(${json}) o ON o.parent = a.parent JOIN json_tree(${json}) v ON v.parent = a.parent
  WHERE a.key = 'attribute' AND a.atom = '${attr}' AND o.key = 'operator' AND o.atom = '${op}' AND v.key = 'value' AND CAST(v.atom AS REAL) = ${val})`;
const THEMES = ['Summer Splash', 'Back to School', 'Loyal Customer', 'Weekend Flash', 'Holiday Cheer', 'Spring Refresh', 'Big Basket', 'Welcome Back', 'Fall Favorites', 'Midweek Deal'];

const cartRule = {
  id: 'gen-admin-cart-rule-coupon', site: 'shopping_admin', kind: 'write', skills: ['navigate', 'form-edit', 'create'], difficulty: 3, cap: 40,
  phrasings: [
    'Create an active cart price rule named "{{name}}" for {{groups}} customers: with the coupon code {{code}}, orders with a subtotal of at least ${{min}} get {{discount}}. Each customer may use the coupon {{per}} time(s).',
    'Set up a new coupon promotion "{{name}}": code {{code}}, {{discount}} when the cart subtotal is ${{min}} or more, only for the {{groups}} group(s), limited to {{per}} use(s) per customer.',
  ],
  sample(L, r) {
    const out = [];
    for (const name of THEMES) {
      for (let k = 0; k < 8; k++) {
        const gs = r.pick([[1], [2], [3], [1, 2], [2, 3], [1, 3]]);
        const min = r.pick([50, 75, 100, 150, 200]);
        const pct = r() < 0.5;
        const amt = pct ? r.pick([5, 10, 15, 20]) : r.pick([5, 10, 15, 25]);
        const code = `${name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 6)}${amt}${String.fromCharCode(65 + r.int(26))}`;
        const per = 1 + r.int(3);
        const R = `(SELECT id FROM sales_rules WHERE name = ${L.lit(name)} AND id > 4 ORDER BY id DESC LIMIT 1)`;
        out.push({ slots: { name, groups: gs.map((g) => GROUPS[g]).join(' and '), code, min, discount: pct ? `${amt}% off` : `$${amt} off the whole cart`, per }, login_user: ADMIN,
          eval: { type: 'state', state_sql: [
            `SELECT is_active, coupon_type, simple_action, round(discount_amount, 2), uses_per_customer, ${groupsOnly('customer_group_ids', gs)} FROM sales_rules WHERE id = ${R}`,
            `SELECT upper(code) FROM coupons WHERE rule_id = ${R}`,
            `SELECT ${condSql('conditions_json', 'base_subtotal', '>=', min)} FROM sales_rules WHERE id = ${R}`,
          ], state_expect: [[[1, 2, pct ? 'by_percent' : 'cart_fixed', amt, per, 1]], code, 1] } });
      }
    }
    return out;
  },
};

const catalogRule = {
  id: 'gen-admin-catalog-rule', site: 'shopping_admin', kind: 'write', skills: ['navigate', 'form-edit', 'create'], difficulty: 2, cap: 40,
  phrasings: [
    'Create an active catalog price rule "{{name}}" that gives {{groups}} customers {{discount}} on all products from {{from}} to {{to}}.',
    'Add a catalog price rule called "{{name}}": {{discount}} for the {{groups}} group(s), running {{from}} through {{to}}, active.',
  ],
  sample(L, r) {
    const out = [];
    for (const name of THEMES) {
      for (let k = 0; k < 8; k++) {
        const gs = r.pick([[1], [2], [3], [0, 1], [1, 2, 3]]);
        const pct = r() < 0.6;
        const amt = pct ? r.pick([5, 10, 15, 25, 30]) : r.pick([2, 5, 10]);
        const m = r.pick(['07', '08', '09', '10']);
        const d1 = `2023-${m}-01`; const d2 = `2023-${m}-${r.pick(['15', '20', '28'])}`;
        const R = `(SELECT id FROM catalog_rules WHERE name = ${L.lit(name)} AND id > 2 ORDER BY id DESC LIMIT 1)`;
        out.push({ slots: { name, groups: gs.map((g) => GROUPS[g]).join(', '), discount: pct ? `${amt}% off` : `$${amt} off the price`, from: L.longDate(d1), to: L.longDate(d2) }, login_user: ADMIN,
          eval: { type: 'state', state_sql: `SELECT is_active, simple_action, round(discount_amount, 2), substr(from_date, 1, 10), substr(to_date, 1, 10), ${groupsOnly('customer_group_ids', gs)} FROM catalog_rules WHERE id = ${R}`,
            state_expect: [[1, pct ? 'by_percent' : 'by_fixed', amt, d1, d2, 1]] } });
      }
    }
    return out;
  },
};

const PAGES = [['Shipping Policy', 'shipping-policy', 'How we ship your orders'], ['Return Policy', 'returns', 'Returns and exchanges'], ['Store Locations', 'stores', 'Visit us'],
  ['Gift Cards', 'gift-cards', 'Give the gift of choice'], ['Size Guide', 'size-guide', 'Find your size'], ['Careers', 'careers', 'Join our team'], ['Press', 'press', 'In the news'],
  ['Loyalty Program', 'rewards', 'Earn points on every order'], ['Sustainability', 'sustainability', 'Our green promise'], ['FAQ', 'faq', 'Frequently asked questions']];
const cmsPage = {
  id: 'gen-admin-cms-page-create', site: 'shopping_admin', kind: 'write', skills: ['navigate', 'form-edit', 'create'], difficulty: 2, cap: 40,
  phrasings: [
    'Create a new CMS page titled "{{title}}" with the URL key "{{key}}" and the content heading "{{heading}}". Keep it {{state}} for now.',
    'Add a content page "{{title}}" (URL key {{key}}, heading "{{heading}}") and make it {{state}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const [title, key0, heading] of PAGES) {
      for (const suf of ['', '-2023', '-info', '-page', '-us', '-new']) {
        const key = key0 + suf;
        if (L.one('SELECT count(*) FROM cms_pages WHERE identifier = ?', key)) continue;
        const on = r() < 0.5;
        out.push({ slots: { title, key, heading, state: on ? 'enabled' : 'disabled' }, login_user: ADMIN,
          eval: { type: 'state', state_sql: `SELECT title, content_heading, is_active FROM cms_pages WHERE identifier = ${L.lit(key)}`, state_expect: [[title, heading, on ? 1 : 0]] } });
      }
    }
    return out;
  },
};

const termRedirect = {
  id: 'gen-admin-search-term-redirect', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'Customers searching for "{{q}}" should be sent straight to {{url}}. Set up that redirect on the search term.',
    'Edit the search term "{{q}}" so that it redirects to {{url}}.',
  ],
  sample(L, r) {
    const out = [];
    const cats = L.tree().rows.filter((c) => c.level >= 3 && c.url_path);
    for (const t of L.all("SELECT id, query_text FROM search_terms WHERE (redirect IS NULL OR redirect = '') AND length(query_text) BETWEEN 3 AND 30 AND query_text NOT GLOB '*[^ -~]*' ORDER BY id")) {
      const c = r.pick(cats);
      const url = `http://shopping.wa/${c.url_path}.html`;
      out.push({ slots: { q: t.query_text, url }, login_user: ADMIN,
        eval: { type: 'state', state_sql: `SELECT instr(redirect, ${L.lit(`/${c.url_path}.html`)}) > 0 FROM search_terms WHERE id = ${t.id}`, state_expect: 1 } });
    }
    return out;
  },
};

module.exports = [cartRule, catalogRule, cmsPage, termRedirect];
