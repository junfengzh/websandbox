#!/usr/bin/env node
// Verify base.db + media/ with the runtime stack (Node, better-sqlite3, zstd-napi).
//   node verify.js [/path/to/data/wiki]
// Checks: every task article present (directly or via redirect) and renders
// (decompresses, contains the facts the task answer is read from, all its
// /wiki/ links resolve, all its images exist on disk); redirect resolution;
// FTS sample queries; title suggestions; DB + media size.
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Decompressor } = require('zstd-napi');

const dir = process.argv[2] || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'wiki');
const db = new Database(path.join(dir, 'base.db'), { readonly: true });
const dict = db.prepare('select dict from zdict where id=1').get().dict;
const dz = new Decompressor();
dz.loadDictionary(dict);
const tasks = JSON.parse(fs.readFileSync(path.join(__dirname, 'task_articles.json'), 'utf8'));

let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg); } return cond; };

const byPath = db.prepare('select * from article where path=?');
const redir = db.prepare('select target from redirect where path=?');
const byId = db.prepare('select * from article where id=?');
function lookup(p) {
  let a = byPath.get(p);
  if (a) return a;
  const r = redir.get(p);
  return r ? byId.get(r.target) : null;
}
function raw(a) { return dz.decompress(a.html); }
function render(a) { return raw(a).toString('utf8'); }
const textOf = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ');

// 1. task articles
const linkCheck = db.prepare('select 1 from article where path=?');
let nTask = 0, nLinks = 0, nImgs = 0;
for (const g of tasks.groups) {
  for (const p of g.core) {
    const a = lookup(p);
    if (!ok(a, `task ${g.tasks} article missing: ${p}`)) continue;
    nTask++;
    const buf = raw(a);
    const h = buf.toString('utf8');
    ok(buf.length === a.html_len, `html_len mismatch ${p}`);
    ok(!h.includes('../I/') && !h.includes('<script'), `unclean html ${p}`);
    for (const m of h.matchAll(/href="\/wiki\/([^"#]+)/g)) {
      nLinks++;
      ok(linkCheck.get(decodeURIComponent(m[1])), `${p}: dangling link ${m[1]}`);
    }
    for (const m of h.matchAll(/src="(\/media\/[^"]+)"/g)) {
      nImgs++;
      ok(fs.existsSync(path.join(dir, m[1])), `${p}: missing image ${m[1]}`);
    }
  }
  for (const [p, facts] of Object.entries(g.facts || {})) {
    const a = lookup(p);
    if (!a) continue;
    const t = textOf(render(a));
    for (const f of facts) ok(t.includes(f), `task ${g.tasks}: "${f}" not in ${p}`);
  }
}
console.log(`task articles ok: ${nTask}, links checked ${nLinks}, images checked ${nImgs}`);

// 2. redirects
const redirects = {
  'Mr._Rogers': 'Fred_Rogers', 'Christopher_nolan': 'Christopher_Nolan', 'Mackinac_bridge': 'Mackinac_Bridge',
  'The_Chair_(Netflix_series)': 'The_Chair_(2021_TV_series)', 'Flight_93': 'United_Airlines_Flight_93',
  'MIT': 'Massachusetts_Institute_of_Technology', 'John_Forbes_Nash': 'John_Forbes_Nash_Jr.',
  '76ers': 'Philadelphia_76ers', 'The_Spectrum_(arena)': 'Spectrum_(arena)', 'NYC': 'New_York_City',
};
for (const [from, to] of Object.entries(redirects)) {
  const a = lookup(from);
  ok(a && a.path === to, `redirect ${from} -> ${a ? a.path : null}, expected ${to}`);
}
console.log('redirect count', db.prepare('select count(*) n from redirect').get().n);

// 3. FTS
// recommended ranking: bm25 with title weight 50, minus 0.3 * ln(1 + in-links) (see SCHEMA.md)
const fts = db.prepare(`select a.path, bm25(article_fts, 50.0, 1.0) - 0.3 * ln(1 + a.inlinks) s
  from article_fts f join article a on a.id=f.rowid where article_fts match ? order by s limit 5`);
const queries = [
  ['christopher nolan', 'Christopher_Nolan'], ['acadia national park', 'Acadia_National_Park'],
  ['turing award', 'Turing_Award'], ['nash equilibrium', 'Nash_equilibrium'],
  ['flight 93', 'United_Airlines_Flight_93'], ['mister rogers neighborhood', "Mister_Rogers'_Neighborhood"],
  ['philadelphia 76ers', 'Philadelphia_76ers'], ['mackinac bridge', 'Mackinac_Bridge'],
  ['stephen king', 'Stephen_King'], ['yankee stadium', 'Yankee_Stadium'],
  ['"suspension bridge" michigan', 'Mackinac_Bridge'], ['carnegie mellon', 'Carnegie_Mellon_University'],
];
for (const [q, want] of queries) {
  const t = process.hrtime.bigint();
  const rows = fts.all(q);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const got = rows.map((r) => r.path);
  ok(got.includes(want), `fts "${q}" top5 ${JSON.stringify(got)} lacks ${want}`);
  console.log(`fts "${q}" ${ms.toFixed(1)}ms -> ${got.slice(0, 3).join(' | ')}`);
}

// 4. suggestions
const topq = db.prepare('select items from suggest_top where prefix=?');
const sugq = db.prepare('select title, target from suggest where norm >= ? and norm < ? order by score desc limit 10');
function suggest(q) {
  const n = q.toLowerCase();
  if (n.length <= 3) { const r = topq.get(n); return r ? JSON.parse(r.items).map((x) => x[0]) : []; }
  return sugq.all(n, n + '￿').map((r) => r.title);
}
for (const [q, want] of [['chri', 'Christianity'], ['christopher n', 'Christopher Nolan'], ['acadia n', 'Acadia National Park'], ['bos', 'Boston'], ['mackinac b', 'Mackinac Bridge'], ['the chair', 'The Chair (2021 TV series)']]) {
  const s = suggest(q);
  ok(s.includes(want), `suggest "${q}" -> ${JSON.stringify(s)}`);
  console.log(`suggest "${q}" -> ${s.slice(0, 5).join(' | ')}`);
}

// 5. random render sample
const n = db.prepare('select count(*) n from article').get().n;
let bad = 0;
for (let i = 0; i < 300; i++) {
  const a = byId.get(1 + Math.floor(Math.random() * n));
  const buf = raw(a);
  if (!buf.toString('utf8').startsWith('<div class="mw-parser-output">') || buf.length !== a.html_len) bad++;
}
ok(bad === 0, `random render sample: ${bad} bad`);

// 6. sizes
const dbBytes = fs.statSync(path.join(dir, 'base.db')).size;
let mediaBytes = 0, mediaFiles = 0;
const mdir = path.join(dir, 'media');
if (fs.existsSync(mdir)) for (const d of fs.readdirSync(mdir)) for (const f of fs.readdirSync(path.join(mdir, d))) {
  mediaFiles++; mediaBytes += fs.statSync(path.join(mdir, d, f)).size;
}
console.log(`articles ${n}; base.db ${(dbBytes / 1e9).toFixed(2)} GB; media ${mediaFiles} files ${(mediaBytes / 1e9).toFixed(2)} GB; total ${((dbBytes + mediaBytes) / 1e9).toFixed(2)} GB`);
ok(dbBytes + mediaBytes <= 4.0e9, 'total size over 4 GB');
console.log(fails ? `${fails} FAILURES` : 'ALL OK');
process.exit(fails ? 1 : 0);
