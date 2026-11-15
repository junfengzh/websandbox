#!/usr/bin/env node
'use strict';
// Full-stack load benchmark (docs/BENCH-FULL.md): N concurrent simulated agent rollouts over all
// sites started by `sites.sh up --bind rl` (one tenant per rollout, from a pool per site process).
// A rollout = a random task of tasks/splits/{train,heldout}.jsonl: control-API login as the task's
// login_user, GET its start URL, then 8-20 steps like a browser-driving agent (click a random
// same-origin link, submit a search form with words of the intent, go back; write tasks also
// submit up to 3 allowlisted POST forms: comments, notes, add to cart, wishlist, admin "save"),
// each page with its same-origin subresources (CSS/JS/images; map tiles of the view), cached per
// rollout like a browser. Think time between steps; at the end POST /__rl/reset of the tenant.
//
//   node tasks/tools/bench-full.js [--base 7700] [--port 80] [--tenants 16] [--rollouts 32]
//        [--seconds 300] [--think 1000-3000 | 0] [--procs 4] [--state $WSB_TMP/wsb-sites/<base>] [--out FILE.json]
//
// Prints a JSON summary (per site: document / asset / write / search latency p50/p95/p99, reset
// latency client + server side, rollouts, peak RSS / PSS / anonymous PSS per site process group, sampled every 5 s).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseArgs } = require('node:util');

const { values: a } = parseArgs({ options: {
  base: { type: 'string', default: '7700' }, port: { type: 'string', default: '80' }, tenants: { type: 'string', default: '16' },
  rollouts: { type: 'string', default: '32' }, seconds: { type: 'string', default: '300' }, think: { type: 'string', default: '1000-3000' },
  state: { type: 'string' }, out: { type: 'string' }, seed: { type: 'string', default: '1' }, stride: { type: 'string', default: '10' },
  procs: { type: 'string', default: '4' }, child: { type: 'string' },
} });
const ROOT = path.join(__dirname, '..', '..');
const BASE = +a.base, PORT = +a.port, NT = +a.tenants, NR = +a.rollouts, STRIDE = +a.stride;
const [TMIN, TMAX] = a.think.includes('-') ? a.think.split('-').map(Number) : [+a.think, +a.think];
const STATE = a.state || path.join((process.env.WSB_TMP || require('os').tmpdir()), 'wsb-sites', String(BASE));

let seed = +a.seed;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// task site -> process (pool) + host octet
const SITES = { shopping: ['store', 2], shopping_admin: ['store', 3], forum: ['forum', 4], gitlab: ['code', 5], wiki: ['wiki', 6], map: ['map', 7] };
const PIDX = { store: 0, forum: 1, code: 2, wiki: 3, map: 4 };
// control API on the tenant's own address: with --workers > 1 the 127.0.0.1 listener (worker 0) serves only its tenants
const PROC_OCTET = { store: 2, forum: 4, code: 5, wiki: 6, map: 7 };
const ctlUrl = (proc, i) => `http://127.10.${i}.${PROC_OCTET[proc]}${PORT === 80 ? '' : ':' + PORT}`;
const host = (site, i) => `127.10.${i}.${SITES[site][1]}${PORT === 80 ? '' : ':' + PORT}`;
const WRITE_FORMS = {
  shopping: /checkout\/cart\/add|wishlist\/index\/add|review\/product\/post/,
  shopping_admin: /\/save\/?($|\?|id\/)/,
  forum: /\/comment$/,
  gitlab: /\/notes$|\/-\/issues$/,
  wiki: null, map: null,
};
// pages that carry those forms: write rollouts click these links first half of the time
const WRITE_PAGES = { shopping: /\.html$|\/catalog\/product\/view\//, shopping_admin: /\/edit\/id\/\d+\/?$/, forum: /^\/f\/[^/]+\/\d+/, gitlab: /\/-\/(issues|merge_requests)\/\d+$|\/-\/issues\/new$/ };
const SKIP_LINK = /logout|sign_out|signout|\/__rl|delete|remove|destroy|\/raw\/|archive\.|download|mailto:|javascript:|\.(zip|gz|tar|png|jpe?g|gif|webp|svg|ico|css|js|pdf|patch|diff|atom|rss|json)(\?|$)/i;
const STOP = new Set('the and for with that this from what which have your will into about there their them they show tell list find give most many much how does when where who whom whose than then also only each every some any make made like over under between more less'.split(' '));

const tasks = [];
for (const f of ['train.jsonl', 'heldout.jsonl']) for (const l of fs.readFileSync(path.join(ROOT, 'tasks/splits', f), 'utf8').split('\n')) {
  if (!l.trim()) continue; const t = JSON.parse(l);
  if (!SITES[t.site] || typeof t.start_url !== 'string') continue;
  t.write = JSON.stringify(t.eval && t.eval.type).includes('state');
  tasks.push(t);
}
// One client process cannot drive the no-think load (HTML parsing + 600 req/s saturate its event loop and
// inflate every latency): --procs P client processes, child j runs rollouts j, j+P, ... on tenants i % P == j.
const NP = +a.procs; const CHILD = a.child != null ? +a.child : null;
const pools = Object.fromEntries(Object.keys(PIDX).map((p) => [p, [...Array(NT).keys()].filter((i) => CHILD == null || i % NP === CHILD)]));
if (CHILD != null) seed = +a.seed * 1000 + CHILD;
const rec = []; // {site, kind, ms, status}
const resets = []; // {site, proc, client, server, writes}
let rolloutsDone = 0, errors = 0;
const errSamples = [];

function absUrl(href, cur) {
  try { const u = new URL(href.replace(/&amp;/g, '&'), cur); u.hash = ''; return u; } catch { return null; }
}
const attrs = (tag) => { const o = {}; for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) o[m[1].toLowerCase()] = (m[3] ?? m[4] ?? m[5] ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); return o; };
function forms(html) {
  const out = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const f = attrs(m[1]); const fields = [];
    for (const t of m[2].matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
      const at = attrs(t[2]); if (!at.name) continue;
      const tag = t[1].toLowerCase();
      if (tag === 'select') {
        const body = m[2].slice(t.index).split(/<\/select>/i)[0];
        const opts = [...body.matchAll(/<option\b([^>]*)>/gi)].map((o) => attrs(o[1]));
        const sel = opts.find((o) => 'selected' in o) || opts[0];
        fields.push({ name: at.name, type: 'select', value: sel ? sel.value ?? '' : '' });
      } else fields.push({ name: at.name, type: tag === 'textarea' ? 'textarea' : (at.type || 'text').toLowerCase(), value: at.value ?? '', checked: 'checked' in at });
    }
    out.push({ action: f.action, method: (f.method || 'get').toLowerCase(), enctype: f.enctype || '', fields });
  }
  return out;
}
const words = (t) => { const w = String(t.intent).toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || ['test']; const ws = w.filter((x) => !STOP.has(x)); return ws.length ? ws : w; };

function lonlatTile(lon, lat, z) {
  const n = 2 ** z; const x = Math.floor((lon + 180) / 360 * n);
  const r = lat * Math.PI / 180; const y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  return [x, y];
}

class Browser {
  constructor(site) { this.site = site; this.jar = new Map(); this.cache = new Set(); }
  async req(method, url, { body, headers = {}, kind = 'doc', record = true } = {}) {
    let u = url; let ms = 0; let r; let hops = 0;
    for (;;) {
      const h = { ...headers, 'user-agent': 'wsb-bench' };
      if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const t0 = performance.now();
      r = await fetch(u, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await r.arrayBuffer());
      ms += performance.now() - t0;
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (!v || /01 Jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v); }
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc && hops++ < 5) {
        if (record) rec.push({ site: this.site, kind: method === 'POST' ? 'write' : kind, ms, status: r.status, url: u }); ms = 0;
        u = new URL(loc, u).href; method = 'GET'; body = undefined; headers = {}; kind = 'doc'; continue;
      }
      if (record) rec.push({ site: this.site, kind: method === 'POST' ? 'write' : kind, ms, status: r.status, url: u });
      if (r.status >= 500) { errors++; if (errSamples.length < 30) errSamples.push(`${r.status} ${method} ${u}`); }
      return { status: r.status, url: u, text: (r.headers.get('content-type') || '').includes('html') ? buf.toString('utf8') : '' };
    }
  }
  async page(method, url, opts = {}) {
    const p = await this.req(method, url, opts);
    await this.assets(p);
    return p;
  }
  async assets(p) {
    if (!p.text) return;
    const cur = new URL(p.url); const urls = [];
    for (const m of p.text.matchAll(/<(link|script|img)\b([^>]*)>/gi)) {
      const at = attrs(m[2]); const tag = m[1].toLowerCase();
      const href = tag === 'link' ? (/stylesheet|icon/.test(at.rel || '') ? at.href : null) : at.src;
      if (!href || href.startsWith('data:')) continue;
      const u = absUrl(href, cur); if (!u || u.host !== cur.host) continue;
      if (!this.cache.has(u.href)) { this.cache.add(u.href); urls.push(u.href); }
    }
    if (this.site === 'map') { // MapLibre: style + the tiles of the view (z, lat, lon from #map=... or the default)
      const m = /#map=(\d+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(this.view || '') || [null, 13, 40.4443, -79.9436];
      const z = Math.min(+m[1], 14); const [x, y] = lonlatTile(+m[3], +m[2], z);
      for (const u of [`/style.json`, ...[-1, 0, 1].flatMap((dy) => [-2, -1, 0, 1].map((dx) => `/tiles/${z}/${x + dx}/${y + dy}.pbf`))]) {
        const h = new URL(u, cur).href; if (!this.cache.has(h)) { this.cache.add(h); urls.push(h); }
      }
    }
    let i = 0; // 6 connections per host, like Chrome
    await Promise.all([...Array(Math.min(6, urls.length)).keys()].map(async () => { while (i < urls.length) { const u = urls[i++]; try { await this.req('GET', u, { kind: 'asset' }); } catch { errors++; } } }));
  }
}

async function rollout(n) {
  // a task whose site process has a free tenant
  let t, proc, ten;
  for (let k = 0; k < 100; k++) { t = pick(tasks); proc = SITES[t.site][0]; if (pools[proc].length) break; t = null; }
  if (!t) { await sleep(200); return; }
  ten = pools[proc].splice(Math.floor(rnd() * pools[proc].length), 1)[0];
  const b = new Browser(t.site); const origin = `http://${host(t.site, ten)}`;
  let writes = 0;
  try {
    if (t.require_login && t.login_user) {
      const user = typeof t.login_user === 'string' ? t.login_user : null;
      if (user) {
        const r = await fetch(`${ctlUrl(proc, ten)}/__rl/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wsb-tenant': String(ten) }, body: JSON.stringify({ user }) });
        const j = await r.json(); if (j.cookie) b.jar.set(j.cookie.name, j.cookie.value);
      }
    }
    const start = t.start_url.replace(/__[A-Z_]+__/, origin);
    b.view = start;
    let p = await b.page('GET', start);
    const hist = [p.url];
    const steps = 8 + Math.floor(rnd() * 13);
    const ws = words(t);
    for (let s = 0; s < steps && !stop; s++) {
      if (TMAX > 0) await sleep(TMIN + rnd() * (TMAX - TMIN));
      const fs_ = p.text ? forms(p.text) : [];
      const cur = new URL(p.url);
      const csrf = (/<meta name="csrf-token" content="([^"]+)"/.exec(p.text || '') || [])[1];
      const wre = WRITE_FORMS[t.site];
      const wf = t.write && wre && writes < 3 && s >= 2 ? fs_.filter((f) => f.method === 'post' && f.action && wre.test(new URL(f.action, cur).pathname) && !f.fields.some((x) => x.type === 'file')) : [];
      const sf = fs_.filter((f) => f.method === 'get' && f.fields.some((x) => ['text', 'search'].includes(x.type)));
      const r = rnd();
      if (wf.length && r < 0.4) {
        const f = pick(wf); const body = new URLSearchParams();
        for (const x of f.fields) {
          if ((x.type === 'checkbox' || x.type === 'radio') && !x.checked) continue;
          if (x.type === 'submit' || x.type === 'button') continue;
          let v = x.value;
          if (!v && (x.type === 'textarea' || x.type === 'text')) v = `Benchmark note ${n}.${s}`;
          body.append(x.name, v);
        }
        if (csrf && !body.has('_csrf')) body.append('_csrf', csrf);
        p = await b.page('POST', new URL(f.action, cur).href, { body: body.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        writes++;
      } else if (sf.length && r < (wf.length ? 0.55 : 0.2)) {
        const f = pick(sf); const u = new URL(f.action || cur.pathname, cur); let filled = 0;
        for (const x of f.fields) {
          if ((x.type === 'checkbox' || x.type === 'radio') && !x.checked) continue;
          if (x.type === 'submit' || x.type === 'button') continue;
          let v = x.value;
          if (['text', 'search'].includes(x.type) && (!v || filled === 0)) { v = [pick(ws), rnd() < 0.5 ? pick(ws) : ''].join(' ').trim(); filled++; }
          u.searchParams.append(x.name, v);
        }
        p = await b.page('GET', u.href, { kind: 'search' });
      } else if (hist.length > 1 && r < (wf.length ? 0.65 : 0.3)) {
        hist.pop(); p = await b.page('GET', hist[hist.length - 1]);
      } else {
        const links = [];
        for (const m of (p.text || '').matchAll(/<a\b([^>]*)>/gi)) {
          const at = attrs(m[1]); if (!at.href || at.href.startsWith('#') || SKIP_LINK.test(at.href)) continue;
          const u = absUrl(at.href, cur); if (u && u.host === cur.host && u.href !== cur.href) links.push(u.href);
        }
        if (!links.length) { p = await b.page('GET', hist[0]); continue; }
        const wl = t.write && WRITE_PAGES[t.site] ? links.filter((l) => WRITE_PAGES[t.site].test(new URL(l).pathname)) : [];
        p = await b.page('GET', pick(wl.length && rnd() < 0.5 ? wl : links));
      }
      if (p.status < 400) hist.push(p.url);
    }
  } catch (e) { errors++; if (errSamples.length < 30) errSamples.push(`${t.id}: ${e.message}`); }
  finally {
    const t0 = performance.now();
    try {
      const r = await fetch(`${ctlUrl(proc, ten)}/__rl/reset`, { method: 'POST', headers: { 'x-wsb-tenant': String(ten) } });
      const j = await r.json();
      resets.push({ site: t.site, proc, client: performance.now() - t0, server: j.ms, writes });
    } catch (e) { errors++; }
    pools[proc].push(ten); rolloutsDone++;
  }
}

// RSS of every site process (pid files of sites.sh = process-group leaders; workers share the group)
function rssByProc() {
  const out = {}; const groups = {};
  for (const p of Object.keys(PIDX)) { try { groups[fs.readFileSync(path.join(STATE, p + '.pid'), 'utf8').trim()] = p; } catch {} }
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
      const proc = groups[f[2]]; if (!proc) continue; // pgrp
      // PSS: shared file pages (SQLite mmap / page cache of base.db, shared by worker processes) split between sharers
      const sm = fs.readFileSync(`/proc/${d}/smaps_rollup`, 'utf8');
      const kb = (k) => +((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(sm) || [])[1] || 0) * 1024;
      const o = out[proc] = out[proc] || { rss: 0, pss: 0, anon: 0, procs: 0 };
      o.rss += +f[21] * 4096; o.pss += kb('Pss'); o.anon += kb('Pss_Anon'); o.procs++;
    } catch {}
  }
  return out;
}

const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10; };
const stats = (xs) => ({ n: xs.length, p50: q(xs, 0.5), p95: q(xs, 0.95), p99: q(xs, 0.99), max: q(xs, 1) });

let stop = false;
async function runRollouts(nr) {
  setTimeout(() => { stop = true; }, +a.seconds * 1000);
  let n = 0;
  await Promise.all([...Array(nr).keys()].map(async () => { while (!stop) await rollout(n++); }));
}
if (CHILD != null) {
  const nr = Math.floor(NR / NP) + (CHILD < NR % NP ? 1 : 0);
  runRollouts(nr).then(() => { fs.writeFileSync(a.out, JSON.stringify({ rec, resets, rolloutsDone, errors, errSamples })); process.exit(0); });
} else (async () => {
  const t0 = Date.now(); const rss = []; let peak = {};
  const iv = setInterval(() => {
    const r = rssByProc(); rss.push(r);
    for (const [k, v] of Object.entries(r)) { const p = peak[k] = peak[k] || { rss: 0, pss: 0, anon: 0, procs: 0 }; for (const f of Object.keys(p)) p[f] = Math.max(p[f], v[f]); }
  }, 5000);
  if (NP > 1) {
    const { spawn } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join((process.env.WSB_TMP || require('os').tmpdir()), 'wsb-bench-'));
    const outs = await Promise.all([...Array(NP).keys()].map((j) => new Promise((res, rej) => {
      const f = path.join(dir, `c${j}.json`);
      const args = process.argv.slice(2).filter((x, i, xs) => x !== '--out' && xs[i - 1] !== '--out');
      const c = spawn(process.execPath, [__filename, ...args, '--child', String(j), '--out', f], { stdio: ['ignore', 'inherit', 'inherit'] });
      c.on('exit', (code) => (code ? rej(new Error(`client ${j} exited ${code}`)) : res(JSON.parse(fs.readFileSync(f, 'utf8')))));
    })));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const o of outs) { rec.push(...o.rec); resets.push(...o.resets); rolloutsDone += o.rolloutsDone; errors += o.errors; errSamples.push(...o.errSamples); }
  } else await runRollouts(NR);
  clearInterval(iv);
  const secs = (Date.now() - t0) / 1000;
  const sites = {};
  for (const s of Object.keys(SITES)) {
    const r = rec.filter((x) => x.site === s);
    if (!r.length) continue;
    sites[s] = { doc: stats(r.filter((x) => x.kind === 'doc').map((x) => x.ms)), search: stats(r.filter((x) => x.kind === 'search').map((x) => x.ms)),
      write: stats(r.filter((x) => x.kind === 'write').map((x) => x.ms)), asset: stats(r.filter((x) => x.kind === 'asset').map((x) => x.ms)),
      status5xx: r.filter((x) => x.status >= 500).length,
      slowest: [...r].sort((x, y) => y.ms - x.ms).slice(0, 12).map((x) => `${Math.round(x.ms)} ${x.kind} ${x.status} ${x.url.replace(/^http:\/\/[^/]+/, '')}`),
      resetClient: stats(resets.filter((x) => x.site === s).map((x) => x.client)), resetServer: stats(resets.filter((x) => x.site === s).map((x) => x.server)),
      rollouts: resets.filter((x) => x.site === s).length, writes: resets.filter((x) => x.site === s).reduce((t, x) => t + x.writes, 0) };
  }
  const pages = rec.filter((x) => x.kind !== 'asset').map((x) => x.ms);
  const out = { when: new Date().toISOString(), args: a, secs, requests: rec.length, rps: Math.round(rec.length / secs), rolloutsDone, errors, errSamples: errSamples.slice(0, 30),
    pages: stats(pages), assets: stats(rec.filter((x) => x.kind === 'asset').map((x) => x.ms)),
    resetsAfterWrites: { client: stats(resets.filter((x) => x.writes).map((x) => x.client)), server: stats(resets.filter((x) => x.writes).map((x) => x.server)) },
    resetsAll: { client: stats(resets.map((x) => x.client)), server: stats(resets.map((x) => x.server)) },
    sites, memPeakMB: Object.fromEntries(Object.entries(peak).map(([k, v]) => [k, { procs: v.procs, rss: Math.round(v.rss / 1048576), pss: Math.round(v.pss / 1048576), anon: Math.round(v.anon / 1048576) }])),
    memPeakTotalGB: Object.fromEntries(['rss', 'pss', 'anon'].map((f) => [f, Math.round(Object.values(peak).reduce((t, v) => t + v[f], 0) / 1073741824 * 100) / 100])) };
  const js = JSON.stringify(out, null, 1);
  if (a.out) fs.writeFileSync(a.out, js);
  console.log(js);
})();
