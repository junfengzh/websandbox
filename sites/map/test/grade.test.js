'use strict';
// node --test test/grade.test.js   (map grader: directions / place / search checks; needs geocode.db)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DEFAULT_DB } = require('../lib/geocode');
const grade = require('../grade');

const have = fs.existsSync(DEFAULT_DB);
const opt = { skip: !have && 'geocode.db not built' };
let query;
test.before(() => { if (have) { const db = new Database(DEFAULT_DB, { readonly: true }); query = async (sql) => db.prepare(sql).all(); } });

const GATES = [40.4438999, -79.9443914], INDEP = [39.9488951, -75.150009], CMU = [40.4436977, -79.9434082];
const dirTask = { eval: { type: 'directions', directions: { engine: 'car', from: { must_include: ['Gates and Hillman Centers', 'Pittsburgh'], near: GATES, radius_m: 300 }, to: { must_include: ['Independence Hall'], near: INDEP } } } };
const dirUrl = (eng, a, b, from, to) => `http://map.wa/directions?engine=${eng}&route=${a.join(',')};${b.join(',')}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

test('directions: engine, From/To names, end points', async () => {
  const ok = dirUrl('fossgis_osrm_car', GATES, INDEP, 'Gates and Hillman Centers, Forbes Avenue, Pittsburgh', 'Independence Hall, 520, Chestnut Street, Philadelphia');
  assert.equal((await grade(dirTask, { url: ok })).pass, true);
  assert.equal((await grade(dirTask, { url: ok.replace('osrm_car', 'osrm_foot') })).pass, false);
  assert.equal((await grade(dirTask, { url: ok.replace('engine=fossgis_osrm_car', 'engine=driving') })).pass, true); // alias
  assert.equal((await grade(dirTask, { url: dirUrl('fossgis_osrm_car', CMU.map((v) => v + 0.01), INDEP, 'Gates and Hillman Centers, Pittsburgh', 'Independence Hall') })).pass, false); // far start
  assert.equal((await grade(dirTask, { url: dirUrl('fossgis_osrm_car', GATES, INDEP, 'Carnegie Mellon University, Pittsburgh', 'Independence Hall') })).pass, false);
  assert.equal((await grade(dirTask, { url: 'http://map.wa/search?query=x' })).pass, false);
});

test('place: OSM object list and page text', opt, async () => {
  const t = { eval: { type: 'place', place: { osm: ['W154257484'], must_include: ['Carnegie Music Hall'] } } };
  assert.equal((await grade(t, { url: 'http://map.wa/way/154257484', query })).pass, true);
  assert.equal((await grade(t, { url: 'http://map.wa/way/31899525', query })).pass, false);
  const t2 = { eval: { type: 'place', place: { must_include: ['Piada Italian Street Food', 'Forbes Avenue'] } } };
  assert.equal((await grade(t2, { url: 'http://map.wa/node/2710170970', query })).pass, true);
  assert.equal((await grade(t2, { url: 'http://map.wa/node/5241955436', query })).pass, false);
});

test('search: category wording and place name near the expected one', opt, async () => {
  const t = { eval: { type: 'search', search: { category: [['tourism', 'hotel']], near: CMU, radius_m: 600 } } };
  const g = async (q) => (await grade(t, { url: 'http://map.wa/search?query=' + encodeURIComponent(q), query })).pass;
  assert.equal(await g('hotels near carnegie mellon university'), true);
  assert.equal(await g('hotel around CMU'), true);
  assert.equal(await g('hotels near Carnegie Mellon'), true);
  assert.equal(await g('parking near CMU'), false);
  assert.equal(await g('hotels near University of Pittsburgh'), false);
  assert.equal(await g('hotels'), false);
  const t2 = { eval: { type: 'search', search: { category: [['amenity', 'restaurant']], near: [40.441144, -79.9437501] } } };
  assert.equal((await grade(t2, { url: 'http://map.wa/search?query=restaurants%20near%20CMU%20Hunt%20Library', query })).pass, true);
});

test('search: the place page\'s "What\'s nearby?" result (/query) near the expected place', async () => {
  const t = { eval: { type: 'search', search: { category: [['amenity', 'fast_food']], near: [41.780223, -71.437802], radius_m: 300 } } };
  const g = async (u) => (await grade(t, { url: u })).pass;
  assert.equal(await g('http://map.wa/query?lat=41.7802227&lon=-71.4378016&category=fast+food'), true);
  assert.equal(await g('http://map.wa/query?category=fast%20food&lon=-71.4378016&lat=41.7802227'), true);
  assert.equal(await g('http://map.wa/query?lat=41.7802227&lon=-71.4378016&category=restaurant'), false); // other category
  assert.equal(await g('http://map.wa/query?lat=41.7902227&lon=-71.4378016&category=fast+food'), false); // 1.1 km away
  assert.equal(await g('http://map.wa/query?lat=41.7802227&lon=-71.4378016'), false); // query features, no category
  assert.equal(await g('http://map.wa/query?lat=41.7802227&category=fast+food'), false);
  assert.equal(await g('http://map.wa/query?lat=41.7802227&lon=-71.4378016&category=nonsense'), false);
  const bars = { eval: { type: 'search', search: { category: [['amenity', 'pub']], near: [41.780223, -71.437802] } } };
  assert.equal((await grade(bars, { url: 'http://map.wa/query?lat=41.7802227&lon=-71.4378016&category=bar' })).pass, true); // "bar" = bar or pub
});

test('answer checks still go to the kit grader', async () => {
  const t = { eval: { type: 'answer', answer: { numeric: { value: 14, unit: 'min', tol_abs: 1 } } } };
  assert.equal((await grade(t, { answer: 'about 15 minutes' })).pass, true);
  assert.equal((await grade(t, { answer: '25 min' })).pass, false);
});
