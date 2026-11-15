#!/usr/bin/env node
'use strict';
// Latency benchmark against a running map server: the WebArena task places as searches
// (uncached first pass), their place pages, car/foot/bike directions between task pairs,
// "where is this", and tiles; C concurrent clients spread over the tenants.
//   node sites/map/test/bench.js [--base http://127.0.0.1:7600] [--tenants 2] [--concurrency 8]
const { parseArgs } = require('node:util');
const spec = require('./task_places.json');

const { values: a } = parseArgs({ options: { base: { type: 'string', default: 'http://127.0.0.1:7600' }, tenants: { type: 'string', default: '2' }, concurrency: { type: 'string', default: '8' } } });
const u = new URL(a.base);
const bases = Array.from({ length: +a.tenants }, (_, i) => `${u.protocol}//${u.hostname}:${+u.port + i}`);
const lat = (kind) => (lat[kind] = lat[kind] || []);

async function timed(kind, url, opts) {
  const t0 = performance.now();
  const r = await fetch(url, { redirect: 'manual', ...opts });
  const body = await r.arrayBuffer();
  lat(kind).push(performance.now() - t0);
  if (r.status >= 400) throw new Error(`${r.status} ${url}`);
  return { r, body: Buffer.from(body).toString('utf8') };
}

(async () => {
  const places = spec.places.map((p) => p.q);
  const jobs = [];
  places.forEach((q, i) => jobs.push(async (b) => {
    const { body } = await timed('search', `${b}/search?query=${encodeURIComponent(q)}`);
    const m = body.match(/<a class="set_position" href="([^"]+)"/);
    if (m) await timed('place', b + m[1]);
  }));
  const pairs = [];
  for (let i = 0; i + 1 < places.length; i += 2) pairs.push([places[i], places[i + 1]]);
  pairs.forEach(([f, t], i) => {
    const eng = ['fossgis_osrm_car', 'fossgis_osrm_foot', 'fossgis_osrm_bike'][i % 3];
    jobs.push(async (b) => {
      const { r } = await timed('directions-geocode', `${b}/directions?engine=${eng}&route_from=${encodeURIComponent(f)}&route_to=${encodeURIComponent(t)}`);
      const loc = r.headers.get('location');
      if (loc && /route=[^;&]+;[^&]+/.test(loc)) {
        // skip very long walks/rides (A* over hundreds of km takes seconds; reported separately)
        const { body } = await timed('directions-' + eng.split('_').pop(), b + loc);
        const d = +((body.match(/data-meters="(\d+)"/) || [])[1] || 0);
        lat('km-' + eng.split('_').pop()).push(d / 1000);
      }
    });
  });
  for (let i = 0; i < 40; i++) {
    const la = 40.43 + (i % 7) * 0.004, lo = -79.96 + (i % 5) * 0.006;
    jobs.push((b) => timed('whereis', `${b}/search?lat=${la}&lon=${lo}&zoom=18`));
    jobs.push(async (b) => { for (const [x, y] of [[4551, 6157], [4552, 6158], [4553, 6157], [4550, 6159]]) await timed('tile', `${b}/tiles/14/${x + (i % 3)}/${y + (i % 2)}.pbf`); });
  }
  let next = 0, n = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: +a.concurrency }, async (_, w) => {
    while (next < jobs.length) {
      const j = jobs[next++];
      try { await j(bases[(n++) % bases.length]); } catch (e) { console.error('error', e.message); }
    }
  }));
  const wall = performance.now() - t0;
  const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  console.log(`concurrency ${a.concurrency}, tenants ${a.tenants}, ${jobs.length} jobs, wall ${(wall / 1000).toFixed(1)} s`);
  console.log('kind                  n    p50 ms   p95 ms   max ms');
  for (const [k, v] of Object.entries(lat)) {
    if (typeof v !== 'object' || k.startsWith('km-')) continue;
    console.log(`${k.padEnd(20)} ${String(v.length).padStart(3)} ${q(v, 0.5).toFixed(0).padStart(8)} ${q(v, 0.95).toFixed(0).padStart(8)} ${Math.max(...v).toFixed(0).padStart(8)}`);
  }
  for (const k of Object.keys(lat)) if (k.startsWith('km-')) console.log(`${k}: max ${Math.max(...lat[k]).toFixed(0)} km`);
})();
