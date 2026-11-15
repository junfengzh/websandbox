'use strict';
// Per-process engines for the map site: a geocoder worker pool and the routing worker(s),
// shared by every tenant of the process (all data is read-only). Started from cfg.onOpen
// (the first tenant open) so the ~10 s routing-graph load overlaps server start-up.
//
//   const E = engines.get(dataDir);
//   await E.geo('search', 'Carnegie Mellon University', { center: [lon, lat] });
//   await E.route('car', [lon, lat], [lon, lat]);     // cached (LRU)
//
// Env: WSB_MAP_GEO_WORKERS (default 3), WSB_MAP_ROUTE_WORKERS (default 1; each loads ~2 GB),
// WSB_MAP_MAX_SLOW_KM (default 250: longest straight-line bike/foot route).

const path = require('path');
const { Worker } = require('worker_threads');
const { createRouter } = require('./route');

class Pool {
  constructor(file, workerData, n) {
    this.ws = [];
    this.seq = 0;
    this.ready = Promise.all(Array.from({ length: n }, () => this._spawn(file, workerData)));
    this.ready.catch(() => {});
  }
  _spawn(file, workerData) {
    const w = new Worker(file, { workerData });
    const s = { w, pending: new Map() };
    this.ws.push(s);
    w.unref();
    w.on('message', (m) => {
      if (m.ready) return;
      const p = s.pending.get(m.id);
      if (!p) return;
      s.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    w.on('error', (e) => { for (const p of s.pending.values()) p.reject(e); s.pending.clear(); });
    return new Promise((resolve, reject) => {
      w.once('message', (m) => (m.ready ? resolve() : reject(new Error('worker failed'))));
      w.once('error', reject);
    });
  }
  async call(method, ...args) {
    await this.ready;
    const s = this.ws.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      s.pending.set(id, { resolve, reject });
      s.w.postMessage({ id, method, args });
    });
  }
  close() { return Promise.all(this.ws.map((s) => s.w.terminate())); }
}

const MAX_SLOW_KM = +process.env.WSB_MAP_MAX_SLOW_KM || 250;
function hav(lon1, lat1, lon2, lat2) {
  const R = 6371008.8, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

class LRU {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k, v) { this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value); return v; }
}

class Engines {
  constructor(dir) {
    this.dir = dir;
    this.geoPool = new Pool(path.join(__dirname, 'geo-worker.js'), { db: path.join(dir, 'geocode.db') }, +process.env.WSB_MAP_GEO_WORKERS || 3);
    this.routerReady = createRouter({ dir: path.join(dir, 'route'), workers: +process.env.WSB_MAP_ROUTE_WORKERS || 1 }).then((r) => {
      this.router = r;
      return r;
    });
    this.routerReady.catch((e) => console.error('[map] router failed to load:', e.message));
    this.routes = new LRU(300);
    this.geoCache = new LRU(2000);
    this.stats = { geo: 0, route: 0, routeMs: 0, routeMax: 0 };
  }
  /** geocoder call in a worker; results cached (the data is read-only) */
  async geo(method, ...args) {
    const k = method + JSON.stringify(args);
    const hit = this.geoCache.get(k);
    if (hit) return hit;
    this.stats.geo++;
    const r = await this.geoPool.call(method, ...args);
    return this.geoCache.set(k, r);
  }
  /**
   * route(profile, [lon, lat], [lon, lat]) -> OSRM-like result; cached.
   * Bike/foot use A* on one shared worker: a 500 km walk takes ~50 s and would stall every
   * other route of the process, so they are limited to MAX_SLOW_KM straight-line distance.
   */
  async route(profile, from, to) {
    if (profile !== 'car' && hav(from[0], from[1], to[0], to[1]) > MAX_SLOW_KM * 1000) {
      return { code: 'TooLong', message: `Route too long: ${profile === 'foot' ? 'walking' : 'cycling'} directions are limited to ${MAX_SLOW_KM} km (straight line) in this map.` };
    }
    const k = `${profile}|${from.map((x) => x.toFixed(6))}|${to.map((x) => x.toFixed(6))}`;
    let p = this.routes.get(k);
    if (p) return p;
    const t0 = process.hrtime.bigint();
    p = this.routerReady.then((r) => r.route({ from, to, profile })).then((res) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      this.stats.route++; this.stats.routeMs += ms; this.stats.routeMax = Math.max(this.stats.routeMax, ms);
      res.ms = Math.round(ms);
      return res;
    });
    p.catch(() => this.routes.m.delete(k));
    return this.routes.set(k, p);
  }
  async close() {
    await this.geoPool.close();
    try { const r = await this.routerReady; await r.close(); } catch { /* not loaded */ }
  }
}

const byDir = new Map();
function get(dir) {
  dir = path.resolve(dir);
  let e = byDir.get(dir);
  if (!e) { e = new Engines(dir); byDir.set(dir, e); }
  return e;
}
async function closeAll() {
  const all = [...byDir.values()];
  byDir.clear();
  await Promise.all(all.map((e) => e.close()));
}

module.exports = { get, closeAll };
