'use strict';
// Back-office catalog templates (write): special price with dates, visibility, SEO fields,
// weight + country of manufacture, grid mass actions (price adjust, disable), category
// assignment and creation, related / up-sell / cross-sell links, disabling configurable variants.

const ADMIN = 'admin';
const label = (L, p) => `"${L.plain(p.name).trim()}" (SKU ${p.sku})`;
// products editable by SKU: Luma simples/configurables and a slice of the shop catalog
function editable(L, r, n, where = '1') {
  const rows = L.all(`SELECT id, sku, name, type, price, visibility, status, url_key, weight, country_of_manufacture FROM products
    WHERE (id <= 2040 OR id % 53 = 7) AND length(name) BETWEEN 6 AND 90 AND sku GLOB '[A-Za-z0-9]*' AND sku NOT GLOB '*[^A-Za-z0-9._-]*' AND ${where}`);
  return r.sample(rows, n);
}
const D = (L, s) => L.longDate(s);

const specialPrice = {
  id: 'gen-admin-special-price', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'Put {{product}} on sale: set a special price of ${{special}} from {{from}} to {{to}}.',
    'Give {{product}} a special price of ${{special}}, valid {{from}} through {{to}}.',
    'Under Advanced Pricing for {{product}}, enter the special price ${{special}} with the dates {{from}} - {{to}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const p of editable(L, r, 120, "type = 'simple' AND price >= 5 AND special_price IS NULL")) {
      const special = (Math.round(p.price * r.pick([0.7, 0.75, 0.8, 0.85, 0.9]) * 100) / 100).toFixed(2);
      const m = r.pick(['06', '07', '08']);
      const d1 = `2023-${m}-${String(1 + r.int(14)).padStart(2, '0')}`;
      const d2 = `2023-${m}-${String(16 + r.int(12)).padStart(2, '0')}`;
      out.push({ slots: { product: label(L, p), special, from: D(L, d1), to: D(L, d2) }, login_user: ADMIN,
        eval: { type: 'state', state_sql: `SELECT round(special_price, 2), substr(special_from, 1, 10), substr(special_to, 1, 10), round(price, 2) FROM products WHERE id = ${p.id}`, state_expect: [[+special, d1, d2, Math.round(p.price * 100) / 100]] } });
    }
    return out;
  },
};

const VIS = { 1: 'Not Visible Individually', 2: 'Catalog', 3: 'Search', 4: 'Catalog, Search' };
const VIS_TEXT = { 2: 'only show up when browsing categories, not in search results', 3: 'only be findable through search, not in category listings', 4: 'appear both in category listings and in search results' };
const visibility = {
  id: 'gen-admin-product-visibility', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    '{{product}} should {{what}}. Change its visibility accordingly.',
    'Update the visibility of {{product}} so that it will {{what}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const p of editable(L, r, 150, 'visibility IN (2, 3, 4) AND status = 1')) {
      const v = r.pick([2, 3, 4].filter((x) => x !== p.visibility));
      out.push({ slots: { product: label(L, p), what: VIS_TEXT[v] }, login_user: ADMIN,
        eval: { type: 'state', state_sql: `SELECT visibility, status FROM products WHERE id = ${p.id}`, state_expect: [[v, 1]] } });
    }
    return out;
  },
};

const seo = {
  id: 'gen-admin-product-seo', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'For SEO, change the URL key of {{product}} to "{{key}}" and set its meta title to "{{title}}".',
    'Update the Search Engine Optimization section of {{product}}: URL key "{{key}}", meta title "{{title}}".',
  ],
  sample(L, r) {
    const out = [];
    const SUF = ['sale', 'best-price', '2023', 'new', 'deal', 'top-pick', 'official'];
    for (const p of editable(L, r, 150, 'url_key IS NOT NULL')) {
      const words = L.plain(p.name).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 4);
      const key = `${words.join('-')}-${r.pick(SUF)}`;
      if (key === p.url_key || L.one('SELECT count(*) FROM products WHERE url_key = ?', key)) continue;
      const title = `${words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')} | ${r.pick(['Best Price', 'Free Shipping', 'Shop Now', 'On Sale'])}`;
      out.push({ slots: { product: label(L, p), key, title }, login_user: ADMIN,
        eval: { type: 'state', state_sql: `SELECT url_key, meta_title FROM products WHERE id = ${p.id}`, state_expect: [[key, title]] } });
    }
    return out;
  },
};

const COUNTRIES = [['DE', 'Germany'], ['JP', 'Japan'], ['MX', 'Mexico'], ['VN', 'Vietnam'], ['IT', 'Italy'], ['CA', 'Canada'], ['IN', 'India'], ['PT', 'Portugal'], ['KR', 'South Korea'], ['TR', 'Turkey']];
const weightCountry = {
  id: 'gen-admin-product-weight-country', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'The supplier sent new specs for {{product}}: it weighs {{w}} lbs and is made in {{country}}. Update the product.',
    'Set the weight of {{product}} to {{w}} and its country of manufacture to {{country}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const p of editable(L, r, 150, "type = 'simple'")) {
      const w = r.pick([0.5, 0.8, 1.2, 1.5, 2, 2.5, 3.4, 4, 5.5, 7]);
      if (p.weight === w) continue;
      const [code, name] = r.pick(COUNTRIES.filter((c) => c[0] !== p.country_of_manufacture));
      if (L.one('SELECT name FROM countries WHERE id = ?', code) == null) continue;
      out.push({ slots: { product: label(L, p), w, country: name }, login_user: ADMIN,
        eval: { type: 'state', state_sql: `SELECT round(weight, 2), country_of_manufacture FROM products WHERE id = ${p.id}`, state_expect: [[w, code]] } });
    }
    return out;
  },
};

// grid mass action: adjust prices of the products whose name contains a term
const massPrice = {
  id: 'gen-admin-mass-price-adjust', site: 'shopping_admin', kind: 'write', skills: ['filter-sort', 'form-edit', 'multi-step'], difficulty: 3, cap: 40,
  phrasings: [
    '{{dir_cap}} the price of every product whose name contains "{{term}}" by {{pct}}%.',
    'Apply a {{pct}}% price {{dir_noun}} to all catalog products with "{{term}}" in the name.',
  ],
  sample(L, r) {
    const out = [];
    const words = new Map();
    for (const x of L.all("SELECT id, name, price FROM products WHERE type = 'simple' AND price > 0 AND source = 'shop' AND id % 3 = 0")) {
      for (const w of new Set(L.plain(x.name).split(/[^A-Za-z]+/).filter((y) => y.length >= 7))) words.set(w, (words.get(w) || 0) + 1);
    }
    const cands = [...words.entries()].filter(([, n]) => n >= 2 && n <= 6).map(([w]) => w);
    const allp = L.all('SELECT id, lower(name) AS n, price, type FROM products');
    for (const term of r.sample(cands, 400)) {
      const t = term.toLowerCase();
      const ps = allp.filter((p) => p.n.includes(t));
      if (ps.length < 2 || ps.length > 12 || ps.some((p) => p.type !== 'simple' || !(p.price > 0))) continue;
      const pct = r.pick([5, 10, 15, 20, 25]);
      const up = r() < 0.5;
      const exp = ps.map((p) => [p.id, Math.round(Math.max(0, p.price * (1 + (up ? pct : -pct) / 100)) * 100) / 100]);
      out.push({ slots: { term, pct, dir_cap: up ? 'Raise' : 'Lower', dir_noun: up ? 'increase' : 'reduction' }, login_user: ADMIN, difficulty: ps.length > 4 ? 3 : 2,
        eval: { type: 'state', state_sql: `SELECT id, round(price, 2) FROM products WHERE id IN (${ps.map((p) => p.id).join(',')}) ORDER BY id`, state_expect: exp } });
      if (out.length >= 120) break;
    }
    return out;
  },
};

// grid mass action: disable the products of a brand above a price
const massDisable = {
  id: 'gen-admin-mass-disable-brand', site: 'shopping_admin', kind: 'write', skills: ['filter-sort', 'form-edit', 'multi-step'], difficulty: 3, cap: 40,
  phrasings: [
    'We stop selling expensive {{brand}} items: disable every {{brand}} product priced above ${{min}}. Leave the cheaper ones enabled.',
    'Disable all products of the brand {{brand}} that cost more than ${{min}} (keep the others as they are).',
  ],
  sample(L, r) {
    const out = [];
    const brands = L.col("SELECT brand FROM products WHERE brand GLOB '[A-Za-z]*' AND brand NOT GLOB '*[^A-Za-z0-9 .&-]*' AND length(brand) BETWEEN 3 AND 20 AND status = 1 GROUP BY brand HAVING count(*) BETWEEN 4 AND 14");
    for (const brand of r.sample(brands, 300)) {
      // the grid's brand filter is a substring match: no other brand may contain this one
      if (L.one('SELECT count(DISTINCT brand) FROM products WHERE instr(lower(brand), lower(?)) > 0', brand) !== 1) continue;
      const ps = L.all('SELECT id, price, status FROM products WHERE brand = ? ORDER BY price', brand);
      if (ps.some((p) => p.status !== 1 || p.price == null)) continue;
      const min = r.pick([20, 25, 30, 40, 50, 75, 100]);
      const hi = ps.filter((p) => p.price > min); const lo = ps.filter((p) => p.price <= min);
      if (hi.length < 2 || lo.length < 1 || hi.length > 8 || ps.some((p) => Math.abs(p.price - min) < 0.01)) continue;
      out.push({ slots: { brand, min }, login_user: ADMIN,
        eval: { type: 'state', state_sql: [`SELECT count(*) FROM products WHERE id IN (${hi.map((p) => p.id).join(',')}) AND status = 2`, `SELECT count(*) FROM products WHERE id IN (${lo.map((p) => p.id).join(',')}) AND status = 1`],
          state_expect: [hi.length, lo.length] } });
      if (out.length >= 120) break;
    }
    return out;
  },
};

const categoryAssign = {
  id: 'gen-admin-category-assign', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'Also list {{product}} in the category "{{category}}" (keep its current categories).',
    'Add {{product}} to the "{{category}}" category without removing it from the categories it is already in.',
  ],
  sample(L, r) {
    const out = [];
    const cats = L.tree().rows.filter((c) => c.level >= 3 && c.is_active);
    for (const p of editable(L, r, 150, 'status = 1')) {
      const cur = L.col('SELECT category_id FROM product_categories WHERE product_id = ?', p.id);
      if (!cur.length) continue;
      const c = r.pick(cats.filter((x) => !cur.includes(x.id)));
      out.push({ slots: { product: label(L, p), category: L.catPath(c) }, login_user: ADMIN,
        eval: { type: 'state', state_sql: [`SELECT count(*) FROM product_categories WHERE product_id = ${p.id} AND category_id = ${c.id}`, `SELECT count(*) FROM product_categories WHERE product_id = ${p.id} AND category_id IN (${cur.join(',')})`],
          state_expect: [1, cur.length] } });
    }
    return out;
  },
};

const NEWCATS = ['Summer Picks', 'Gift Ideas', 'Clearance', 'Staff Favorites', 'Back to School', 'Eco Friendly', 'New Arrivals', 'Holiday Deals', 'Best Sellers', 'Travel Essentials', 'Home Office', 'Under $20'];
const categoryCreate = {
  id: 'gen-admin-category-create', site: 'shopping_admin', kind: 'write', skills: ['navigate', 'form-edit', 'create'], difficulty: 2, cap: 40,
  phrasings: [
    'Create a new subcategory "{{name}}" under "{{parent}}". It should be enabled and {{menu}} in the navigation menu.',
    'Add a category called "{{name}}" inside {{parent}}; make it active and {{menu}} in the menu.',
  ],
  sample(L, r) {
    const out = [];
    for (const c of L.tree().rows.filter((x) => x.level >= 2 && x.level <= 3 && x.is_active)) {
      for (const name of r.sample(NEWCATS, 2)) {
        if (c.children.some((k) => L.plain(k.name) === name)) continue;
        const inMenu = r() < 0.5;
        const sql = `SELECT is_active, include_in_menu FROM categories WHERE parent_id = ${c.id} AND name = ${L.lit(name)}`;
        out.push({ slots: { name, parent: L.catPath(c), menu: inMenu ? 'shown' : 'not shown' }, login_user: ADMIN,
          eval: { type: 'state', state_sql: sql, state_expect: [[1, inMenu ? 1 : 0]] } });
      }
    }
    return out;
  },
};

const LINKS = { related: 'a related product', upsell: 'an up-sell product', crosssell: 'a cross-sell product' };
const productLinks = {
  id: 'gen-admin-product-links', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'Add {{b}} as {{kind}} of {{a}}.',
    'On the product {{a}}, link {{b}} as {{kind}}.',
  ],
  sample(L, r) {
    const out = [];
    const ps = editable(L, r, 300, 'status = 1 AND visibility IN (2, 3, 4)');
    for (let i = 0; i + 1 < ps.length; i += 2) {
      const [a, b] = [ps[i], ps[i + 1]];
      if ([a, b].some((p) => /&|quot;/.test(p.name))) continue; // names with leftover entities read badly
      const t = r.pick(Object.keys(LINKS));
      if (L.one('SELECT count(*) FROM product_links WHERE product_id = ? AND linked_product_id = ? AND link_type = ?', a.id, b.id, t)) continue;
      out.push({ slots: { a: label(L, a), b: label(L, b), kind: LINKS[t] }, login_user: ADMIN,
        eval: { type: 'state', state_sql: `SELECT count(*) FROM product_links WHERE product_id = ${a.id} AND linked_product_id = ${b.id} AND link_type = '${t}'`, state_expect: 1 } });
    }
    return out;
  },
};

const variantDisable = {
  id: 'gen-admin-variant-disable', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit', 'multi-step'], difficulty: 3, cap: 40,
  phrasings: [
    'The {{value}} {{axis}} of "{{product}}" is discontinued. Disable all its {{value}} variants, but keep the other variants enabled.',
    'Turn off every {{axis}} {{value}} configuration of the configurable product "{{product}}"; the rest stay enabled.',
  ],
  sample(L, r) {
    const out = [];
    for (const p of L.all("SELECT id, name FROM products WHERE type = 'configurable' AND status = 1 ORDER BY id")) {
      for (const axis of ['color', 'size']) {
        const kids = L.all(`SELECT k.id, k.status, o.label FROM product_variants v JOIN products k ON k.id = v.child_id JOIN attribute_options o ON o.id = k.${axis}_option_id WHERE v.parent_id = ?`, p.id);
        const vals = [...new Set(kids.map((k) => k.label))];
        if (vals.length < 2 || kids.some((k) => k.status !== 1)) continue;
        const value = r.pick(vals);
        const off = kids.filter((k) => k.label === value); const on = kids.filter((k) => k.label !== value);
        if (off.length > 6) continue;
        out.push({ slots: { value, axis, product: L.plain(p.name) }, login_user: ADMIN, difficulty: off.length > 2 ? 3 : 2,
          eval: { type: 'state', state_sql: [`SELECT count(*) FROM products WHERE id IN (${off.map((k) => k.id).join(',')}) AND status = 2`, `SELECT count(*) FROM products WHERE id IN (${on.map((k) => k.id).join(',')}) AND status = 1`, `SELECT status FROM products WHERE id = ${p.id}`],
            state_expect: [off.length, on.length, 1] } });
      }
    }
    return out;
  },
};

module.exports = [specialPrice, visibility, seo, weightCountry, massPrice, massDisable, categoryAssign, categoryCreate, productLinks, variantDisable];
