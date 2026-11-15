#!/usr/bin/env node
'use strict';
// Front router of the public websandbox demo (deploy/README.md). One port, routing by Host:
//   <domain>          landing page (deploy/landing.html) + /__status (JSON, no secrets)
//   shop.<domain>     store (storefront /, back office /admin)
//   forum. code. wiki. map.<domain>   those sites
// The sites listen on 127.0.0.1 (tasks/tools/sites.sh --bind ports) and trust loopback for
// their control API, and every proxied request comes from loopback -- so /__rl/* is refused
// here for every host (also percent-encoded), X-WSB-* headers are dropped, and the control
// token is used only by the router's own reset/health calls. Abuse limits: per-IP token
// buckets (all requests, writes, large uploads), in-flight cap, request body cap.
const http = require('http');
const fs = require('fs');
const path = require('path');

const env = process.env;
const PORT = +env.WSB_PORT || 8080;
const DOMAIN = (env.WSB_DOMAIN || 'websandbox.pystem.com').toLowerCase();
const BASE = +env.WSB_BASE_PORT || 7700;
const TOKEN = fs.readFileSync(env.WSB_CONTROL_TOKEN_FILE || '/srv/state/control-token', 'utf8').trim();
const RESET_MIN = +env.WSB_RESET_MINUTES || 60;
const MAX_BODY = (+env.WSB_MAX_BODY_MB || 5) * 2 ** 20;
const BIG_BODY = 256 * 1024;                      // bodies above this count against the upload bucket
const UPSTREAM_TIMEOUT = 60e3;

// site key -> subdomain, sites.sh index (port BASE + 10k), label
const SITES = [
  { key: 'store', sub: 'shop', idx: 0, name: 'Store' },
  { key: 'forum', sub: 'forum', idx: 1, name: 'Forum' },
  { key: 'code', sub: 'code', idx: 2, name: 'Code' },
  { key: 'wiki', sub: 'wiki', idx: 3, name: 'Wiki' },
  { key: 'map', sub: 'map', idx: 4, name: 'Map' },
].map((s) => ({ ...s, port: BASE + s.idx * 10, host: `${s.sub}.${DOMAIN}`, health: null, fails: 0 }));
const BY_HOST = new Map(SITES.map((s) => [s.host, s]));
const BY_SUB = new Map(SITES.map((s) => [s.sub, s]));

const log = (...a) => console.log(`[router ${new Date().toISOString().slice(11, 19)}]`, ...a);
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

// ---------------------------------------------------------------- control calls (loopback, token)
function control(site, method, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: site.port, method, path: '/__rl' + p, timeout: 15e3,
      headers: { 'x-wsb-control': TOKEN, 'user-agent': 'wsb-router', 'content-type': 'application/json' } }, (res) => {
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

const state = { lastReset: null, nextReset: null, started: new Date().toISOString(), commit: env.WSB_COMMIT || 'unknown' };
async function resetAll(why) {
  const out = [];
  for (const s of SITES) {
    const r = await control(s, 'POST', '/reset');
    out.push(`${s.key}=${r.status === 200 && r.body && r.body.ok ? r.body.ms + 'ms' : 'FAIL ' + (r.error || r.status)}`);
  }
  state.lastReset = new Date().toISOString();
  log(`reset (${why}): ${out.join(' ')}`);
}
function scheduleReset() {
  const period = RESET_MIN * 60e3;
  const next = Math.ceil((Date.now() + 1000) / period) * period;          // aligned: on the hour for 60
  state.nextReset = new Date(next).toISOString();
  setTimeout(async () => { await resetAll('periodic'); scheduleReset(); }, next - Date.now());
}

// watchdog: a site that stays unhealthy for ~3 min restarts the container (compose restart policy)
async function checkHealth() {
  for (const s of SITES) {
    const r = await control(s, 'GET', '/health');
    const ok = r.status === 200 && r.body && r.body.ok === true;
    s.health = ok ? 'ok' : 'down';
    s.fails = ok ? 0 : s.fails + 1;
    if (!ok) log(`health ${s.key}: ${r.error || r.status} ${r.body ? JSON.stringify(r.body).slice(0, 200) : ''}`);
    if (s.fails === 2) await control(s, 'POST', '/reset');                 // lost transaction etc.
    if (s.fails >= 6) { log(`${s.key} unhealthy for 6 checks: exiting so the container restarts`); process.exit(1); }
  }
}

// ---------------------------------------------------------------- abuse limits
const buckets = new Map();   // ip -> {all, write, big, inflight, t}
const LIMITS = { all: [30, 400], write: [1, 40], big: [30 / 3600, 30] };   // [refill per s, burst]
function take(ip, kind, n = 1) {
  let b = buckets.get(ip);
  const now = Date.now() / 1000;
  if (!b) { b = { all: LIMITS.all[1], write: LIMITS.write[1], big: LIMITS.big[1], inflight: 0, t: now }; buckets.set(ip, b); }
  const dt = now - b.t; b.t = now;
  for (const k of Object.keys(LIMITS)) b[k] = Math.min(LIMITS[k][1], b[k] + dt * LIMITS[k][0]);
  if (b[kind] < n) return false;
  b[kind] -= n; return true;
}
setInterval(() => { const now = Date.now() / 1000; for (const [ip, b] of buckets) if (!b.inflight && now - b.t > 3600) buckets.delete(ip); }, 600e3).unref();

const counters = { req: 0, limited: 0, blocked: 0, errors: 0 };
setInterval(() => { if (counters.req) log(`last 10 min: ${JSON.stringify(counters)} ips=${buckets.size}`); for (const k in counters) counters[k] = 0; }, 600e3).unref();

function clientIp(req) {
  return String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}
function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}
function blockedPath(url) {
  let p = String(url || '');
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(p); if (d === p) break; p = d; } catch { break; } }
  return /__rl/i.test(p);
}

// ---------------------------------------------------------------- landing page
const LANDING = path.join(__dirname, 'landing.html');
function landing(req, res) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const url = (s) => `${proto}://${s.host}`;
  const fmt = (iso) => (iso ? iso.slice(11, 16) + ' UTC' : 'n/a');
  const vars = {
    DOMAIN, COMMIT: state.commit, RESET_MIN: String(RESET_MIN), NEXT_RESET: fmt(state.nextReset), LAST_RESET: fmt(state.lastReset),
    ...Object.fromEntries(SITES.flatMap((s) => [[`URL_${s.key.toUpperCase()}`, url(s)], [`ST_${s.key.toUpperCase()}`, s.health || 'starting']])),
  };
  const html = fs.readFileSync(LANDING, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  send(res, 200, html, 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:", 'x-content-type-options': 'nosniff' });
}

// ---------------------------------------------------------------- proxy
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization'];
// responses whose bodies carry absolute http://<host> URLs (map style -> tile URLs; wiki opensearch)
const REWRITE = { map: /^\/style\.json(\?|$)/, wiki: /^\/w\/api\.php(\?|$)/ };

function proxy(site, req, res, ip) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k) && !k.startsWith('x-wsb-')) headers[k] = v;
  headers.host = site.host;
  headers['x-forwarded-for'] = ip; headers['x-forwarded-proto'] = proto;
  const rewrite = proto === 'https' && REWRITE[site.key] && REWRITE[site.key].test(req.url);
  if (rewrite) headers['accept-encoding'] = 'identity';

  const b = buckets.get(ip); if (b) b.inflight++;
  let done = false;
  const finish = () => { if (!done) { done = true; if (b) b.inflight--; } };
  res.on('close', finish);

  const up = http.request({ host: '127.0.0.1', port: site.port, method: req.method, path: req.url, headers, agent, timeout: UPSTREAM_TIMEOUT }, (ur) => {
    const h = { ...ur.headers };
    for (const k of HOP) delete h[k];
    if (proto === 'https' && h.location) h.location = String(h.location).replace(new RegExp(`^http://(${site.host.replace(/\./g, '\\.')})`, 'i'), 'https://$1');
    if (rewrite) {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').split(`http://${site.host}`).join(`https://${site.host}`);
        delete h['content-length']; delete h['content-encoding'];
        res.writeHead(ur.statusCode, h); res.end(body);
      });
      return;
    }
    res.writeHead(ur.statusCode, h);
    ur.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', (e) => {
    counters.errors++;
    if (!res.headersSent) send(res, 502, `${site.name} is not available right now (${e.message}). It may be restarting; try again in a minute.\n`);
    else res.destroy();
  });

  let seen = 0;
  req.on('data', (c) => {
    seen += c.length;
    if (seen > MAX_BODY) { up.destroy(); if (!res.headersSent) send(res, 413, 'Request body too large.\n'); req.destroy(); }
  });
  req.pipe(up);
}

const server = http.createServer((req, res) => {
  counters.req++;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const ip = clientIp(req);
  if (blockedPath(req.url)) { counters.blocked++; return send(res, 404, 'Not found.\n'); }
  const site = BY_HOST.get(host) || (host.endsWith('.localhost') ? BY_SUB.get(host.split('.')[0]) : null);

  if (!take(ip, 'all')) { counters.limited++; return send(res, 429, 'Too many requests; slow down.\n', undefined, { 'retry-after': '10' }); }
  if (!site) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed.\n');
    const p = req.url.split('?')[0];
    if (p === '/__status') {
      return send(res, 200, JSON.stringify({ ok: SITES.every((s) => s.health === 'ok'), sites: Object.fromEntries(SITES.map((s) => [s.key, s.health])), ...state }, null, 1), 'application/json');
    }
    if (p === '/favicon.ico' || p === '/robots.txt') return send(res, 404, '');
    if (host !== DOMAIN && !/^[\d.]+$|^localhost$/.test(host)) return send(res, 404, `Unknown host. See https://${DOMAIN}/\n`);
    return landing(req, res);
  }
  if (req.url.split('?')[0] === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');

  const len = +req.headers['content-length'] || 0;
  if (len > MAX_BODY) return send(res, 413, 'Request body too large.\n');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !take(ip, 'write')) { counters.limited++; return send(res, 429, 'Too many form submissions; slow down.\n', undefined, { 'retry-after': '30' }); }
  if ((len > BIG_BODY || (!len && req.headers['transfer-encoding'])) && !take(ip, 'big')) { counters.limited++; return send(res, 429, 'Upload limit reached; try again later.\n', undefined, { 'retry-after': '600' }); }
  const b = buckets.get(ip);
  if (b && b.inflight >= 32) { counters.limited++; return send(res, 429, 'Too many parallel requests.\n', undefined, { 'retry-after': '5' }); }
  proxy(site, req, res, ip);
});
server.headersTimeout = 20e3;
server.requestTimeout = 120e3;
server.keepAliveTimeout = 30e3;
server.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
server.on('upgrade', (req, sock) => sock.destroy());                    // the sites use no websockets

server.listen(PORT, '0.0.0.0', async () => {
  log(`listening on :${PORT}; ${DOMAIN} -> landing, ${SITES.map((s) => `${s.sub}->${s.key}:${s.port}`).join(' ')}; reset every ${RESET_MIN} min; commit ${state.commit}`);
  await checkHealth();
  setInterval(checkHealth, 30e3);
  scheduleReset();
});
const stop = () => { log('stopping'); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
