'use strict';
// Routing API for the map site. Queries run in worker threads on the read-only graph
// (build/graph.cpp output), so the event loop of the site server never blocks.
//
//   const { createRouter } = require('./route');
//   const router = await createRouter({ dir: '<data root>/map/route' });
//   const r = await router.route({ from: [lon, lat], to: [lon, lat], profile: 'car' });
//   // r: { code: 'Ok', distance (m), duration (s), geometry (GeoJSON LineString), steps: [...], waypoints, bbox }
//   router.close();
//
// Profiles: 'car' | 'bike' | 'foot' (aliases: driving, cycling/bicycle, walking).

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULT_DIR = process.env.WSB_MAP_DATA ? path.join(process.env.WSB_MAP_DATA, 'route')
  : path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'map/route');
const ALIASES = { car: 'car', driving: 'car', drive: 'car', bike: 'bike', bicycle: 'bike', cycling: 'bike',
  foot: 'foot', walking: 'foot', walk: 'foot', pedestrian: 'foot' };

function normProfile(p) {
  const q = ALIASES[String(p || 'car').toLowerCase()];
  if (!q) throw new Error('unknown profile ' + p);
  return q;
}

async function createRouter({ dir = DEFAULT_DIR, workers = 1, profiles } = {}) {
  const pool = [];
  for (let i = 0; i < workers; i++) {
    const w = new Worker(path.join(__dirname, 'route-worker.js'), { workerData: { dir, profiles } });
    const state = { w, pending: new Map(), busy: 0 };
    await new Promise((resolve, reject) => {
      w.once('message', (m) => (m.ready ? resolve() : reject(new Error('worker failed'))));
      w.once('error', reject);
    });
    w.on('message', (m) => {
      const p = state.pending.get(m.id);
      if (!p) return;
      state.pending.delete(m.id);
      state.busy--;
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    w.on('error', (e) => { for (const p of state.pending.values()) p.reject(e); state.pending.clear(); });
    pool.push(state);
  }
  let seq = 0;
  const call = (method, args) => {
    const s = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = ++seq;
    s.busy++;
    return new Promise((resolve, reject) => {
      s.pending.set(id, { resolve, reject });
      s.w.postMessage({ id, method, args });
    });
  };
  return {
    /** route({from:[lon,lat], to:[lon,lat], profile}) */
    route: ({ from, to, profile = 'car', opts } = {}) => call('route', { from, to, profile: normProfile(profile), opts }),
    /** nearest routable point of a profile */
    snap: ({ lon, lat, profile = 'car' }) => call('snap', { lon, lat, profile: normProfile(profile) }),
    /** many-to-many distances/durations (sequential routes; small matrices only) */
    table: ({ sources, destinations, profile = 'car' }) => call('table', { sources, destinations, profile: normProfile(profile) }),
    close: () => Promise.all(pool.map((s) => s.w.terminate())),
  };
}

/** "1h 23min" / "7 min" formatting like the OSM website directions panel. */
function formatDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}min`;
}
/** "557m" / "4.0km" like the OSM website. */
function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)}m`;
  return m < 10000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m / 1000)}km`;
}

module.exports = { createRouter, normProfile, formatDuration, formatDistance, DEFAULT_DIR };
