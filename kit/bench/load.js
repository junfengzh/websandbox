#!/usr/bin/env node
'use strict';
// Load generator: C concurrent "rollouts", client i on tenant i (127.10.<i>.<k>:port),
// each a closed loop of page views / searches / form posts with periodic resets.
// usage: node bench/load.js --port 7120 --site-index 9 --clients 32 --seconds 30 [--think-ms 0] [--reset-every 200] [--max-id 100000]
const http = require('node:http');
const { parseArgs } = require('node:util');

const { values: a } = parseArgs({ options: {
  port: { type: 'string', default: '7120' }, 'site-index': { type: 'string', default: '9' }, clients: { type: 'string', default: '32' },
  seconds: { type: 'string', default: '30' }, 'think-ms': { type: 'string', default: '0' }, 'reset-every': { type: 'string', default: '200' },
  'max-id': { type: 'string', default: '100000' }, host: { type: 'string' },
} });
const PORT = +a.port; const C = +a.clients; const END = Date.now() + +a.seconds * 1000; const THINK = +a['think-ms'];
const MAXID = +a['max-id'];
const WORDS = ['quick', 'brown', 'zebra', 'garden', 'recipe', 'travel', 'budget', 'meeting', 'project', 'coffee', 'mountain', 'river', 'music', 'guitar', 'holiday', 'kitchen', 'bike', 'ocean', 'qick', 'gardn', 'kalo', 'mira', 'tendor', 'solvex'];
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

function request(agent, host, method, path, { cookie, body, json } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'user-agent': 'wsb-bench', accept: 'text/html' };
    if (cookie) headers.cookie = cookie;
    let data;
    if (body) { data = new URLSearchParams(body).toString(); headers['content-type'] = 'application/x-www-form-urlencoded'; }
    if (json) { data = JSON.stringify(json); headers['content-type'] = 'application/json'; }
    if (data) headers['content-length'] = Buffer.byteLength(data);
    const t0 = performance.now();
    const req = http.request({ host, port: PORT, method, path, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, ms: performance.now() - t0, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const lat = {}; const errors = {}; const resets = [];
const rec = (type, r) => { (lat[type] ||= []).push(r.ms); if (r.status >= 500 || (r.status >= 400 && type !== 'notfound')) errors[`${type}:${r.status}`] = (errors[`${type}:${r.status}`] || 0) + 1; };

async function client(i) {
  const host = a.host || `127.10.${i}.${a['site-index']}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let cookie; let csrf;
  const login = async () => {
    const r = await request(agent, host, 'POST', '/__rl/login', { json: { user: 'alice' } });
    const j = JSON.parse(r.text);
    cookie = `${j.cookie.name}=${j.cookie.value}`;
    const p = await request(agent, host, 'GET', '/', { cookie });
    csrf = /name="csrf-token" content="([^"]+)"/.exec(p.text)[1];
  };
  await login();
  let n = 0;
  while (Date.now() < END) {
    const x = rnd();
    let type, r;
    if (x < 0.15) { type = 'list'; r = await request(agent, host, 'GET', '/', { cookie }); }
    else if (x < 0.30) { type = 'list_sorted_paged'; r = await request(agent, host, 'GET', `/?sort=${pick(['likes_desc', 'title_asc', 'created_asc'])}&page=${1 + Math.floor(rnd() * 50)}`, { cookie }); }
    else if (x < 0.50) { type = 'search'; r = await request(agent, host, 'GET', `/?q=${encodeURIComponent(pick(WORDS) + (rnd() < 0.4 ? ' ' + pick(WORDS) : ''))}`, { cookie }); }
    else if (x < 0.60) { type = 'search_filtered'; r = await request(agent, host, 'GET', `/?q=${pick(WORDS)}&tag=${pick(['work', 'food', 'travel'])}&sort=likes_desc`, { cookie }); }
    else if (x < 0.85) { type = 'view'; r = await request(agent, host, 'GET', `/notes/${1 + Math.floor(rnd() * MAXID)}`, { cookie }); }
    else if (x < 0.95) { type = 'create'; r = await request(agent, host, 'POST', '/notes', { cookie, body: { _csrf: csrf, title: `bench ${pick(WORDS)} ${n}`, body: `${pick(WORDS)} ${pick(WORDS)} body text ${n}`, tag: 'work' } }); }
    else { type = 'edit'; r = await request(agent, host, 'POST', `/notes/${1 + Math.floor(rnd() * 1000)}/edit`, { cookie, body: { _csrf: csrf, title: `edited ${pick(WORDS)}`, body: `edited ${pick(WORDS)}`, tag: 'food', likes: '3' } }); }
    rec(type, r);
    n++;
    if (n % +a['reset-every'] === 0) {
      const rr = await request(agent, host, 'POST', '/__rl/reset', { json: {} });
      resets.push(JSON.parse(rr.text).ms); rec('reset_http', rr);
      await login();
    }
    if (THINK) await new Promise((res) => setTimeout(res, THINK));
  }
  agent.destroy();
}

const pct = (xs, p) => { const s = [...xs].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const sum = (xs) => ({ n: xs.length, p50: +pct(xs, 0.5).toFixed(2), p95: +pct(xs, 0.95).toFixed(2), p99: +pct(xs, 0.99).toFixed(2), max: +Math.max(...xs).toFixed(2) });

(async () => {
  const t0 = Date.now();
  await Promise.all(Array.from({ length: C }, (_, i) => client(i)));
  const secs = (Date.now() - t0) / 1000;
  const all = Object.entries(lat).filter(([k]) => k !== 'reset_http').flatMap(([, v]) => v);
  const out = { clients: C, seconds: +secs.toFixed(1), requests: all.length, rps: +(all.length / secs).toFixed(0), all: sum(all), byType: {}, resetServerMs: resets.length ? sum(resets) : null, errors };
  for (const [k, v] of Object.entries(lat)) out.byType[k] = sum(v);
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e); process.exit(1); });
