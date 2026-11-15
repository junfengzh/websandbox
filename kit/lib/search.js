'use strict';
// FTS5 helpers: safe MATCH expressions from user input, bm25 with column
// weights, snippets/highlights, synonym expansion, "did you mean".
const { escapeHtml } = require('./web');

const MARK_OPEN = '\u0002';
const MARK_CLOSE = '\u0003';
const WORD = /[\p{L}\p{N}]+/gu;
const quote = (s) => `"${String(s).replace(/"/g, '""')}"`;

// Split user input into phrases ("...") and words; FTS5 syntax is never passed through.
function tokenize(q) {
  const out = [];
  const s = String(q || '').slice(0, 500);
  const re = /"([^"]*)"|([^\s"]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] != null) { const w = m[1].match(WORD); if (w) out.push({ phrase: w.map((x) => x.toLowerCase()) }); }
    else for (const w of m[2].match(WORD) || []) out.push({ word: w.toLowerCase() });
  }
  return out;
}

function synonymsOf(db, synonyms, word) {
  if (!synonyms) return [];
  if (typeof synonyms === 'function') return synonyms(word) || [];
  if (typeof synonyms === 'string') return db.prepare(`SELECT synonym FROM ${synonyms} WHERE term = ?`).pluck().all(word);
  return synonyms[word] || [];
}

// match(q, {prefix: 'last'|'all'|'none', synonyms: map|fn|tableName, db, op: 'AND'|'OR'})
// -> FTS5 MATCH string, or null when the input has no searchable terms.
function match(q, o = {}) {
  const prefix = o.prefix || 'last';
  const toks = tokenize(q);
  if (!toks.length) return null;
  const parts = toks.map((t, i) => {
    if (t.phrase) return quote(t.phrase.join(' '));
    const pre = prefix === 'all' || (prefix === 'last' && i === toks.length - 1);
    const alts = [quote(t.word) + (pre ? '*' : '')];
    for (const s of synonymsOf(o.db, o.synonyms, t.word)) alts.push(quote(String(s).toLowerCase()));
    return alts.length > 1 ? `(${alts.join(' OR ')})` : alts[0];
  });
  return parts.join(o.op === 'OR' ? ' OR ' : ' AND ');
}

const colCache = new WeakMap();
function columnsOf(db, table) {
  let m = colCache.get(db);
  if (!m) colCache.set(db, (m = new Map()));
  if (!m.has(table)) m.set(table, db.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(table));
  return m.get(table);
}

// prepare(db, 'notes_fts', q, {weights: {title: 10, body: 1}, prefix, synonyms})
// -> {match, rank, snippet(col, tokens), highlight(col), terms} (match null = nothing to search)
function prepare(db, table, q, o = {}) {
  const cols = columnsOf(db, table);
  const w = o.weights || {};
  const idx = (c) => { const i = cols.indexOf(c); if (i < 0) throw new Error(`search: ${table} has no column ${c}`); return i; };
  return {
    match: match(q, { ...o, db }),
    terms: tokenize(q),
    rank: `bm25(${table}${cols.length && Object.keys(w).length ? ', ' + cols.map((c) => Number(w[c] ?? 1).toFixed(2)).join(', ') : ''})`,
    snippet: (col, tokens = 16) => `snippet(${table}, ${idx(col)}, '${MARK_OPEN}', '${MARK_CLOSE}', '…', ${tokens | 0})`,
    highlight: (col) => `highlight(${table}, ${idx(col)}, '${MARK_OPEN}', '${MARK_CLOSE}')`,
  };
}

// Escape a snippet/highlight result and turn the markers into <mark>.
const markup = (s) => escapeHtml(s).replace(/\u0002/g, '<mark>').replace(/\u0003/g, '</mark>');

// Optimal-string-alignment distance (insert/delete/substitute/transpose), capped.
function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let pp = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    pp = prev;
    prev = cur;
  }
  return prev[b.length];
}

// didYouMean(db, 'notes_fts', 'quik brwn') -> 'quick brown' or null.
// Uses an fts5vocab table (created in temp on demand). The FTS table should use
// an unstemmed tokenizer (unicode61), or suggestions come back as stems.
function didYouMean(db, table, q, { maxCandidates = 50000 } = {}) {
  const vocab = `${table}_kitvocab`;
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.${vocab} USING fts5vocab(main, ${table}, 'row')`);
  const has = db.prepare(`SELECT doc FROM temp.${vocab} WHERE term = ?`).pluck();
  const range = db.prepare(`SELECT term, doc FROM temp.${vocab} WHERE term >= ? AND term < ? LIMIT ${maxCandidates | 0}`);
  const words = String(q || '').toLowerCase().match(WORD) || [];
  let changed = false;
  const out = words.map((w) => {
    if (has.get(w) || /^\d+$/.test(w)) return w;
    const max = w.length <= 4 ? 1 : 2;
    let best = null;
    for (const p of [w.slice(0, 2), w.slice(0, 1)]) {
      const hi = p.slice(0, -1) + String.fromCodePoint(p.codePointAt(p.length - 1) + 1);
      for (const r of range.iterate(p, hi)) {
        const d = editDistance(w, r.term, max);
        if (d <= max && (!best || d < best.d || (d === best.d && r.doc > best.doc))) best = { term: r.term, d, doc: r.doc };
      }
      if (best) break;
    }
    if (best) { changed = true; return best.term; }
    return w;
  });
  return changed ? out.join(' ') : null;
}

module.exports = { tokenize, match, prepare, markup, didYouMean, editDistance, MARK_OPEN, MARK_CLOSE };
