'use strict';
// Full-text search over article_fts (contentless FTS5, porter): SCHEMA.md ranking
// (bm25 title weight 50 minus 0.3 x ln(1 + in-links)), exact title/redirect match first,
// stop words stripped. Big match sets (common words: > BIG matches) would score every row
// (~0.1-0.8 s), so they are ranked in tiers instead: title matches by the same score, then
// the same score over the matches among the most popular articles (ids follow in-link
// rank; an id window holding ~CAND matches), then the rest in popularity order.
const kit = require('../../../kit');
const W = require('./wiki');

const BIG = 8000;   // more matches than this: tiered ranking
const CAND = 4000;  // matches scored in tier 2
const STOP = new Set(('a an and are as at be but by for from has have he her his how i if in into is it its of on or '
  + 'she that the their there these they this to was were what when where which who whom why will with you your').split(' '));

const LRU = new W.LRU(16 * 2 ** 20); // query -> result list (ids + scores), per process

function terms(q) {
  const toks = kit.search.tokenize(q);
  const kept = toks.filter((x) => x.phrase || !STOP.has(x.word));
  return kept.length ? kept : toks; // a query of only stop words ("the who") searches them
}
function matchOf(q) {
  const parts = terms(q).map((x) => (x.phrase ? `"${x.phrase.join(' ')}"` : `"${x.word.replace(/"/g, '""')}"`));
  return parts.length ? parts.join(' AND ') : null;
}

// -> {ids: [..] (ranked), total, big}
// Score = bm25(title x50, body) - 0.3 ln(1 + in-links) (SCHEMA.md). A title-coverage bonus
// (recall x sqrt(precision) of the query words in the title, x1..4) was tried on 30 task-like
// queries and did not improve top-1/top-3, so it is not used.
function rankedIds(t, m, q) {
  const hit = LRU.get(m);
  if (hit) return hit;
  const total = t.sql('SELECT count(*) FROM article_fts WHERE article_fts MATCH ?').pluck().get(m);
  const SCORE = 'bm25(article_fts, 50.0, 1.0) - 0.3 * ln(1 + a.inlinks)';
  const sel = `SELECT f.rowid AS id, a.title, ${SCORE} AS s FROM article_fts f JOIN article a ON a.id = f.rowid WHERE article_fts MATCH ?`;
  const cand = new Map();
  const add = (r) => { if (!cand.has(r.id)) cand.set(r.id, r); };
  const big = total > BIG;
  let rest = [];
  if (!big) {
    t.sql(`${sel} ORDER BY s LIMIT 1000`).all(m).forEach(add);
  } else {
    // tier 1: title matches; tier 2: the most popular articles (ids are in in-link order; an
    // id window sized for ~CAND matches) -- both fully scored; tier 3: the rest by id
    const maxId = t.sql('SELECT max(id) FROM article').pluck().get();
    const window = Math.max(2000, Math.floor(maxId * CAND / total));
    t.sql(`${sel} AND f.rowid <= ? ORDER BY s LIMIT 700`).all(m, window).forEach(add);
    rest = t.sql('SELECT rowid FROM article_fts WHERE article_fts MATCH ? AND rowid > ? ORDER BY rowid LIMIT 1000').pluck().all(m, window);
  }
  // articles with any query word in the title (they may score below the cut)
  t.sql(`${sel} AND article_fts MATCH ? ORDER BY s LIMIT 300`).all(m, `{title} : (${terms(q).map((x) => (x.phrase ? `"${x.phrase.join(' ')}"` : `"${x.word}"`)).join(' OR ')})`).forEach(add);
  const scored = [...cand.values()].sort((x, y) => x.s - y.s);
  const ids = scored.map((r) => r.id).slice(0, 1000);
  const seen = new Set(ids);
  for (const id of rest) { if (ids.length >= 1000) break; if (!seen.has(id)) ids.push(id); }
  const v = { ids, total, big };
  LRU.set(m, v, 64 + ids.length * 8);
  return v;
}

// Highlight query words in a plain-text snippet (HTML-escaped, <span class="searchmatch">).
function highlight(text, q) {
  const ws = terms(q).flatMap((x) => x.phrase || [x.word]).filter((w) => w.length > 1)
    .map((w) => w.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  let h = kit.escapeHtml(text || '');
  if (!ws.length) return h;
  const stems = ws.map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s|e|y)$/, '') : w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])((?:${stems.join('|')})[\\p{L}\\p{N}]*)`, 'giu');
  return h.replace(re, '$1<span class="searchmatch">$2</span>');
}

// search(t, q, {offset, limit}) -> {q, total, results: [...], exact, big, ms}
function search(t, q, { offset = 0, limit = 20 } = {}) {
  const t0 = performance.now();
  const m = matchOf(q);
  if (!m) return { q, total: 0, results: [], exact: null, ms: 0 };
  const exact = W.exactMatch(t, q);
  let { ids, total, big } = rankedIds(t, m, q);
  if (exact) {
    ids = [exact.id, ...ids.filter((x) => x !== exact.id)];
    if (!total) total = 1;
  }
  const page = ids.slice(offset, offset + limit);
  const get = t.sql('SELECT id, path, title, lead, image, text_len, edited FROM article WHERE id = ?');
  const results = page.map((id) => get.get(id)).filter(Boolean).map((a) => ({ ...a, url: W.wikiUrl(a.path), snippet: highlight(a.lead, q) }));
  return { q, total, shown: Math.min(total, ids.length), results, exact, big, ms: performance.now() - t0 };
}

module.exports = { search, matchOf, highlight, STOP, BIG };
