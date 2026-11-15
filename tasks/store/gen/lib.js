'use strict';
// Shared helpers for the store task generators (storefront "shopping" and back office
// "shopping_admin"): base.db access, seeded randomness, SQL snippets that mirror what the
// store shows (final prices, category listings, ratings, local dates), reference formatting.
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const Database = require(require.resolve('better-sqlite3', { paths: [path.join(ROOT, 'kit')] }));
const U = require(path.join(ROOT, 'sites', 'store', 'admin', 'lib', 'util.js'));
const S = require(path.join(ROOT, 'sites', 'store', 'shared.js'));

const DATA = process.env.WSB_STORE_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'store');
const TODAY = '2023-06-12'; // store clock (sites/store/server.js); rollout writes are newer
const NOW = '2023-06-12 16:00:00';

let DB = null;
function db() {
  if (DB) return DB;
  DB = new Database(path.join(DATA, 'base.db'), { readonly: true, fileMustExist: true });
  DB.function('today', { deterministic: true }, () => TODAY);
  DB.function('now', { deterministic: true }, () => NOW);
  DB.function('admin_local', { deterministic: true }, (s) => (s == null ? null : U.toLocal(String(s))));
  DB.function('admin_local_date', { deterministic: true }, (s) => (s == null ? null : U.localDate(String(s))));
  return DB;
}
const all = (sql, ...a) => db().prepare(sql).all(...a);
const get = (sql, ...a) => db().prepare(sql).get(...a);
const one = (sql, ...a) => { const r = db().prepare(sql).raw().get(...a); return r ? r[0] : undefined; };
const col = (sql, ...a) => db().prepare(sql).raw().all(...a).map((r) => r[0]);

// ---------------------------------------------------------------- randomness (seeded)
function rng(seed) {
  let a = (seed >>> 0) || 1;
  const f = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.int = (n) => Math.floor(f() * n);
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.shuffle = (arr) => { const x = arr.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  f.sample = (arr, n) => f.shuffle(arr).slice(0, n);
  return f;
}
const hash = (s) => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// ---------------------------------------------------------------- SQL snippets
const lit = (s) => (s == null ? 'NULL' : typeof s === 'number' ? String(s) : "'" + String(s).replace(/'/g, "''") + "'");
const inList = (xs) => xs.map(lit).join(', ');
// final price of one product row (special price inside its window, store clock)
const FP = (a = 'p') => S.priceSql(a).replace(/\s+/g, ' ');
// listing price: configurables "As low as" the cheapest enabled child
const LPRICE = (a = 'p') => `(CASE WHEN ${a}.type = 'configurable' THEN coalesce((SELECT min(${FP('c')}) FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id = ${a}.id AND c.status = 1), ${a}.price) ELSE ${FP(a)} END)`;
const LOCAL_DATE = (c) => `admin_local_date(${c})`;
// storefront rating of a product (approved reviews; avg of vote percents) and review count
const RATING = (a = 'p') => `(SELECT avg(v.percent) FROM reviews r JOIN review_votes v ON v.review_id = r.id WHERE r.product_id = ${a}.id AND r.status = 'approved')`;
const NREV = (a = 'p') => `(SELECT count(*) FROM reviews r WHERE r.product_id = ${a}.id AND r.status = 'approved')`;

// ---------------------------------------------------------------- categories
let TREE = null;
function tree() {
  if (TREE) return TREE;
  const rows = all('SELECT id, parent_id, path, level, position, name, url_path, is_active, include_in_menu, is_anchor FROM categories ORDER BY level, position, id');
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]));
  for (const c of byId.values()) { const p = byId.get(c.parent_id); if (p && c.id !== c.parent_id) p.children.push(c); }
  TREE = { byId, rows: [...byId.values()] };
  return TREE;
}
function subtree(c) { const out = []; const st = [c]; while (st.length) { const x = st.pop(); out.push(x.id); st.push(...x.children); } return out; }
// category ids a category page lists (anchor: whole subtree), as the storefront does
const listIds = (c) => (c.is_anchor && c.children.length ? subtree(c) : [c.id]);
const plain = (s) => S.plainName(s);
// "Electronics > Headphones > Earbud Headphones"
function catPath(c) {
  const t = tree(); const names = [];
  for (let x = c; x && x.level >= 2; x = t.byId.get(x.parent_id)) names.unshift(plain(x.name));
  return names.join(' > ');
}
// products listed on a category page: SQL subquery of ids
const listedSql = (c) => `SELECT DISTINCT pc.product_id FROM product_categories pc JOIN products p ON p.id = pc.product_id WHERE pc.category_id IN (${listIds(c).join(',')}) AND p.status = 1 AND p.visibility IN (2, 4)`;

// ---------------------------------------------------------------- storefront search (mirror of storefront/lib/catalog.js, 'and' mode)
const kitSearch = require(path.join(ROOT, 'kit', 'lib', 'search.js'));
function searchMatch(q) { return kitSearch.prepare(db(), 'product_search', q, { weights: { name: 10, brand: 5, category_names: 3, sku: 2, description: 1 }, prefix: 'none' }).match; }

// ---------------------------------------------------------------- references
// money in the forms people write: 1234.5 -> "1234.50 |OR| 1,234.50"
function moneyRef(x) {
  const v = Math.round(x * 100) / 100;
  const alts = [v.toFixed(2)];
  if (v >= 1000) alts.push(v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return alts.join(' |OR| ');
}
// SQL producing moneyRef of expression x
const moneySql = (x) => `(printf('%.2f', ${x}) || CASE WHEN ${x} >= 1000 THEN ' |OR| ' || printf('%,.2f', ${x}) ELSE '' END)`;
const intRef = (n) => (n >= 1000 ? `${n} |OR| ${n.toLocaleString('en-US')}` : String(n));
const intSql = (x) => `(CASE WHEN ${x} >= 1000 THEN ${x} || ' |OR| ' || printf('%,d', ${x}) ELSE CAST(${x} AS TEXT) END)`;
// order number: "000001138" or "1138"
const orderRef = (inc) => `${inc} |OR| ${String(parseInt(inc, 10))}`;
const orderSql = (x) => `(${x} || ' |OR| ' || CAST(CAST(${x} AS INTEGER) AS TEXT))`;
const has = (expr, needles) => needles.map((n) => `instr(lower(${expr}), lower(${lit(n)})) > 0`).join(' AND ') || '1';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
// 2023-03-05 -> "March 5, 2023" ; "3/5/2023"
const longDate = (d) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`;
const usDate = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}/${d.slice(0, 4)}`;
const lastDay = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);

// product URLs as the storefront serves them (url eval: either form passes)
const productUrls = (p) => [`__SHOPPING__/${p.url_key}.html`, `__SHOPPING__/catalog/product/view/id/${p.id}`];

// short, searchable product label: names are long Amazon titles; keep the first ~12 words
function shortName(name, words = 12) {
  const n = plain(name).replace(/\s+/g, ' ').trim();
  const w = n.split(' ');
  return w.length <= words ? n : w.slice(0, words).join(' ') + ' ...';
}

// customers that can log in on the storefront cheaply (kit scrypt hash); never prints hashes
let CUST = null;
function customers() {
  if (CUST) return CUST;
  CUST = all("SELECT id, email, firstname, lastname, group_id, default_billing_id, default_shipping_id FROM customers WHERE password_hash LIKE 'scrypt$%' ORDER BY id");
  return CUST;
}
const fullName = (c) => `${c.firstname} ${c.lastname}`.trim();

module.exports = {
  ROOT, DATA, TODAY, NOW, db, all, get, one, col, rng, hash, lit, inList, FP, LPRICE, LOCAL_DATE, RATING, NREV,
  tree, subtree, listIds, plain, catPath, listedSql, searchMatch, moneyRef, moneySql, intRef, intSql, orderRef, orderSql, has,
  MONTHS, monthName, longDate, usDate, lastDay, productUrls, shortName, customers, fullName, U, S,
};

// ---------------------------------------------------------------- fake US addresses (for address / checkout tasks)
const CITIES = [['Columbus', 'Ohio', '43215'], ['Austin', 'Texas', '78701'], ['Denver', 'Colorado', '80202'], ['Portland', 'Oregon', '97205'],
  ['Madison', 'Wisconsin', '53703'], ['Raleigh', 'North Carolina', '27601'], ['Tucson', 'Arizona', '85701'], ['Boise', 'Idaho', '83702'],
  ['Albany', 'New York', '12207'], ['Richmond', 'Virginia', '23219'], ['Omaha', 'Nebraska', '68102'], ['Spokane', 'Washington', '99201'],
  ['Savannah', 'Georgia', '31401'], ['Burlington', 'Vermont', '05401'], ['Providence', 'Rhode Island', '02903'], ['Lexington', 'Kentucky', '40507'],
  ['Des Moines', 'Iowa', '50309'], ['Tulsa', 'Oklahoma', '74103'], ['Reno', 'Nevada', '89501'], ['Fargo', 'North Dakota', '58102'],
  ['Pittsburgh', 'Pennsylvania', '15222'], ['Ann Arbor', 'Michigan', '48104'], ['Santa Fe', 'New Mexico', '87501'], ['Charleston', 'South Carolina', '29401'],
  ['Little Rock', 'Arkansas', '72201'], ['Knoxville', 'Tennessee', '37902'], ['Salem', 'Massachusetts', '01970'], ['Duluth', 'Minnesota', '55802']];
const STREETS = ['Maple Avenue', 'Oak Street', 'Pine Road', 'Cedar Lane', 'Elm Drive', 'Willow Way', 'Birch Court', 'Lakeview Boulevard', 'Hillcrest Road',
  'River Street', 'Sunset Avenue', 'Park Place', 'Church Street', 'Mill Road', 'Meadow Lane', 'Highland Avenue', 'Spring Street', 'Forest Drive'];
function fakeAddress(r) {
  const [city, region, postcode] = r.pick(CITIES);
  const street = `${100 + r.int(9800)} ${r.pick(STREETS)}`;
  const telephone = `${200 + r.int(700)}-555-${String(1000 + r.int(9000))}`;
  const region_id = one("SELECT id FROM regions WHERE country_id = 'US' AND name = ?", region);
  return { street, city, region, region_id, postcode, telephone, text: `${street}, ${city}, ${region} ${postcode}` };
}
// SQL: address row alias x matches the fake address (street contains, city, postcode, region)
const addrMatch = (x, a) => `(instr(lower(${x}.street), lower(${lit(a.street)})) > 0 AND lower(${x}.city) = lower(${lit(a.city)}) AND ${x}.postcode = ${lit(a.postcode)} AND (${x}.region_id = ${a.region_id} OR lower(${x}.region) = lower(${lit(a.region)})))`;
// the customer's active cart items (top-level)
const CART = (cid) => `cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.customer_id = ${cid} AND c.is_active = 1 AND ci.parent_item_id IS NULL`;
// the customer's newest order placed during the rollout
const NEW_ORDER = (cid) => `(SELECT id FROM orders WHERE customer_id = ${cid} AND created_at >= '${TODAY}' ORDER BY id DESC LIMIT 1)`;
const WISH = (cid) => `wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id WHERE w.customer_id = ${cid}`;
Object.assign(module.exports, { CITIES, fakeAddress, addrMatch, CART, NEW_ORDER, WISH });

// date reference in the forms people write ("March 5, 2023 |OR| 3/5/2023 |OR| 2023-03-05 |OR| Mar 5, 2023") and its SQL twin (d = 'YYYY-MM-DD' expr)
const dateRef = (d) => [longDate(d), usDate(d), d, `${MONTHS[+d.slice(5, 7) - 1].slice(0, 3)} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`].join(' |OR| ');
const MCASE = (d, short) => `CASE CAST(substr(${d}, 6, 2) AS INTEGER) ${MONTHS.map((m, i) => `WHEN ${i + 1} THEN '${short ? m.slice(0, 3) : m}'`).join(' ')} END`;
const dateSql = (d) => `(${MCASE(d)} || ' ' || CAST(CAST(substr(${d}, 9, 2) AS INTEGER) AS TEXT) || ', ' || substr(${d}, 1, 4) || ' |OR| ' || CAST(CAST(substr(${d}, 6, 2) AS INTEGER) AS TEXT) || '/' || CAST(CAST(substr(${d}, 9, 2) AS INTEGER) AS TEXT) || '/' || substr(${d}, 1, 4) || ' |OR| ' || substr(${d}, 1, 10) || ' |OR| ' || ${MCASE(d, true)} || ' ' || CAST(CAST(substr(${d}, 9, 2) AS INTEGER) AS TEXT) || ', ' || substr(${d}, 1, 4))`;
Object.assign(module.exports, { dateRef, dateSql });
