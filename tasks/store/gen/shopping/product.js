'use strict';
// Storefront product-detail templates: rating histogram, rating summary, "More Information"
// specs, configurable options (Luma swatches), compare list.

const login = (L, r) => r.pick(L.customers()).email;

// enabled, searchable, catalog-visible products with a distinctive, not-too-long name
function namedProducts(L, where, limit = 4000) {
  return L.all(`SELECT p.id, p.name, p.url_key, p.sku, p.type FROM products p WHERE p.status = 1 AND p.visibility = 4 AND length(p.name) BETWEEN 12 AND 90
      AND p.name NOT LIKE '%&%' AND ${where} AND (SELECT count(*) FROM products q WHERE q.name = p.name) = 1 ORDER BY p.id LIMIT ${limit}`);
}
// the product is easy to find: a search for its name (all words) has few results
function findable(L, p) {
  const m = L.searchMatch(L.plain(p.name));
  if (!m) return false;
  const n = L.one('SELECT count(*) FROM product_search WHERE product_search MATCH ?', m);
  return n >= 1 && n <= 40;
}
const STAR_WORD = { 1: 'one-star', 2: 'two-star', 3: 'three-star', 4: 'four-star', 5: 'five-star' };

const histogram = {
  id: 'gen-shopping-review-histogram', site: 'shopping', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 50,
  phrasings: [
    'How many {{stars_word}} reviews does the product "{{product}}" have?',
    'Find "{{product}}" in the store. How many {{stars_word}} ratings did customers give it?',
    'Check the rating breakdown of "{{product}}": how many of its reviews are {{stars_word}}?',
  ],
  sample(L, r) {
    const out = [];
    const ps = r.shuffle(namedProducts(L, `p.id IN (SELECT product_id FROM reviews WHERE status = 'approved' GROUP BY product_id HAVING count(*) BETWEEN 6 AND 60)`, 3000));
    for (const p of ps) {
      if (out.length >= 160) break;
      if (!findable(L, p)) continue;
      const hist = new Map(L.all("SELECT v.value, count(*) n FROM reviews r JOIN review_votes v ON v.review_id = r.id WHERE r.product_id = ? AND r.status = 'approved' GROUP BY v.value", p.id).map((x) => [x.value, x.n]));
      const stars = 1 + r.int(5);
      const n = hist.get(stars) || 0;
      const sql = `SELECT count(*) FROM reviews r JOIN review_votes v ON v.review_id = r.id WHERE r.product_id = ${p.id} AND r.status = 'approved' AND v.value = ${stars}`;
      const wrong = [...hist.values()].find((x) => x !== n) ?? n + 1;
      out.push({ slots: { product: L.plain(p.name), stars, stars_word: STAR_WORD[stars], plural: stars === 1 ? '' : 's' }, login_user: login(L, r),
        eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: sql }, wrong_answer: String(wrong) });
    }
    return out;
  },
};

const ratingSummary = {
  id: 'gen-shopping-rating-summary', site: 'shopping', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 45,
  phrasings: [
    'What is the average star rating (out of 5) of "{{product}}", and how many reviews is it based on?',
    'Tell me the rating out of 5 and the number of reviews for "{{product}}".',
  ],
  sample(L, r) {
    const out = [];
    const ps = r.shuffle(namedProducts(L, `p.id IN (SELECT product_id FROM reviews WHERE status = 'approved' GROUP BY product_id HAVING count(*) BETWEEN 3 AND 80)`, 3000));
    for (const p of ps) {
      if (out.length >= 120) break;
      if (!findable(L, p)) continue;
      const s = L.get(`SELECT count(DISTINCT r.id) AS n, avg(v.percent) AS pct FROM reviews r LEFT JOIN review_votes v ON v.review_id = r.id WHERE r.product_id = ? AND r.status = 'approved'`, p.id);
      if (s.pct == null) continue;
      const stars = (Math.round(s.pct) / 20).toFixed(1); // product.eta: (pct / 20).toFixed(1) of the rounded pct? (see view)
      const raw = (s.pct / 20).toFixed(1);
      if (stars !== raw) continue; // avoid rounding ambiguity
      if (String(s.n) === stars.replace(/\.0$/, '')) continue;
      const sql = `SELECT printf('%.1f', avg(v.percent) / 20.0) FROM reviews r JOIN review_votes v ON v.review_id = r.id WHERE r.product_id = ${p.id} AND r.status = 'approved' UNION ALL SELECT CAST(count(*) AS TEXT) FROM reviews r WHERE r.product_id = ${p.id} AND r.status = 'approved'`;
      out.push({ slots: { product: L.plain(p.name) }, login_user: login(L, r),
        eval: { type: 'answer', answer: { must_include: [stars, String(s.n)] }, answer_sql: sql }, wrong_answer: `${(+stars + 0.5).toFixed(1)} out of 5, ${s.n + 2} reviews` });
    }
    return out;
  },
};

const SPECS = { spec_item_model_number: 'item model number', spec_upc: 'UPC', spec_product_dimensions: 'product dimensions', spec_package_dimensions: 'package dimensions',
  spec_item_weight: 'item weight', spec_date_first_available: 'date it was first available', spec_country_of_origin: 'country of origin', spec_manufacturer: 'manufacturer' };
const spec = {
  id: 'gen-shopping-product-spec', site: 'shopping', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 50,
  phrasings: [
    'What is the {{spec}} of "{{product}}"? Check the product details.',
    'Look up "{{product}}" and tell me its {{spec}}.',
    'According to its "More Information" section, what is the {{spec}} listed for "{{product}}"?',
  ],
  sample(L, r) {
    const out = [];
    const codes = Object.keys(SPECS);
    const ps = r.shuffle(namedProducts(L, `p.source = 'shop' AND p.id % 7 = 3`, 4000));
    for (const p of ps) {
      if (out.length >= 160) break;
      const code = r.pick(codes);
      const vals = L.col('SELECT value FROM product_attributes WHERE product_id = ? AND attribute_code = ?', p.id, code);
      if (vals.length !== 1 || !vals[0] || vals[0].length < 2 || vals[0].length > 60 || /^\d$/.test(vals[0])) continue;
      if (!findable(L, p)) continue;
      // dimensions are stored as "2.8 x 2.8 x 3.4 inches; 1.92 Ounces": the dimensions part is the answer (the weight after ';' is optional)
      const dims = /dimensions$/.test(code);
      const ref = dims ? vals[0].split(';')[0].trim() : vals[0];
      const sql = dims ? `SELECT trim(substr(value, 1, instr(value || ';', ';') - 1)) FROM product_attributes WHERE product_id = ${p.id} AND attribute_code = ${L.lit(code)}`
        : `SELECT value FROM product_attributes WHERE product_id = ${p.id} AND attribute_code = ${L.lit(code)}`;
      out.push({ slots: { spec: SPECS[code], product: L.plain(p.name) }, login_user: login(L, r),
        eval: { type: 'answer', answer: { must_include: [ref] }, answer_sql: sql }, wrong_answer: 'Not listed' });
    }
    return out;
  },
};

// Luma configurables: colors / sizes offered (enabled children)
const variants = {
  id: 'gen-shopping-variant-options', site: 'shopping', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 50,
  phrasings: [
    'Which {{axis_plural}} is the "{{product}}" available in? List them all.',
    'I want to buy the {{product}}. What {{axis}} options can I choose from?',
    'List every {{axis}} offered for "{{product}}" on its product page.',
  ],
  sample(L, r) {
    const out = [];
    const ps = L.all("SELECT p.id, p.name FROM products p WHERE p.type = 'configurable' AND p.status = 1 AND p.visibility IN (2, 3, 4) ORDER BY p.id");
    for (const p of ps) {
      for (const axis of ['color', 'size']) {
        const labels = L.col(`SELECT DISTINCT o.label FROM product_variants v JOIN products k ON k.id = v.child_id JOIN attribute_options o ON o.id = k.${axis}_option_id
          WHERE v.parent_id = ? AND k.status = 1 ORDER BY o.position, o.label`, p.id);
        if (labels.length < 2) continue;
        const allAxis = L.col(`SELECT DISTINCT o.label FROM product_variants v JOIN products k ON k.id = v.child_id JOIN attribute_options o ON o.id = k.${axis}_option_id WHERE v.parent_id = ?`, p.id);
        const sql = `SELECT DISTINCT o.label FROM product_variants v JOIN products k ON k.id = v.child_id JOIN attribute_options o ON o.id = k.${axis}_option_id WHERE v.parent_id = ${p.id} AND k.status = 1`;
        // sizes like "28" or "S" are substrings of others ("XS"): only colors, or sizes that are not substrings of each other
        if (labels.some((a) => labels.some((b) => a !== b && b.toLowerCase().includes(a.toLowerCase())))) continue;
        const wrong = labels.slice(0, -1).join(', ');
        out.push({ slots: { product: L.plain(p.name), axis, axis_plural: axis === 'color' ? 'colors' : 'sizes' }, login_user: login(L, r),
          eval: { type: 'answer', answer: { must_include: labels }, answer_sql: sql }, wrong_answer: wrong, _all: allAxis });
      }
    }
    return out;
  },
};

// compare list: add two products, answer which is cheaper (state + answer)
const compare = {
  id: 'gen-shopping-compare-pair', site: 'shopping', kind: 'write', skills: ['search', 'compare', 'create'], difficulty: 2, cap: 70,
  phrasings: [
    'Add "{{a}}" and "{{b}}" to my comparison list, then tell me the SKU of the one with more reviews.',
    'Put "{{a}}" and "{{b}}" in the product comparison and give me the SKU of whichever has more customer reviews.',
  ],
  sample(L, r) {
    const out = [];
    const ps = r.shuffle(namedProducts(L, `p.source = 'shop' AND p.id IN (SELECT product_id FROM reviews WHERE status = 'approved' GROUP BY product_id HAVING count(*) BETWEEN 2 AND 40)`, 3000));
    const byCat = new Map();
    for (const p of ps.slice(0, 1500)) {
      const c = L.one('SELECT category_id FROM product_categories WHERE product_id = ? ORDER BY category_id DESC LIMIT 1', p.id);
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(p);
    }
    for (const [, list] of byCat) {
      if (list.length < 2) continue;
      const [a, b] = list;
      if (!findable(L, a) || !findable(L, b)) continue;
      const na = L.one("SELECT count(*) FROM reviews WHERE product_id = ? AND status = 'approved'", a.id);
      const nb = L.one("SELECT count(*) FROM reviews WHERE product_id = ? AND status = 'approved'", b.id);
      if (na === nb) continue;
      const win = na > nb ? a : b;
      const lose = na > nb ? b : a;
      const user = login(L, r);
      const n = (x) => `(SELECT count(*) FROM reviews WHERE product_id = ${x} AND status = 'approved')`;
      out.push({ slots: { a: L.plain(a.name), b: L.plain(b.name) }, login_user: user,
        eval: {
          type: ['state', 'answer'],
          // the customer's compare list holds both products
          state_sql: `SELECT count(DISTINCT product_id) FROM compare_items WHERE customer_id = (SELECT id FROM customers WHERE email = ${L.lit(user)}) AND product_id IN (${a.id}, ${b.id})`,
          state_expect: 2,
          answer: { must_include: [win.sku] },
          answer_sql: `SELECT sku FROM products WHERE id = CASE WHEN ${n(a.id)} > ${n(b.id)} THEN ${a.id} ELSE ${b.id} END`,
        },
        wrong_answer: lose.sku });
    }
    return out;
  },
};

module.exports = [histogram, ratingSummary, spec, variants, compare];
