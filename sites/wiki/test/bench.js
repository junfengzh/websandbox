#!/usr/bin/env node
'use strict';
// Latency benchmark against a running wiki server: article pages (uncached first pass over
// N random articles + the big task articles, then a cached pass), full-text search (task-like
// queries, title queries, common words), Go searches, autocomplete, What links here, page info;
// C concurrent clients spread over the tenants. Picks articles with a read-only DB connection.
//   node sites/wiki/test/bench.js [--base http://127.0.0.1:7500] [--tenants 2] [--concurrency 8] [--n 300] [--data DIR]
const { parseArgs } = require('node:util');
const path = require('node:path');
const Database = require(path.join(__dirname, '../../../kit/node_modules/better-sqlite3'));

const { values: a } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:7500' }, tenants: { type: 'string', default: '2' }, concurrency: { type: 'string', default: '8' }, n: { type: 'string', default: '300' }, data: { type: 'string', default: process.env.WSB_WIKI_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'wiki') } } });
const u = new URL(a.base);
const bases = Array.from({ length: +a.tenants }, (_, i) => `${u.protocol}//${u.hostname}:${+u.port + i}`);
const lat = {};
const rec = (k, ms) => (lat[k] = lat[k] || []).push(ms);

async function timed(kind, url) {
  const t0 = performance.now();
  const r = await fetch(url, { redirect: 'manual' });
  await r.arrayBuffer();
  rec(kind, performance.now() - t0);
  if (r.status >= 400 && r.status !== 404) throw new Error(`${r.status} ${url}`);
}

async function run(jobs) {
  let next = 0, n = 0;
  await Promise.all(Array.from({ length: +a.concurrency }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      try { await j(bases[(n++) % bases.length]); } catch (e) { console.error('error', e.message); }
    }
  }));
}

(async () => {
  const db = new Database(path.join(a.data, 'base.db'), { readonly: true });
  const max = db.prepare('SELECT max(id) FROM article').pluck().get();
  // deterministic sample (LCG), plus the largest task articles
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const ids = new Set();
  while (ids.size < +a.n) ids.add(1 + Math.floor(rnd() * max));
  const get = db.prepare('SELECT path, title FROM article WHERE id = ?');
  const arts = [...ids].map((id) => get.get(id)).filter(Boolean);
  const big = db.prepare("SELECT path, title FROM article WHERE reason LIKE 'task:%' ORDER BY html_len DESC LIMIT 20").all();
  const sizes = db.prepare('SELECT max(html_len) FROM article WHERE path IN (' + big.map(() => '?').join(',') + ')').pluck().get(...big.map((x) => x.path));
  const enc = (p) => '/wiki/' + encodeURIComponent(p).replace(/%2F/g, '/').replace(/%3A/g, ':');
  const queries = ['national park maine', 'longest bridge western hemisphere', 'where was mister rogers neighborhood filmed', 'flight 93 crash pennsylvania', 'the chair netflix series',
    'largest city in maine', 'nolan filmography', '76ers arena', 'knicks home arena', 'celtics arena', 'john nash mathematician', 'turing award university', 'stephen king birthplace',
    'inception film', 'mit computer science', 'spectrum arena philadelphia', 'yankee stadium 1923', 'chatham university', 'mackinac bridge length', 'acadia national park'];
  const common = ['united states', 'city', 'history of the world', 'film', 'music', 'john', 'new york', 'water', 'war', 'university of california'];
  const titleQ = arts.slice(0, 60).map((x) => x.title.split(/\s+/).slice(0, 2).join(' '));

  const t0 = performance.now();
  await run([...big, ...arts].map((x) => (b) => timed('article (uncached)', b + enc(x.path))));
  await run([...big, ...arts].map((x) => (b) => timed('article (cached)', b + enc(x.path))));
  await run(queries.map((q) => (b) => timed('search: task-like', `${b}/w/index.php?search=${encodeURIComponent(q)}&title=Special%3ASearch&fulltext=1`)));
  await run(titleQ.map((q) => (b) => timed('search: title words', `${b}/w/index.php?search=${encodeURIComponent(q)}&title=Special%3ASearch&fulltext=1`)));
  await run(common.map((q) => (b) => timed('search: common words', `${b}/w/index.php?search=${encodeURIComponent(q)}&title=Special%3ASearch&fulltext=1`)));
  await run(arts.slice(0, 80).map((x) => (b) => timed('search: go (exact title)', `${b}/w/index.php?search=${encodeURIComponent(x.title)}&title=Special%3ASearch&go=Go`)));
  await run(arts.slice(0, 80).flatMap((x) => [2, 4, 7].map((k) => (b) => timed('autocomplete', `${b}/w/api.php?action=opensearch&search=${encodeURIComponent(x.title.slice(0, k))}`))));
  await run([...big, ...arts.slice(0, 60)].map((x) => (b) => timed('what links here', b + '/wiki/Special:WhatLinksHere/' + enc(x.path).slice(6))));
  await run(arts.slice(0, 60).map((x) => (b) => timed('page info', `${b}/w/index.php?title=${encodeURIComponent(x.path)}&action=info`)));
  await run(Array.from({ length: 60 }, () => (b) => timed('random (302)', `${b}/wiki/Special:Random`)));
  const wall = performance.now() - t0;

  const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  console.log(`concurrency ${a.concurrency}, tenants ${a.tenants}, ${arts.length} random + ${big.length} largest task articles (max ${(sizes / 1024).toFixed(0)} KB HTML), wall ${(wall / 1000).toFixed(1)} s`);
  console.log('kind                       n   p50 ms   p95 ms   max ms');
  for (const [k, v] of Object.entries(lat)) console.log(`${k.padEnd(25)} ${String(v.length).padStart(3)} ${q(v, 0.5).toFixed(0).padStart(8)} ${q(v, 0.95).toFixed(0).padStart(8)} ${Math.max(...v).toFixed(0).padStart(8)}`);
  const st = await (await fetch(bases[0] + '/__wiki/stats')).json();
  console.log('server', JSON.stringify(st));
})();
