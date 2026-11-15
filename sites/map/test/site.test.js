'use strict';
// node --test test/site.test.js   (needs the built data in $WSB_MAP_DATA or $WSB_DATA_ROOT/map)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = process.env.WSB_MAP_DATA || '$WSB_DATA_ROOT/map';
const have = fs.existsSync(path.join(DATA, 'geocode.db')) && fs.existsSync(path.join(DATA, 'route'));
const opt = { skip: !have && 'map data not built' };
const site = require('../server.js');
let s, base, base1;

const get = async (p, o = {}) => {
  const r = await fetch((o.base || base) + p, { redirect: o.redirect || 'follow', headers: o.headers });
  return { status: r.status, url: r.url, headers: r.headers, text: await r.text(), r };
};
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test.before(async () => {
  if (!have) return;
  const tmp = fs.mkdtempSync(path.join((process.env.WSB_TMP || os.tmpdir()), 'wsb-map-test-'));
  s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads: tmp });
  base = s.url(0);
  base1 = s.url(1);
  await site.engines.get(DATA).routerReady; // ~10 s graph load
});
test.after(async () => { if (s) await s.close(); });

test('home page: map container, search form, attribution', opt, async () => {
  const r = await get('/');
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /<div id="map"/);
  assert.match(r.text, /<form class="search_form" action="\/search"/);
  assert.match(r.text, /© OpenStreetMap contributors/);
  assert.match(r.text, /<script type="application\/json" id="map-data">\{\}<\/script>/);
});

test('search: Carnegie Mellon University -> results list with place links', opt, async () => {
  const r = await get('/search?query=Carnegie%20Mellon%20University');
  assert.strictEqual(r.status, 200);
  const m = r.text.match(/<a class="set_position" href="([^"]+)">([^<]+)<\/a>/);
  assert.ok(m, 'a result link');
  assert.strictEqual(m[1], '/relation/2279034');
  assert.match(m[2], /^Carnegie Mellon University, .*Pittsburgh, Allegheny County, Pennsylvania, 15213, United States$/);
  const md = JSON.parse(r.text.match(/id="map-data">([^<]*)</)[1]);
  assert.ok(md.markers.length >= 1 && md.fit);
  // q= alias, empty results
  const n = await get('/search?q=zzqxwv%20nonexistent%20place');
  assert.match(n.text, /No results found/);
});

test('search: "hotels near Carnegie Music Hall" lists hotels with distances', opt, async () => {
  const r = await get('/search?query=hotels%20near%20Carnegie%20Music%20Hall');
  const items = [...r.text.matchAll(/<span class="result-type">([^<]+)<\/span>/g)].map((x) => x[1]);
  assert.ok(items.length >= 3);
  assert.ok(items.every((t) => t === 'Hotel'), items.join(','));
  assert.match(r.text, /away, straight line/);
});

test('place page: name, category, address, coordinates, tags, nearby', opt, async () => {
  const r = await get('/relation/2279034');
  assert.strictEqual(r.status, 200);
  const t = text(r.text);
  assert.match(t, /Carnegie Mellon University/);
  assert.match(t, /University \(amenity=university\)/);
  assert.match(t, /Address Carnegie Mellon University, Forbes Avenue, Squirrel Hill North, Pittsburgh/);
  assert.match(t, /Coordinates 40\.44\d+\s*, -79\.94\d+/);
  assert.match(r.text, /<th scope="row" class="browse-tag-k">short_name<\/th><td class="browse-tag-v">CMU<\/td>/);
  assert.match(r.text, /href="\/directions\?route=40\.\d+,-79\.\d+;&amp;from=/);
  assert.match(r.text, /<h3>Nearby<\/h3>/);
  // hours / website / phone shown when tagged
  const k = await get('/search?query=Kenmawr%20Apartments');
  const href = k.text.match(/<a class="set_position" href="([^"]+)"/)[1];
  const p = text((await get(href)).text);
  assert.match(p, /Phone \+1-412-361-2774/);
  assert.match(p, /Website http:\/\/www\.kenmawrapartments\.com\//);
  assert.strictEqual((await get('/node/1')).status, 404);
  assert.strictEqual((await get('/way/abc')).status, 404);
});

test('house-number results have /place/a:<street>:<id> pages', opt, async () => {
  const r = await get('/search?query=5000%20Fifth%20Avenue%2C%20Pittsburgh');
  const href = r.text.match(/<a class="set_position" href="([^"]+)"/)[1];
  assert.match(href, /^\/(place\/a%3A\d+%3A\d+|node\/\d+|way\/\d+)$/);
  const p = await get(href);
  assert.strictEqual(p.status, 200);
  assert.match(text(p.text), /5000, Fifth Avenue/);
});

test('directions: form -> canonical URL; car CMU -> Pittsburgh airport; then foot', opt, async () => {
  const q = '/directions?engine=fossgis_osrm_car&route_from=Carnegie%20Mellon%20University&route_to=Pittsburgh%20International%20Airport';
  const red = await get(q, { redirect: 'manual' });
  assert.strictEqual(red.status, 302);
  const loc = red.headers.get('location');
  assert.match(loc, /^\/directions\?engine=fossgis_osrm_car&route=40\.\d+,-79\.\d+;40\.\d+,-80\.\d+&from=Carnegie\+Mellon\+University,\+/);
  const t0 = Date.now();
  const r = await get(loc);
  assert.ok(Date.now() - t0 < 3000);
  assert.match(r.text, /<select id="route_engine" name="engine" class="routing_engines">\s*<option value="fossgis_osrm_bike">Bicycle \(OSRM\)<\/option><option value="fossgis_osrm_car" selected>/);
  assert.match(r.text, /name="route_from" value="Carnegie Mellon University, /);
  assert.match(r.text, /name="route_to" value="Pittsburgh International Airport, /);
  const km = +r.text.match(/data-meters="(\d+)"/)[1] / 1000, min = +r.text.match(/data-seconds="(\d+)"/)[1] / 60;
  assert.ok(km > 25 && km < 40, `car ${km} km`);
  assert.ok(min > 25 && min < 50, `car ${min} min`);
  assert.match(text(r.text), /Distance: \d+km\s*\. Time: \d+ min\s*\./);
  const steps = (r.text.match(/class="routing_step"/g) || []).length;
  assert.ok(steps >= 5, `${steps} steps`);
  assert.match(text(r.text), /You have arrived at your destination/);
  // switch to foot by resubmitting the form (fields unchanged -> coordinates kept, no re-geocoding)
  const ll = (n) => r.text.match(new RegExp(`name="${n}" value="([^"]*)"`))[1];
  const unesc = (x) => x.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const f = new URLSearchParams({ engine: 'fossgis_osrm_foot', route_from: unesc(ll('route_from')), from_ll: ll('from_ll'), from: unesc(ll('from')), route_to: unesc(ll('route_to')), to_ll: ll('to_ll'), to: unesc(ll('to')) });
  const red2 = await get('/directions?' + f, { redirect: 'manual' });
  assert.strictEqual(red2.headers.get('location'), loc.replace('fossgis_osrm_car', 'fossgis_osrm_foot'));
  const w = await get(red2.headers.get('location'));
  const wmin = +w.text.match(/data-seconds="(\d+)"/)[1] / 60;
  assert.ok(wmin > 4 * 60, `foot ${wmin} min`);
  assert.match(w.text, /<option value="fossgis_osrm_foot" selected>/);
  // JSON geometry for the map
  const api = JSON.parse((await get('/api/route?engine=fossgis_osrm_car&route=' + loc.match(/route=([^&]+)/)[1])).text);
  assert.strictEqual(api.code, 'Ok');
  assert.ok(api.geometry.coordinates.length > 50);
  assert.strictEqual(api.duration_text, r.text.match(/data-seconds="\d+">([^<]+)</)[1]);
});

test('directions: unknown place shows an error; one-sided route prefills the form', opt, async () => {
  const r = await get('/directions?route_from=qqzzxxvvnonexistent&route_to=Pittsburgh');
  assert.match(r.text, /Could not find "qqzzxxvvnonexistent" \(from\)/);
  const o = await get('/directions?route=40.4437,-79.94341;&from=Carnegie%20Mellon%20University');
  assert.match(o.text, /name="route_from" value="Carnegie Mellon University"/);
  assert.match(o.text, /name="route_to" value=""/);
  // coordinates only: names come from reverse geocoding
  const c = await get('/directions?engine=fossgis_osrm_foot&route=40.4437,-79.94341;40.4443,-79.9533');
  assert.match(c.text, /name="route_from" value="[^"]+Pittsburgh/);
  assert.match(c.text, /data-seconds="\d+"/);
});

test('where is this / query features / what is nearby', opt, async () => {
  const r = await get('/search?lat=40.4443&lon=-79.9436&zoom=18');
  assert.match(r.text, /<h2 id="where_h">Where is this\?<\/h2>/);
  const t = text(r.text);
  assert.match(t, /Forbes Avenue/);
  assert.match(t, /Pittsburgh, Allegheny County, Pennsylvania, United States/);
  assert.doesNotMatch(t, /New Jersey/);
  const q = text((await get('/query?lat=40.4443&lon=-79.9436')).text);
  assert.match(q, /Nearby features/);
  assert.match(q, /Enclosing features .*City Pittsburgh/);
  const n = await get('/query?lat=40.4443&lon=-79.9436&category=cafe');
  const types = [...n.text.matchAll(/<span class="result-type">([^<]+)<\/span>/g)].map((x) => x[1]);
  assert.ok(types.length >= 5 && types.every((x) => x === 'Cafe'));
  const d = [...n.text.matchAll(/<span class="result-distance">([\d.]+)(k?m) /g)].map((x) => +x[1] * (x[2] === 'km' ? 1000 : 1));
  for (let i = 1; i < d.length; i++) assert.ok(d[i] >= d[i - 1] - 1, 'sorted by distance');
});

test('tiles, style, glyphs, sprites, maplibre bundle', opt, async () => {
  const st = JSON.parse((await get('/style.json')).text);
  assert.strictEqual(st.sources.openmaptiles.tiles[0], base + '/tiles/{z}/{x}/{y}.pbf');
  assert.match(st.sources.openmaptiles.attribution, /OpenStreetMap contributors/);
  const t = await fetch(base + '/tiles/14/4552/6158.pbf');
  assert.strictEqual(t.status, 200);
  assert.strictEqual(t.headers.get('content-type'), 'application/x-protobuf');
  assert.ok((await t.arrayBuffer()).byteLength > 1000);
  assert.strictEqual((await fetch(base + '/tiles/14/0/0.pbf')).status, 204); // outside the regions
  assert.strictEqual((await fetch(base + '/glyphs/Noto%20Sans%20Regular/0-255.pbf')).status, 200);
  assert.strictEqual((await fetch(base + '/sprites/sprite@2x.png')).status, 200);
  assert.strictEqual((await fetch(base + '/glyphs/..%2F..%2Fgeocode.db')).status, 404);
  assert.strictEqual((await fetch(base + '/vendor/maplibre-gl.js')).status, 200);
});

test('tenants: both serve, reset/health/query on the shared geocode.db', opt, async () => {
  for (const b of [base, base1]) {
    assert.strictEqual((await get('/search?query=Randyland', { base: b })).status, 200);
    const rs = await (await fetch(b + '/__rl/reset', { method: 'POST' })).json();
    assert.ok(rs.ok);
    const h = await (await fetch(b + '/__rl/health')).json();
    assert.ok(h.ok && h.mode === 'shared', JSON.stringify(h));
  }
  const q = await (await fetch(base1 + '/__rl/query', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: "SELECT display_name FROM places WHERE osm_type = 'R' AND osm_id = 2279034" }) })).json();
  assert.match(q.rows[0].display_name, /^Carnegie Mellon University/);
});

test('directions: bike/foot longer than 250 km (straight line) are refused quickly; car is not', opt, async () => {
  const route = '40.4437,-79.94341;42.3601,-71.0942'; // CMU -> MIT, ~770 km
  const t0 = Date.now();
  const f = await get(`/directions?engine=fossgis_osrm_foot&route=${route}`);
  assert.ok(Date.now() - t0 < 2000);
  assert.match(f.text, /Route too long: walking directions are limited to 250 km/);
  const c = await get(`/directions?engine=fossgis_osrm_car&route=${route}`);
  assert.ok(+c.text.match(/data-meters="(\d+)"/)[1] > 850000);
});
