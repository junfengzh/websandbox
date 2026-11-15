#!/usr/bin/env node
'use strict';
// Single-client page latency over representative forum pages (anonymous and logged in).
//   node sites/forum/test/bench.js [--base http://127.0.0.1:7200] [--rounds 10]
// Prints p50/p95/max per page and overall (seconds -> ms). Run on a started server; the first
// round warms the page cache and is not counted.
const { parseArgs } = require('node:util');
const { values: a } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:7200' }, rounds: { type: 'string', default: '10' } } });
const BASE = a.base.replace(/\/$/, '');

const PAGES = [
  '/', '/new', '/active', '/top', '/top?t=week', '/all/controversial', '/most_commented?t=year', '/?page=40',
  '/f/AskReddit', '/f/AskReddit/new?page=20', '/f/books/top', '/f/DIY/active', '/f/news/top?t=month', '/f/pics',
  '/f/books/59421/friendly-reminder-bookshop-org-exists', '/f/books/59421/-/comment/1235250', '/f/Pennsylvania/36068/-', '/user/%5Bdeleted%5D',
  '/forums', '/forums/submissions', '/forums/all', '/forums/by_category', '/tag/technology',
  '/user/MarvelsGrantMan136', '/user/MarvelsGrantMan136/submissions', '/user/MarvelsGrantMan136/comments', '/user/AutoModerator',
  '/search?q=bookshop', '/search?q=the', '/search?q=good+book&sort=top', '/search?q=the&type=comments', '/search?q=nvidia&type=comments&f=MachineLearning',
  '/search?q=tech&type=forums', '/search?q=marvel&type=users', '/comments', '/f/books/comments', '/moderation_log', '/users?page=100', '/wiki/_all',
];
const AUTH = ['/', '/subscribed', '/submit', '/notifications', '/messages', '/user/MarvelsGrantMan136/preferences', '/f/books', '/f/books/59421/-'];

const pct = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };

(async () => {
  const login = await (await fetch(BASE + '/__rl/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'MarvelsGrantMan136' }) })).json();
  const cookie = `${login.cookie.name}=${login.cookie.value}`;
  const jobs = [...PAGES.map((p) => [p, null]), ...AUTH.map((p) => [p, cookie])];
  const times = new Map(jobs.map(([p, c]) => [(c ? '[auth] ' : '') + p, []]));
  const rounds = +a.rounds;
  for (let r = 0; r <= rounds; r++) {
    for (const [p, c] of jobs) {
      const t0 = performance.now();
      const res = await fetch(BASE + p, { headers: c ? { cookie: c } : {}, redirect: 'manual' });
      await res.arrayBuffer();
      const ms = performance.now() - t0;
      if (res.status >= 400) throw new Error(`${p}: HTTP ${res.status}`);
      if (r > 0) times.get((c ? '[auth] ' : '') + p).push(ms);
    }
  }
  const all = [];
  const rows = [...times].map(([k, v]) => { all.push(...v); return { page: k, p50: pct(v, 50), p95: pct(v, 95), max: Math.max(...v) }; }).sort((x, y) => y.p95 - x.p95);
  for (const r of rows) console.log(`${r.p50.toFixed(1).padStart(7)} ${r.p95.toFixed(1).padStart(7)} ${r.max.toFixed(1).padStart(7)}  ${r.page}`);
  console.log(`\nall pages (${all.length} requests, ${rows.length} pages x ${rounds} rounds): p50 ${pct(all, 50).toFixed(1)} ms, p95 ${pct(all, 95).toFixed(1)} ms, p99 ${pct(all, 99).toFixed(1)} ms, max ${Math.max(...all).toFixed(1)} ms`);
})().catch((e) => { console.error(e); process.exit(1); });
