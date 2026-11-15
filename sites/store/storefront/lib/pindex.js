'use strict';
// In-process listing index: the product fields listings need (type, name, status, visibility,
// prices, brand, stock, categories, configurable children), built once per process from
// base.db and shared by all tenants. Reading 20k product rows from SQLite per category page
// costs ~0.5-2 s (rows carry large descriptions); this keeps listings at a few ms.
//
// Correctness under tenant writes: temp triggers on products / product_categories /
// product_variants call store_dirty(kind, id) for every change, so each tenant knows which
// products / categories differ from base and reads those from its own DB. The dirty sets are
// cleared when the tenant is reset (tenant.stats.resets changes). Over-reporting (a write that
// was later rolled back by a failed request) only costs a DB read.
const S = require('../../shared');

let BASE = null; // { P: Map(id -> rec), cats: Map(catId -> Int32Array pairs [pid, pos, ...]), kids: Map(parent -> [child ids]) }

const COLS = 'id, type, name, url_key, status, visibility, price, special_price, special_from, special_to, brand, is_in_stock, source, color_option_id, size_option_id';
const rec = (r) => ({ ...r, lname: S.plainName(r.name).toLowerCase() });

function build(db) {
  const t0 = Date.now();
  const P = new Map();
  for (const r of db.prepare(`SELECT ${COLS} FROM products`).iterate()) P.set(r.id, rec(r));
  const tmp = new Map();
  const pcats = new Map();
  for (const [c, p, pos] of db.prepare('SELECT category_id, product_id, position FROM product_categories').raw().iterate()) {
    let a = tmp.get(c); if (!a) tmp.set(c, (a = [])); a.push(p, pos ?? 0);
    let b = pcats.get(p); if (!b) pcats.set(p, (b = [])); b.push(c);
  }
  const cats = new Map();
  for (const [c, a] of tmp) cats.set(c, Int32Array.from(a));
  for (const [p, b] of pcats) { const r = P.get(p); if (r) r.cats = Int32Array.from(b); }
  const kids = new Map();
  for (const [pa, ch] of db.prepare('SELECT parent_id, child_id FROM product_variants').raw().iterate()) { let a = kids.get(pa); if (!a) kids.set(pa, (a = [])); a.push(ch); }
  BASE = { P, cats, kids, ms: Date.now() - t0 };
  return BASE;
}

// Called from cfg.onOpen (before the tenant's first BEGIN, so the DB is in base state).
function attach(db, tenant) {
  const first = !BASE;
  if (!BASE) build(db);
  if (first) require('./catalog').prewarm(db, () => tenant.nowSql().slice(0, 10));
  const st = { resets: -1, p: new Set(), c: new Set(), v: new Set(), all: false };
  tenant.storeIndex = st;
  const touch = () => { if (st.resets !== tenant.stats.resets) { st.resets = tenant.stats.resets; st.p.clear(); st.c.clear(); st.v.clear(); st.all = false; } };
  st.touch = touch;
  db.function('store_dirty', { deterministic: false, directOnly: false }, (kind, id) => {
    touch();
    const s = st[kind];
    if (s) { if (s.size > 50000) st.all = true; else s.add(id); }
    return null;
  });
  db.exec(`
    CREATE TEMP TRIGGER IF NOT EXISTS store_pi_p_ai AFTER INSERT ON main.products BEGIN SELECT store_dirty('p', new.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS store_pi_p_au AFTER UPDATE ON main.products BEGIN SELECT store_dirty('p', new.id); SELECT store_dirty('p', old.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS store_pi_p_ad AFTER DELETE ON main.products BEGIN SELECT store_dirty('p', old.id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS store_pi_c_ai AFTER INSERT ON main.product_categories BEGIN SELECT store_dirty('c', new.category_id); SELECT store_dirty('p', new.product_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS store_pi_c_au AFTER UPDATE ON main.product_categories BEGIN SELECT store_dirty('c', new.category_id); SELECT store_dirty('c', old.category_id); SELECT store_dirty('p', new.product_id); SELECT store_dirty('p', old.product_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS store_pi_c_ad AFTER DELETE ON main.product_categories BEGIN SELECT store_dirty('c', old.category_id); SELECT store_dirty('p', old.product_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS store_pi_v_ai AFTER INSERT ON main.product_variants BEGIN SELECT store_dirty('v', new.parent_id); END;
    CREATE TEMP TRIGGER IF NOT EXISTS store_pi_v_ad AFTER DELETE ON main.product_variants BEGIN SELECT store_dirty('v', old.parent_id); END;
  `);
}

// A per-request view: get(id) -> product record (tenant state), catMembers(catId) -> [[pid, pos]...]
function view(db, tenant) {
  const st = tenant.storeIndex;
  if (st) st.touch();
  const dirtyAll = !st || st.all;
  const cacheP = new Map();
  const getP = db.prepare(`SELECT ${COLS} FROM products WHERE id = ?`);
  const getCats = db.prepare('SELECT category_id FROM product_categories WHERE product_id = ?').pluck();
  const get = (id) => {
    if (!dirtyAll && !st.p.has(id)) return BASE.P.get(id) || null;
    if (cacheP.has(id)) return cacheP.get(id);
    const r = getP.get(id);
    const out = r ? rec(r) : null;
    if (out) out.cats = Int32Array.from(getCats.all(id));
    cacheP.set(id, out);
    return out;
  };
  const members = (catId) => {
    if (!dirtyAll && !st.c.has(catId)) {
      const a = BASE.cats.get(catId);
      const out = [];
      if (a) for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]);
      return out;
    }
    return db.prepare('SELECT product_id, coalesce(position, 0) FROM product_categories WHERE category_id = ?').raw().all(catId);
  };
  const children = (pid) => {
    if (!dirtyAll && !st.v.has(pid)) return BASE.kids.get(pid) || [];
    return db.prepare('SELECT child_id FROM product_variants WHERE parent_id = ?').pluck().all(pid);
  };
  return { get, members, children };
}

// Effective listing price (configurables: lowest enabled child final price).
function price(v, r, today) {
  if (r.type === 'configurable') {
    let best = null;
    for (const c of v.children(r.id)) {
      const k = v.get(c);
      if (!k || k.status !== 1) continue;
      const fp = S.finalPrice(k, today);
      if (fp != null && (best == null || fp < best)) best = fp;
    }
    return best ?? S.finalPrice(r, today);
  }
  return S.finalPrice(r, today);
}

// Dirty state of a tenant (after a reset check): { p: Set, c: Set, v: Set, all }
function dirty(tenant) {
  const st = tenant.storeIndex;
  if (!st) return { p: new Set(), c: new Set(), v: new Set(), all: true };
  st.touch();
  return st;
}
// A view of the base data only (no tenant changes): for process-wide caches.
const EMPTY = { p: new Set(), c: new Set(), v: new Set(), all: false, touch() {} };
function baseView(db) { return view(db, { storeIndex: EMPTY }); }

module.exports = { build, attach, view, baseView, dirty, price, base: () => BASE };
