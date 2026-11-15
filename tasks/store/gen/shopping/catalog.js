'use strict';
// Storefront catalog templates: category browsing with layered navigation (brand / price facets),
// sorting, search results, Luma attribute filters.

const GOOD_BRAND = /^[A-Za-z0-9][A-Za-z0-9 &'.+-]{1,28}[A-Za-z0-9.]$/;

// categories with a sizeable listing (level >= 3, active), with their listing rows
function categoryRows(L, { min = 20, max = 4000, luma = null } = {}) {
  const t = L.tree();
  const lumaDept = +L.one("SELECT value FROM build_info WHERE key = 'luma_department_category_id'");
  const out = [];
  for (const c of t.rows) {
    if (c.level < 3 || !c.is_active) continue;
    const isLuma = c.path.split('/').map(Number).includes(lumaDept);
    if (luma != null && isLuma !== luma) continue;
    const n = L.one(`SELECT count(*) FROM (${L.listedSql(c)})`);
    if (n < min || n > max) continue;
    out.push({ c, n });
  }
  return out;
}
function rowsOf(L, c) {
  return L.all(`SELECT p.id, p.name, p.url_key, p.brand, p.type, ${L.LPRICE('p')} AS price FROM products p WHERE p.id IN (${L.listedSql(c)})`);
}
const login = (L, r) => r.pick(L.customers()).email;
const catUrl = (c) => `__SHOPPING__/${c.url_path}.html`;

// ---- brand facet count
const brandCount = {
  id: 'gen-shopping-brand-count', site: 'shopping', kind: 'read', skills: ['navigate', 'filter-sort', 'aggregate'], difficulty: 1, cap: 55,
  phrasings: [
    'How many {{brand}} products are listed in the "{{category}}" category?',
    'In the {{category}} department of the store, how many items are from the brand {{brand}}?',
    'Count the products by {{brand}} that the shop lists under {{category}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const { c } of r.sample(categoryRows(L, { min: 40, max: 4000, luma: false }), 70)) {
      const counts = new Map();
      for (const p of rowsOf(L, c)) if (p.brand) counts.set(p.brand, (counts.get(p.brand) || 0) + 1);
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15);
      for (const [brand, n] of r.sample(ranked.filter(([b, k]) => GOOD_BRAND.test(b) && k >= 2), 2)) {
        // the facet groups brands case-insensitively when filtering; require one spelling
        if ([...counts.keys()].filter((b) => b.toLowerCase() === brand.toLowerCase()).length > 1) continue;
        const sql = `SELECT ${L.intSql('n')} FROM (SELECT count(*) AS n FROM products p WHERE p.id IN (${L.listedSql(c)}) AND lower(p.brand) = lower(${L.lit(brand)}))`;
        out.push({ slots: { brand, category: L.catPath(c) }, login_user: login(L, r), start_url: '__SHOPPING__/',
          eval: { type: 'answer', answer: { must_include: [L.intRef(n)] }, answer_sql: sql }, wrong_answer: String(n + 1) });
      }
    }
    return out;
  },
};

// ---- price band count
const BANDS = [[0, 10], [10, 20], [10, 25], [20, 40], [25, 50], [50, 100], [100, 200], [15, 30], [30, 60], [200, 500]];
const priceBand = {
  id: 'gen-shopping-price-band-count', site: 'shopping', kind: 'read', skills: ['navigate', 'filter-sort', 'aggregate'], difficulty: 1, cap: 55,
  phrasings: [
    'How many products in the "{{category}}" category cost at least ${{lo}} but less than ${{hi}}?',
    'I have a budget between ${{lo}} and ${{hi}} (${{hi}} excluded). How many items under {{category}} fall in that price range?',
    'Filter the {{category}} category to prices from ${{lo}} up to (not including) ${{hi}}. How many products are there?',
  ],
  sample(L, r) {
    const out = [];
    for (const { c, n: total } of r.sample(categoryRows(L, { min: 30, max: 5000 }), 80)) {
      const rows = rowsOf(L, c);
      for (const [lo, hi] of r.sample(BANDS, 2)) {
        const n = rows.filter((p) => p.price != null && p.price >= lo && p.price < hi).length;
        if (n < 2 || n === total) continue;
        const sql = `SELECT ${L.intSql('n')} FROM (SELECT count(*) AS n FROM products p WHERE p.id IN (${L.listedSql(c)}) AND ${L.LPRICE('p')} >= ${lo} AND ${L.LPRICE('p')} < ${hi})`;
        out.push({ slots: { category: L.catPath(c), lo, hi }, login_user: login(L, r),
          eval: { type: 'answer', answer: { must_include: [L.intRef(n)] }, answer_sql: sql }, wrong_answer: String(n + 3) });
      }
    }
    return out;
  },
};

// ---- cheapest / priciest product of a brand in a category (price answer)
const brandExtreme = {
  id: 'gen-shopping-brand-price-extreme', site: 'shopping', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2, cap: 55,
  phrasings: [
    'What is the price of the {{which}} {{brand}} product in the "{{category}}" category?',
    'Among the {{brand}} items listed under {{category}}, how much does the {{which}} one cost?',
    'Look at {{category}}: what does the {{which}} product from {{brand}} sell for?',
  ],
  sample(L, r) {
    const out = [];
    for (const { c } of r.sample(categoryRows(L, { min: 40, max: 4000, luma: false }), 70)) {
      const rows = rowsOf(L, c).filter((p) => p.brand && p.price != null);
      const by = new Map();
      for (const p of rows) { if (!by.has(p.brand)) by.set(p.brand, []); by.get(p.brand).push(p); }
      const brands = [...by.entries()].filter(([b, ps]) => GOOD_BRAND.test(b) && ps.length >= 3 && [...by.keys()].filter((x) => x.toLowerCase() === b.toLowerCase()).length === 1);
      for (const [brand, ps] of r.sample(brands, 2)) {
        const cheap = r() < 0.5;
        const prices = ps.map((p) => p.price);
        const v = cheap ? Math.min(...prices) : Math.max(...prices);
        const agg = cheap ? 'min' : 'max';
        const sql = `SELECT ${L.moneySql('x')} FROM (SELECT ${agg}(${L.LPRICE('p')}) AS x FROM products p WHERE p.id IN (${L.listedSql(c)}) AND lower(p.brand) = lower(${L.lit(brand)}))`;
        const other = cheap ? Math.max(...prices) : Math.min(...prices);
        if (Math.abs(other - v) < 0.01) continue;
        out.push({ slots: { which: cheap ? 'cheapest' : 'most expensive', brand, category: L.catPath(c) }, login_user: login(L, r),
          eval: { type: 'answer', answer: { must_include: [L.moneyRef(v)] }, answer_sql: sql }, wrong_answer: `$${other.toFixed(2)}` });
      }
    }
    return out;
  },
};

// ---- open the most expensive product under a budget in a category (url)
const priciestUnder = {
  id: 'gen-shopping-priciest-under-budget', site: 'shopping', kind: 'read', skills: ['navigate', 'filter-sort'], difficulty: 2, cap: 55,
  phrasings: [
    'Open the product page of the most expensive item in "{{category}}" that costs less than ${{budget}}.',
    'My budget is under ${{budget}}. Show me the priciest product I can afford in the {{category}} category.',
    'In {{category}}, go to the page of the highest-priced product that is still below ${{budget}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const { c } of categoryRows(L, { min: 25, max: 3000 })) for (const budget of r.sample([15, 20, 25, 30, 40, 50, 75, 100, 150], 2)) {
      const rows = rowsOf(L, c).filter((p) => p.price != null);
      const under = rows.filter((p) => p.price < budget).sort((a, b) => b.price - a.price);
      if (under.length < 3 || under.length === rows.length) continue;
      if (Math.abs(under[0].price - under[1].price) < 0.005) continue; // tie at the top
      out.push({ slots: { category: L.catPath(c), budget }, login_user: login(L, r), start_url: '__SHOPPING__/',
        eval: { type: 'url', url: L.productUrls(under[0]) } });
    }
    return out;
  },
};

// ---- search results sorted by price: price of the n-th result
const QUERIES = ['toothbrush', 'phone case', 'yoga mat', 'led bulb', 'coffee', 'green tea', 'notebook', 'backpack', 'usb charger', 'keyboard', 'wireless mouse',
  'blender', 'pillow', 'shampoo', 'sunscreen', 'dog toy', 'water bottle', 'desk lamp', 'hdmi cable', 'screen protector', 'lipstick', 'face mask', 'bluetooth speaker',
  'office chair', 'shower curtain', 'kitchen knife', 'frying pan', 'tea kettle', 'hair dryer', 'nail polish', 'running shoes', 'socks', 'gloves', 'umbrella', 'wallet',
  'sunglasses', 'watch band', 'printer ink', 'gift card', 'candle', 'picture frame', 'storage box', 'trash can', 'vacuum', 'air purifier', 'humidifier', 'garden hose',
  'bird feeder', 'protein powder', 'vitamin c', 'chocolate', 'olive oil', 'hot sauce', 'pasta', 'cookies', 'popcorn', 'beef jerky', 'ps4 controller', 'nintendo switch case',
  'xbox headset', 'micro sd card', 'power bank', 'dash cam', 'security camera', 'tripod', 'camera bag', 'earbuds', 'soundbar', 'tv mount', 'router', 'webcam', 'jacket',
  'hoodie', 'tank', 'leggings', 'shorts', 'tee', 'bag', 'jump rope', 'foam roller', 'dumbbell', 'resistance band', 'tent', 'sleeping bag', 'fishing lure', 'bike light'];
const searchNth = {
  id: 'gen-shopping-search-sorted-nth', site: 'shopping', kind: 'read', skills: ['search', 'filter-sort', 'read-detail'], difficulty: 2, cap: 55,
  phrasings: [
    'Search the store for "{{q}}" and sort the results by price, {{dir_label}}. What is the price of the {{nth}} product in that list?',
    'Look up "{{q}}" in the shop search. Ordered by price ({{dir_label}}), what does the {{nth}} result cost?',
    'After searching for "{{q}}" and sorting by price {{dir_label}}, tell me the price shown for result number {{n}}.',
  ],
  sample(L, r) {
    const out = [];
    const terms = [...new Set([...QUERIES, ...L.col("SELECT lower(query_text) FROM search_terms WHERE length(query_text) BETWEEN 3 AND 30 AND query_text GLOB '[a-zA-Z]*' AND query_text NOT GLOB '*[^a-zA-Z0-9 ]*'")])];
    const NTH = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
    for (const q of terms) {
      const m = L.searchMatch(q);
      if (!m) continue;
      const rows = L.all(`SELECT p.id, ${L.LPRICE('p')} AS price FROM product_search s JOIN products p ON p.id = s.rowid WHERE product_search MATCH ? AND p.status = 1 AND p.visibility IN (3, 4)`, m);
      if (rows.length < 6 || rows.length > 3000) continue;
      for (const asc of r.sample([true, false], 1)) {
        const sorted = rows.slice().sort((a, b) => (a.price == null) - (b.price == null) || (asc ? 1 : -1) * ((a.price ?? 0) - (b.price ?? 0)) || a.id - b.id);
        const n = 1 + r.int(5);
        const x = sorted[n - 1].price;
        if (x == null) continue;
        const dir = asc ? 'ASC' : 'DESC';
        const sql = `SELECT ${L.moneySql('x')} FROM (SELECT ${L.LPRICE('p')} AS x, p.id FROM product_search s JOIN products p ON p.id = s.rowid WHERE product_search MATCH ${L.lit(m)} AND p.status = 1 AND p.visibility IN (3, 4) ORDER BY x IS NULL, x ${dir}, p.id LIMIT 1 OFFSET ${n - 1})`;
        const wrong = sorted.find((p) => p.price != null && Math.abs(p.price - x) > 0.01);
        out.push({ slots: { q, dir_label: asc ? 'low to high' : 'high to low', nth: NTH[n], n }, login_user: login(L, r),
          eval: { type: 'answer', answer: { must_include: [L.moneyRef(x)] }, answer_sql: sql }, wrong_answer: wrong ? `$${wrong.price.toFixed(2)}` : 'none' });
      }
    }
    return out;
  },
};

// ---- Luma attribute filters: how many products in a Luma category come in a color (+ size)
const lumaFilter = {
  id: 'gen-shopping-luma-color-size-count', site: 'shopping', kind: 'read', skills: ['navigate', 'filter-sort', 'aggregate'], difficulty: 2, cap: 50,
  phrasings: [
    'In the "{{category}}" category, how many products are offered in {{color}}{{size_part}}?',
    'Use the shop filters: how many {{category}} items can I get in the color {{color}}{{size_part}}?',
    'Count the products under {{category}} that are available in {{color}}{{size_part}}.',
  ],
  sample(L, r) {
    const out = [];
    const opts = (code) => new Map(L.all('SELECT id, label FROM attribute_options WHERE attribute_code = ?', code).map((o) => [o.id, o.label]));
    const colors = opts('color'); const sizes = opts('size');
    for (const { c } of categoryRows(L, { min: 5, max: 400, luma: true })) {
      const ids = L.col(L.listedSql(c));
      const has = (pid, colName) => L.col(`SELECT DISTINCT x FROM (SELECT ${colName} x FROM products WHERE id = ? UNION ALL SELECT k.${colName} FROM product_variants v JOIN products k ON k.id = v.child_id WHERE v.parent_id = ?) WHERE x IS NOT NULL`, pid, pid);
      const info = ids.map((id) => ({ id, colors: new Set(has(id, 'color_option_id')), sizes: new Set(has(id, 'size_option_id')),
        combos: new Set(L.all('SELECT k.color_option_id c, k.size_option_id s FROM product_variants v JOIN products k ON k.id = v.child_id WHERE v.parent_id = ? UNION SELECT color_option_id, size_option_id FROM products WHERE id = ?', id, id).map((x) => `${x.c}/${x.s}`)) }));
      const colorIds = [...new Set(info.flatMap((x) => [...x.colors]))].filter((o) => colors.has(o));
      for (const co of r.sample(colorIds, 3)) {
        const withSize = r() < 0.4;
        let sz = null;
        if (withSize) {
          const ss = [...new Set(info.filter((x) => x.colors.has(co)).flatMap((x) => [...x.sizes]))].filter((o) => sizes.has(o));
          if (!ss.length) continue;
          sz = r.pick(ss);
        }
        const n = info.filter((x) => x.colors.has(co) && (sz == null || x.sizes.has(sz))).length;
        // the storefront filters color and size independently; keep pairs where every match also has the combination
        if (sz != null && info.filter((x) => x.combos.has(`${co}/${sz}`)).length !== n) continue;
        if (n < 1 || n === ids.length) continue;
        const hasSql = (colName, o) => `(p.${colName} = ${o} OR EXISTS (SELECT 1 FROM product_variants v JOIN products k ON k.id = v.child_id WHERE v.parent_id = p.id AND k.${colName} = ${o}))`;
        const sql = `SELECT count(*) FROM products p WHERE p.id IN (${L.listedSql(c)}) AND ${hasSql('color_option_id', co)}${sz ? ` AND ${hasSql('size_option_id', sz)}` : ''}`;
        const name = L.catPath(c);
        out.push({ slots: { category: name, color: colors.get(co), size_part: sz ? ` and also in size ${sizes.get(sz)}` : '' }, login_user: login(L, r),
          eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: sql }, wrong_answer: String(n + 2) });
      }
    }
    return out;
  },
};

module.exports = [brandCount, priceBand, brandExtreme, priciestUnder, searchNth, lumaFilter];
module.exports.QUERIES = QUERIES;
