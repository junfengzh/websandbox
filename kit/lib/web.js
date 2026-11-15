'use strict';
// URL, pagination, sort, filter and form-validation helpers.
// Stable URL params (documented in README): q, page, per_page, sort=<key>_<asc|desc>,
// plus site-defined filter params (e.g. brand=, price_min=, price_max=).

function queryOf(req) {
  const q = {};
  for (const [k, v] of Object.entries(req.query || {})) if (v !== undefined) q[k] = v;
  return q;
}

// Current path with query changes applied (null/'' removes a param). Relative URL.
function urlWith(req, changes = {}, path) {
  const p = path || req.url.split('?')[0];
  const q = { ...queryOf(req), ...changes };
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v == null || v === '') continue;
    for (const x of Array.isArray(v) ? v : [v]) if (x != null && x !== '') sp.append(k, String(x));
  }
  const s = sp.toString();
  return s ? `${p}?${s}` : p;
}

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

// paginate(req, total, {perPage, maxPerPage}) -> {page, perPage, offset, limit, total, pages, prev, next, links}
// cap: pass total from countCapped(); totals above cap show as "cap+" (capped: true).
function paginate(req, total, { perPage = 20, maxPerPage = 100, window = 2, cap } = {}) {
  const capped = cap != null && total > cap;
  if (capped) total = cap;
  perPage = Math.min(Math.max(int(req.query.per_page, perPage), 1), maxPerPage);
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(int(req.query.page, 1), 1), pages);
  const href = (n) => urlWith(req, { page: n === 1 ? null : n });
  const links = [];
  let last = 0;
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= window) {
      if (n - last > 1) links.push({ gap: true });
      links.push({ n, href: href(n), current: n === page });
      last = n;
    }
  }
  return {
    page, perPage, pages, total, capped, offset: (page - 1) * perPage, limit: perPage, links,
    from: total ? (page - 1) * perPage + 1 : 0, to: Math.min(total, page * perPage),
    prev: page > 1 ? href(page - 1) : null, next: page < pages ? href(page + 1) : null,
  };
}

// sorter(req, {options: {price: 'p.price', name: 'p.name COLLATE NOCASE'}, default: 'name_asc', tiebreak: 'p.id'})
// URL: ?sort=price_desc. Returns {value, key, dir, orderBy, link(key, defDir), options}
function sorter(req, { options, default: def, tiebreak, labels = {} }) {
  const parse = (v) => {
    const m = /^(.+)_(asc|desc)$/.exec(String(v || ''));
    return m && options[m[1]] ? { key: m[1], dir: m[2] } : null;
  };
  const cur = parse(req.query.sort) || parse(def) || { key: Object.keys(options)[0], dir: 'asc' };
  const value = `${cur.key}_${cur.dir}`;
  const orderBy = `${options[cur.key]} ${cur.dir.toUpperCase()}${tiebreak ? `, ${tiebreak} ${cur.dir.toUpperCase()}` : ''}`;
  const link = (key, defDir = 'asc') => {
    const dir = cur.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : defDir;
    return urlWith(req, { sort: `${key}_${dir}`, page: null });
  };
  const list = [];
  for (const key of Object.keys(options)) for (const dir of ['asc', 'desc']) {
    const v = `${key}_${dir}`;
    list.push({ value: v, label: labels[v] || `${labels[key] || key} (${dir === 'asc' ? 'ascending' : 'descending'})`, selected: v === value });
  }
  return { ...cur, value, orderBy, link, options: list, arrow: (key) => (cur.key === key ? (cur.dir === 'asc' ? '▲' : '▼') : '') };
}

// filters(req, {status: {col: 'n.status'}, price_min: {col: 'p.price', op: '>=', type: 'number'},
//               tag: {col: 'n.tags', op: 'like'}, author: {col: 'u.username', op: 'in'}})
// -> {where: 'n.status = ? AND ...' ('1' if none), params, values, active: [{name, label, value, removeHref}]}
function filters(req, spec) {
  const clauses = []; const params = []; const values = {}; const active = [];
  for (const [name, f] of Object.entries(spec)) {
    let v = req.query[name];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const conv = (x) => {
      if (f.type === 'int') { const n = parseInt(x, 10); return Number.isFinite(n) ? n : undefined; }
      if (f.type === 'number') { const n = parseFloat(x); return Number.isFinite(n) ? n : undefined; }
      if (f.type === 'bool') return ['1', 'true', 'yes', 'on'].includes(String(x).toLowerCase()) ? 1 : 0;
      return String(x).trim();
    };
    const op = f.op || '=';
    if (op === 'in') {
      const xs = (Array.isArray(v) ? v : String(v).split(',')).map(conv).filter((x) => x !== undefined && x !== '');
      if (!xs.length) continue;
      clauses.push(`${f.col} IN (${xs.map(() => '?').join(',')})`); params.push(...xs); values[name] = xs;
    } else {
      if (Array.isArray(v)) v = v[0];
      const x = conv(v);
      if (x === undefined || x === '') continue;
      if (op === 'like') { clauses.push(`${f.col} LIKE ? ESCAPE '\\'`); params.push(`%${String(x).replace(/[\\%_]/g, '\\$&')}%`); }
      else if (f.sql) { clauses.push(f.sql); params.push(...(f.sql.match(/\?/g) || []).map(() => x)); }
      else { clauses.push(`${f.col} ${op} ?`); params.push(x); }
      values[name] = x;
    }
    active.push({ name, label: f.label || name, value: values[name], removeHref: urlWith(req, { [name]: null, page: null }) });
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1', params, values, active };
}

// validate(body, {title: {required: true, maxLength: 200}, price: {type: 'number', min: 0}, ...})
// -> {ok, values, errors: {field: message}}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validate(input, rules) {
  const values = {}; const errors = {};
  for (const [name, r] of Object.entries(rules)) {
    const label = r.label || name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    let v = input ? input[name] : undefined;
    if (Array.isArray(v) && !r.multiple) v = v[v.length - 1];
    if (typeof v === 'string' && r.trim !== false) v = v.trim();
    const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
    if (r.type === 'bool') { values[name] = !empty && !['0', 'false', 'off', 'no'].includes(String(v).toLowerCase()); continue; }
    if (empty) {
      if (r.required) errors[name] = r.message || `${label} is required.`;
      values[name] = r.default ?? (r.multiple ? [] : null);
      continue;
    }
    let x = v;
    if (r.type === 'int' || r.type === 'number') {
      x = r.type === 'int' ? Number(v) : parseFloat(v);
      if (!Number.isFinite(x) || (r.type === 'int' && !Number.isInteger(x))) { errors[name] = `${label} must be ${r.type === 'int' ? 'a whole number' : 'a number'}.`; values[name] = v; continue; }
      if (r.min != null && x < r.min) errors[name] = `${label} must be at least ${r.min}.`;
      if (r.max != null && x > r.max) errors[name] = `${label} must be at most ${r.max}.`;
    } else if (r.type === 'email' && !EMAIL.test(v)) errors[name] = `${label} must be a valid email address.`;
    else if (r.type === 'url' && !/^https?:\/\/\S+$/i.test(v)) errors[name] = `${label} must be a valid URL (http:// or https://).`;
    else if (r.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[name] = `${label} must be a date (YYYY-MM-DD).`;
    if (typeof x === 'string') {
      if (r.minLength != null && x.length < r.minLength) errors[name] = `${label} must be at least ${r.minLength} characters.`;
      if (r.maxLength != null && x.length > r.maxLength) errors[name] = `${label} must be at most ${r.maxLength} characters.`;
      if (r.pattern && !r.pattern.test(x)) errors[name] = r.message || `${label} has an invalid format.`;
    }
    if (r.oneOf && ![].concat(x).every((y) => r.oneOf.map(String).includes(String(y)))) errors[name] = `${label} has an invalid value.`;
    values[name] = x;
    if (!errors[name] && r.check) { const m = r.check(x, values); if (m) errors[name] = m; }
  }
  return { ok: !Object.keys(errors).length, values, errors };
}

// count(*) that stops at cap+1 rows -- counting millions of rows on every list page is slow.
// countCapped(db, 'FROM notes n WHERE n.tag = ?', ['work'], 10000)
function countCapped(db, fromWhere, params = [], cap = 10000) {
  const { als } = require('./context');
  const c = als.getStore();
  const prep = c && c.db === db ? (x) => c.tenant.sql(x) : (x) => db.prepare(x);
  return prep(`SELECT count(*) FROM (SELECT 1 ${fromWhere} LIMIT ${(cap | 0) + 1})`).pluck().get(...params);
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

module.exports = { urlWith, paginate, countCapped, sorter, filters, validate, escapeHtml, queryOf };
