'use strict';
// node --test test/geocode.test.js   (needs the built data: $WSB_MAP_DATA/geocode.db)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Geocoder, DEFAULT_DB } = require('../lib/geocode');
const { norm, tokens } = require('../lib/textnorm');
const spec = require('./task_places.json');

const have = fs.existsSync(DEFAULT_DB);
const opt = { skip: !have && 'geocode.db not built' };
const CMU = spec.center;
let g;
test.before(() => { if (have) g = new Geocoder(DEFAULT_DB); });

test('normalisation folds abbreviations', () => {
  assert.strictEqual(norm('5000 Fifth Avenue'), norm('5000 5th Ave'));
  assert.strictEqual(norm("Trader Joe's"), 'trader joes');
  assert.strictEqual(norm('Univ. of Pittsburgh'), norm('University of Pittsburgh'));
  assert.deepStrictEqual(tokens('Café'), ['cafe']);
});

test('Carnegie Mellon University: name, address, postcode', opt, () => {
  const r = g.search('Carnegie Mellon University', { center: CMU })[0];
  assert.match(r.display_name, /^Carnegie Mellon University/);
  assert.match(r.display_name, /Pittsburgh/);
  assert.strictEqual(r.address.postcode, '15213');
  assert.strictEqual(r.class, 'amenity');
  assert.strictEqual(r.type, 'university');
});

test('Pittsburgh International Airport is in Findlay Township, Allegheny County', opt, () => {
  const r = g.search('Pittsburgh International Airport')[0];
  assert.match(r.display_name, /Findlay Township/);
  assert.match(r.display_name, /Allegheny County/);
  assert.strictEqual(r.extratags.operator, 'Allegheny County Airport Authority');
});

test('house number search', opt, () => {
  const r = g.search('401 Shady Ave, Pittsburgh', { center: CMU })[0];
  assert.match(r.display_name, /401, Shady Avenue, Shadyside/);
});

test('category near a place ("restaurants near X")', opt, () => {
  const r = g.search('restaurants near Carnegie Mellon University');
  assert.ok(r.length >= 5);
  for (const x of r) {
    assert.strictEqual(x.type, 'restaurant');
    assert.ok(x.distance < 3000, `${x.name} ${x.distance}`);
  }
  for (let i = 1; i < r.length; i++) assert.ok(r[i].distance >= r[i - 1].distance);
});

test('bare category uses the map view', opt, () => {
  const r = g.search('hotel', { center: CMU });
  assert.ok(r.length > 0 && r.every((x) => x.type === 'hotel'));
  assert.ok(r[0].distance < 3000);
});

test('autocomplete', opt, () => {
  const r = g.autocomplete('carnegie mel', { center: CMU });
  assert.ok(r.some((x) => /^Carnegie Mellon University/.test(x.display_name)));
});

test('nearby by category', opt, () => {
  const r = g.nearby(CMU[1], CMU[0], { category: 'cafe', limit: 5 });
  assert.strictEqual(r.length, 5);
  assert.ok(r.every((x) => x.class === 'amenity' && x.type === 'cafe'));
});

test('reverse geocoding near CMU', opt, () => {
  const r = g.reverse(40.4443, -79.9436, { zoom: 18 });
  assert.ok(r && /Pittsburgh/.test(r.display_name), JSON.stringify(r));
  const city = g.reverse(40.4443, -79.9436, { zoom: 10 });
  assert.match(city.display_name, /Pittsburgh/);
});

test('extratags: phone, website, opening hours', opt, () => {
  const tokyo = g.search('Tokyo Japanese Food Store', { center: CMU })[0];
  assert.ok(tokyo.extratags.opening_hours, 'opening_hours present');
  const cmoa = g.search('Carnegie Museum of Art', { center: CMU })[0];
  assert.ok(cmoa.extratags.website || cmoa.extratags['contact:website']);
});

test('lookup by OSM id and place id round-trip', opt, () => {
  const r = g.search('Chatham University', { center: CMU })[0];
  assert.strictEqual(g.get(r.place_id).display_name, r.display_name);
  assert.strictEqual(g.lookup(r.osm_type, r.osm_id).place_id, r.place_id);
});

test('other regions', opt, () => {
  assert.match(g.search('Coit Tower')[0].display_name, /San Francisco/);
  assert.match(g.search('Big Ben')[0].display_name, /London/);
  assert.match(g.search('Marina Bay Sands')[0].display_name, /Singapore/);
});

test('WebArena task places: top hit matches', opt, () => {
  const miss = [];
  for (const p of spec.places) {
    const r = g.search(p.q, { center: spec.center, limit: 5 });
    if (!r[0] || !r[0].display_name.toLowerCase().includes(p.expect.toLowerCase())) miss.push(`${p.q} -> ${r[0] ? r[0].display_name : '(none)'}`);
  }
  // a few places are not in the data (see docs/NOTES-map.md); everything else must hit
  assert.ok(miss.length <= 6, 'misses:\n' + miss.join('\n'));
});

test('state codes, comma segments, colloquial names', opt, () => {
  assert.match(g.search('Scranton, PA', { center: CMU, limit: 1 })[0].display_name, /^Scranton, Lackawanna County/);
  assert.match(g.search('Bridgeport, CT', { center: CMU, limit: 1 })[0].display_name, /^Bridgeport, Greater Bridgeport/);
  assert.match(g.search('Portland, ME', { center: CMU, limit: 1 })[0].display_name, /^Portland, Cumberland County, Maine/);
  assert.match(g.search('Carnegie Hall NYC', { center: CMU, limit: 1 })[0].display_name, /^Carnegie Hall, .*Manhattan/);
});

test('name words + place words ("AMC theatre pittsburgh", "CMU Hunt library")', opt, () => {
  for (const [q, want] of [['AMC theatre pittsburgh', /^AMC Waterfront/], ['gates building at CMU', /^Gates and Hillman Centers/],
    ['CMU gates building', /^Gates and Hillman Centers/], ['CMU Hunt library', /^Hunt Library/], ['CMU Posner Hall', /^Posner Hall/],
    ['university center at Carnegie Mellon University', /^Cohon University Center/], ['starbucks on Craig Street', /^Starbucks, 428, South Craig/]]) {
    const r = g.search(q, { center: CMU, limit: 3 });
    assert.ok(r[0] && want.test(r[0].display_name), `${q} -> ${r[0] && r[0].display_name}`);
  }
  // a city name is not a place name near something ("... in New York" -> not "New York Street")
  const r = g.search('Carnegie Music Hall in NYC', { center: CMU, limit: 3 });
  assert.ok(!r.length || !/Street|Avenue/.test(r[0].display_name.split(',')[0]), r[0] && r[0].display_name);
});

test('rare category near a place widens the radius ("airports near CMU")', opt, () => {
  const r = g.search('airports near Carnegie Mellon University', { center: CMU, limit: 10 });
  assert.ok(r.some((x) => /^Pittsburgh International Airport/.test(x.display_name)), r.map((x) => x.name).join(', '));
});
