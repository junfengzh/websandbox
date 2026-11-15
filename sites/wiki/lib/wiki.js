'use strict';
// Wiki data access shared by all tenants of a process: article lookup (path, redirect,
// case variants), zstd decompression with the trained dictionary, rendered-body LRU,
// TOC, title suggestions, "did you mean" over title words, random article.
// The data is read-only (shared DB mode), so everything here is keyed by article id and
// shared across tenants; statements run on the request tenant's connection.
const { Decompressor } = require('zstd-napi');
const { editDistance } = require('../../../kit/lib/search');
const { escapeHtml } = require('../../../kit/lib/web');

const MAIN_PAGE = 'Main_Page';
const KIWIX_LANDING = 'User:The_other_Kiwix_guy/Landing';
const KIWIX_BOOK = 'wikipedia_en_all_maxi_2022-05';

// ---------------------------------------------------------------- small LRU (by bytes)
class LRU {
  constructor(maxBytes) { this.max = maxBytes; this.bytes = 0; this.m = new Map(); this.hits = 0; this.misses = 0; }
  get(k) {
    const v = this.m.get(k);
    if (v === undefined) { this.misses++; return undefined; }
    this.hits++;
    this.m.delete(k); this.m.set(k, v);
    return v;
  }
  set(k, v, size) {
    if (this.m.has(k)) { this.bytes -= this.m.get(k).size; this.m.delete(k); }
    this.m.set(k, { ...v, size });
    this.bytes += size;
    for (const [key, e] of this.m) {
      if (this.bytes <= this.max) break;
      this.m.delete(key); this.bytes -= e.size;
    }
  }
  stats() { return { entries: this.m.size, MB: +(this.bytes / 2 ** 20).toFixed(1), hits: this.hits, misses: this.misses }; }
}

// ---------------------------------------------------------------- titles and URLs
// Wikipedia-style URL for a path: keeps / : , ' ( ) ! readable, encodes the rest.
function wikiUrl(p, frag) {
  const enc = encodeURIComponent(p).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%27/g, "'")
    .replace(/%40/g, '@').replace(/%24/g, '$').replace(/%3B/g, ';');
  return '/wiki/' + enc + (frag ? '#' + encodeURIComponent(frag) : '');
}
const toPath = (t) => String(t || '').trim().replace(/[\s_]+/g, '_').replace(/^_+|_+$/g, '');
const ucfirst = (p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p);
// suggest.norm: lowercased, diacritics removed, _ -> space, whitespace collapsed
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- per-process state
let dz = null;
const cache = new LRU((+process.env.WSB_WIKI_CACHE_MB || 192) * 2 ** 20);
let vocab = null; // did-you-mean title vocabulary
let maxId = 0;

function decompressor(db) {
  if (!dz) {
    dz = new Decompressor();
    dz.loadDictionary(db.prepare('SELECT dict FROM zdict WHERE id = 1').pluck().get());
  }
  return dz;
}

const S = (t, sql) => t.sql(sql);
const COLS = 'id, path, title, html_len, text_len, lead, sections, infobox, image, inlinks, edited, oldid, reason';

function byPath(t, p) { return S(t, `SELECT ${COLS} FROM article WHERE path = ?`).get(p); }
function byId(t, id) { return S(t, `SELECT ${COLS} FROM article WHERE id = ?`).get(id); }
function redirectOf(t, p) { return S(t, 'SELECT path, title, target FROM redirect WHERE path = ?').get(p); }

// Resolve a requested path: {article} | {redirect, article} | {case: canonical path} | null
function resolve(t, p) {
  let a = byPath(t, p);
  if (a) return { article: a };
  const r = redirectOf(t, p);
  if (r) return { redirect: r, article: byId(t, r.target) };
  const u = ucfirst(p);
  if (u !== p) {
    a = byPath(t, u);
    if (a) return { article: a, alias: true };
    const r2 = redirectOf(t, u);
    if (r2) return { redirect: r2, article: byId(t, r2.target) };
  }
  return null;
}

// Exact title match for "Go" (search box): path / redirect / case-insensitive title.
function exactMatch(t, q) {
  const p = toPath(q);
  if (!p) return null;
  const r = resolve(t, p);
  if (r) return r.article;
  const n = norm(q);
  const s = S(t, 'SELECT target FROM suggest WHERE norm = ? ORDER BY score DESC LIMIT 1').get(n);
  return s ? byId(t, s.target) : null;
}

// ---------------------------------------------------------------- rendering
// Find the end of the element that starts at `start` (tag `tag`), honouring nesting.
function elementEnd(html, start, tag) {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

function tocHtml(sections) {
  if (!sections || sections.length < 4) return '';
  // MediaWiki numbering: a deeper heading opens one TOC level whatever the jump (h2 -> h4 is x.1)
  let out = '<div id="toc" class="toc" role="navigation" aria-labelledby="mw-toc-heading">'
    + '<input type="checkbox" role="button" id="toctogglecheckbox" class="toctogglecheckbox" style="display:none">'
    + '<div class="toctitle" lang="en" dir="ltr"><h2 id="mw-toc-heading">Contents</h2>'
    + '<span class="toctogglespan"><label class="toctogglelabel" for="toctogglecheckbox"></label></span></div><ul>';
  const stack = []; // heading levels of the open TOC levels
  const nums = [];
  for (const [lvl, anchor, heading] of sections) {
    if (!stack.length) { stack.push(lvl); nums.push(0); }
    else if (lvl > stack[stack.length - 1]) { stack.push(lvl); nums.push(0); out += '<ul>'; }
    else {
      out += '</li>';
      while (stack.length > 1 && lvl < stack[stack.length - 1] && lvl <= stack[stack.length - 2]) { stack.pop(); nums.pop(); out += '</ul></li>'; }
      if (lvl < stack[stack.length - 1]) stack[stack.length - 1] = lvl;
    }
    nums[nums.length - 1]++;
    out += `<li class="toclevel-${stack.length}"><a href="#${escapeHtml(encodeURIComponent(anchor).replace(/%3A/g, ':'))}"><span class="tocnumber">${nums.join('.')}</span> <span class="toctext">${escapeHtml(heading)}</span></a>`;
  }
  out += '</li>';
  for (let i = 1; i < stack.length; i++) out += '</ul></li>';
  return out + '</ul></div>';
}

// The Kiwix landing page lists topics as plain <span>s (its links were not in the
// mwoffliner output we kept); link the ones that are articles here.
function linkLanding(t, html) {
  return html.replace(/<span>([^<]{2,80})<\/span>/g, (m, text) => {
    const a = exactMatch(t, text.trim());
    return a ? `<a href="${escapeHtml(wikiUrl(a.path))}" title="${escapeHtml(a.title)}">${text}</a>` : m;
  });
}

// Article body HTML ready for the page: infobox moved to the top of the lead (desktop
// Wikipedia order), TOC before the first section heading, alt/lazy on images.
function body(t, a) {
  const hit = cache.get(a.id);
  if (hit) return hit;
  let html = decompressor(t.db).decompress(S(t, 'SELECT html FROM article WHERE id = ?').pluck().get(a.id)).toString('utf8');
  if (a.path === KIWIX_LANDING) html = linkLanding(t, html);
  const h2 = html.search(/<h2[\s>]/);
  const lead = h2 < 0 ? html.length : h2;
  const ib = html.search(/<table class="infobox[\s"]/);
  if (ib > 0 && ib < lead) {
    const end = elementEnd(html, ib, 'table');
    const open = html.indexOf('>', html.indexOf('<div class="mw-parser-output"')) + 1;
    if (end > ib && open > 0 && open <= ib) html = html.slice(0, open) + html.slice(ib, end) + html.slice(open, ib) + html.slice(end);
  }
  const toc = tocHtml(a.sections ? JSON.parse(a.sections) : []);
  if (toc) {
    const at = html.search(/<h2[\s>]/);
    if (at > 0) html = html.slice(0, at) + toc + html.slice(at);
  }
  html = html.replace(/<img (?![^>]*\balt=)/g, '<img alt="" ').replace(/<img (?![^>]*\bloading=)/g, '<img loading="lazy" decoding="async" ');
  const v = { html };
  cache.set(a.id, v, html.length * 2);
  return cache.get(a.id);
}

// Counts for the page-information page (from the rendered HTML).
function outgoing(html) {
  const links = new Set();
  for (const m of html.matchAll(/href="\/wiki\/([^"#?]+)/g)) links.add(m[1]);
  const red = new Set();
  for (const m of html.matchAll(/<span class="new" title="([^"]*)"/g)) red.add(m[1]);
  return { links: links.size, red: red.size, images: (html.match(/<img /g) || []).length, external: (html.match(/class="external/g) || []).length };
}

// ---------------------------------------------------------------- suggestions
function suggest(t, q, limit = 10) {
  const n = norm(q);
  if (!n) return [];
  let rows;
  if (n.length <= 3) {
    const r = S(t, 'SELECT items FROM suggest_top WHERE prefix = ?').pluck().get(n);
    rows = r ? JSON.parse(r).map(([title, target]) => ({ title, target })) : [];
  } else {
    rows = S(t, 'SELECT title, target FROM suggest WHERE norm >= ? AND norm < ? ORDER BY score DESC LIMIT 30').all(n, n + '\u{10FFFF}');
  }
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (seen.has(r.target)) continue;
    seen.add(r.target);
    const a = S(t, 'SELECT id, path, title, image FROM article WHERE id = ?').get(r.target);
    if (a) out.push({ title: r.title, article: a });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- did you mean
// Vocabulary: words of article titles, weighted by the articles' in-links (built once per
// process, ~0.3 s). Candidates share the first letter; kit's edit distance (<=1 for short
// words, <=2) ranks by distance, then weight. Only words FTS does not know are replaced.
function buildVocab(db) {
  const w = new Map();
  for (const r of db.prepare('SELECT title, inlinks FROM article').iterate()) {
    for (const x of norm(r.title).match(/[\p{L}\p{N}]+/gu) || []) w.set(x, (w.get(x) || 0) + 1 + Math.log1p(r.inlinks));
  }
  const byFirst = new Map();
  for (const [x, wt] of w) {
    const k = x[0];
    if (!byFirst.has(k)) byFirst.set(k, []);
    byFirst.get(k).push([x, wt]);
  }
  return { w, byFirst };
}

function warm(db) { if (!vocab) vocab = buildVocab(db); }
function didYouMean(t, q) {
  if (!vocab) vocab = buildVocab(t.db);
  const hits = S(t, 'SELECT count(*) FROM (SELECT 1 FROM article_fts WHERE article_fts MATCH ? LIMIT 5)').pluck();
  const words = norm(q).match(/[\p{L}\p{N}]+/gu) || [];
  let changed = false;
  const out = words.map((w) => {
    if (/^\d+$/.test(w) || w.length < 3 || vocab.w.has(w) || hits.get(`"${w}"`) >= 5) return w;
    const max = w.length <= 4 ? 1 : 2;
    let best = null;
    for (const [x, wt] of vocab.byFirst.get(w[0]) || []) {
      if (Math.abs(x.length - w.length) > max) continue;
      const d = editDistance(w, x, max);
      if (d <= max && (!best || d < best.d || (d === best.d && wt > best.wt))) best = { x, d, wt };
    }
    if (best) { changed = true; return best.x; }
    return w;
  });
  return changed ? out.join(' ') : null;
}

// ---------------------------------------------------------------- random
function random(t) {
  if (!maxId) maxId = S(t, 'SELECT max(id) FROM article').pluck().get();
  for (let i = 0; i < 20; i++) {
    const a = S(t, 'SELECT id, path FROM article WHERE id >= ? ORDER BY id LIMIT 1').get(1 + Math.floor(Math.random() * maxId));
    if (a && a.path !== MAIN_PAGE && a.path !== KIWIX_LANDING) return a;
  }
  return byPath(t, MAIN_PAGE);
}

module.exports = {
  LRU, cache, wikiUrl, toPath, ucfirst, norm, resolve, exactMatch, byPath, byId, redirectOf,
  body, tocHtml, outgoing, suggest, didYouMean, warm, random, elementEnd,
  MAIN_PAGE, KIWIX_LANDING, KIWIX_BOOK,
};
