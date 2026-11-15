'use strict';
// node --test test/route.test.js   (needs the built data: $WSB_MAP_DATA/route)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createRouter, formatDuration, formatDistance, DEFAULT_DIR } = require('../lib/route');
const { RouteEngine } = require('../lib/route-core');

const DIR = DEFAULT_DIR;
const have = fs.existsSync(path.join(DIR, 'car.ch.bin'));
const P = {
  cmu: [-79.9436, 40.4443],            // Carnegie Mellon University
  pitt: [-79.9533, 40.4446],           // University of Pittsburgh (Cathedral of Learning)
  pit_airport: [-80.2329, 40.4915],    // Pittsburgh International Airport
  downtown_pgh: [-79.9959, 40.4406],
  philly: [-75.1652, 39.9526],         // Philadelphia City Hall
  nyc: [-73.9857, 40.7484],            // Midtown Manhattan
  boston: [-71.0589, 42.3601],
  acadia: [-68.2733, 44.3386],         // Acadia NP (Mount Desert Island)
  vinalhaven: [-68.8337, 44.0484],
  bar_harbor: [-68.2039, 44.3876],
  sf_ferry: [-122.3937, 37.7955],
  sf_ggpark: [-122.4862, 37.7694],
  london_cx: [-0.1246, 51.5079],
  london_tower: [-0.0759, 51.5081],
  sg_marina: [103.8607, 1.2834],
  sg_changi: [103.9893, 1.3592],
};
const opt = { skip: !have && 'route data not built' };

let eng;
test.before(() => { if (have) eng = new RouteEngine(DIR); });

const check = (name, a, b, profile, minKm, maxKm, minMin, maxMin) => test(name, opt, () => {
  const r = eng.route(P[a], P[b], profile);
  assert.strictEqual(r.code, 'Ok', JSON.stringify(r));
  const km = r.distance / 1000, min = r.duration / 60;
  assert.ok(km >= minKm && km <= maxKm, `${name}: ${km.toFixed(1)} km not in [${minKm}, ${maxKm}]`);
  assert.ok(min >= minMin && min <= maxMin, `${name}: ${min.toFixed(1)} min not in [${minMin}, ${maxMin}]`);
  assert.ok(r.geometry.coordinates.length >= 2);
  assert.strictEqual(r.steps[0].maneuver.type, 'depart');
  assert.strictEqual(r.steps[r.steps.length - 1].maneuver.type, 'arrive');
  const sd = r.steps.reduce((s, x) => s + x.distance, 0);
  assert.ok(Math.abs(sd - r.distance) < 5, 'step distances sum to the total');
});

// ballpark ranges around OSRM/WebArena answers (see docs/NOTES-map.md)
check('car CMU -> Pitt', 'cmu', 'pitt', 'car', 0.5, 3, 1, 8);
check('foot CMU -> Pitt', 'cmu', 'pitt', 'foot', 0.7, 2.5, 8, 30);
check('car CMU -> PIT airport', 'cmu', 'pit_airport', 'car', 25, 45, 20, 45);
check('car Pittsburgh -> Philadelphia', 'downtown_pgh', 'philly', 'car', 450, 520, 270, 380);
check('car Pittsburgh -> NYC', 'downtown_pgh', 'nyc', 'car', 520, 620, 320, 450);
check('car Boston -> Acadia', 'boston', 'acadia', 'car', 400, 520, 250, 380);
check('bike Vinalhaven -> Bar Harbor (ferry)', 'vinalhaven', 'bar_harbor', 'bike', 100, 200, 400, 900);
check('car SF Ferry Building -> Golden Gate Park', 'sf_ferry', 'sf_ggpark', 'car', 6, 14, 10, 30);
check('foot London Charing Cross -> Tower', 'london_cx', 'london_tower', 'foot', 3, 5, 35, 65);
check('car Singapore Marina -> Changi', 'sg_marina', 'sg_changi', 'car', 15, 30, 12, 35);

test('same edge / tiny route', opt, () => {
  const r = eng.route(P.cmu, [P.cmu[0] + 0.0003, P.cmu[1]], 'foot');
  assert.strictEqual(r.code, 'Ok');
  assert.ok(r.distance < 200);
});

test('no route between regions', opt, () => {
  const r = eng.route(P.cmu, P.london_cx, 'car');
  assert.strictEqual(r.code, 'NoRoute');
});

test('worker API', opt, async () => {
  const router = await createRouter({ dir: DIR });
  try {
    const [a, b] = await Promise.all([
      router.route({ from: P.cmu, to: P.pitt, profile: 'driving' }),
      router.route({ from: P.cmu, to: P.pitt, profile: 'walking' }),
    ]);
    assert.strictEqual(a.code, 'Ok');
    assert.strictEqual(b.profile, 'foot');
    assert.ok(b.duration > a.duration);
    const t = await router.table({ sources: [P.cmu], destinations: [P.pitt, P.downtown_pgh], profile: 'car' });
    assert.strictEqual(t[0].length, 2);
  } finally {
    await router.close();
  }
});

test('formatting', () => {
  assert.strictEqual(formatDuration(83 * 60), '1h 23min');
  assert.strictEqual(formatDuration(7 * 60 + 10), '7 min');
  assert.strictEqual(formatDistance(557.2), '557m');
  assert.strictEqual(formatDistance(4012), '4.0km');
});
