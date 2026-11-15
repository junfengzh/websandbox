'use strict';
// Task grader for the eval format in docs/CONVENTIONS.md ("WebArena tasks"):
//   eval: { type: 'answer'|'url'|'state' | [...], answer: {exact|must_include|fuzzy: ...},
//           answer_sql, url, state_sql, state_expect }
// grade(task, {answer, url, query, fuzzy}) -> {pass: true|false|null, score, checks: [...]}
// `query(sql)` -> rows (array of objects or arrays); see remoteQuery()/tenant.query().
// `fuzzy({intent, answer, reference})` -> boolean|score (the RL stack's LLM judge). Without it,
// fuzzy checks come back {pass: null, pending: 'fuzzy'} and the overall pass is null.

// WebArena StringEvaluator.clean_answer
const clean = (s) => {
  let a = String(s ?? '').trim();
  if ((a.startsWith("'") && a.endsWith("'")) || (a.startsWith('"') && a.endsWith('"'))) a = a.slice(1, -1);
  return a.toLowerCase();
};

const firstCol = (rows) => rows.map((r) => (Array.isArray(r) ? r[0] : r && typeof r === 'object' ? Object.values(r)[0] : r));
const SQL_REF = (v) => v == null || v === '$sql';

function exactMatch(pred, ref) { return clean(pred) === clean(ref); }
// must_include entries may contain " |OR| " alternatives (WebArena).
// A reference that ends/starts with a digit must not match inside a longer number
// ("1" is not in "10" or "2.15"), unlike WebArena's plain substring test.
function includesRef(p, ref) {
  if (!/\d/.test(ref)) return p.includes(ref);
  const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pre = /^\d/.test(ref) ? '(?<![\\d.]|\\d,)' : '';
  const post = /\d$/.test(ref) ? '(?![\\d]|[.,]\\d)' : '';
  return new RegExp(pre + esc + post).test(p);
}
function mustInclude(pred, refs) {
  const p = clean(pred);
  return [].concat(refs).every((r) => String(r).split(' |OR| ').some((alt) => includesRef(p, clean(alt))));
}

// ---- URLs: host ignored (placeholders / tenant addresses vary), path normalised,
// query params compared as a multiset, order-insensitive.
function normUrl(u) {
  const s = String(u || '').replace(/^__[A-Z_]+__/, 'http://x');
  let url;
  try { url = new URL(s, 'http://x'); } catch { return { path: s, params: [] }; }
  let p = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const params = [];
  for (const [k, v] of url.searchParams) if (v !== '') params.push([k, v.trim()]);
  params.sort((a, b) => (a[0] + '\0' + a[1] < b[0] + '\0' + b[1] ? -1 : 1));
  return { path: p.toLowerCase(), params };
}
// mode 'subset' (WebArena url_match semantics: reference params must all be present) or 'exact'.
function urlMatch(pred, ref, { mode = 'subset', ignore = [] } = {}) {
  const a = normUrl(pred); const b = normUrl(ref);
  if (a.path !== b.path) return false;
  const key = (x) => x.filter(([k]) => !ignore.includes(k)).map(([k, v]) => `${k}=${v.toLowerCase()}`);
  const pa = key(a.params); const pb = key(b.params);
  if (mode === 'exact') return pa.join('&') === pb.join('&');
  const bag = new Map();
  for (const x of pa) bag.set(x, (bag.get(x) || 0) + 1);
  return pb.every((x) => { const n = bag.get(x) || 0; bag.set(x, n - 1); return n > 0; });
}

// ---- state: compare query rows with an expectation
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? parseFloat(v) : null);
function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == b; // eslint-disable-line eqeqeq
  const x = num(a); const y = num(b);
  if (x != null && y != null) return Math.abs(x - y) < 1e-6;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) === Number(b);
  return String(a) === String(b);
}
const rowVals = (r) => (Array.isArray(r) ? r : r && typeof r === 'object' ? Object.values(r) : [r]);
function rowEq(got, want) {
  if (want && typeof want === 'object' && !Array.isArray(want)) {
    return Object.entries(want).every(([k, v]) => same(Array.isArray(got) ? undefined : got[k], v));
  }
  const g = rowVals(got); const w = Array.isArray(want) ? want : [want];
  return g.length >= w.length && w.every((v, i) => same(g[i], v));
}
// expect: scalar (first cell) | array of rows (row = scalar | array | object of column->value,
// order-insensitive unless {ordered: true}) | {count: n} | {nonempty: bool} | {empty: true} |
// {rows: [...], ordered: bool} | {includes: [row...]} | {min: x, max: y} (first cell)
function stateMatch(rows, expect) {
  if (expect === null || typeof expect !== 'object') return rows.length > 0 && same(rowVals(rows[0])[0], expect);
  if (Array.isArray(expect)) return stateMatch(rows, { rows: expect });
  if ('count' in expect) return rows.length === expect.count;
  if ('nonempty' in expect) return (rows.length > 0) === !!expect.nonempty;
  if (expect.empty) return rows.length === 0;
  if ('min' in expect || 'max' in expect) {
    const v = rows.length ? num(rowVals(rows[0])[0]) : null;
    return v != null && (expect.min == null || v >= expect.min) && (expect.max == null || v <= expect.max);
  }
  if (expect.includes) return expect.includes.every((w) => rows.some((g) => rowEq(g, w)));
  if (expect.rows) {
    const want = expect.rows;
    if (rows.length !== want.length) return false;
    if (expect.ordered) return want.every((w, i) => rowEq(rows[i], w));
    const left = [...rows];
    return want.every((w) => { const i = left.findIndex((g) => rowEq(g, w)); if (i < 0) return false; left.splice(i, 1); return true; });
  }
  throw new Error('grader: unknown state_expect form ' + JSON.stringify(expect));
}

async function grade(task, { answer = '', url = '', query, fuzzy } = {}) {
  const ev = task.eval || task;
  let types = ev.type ? [].concat(ev.type) : [];
  if (!types.length) {
    if (ev.answer || ev.answer_sql) types.push('answer');
    if (ev.url) types.push('url');
    if (ev.state_sql) types.push('state');
  }
  const checks = [];
  const needQuery = () => { if (!query) throw new Error('grader: this task needs a query function (control API or tenant)'); return query; };

  for (const type of types) {
    try {
      if (type === 'answer') {
        const spec = ev.answer || {};
        let sqlRef = null;
        if (ev.answer_sql) sqlRef = firstCol(await needQuery()(ev.answer_sql)).map((v) => (v == null ? '' : String(v)));
        const mode = ['exact', 'must_include', 'fuzzy'].find((m) => m in spec) || (sqlRef ? 'must_include' : null);
        if (!mode) throw new Error('answer check without answer.exact/must_include/fuzzy or answer_sql');
        let ref = spec[mode];
        if (SQL_REF(ref)) {
          if (!sqlRef) throw new Error(`answer.${mode} refers to answer_sql but there is none`);
          ref = mode === 'exact' ? (sqlRef[0] ?? '') : mode === 'must_include' ? sqlRef : sqlRef.join(', ');
        }
        const c = { type, mode, reference: ref };
        if (sqlRef && !SQL_REF(spec[mode])) {
          // Static reference and SQL both given: report drift between them.
          const a = [].concat(ref).map(clean).sort().join('\n'); const b = sqlRef.map(clean).sort().join('\n');
          c.sql_reference = sqlRef; c.drift = a !== b;
        }
        if (mode === 'exact') c.pass = exactMatch(answer, ref);
        else if (mode === 'must_include') c.pass = mustInclude(answer, ref);
        else if (fuzzy) {
          const r = await fuzzy({ intent: task.intent, answer, reference: ref });
          c.score = typeof r === 'number' ? r : r ? 1 : 0; c.pass = c.score >= 1;
        } else { c.pass = null; c.pending = 'fuzzy'; }
        checks.push(c);
      } else if (type === 'url') {
        const refs = [].concat(ev.url);
        const ok = refs.some((r) => urlMatch(url, r, { mode: ev.url_match || 'subset', ignore: ev.url_ignore_params || [] }));
        checks.push({ type, pass: ok, reference: ev.url, got: url });
      } else if (type === 'state') {
        const sqls = [].concat(ev.state_sql);
        const exps = Array.isArray(ev.state_sql) ? ev.state_expect : [ev.state_expect];
        for (let i = 0; i < sqls.length; i++) {
          const rows = await needQuery()(sqls[i]);
          checks.push({ type, sql: sqls[i], expect: exps[i], got: rows.slice(0, 20), pass: stateMatch(rows, exps[i]) });
        }
      } else throw new Error(`unknown eval type '${type}'`);
    } catch (e) {
      checks.push({ type, pass: false, error: String(e.message || e) });
    }
  }
  const pass = !checks.length ? false : checks.some((c) => c.pass === false) ? false : checks.some((c) => c.pass == null) ? null : true;
  return { pass, score: pass === true ? 1 : 0, checks };
}

// query function against a running site's control API.
// remoteQuery('http://127.0.0.1:7101', {tenant: 3, token})
function remoteQuery(base, { tenant, token } = {}) {
  return async (sql, params = []) => {
    const headers = { 'content-type': 'application/json' };
    if (tenant != null) headers['x-wsb-tenant'] = String(tenant);
    if (token) headers['x-wsb-control'] = token;
    const r = await fetch(new URL('/__rl/query', base), { method: 'POST', headers, body: JSON.stringify({ sql, params }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`query failed (${r.status}): ${j.error || JSON.stringify(j)}`);
    return j.rows;
  };
}

module.exports = { grade, remoteQuery, clean, exactMatch, mustInclude, urlMatch, normUrl, stateMatch };
