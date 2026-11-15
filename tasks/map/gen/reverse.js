'use strict';
// Reverse geocoding: coordinates typed into the search box -> "Where is this?" (or the map's
// "Show address" / "Query features"): what is here, which street, which postcode.
const L = require('./lib');

const ans = (spec, text) => ({ eval: { type: 'answer', answer: spec }, answer: text });

/** named POIs within m metres of a point (other than the place itself) */
function namedNear(p, m) {
  return L.geo().nearby(p.lat, p.lon, { radius: m, maxRadius: m, limit: 50 }).filter((x) => x.name && x.place_id !== p.id && x.place_rank >= 26 && x.class !== 'highway');
}
/** what the "Where is this?" page lists for a point: reverse at zooms 18, 16, 12, 10 (routes/pages.js) */
function whereIs(lat, lon) {
  const seen = new Set(), out = [];
  for (const z of [18, 16, 12, 10]) {
    const r = L.geo().reverse(lat, lon, { zoom: z });
    if (!r || !r.display_name || seen.has(r.display_name)) continue;
    seen.add(r.display_name);
    out.push(r);
  }
  return out;
}
/** distance to the nearest named street other than `name` (street way geometries) */
function otherStreetDist(lat, lon, name, maxM = 80) {
  const g = L.geo();
  const kx = Math.cos(lat * Math.PI / 180);
  const d = maxM / 111320, dl = d / kx;
  let best = Infinity;
  for (const w of g.st.ways.all(lon - dl, lon + dl, lat - d, lat + d)) {
    const s = g.st.place.get(w.street_id);
    if (!s || s.name === name) continue;
    const cs = new Int32Array(w.coords.buffer, w.coords.byteOffset, w.coords.byteLength / 4);
    for (let i = 0; i + 3 < cs.length; i += 2) {
      const ax = cs[i] / 1e7, ay = cs[i + 1] / 1e7, bx = cs[i + 2] / 1e7, by = cs[i + 3] / 1e7;
      const dx = (bx - ax) * kx, dy = by - ay, Ls = dx * dx + dy * dy;
      let t = Ls > 0 ? (((lon - ax) * kx) * dx + (lat - ay) * dy) / Ls : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, L.hav(lat, lon, ay + t * dy, ax + t * (bx - ax)));
    }
  }
  return best;
}
const c6 = (p) => L.coordsText(p.lat, p.lon);

module.exports = [
  {
    name: 'reverse-place', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2, max: 50,
    phrasings: [
      'What place is located at the coordinates {{coords}}? Tell me its name.',
      'A friend sent me the location {{coords}} (latitude, longitude). What is there, according to the map?',
      'Which named place does the map show at {{coords}}?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: (p, a) => {
        const rv = L.geo().reverse(p.lat, p.lon, { zoom: 18 });
        if (!rv || rv.place_id !== p.id) return null;
        if (namedNear(p, 20).length) return null; // nothing else named right there
        return { slots: { coords: c6(p) }, start_url: L.startUrl(a), ...ans({ must_include: [p.name] }, p.name) };
      },
    }),
  },
  {
    name: 'reverse-street', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2, max: 50,
    phrasings: [
      'Which street is at the coordinates {{coords}}?',
      'I dropped a pin at {{coords}}. What street is that on?',
      'Tell me the name of the street at latitude/longitude {{coords}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: (p) => p.street && L.nameOk(p.street),
      make: (p, a) => {
        // a point a few metres off the place (deterministic), so the question is about the street
        const lat = +(p.lat + (r() - 0.5) * 0.0002).toFixed(6), lon = +(p.lon + (r() - 0.5) * 0.0002).toFixed(6);
        const st = L.geo().reverse(lat, lon, { zoom: 16 });
        if (!st || st.class !== 'highway' || st.name !== p.street) return null;
        const r18 = L.geo().reverse(lat, lon, { zoom: 18 });
        if (!r18 || (r18.address || {}).road !== p.street) return null;
        const near = L.geo()._nearestStreet(lat, lon, 200);
        if (!near || near.d > 30 || otherStreetDist(lat, lon, p.street, 80) < Math.max(2 * near.d, near.d + 25)) return null;
        return { slots: { coords: L.coordsText(lat, lon) }, start_url: L.startUrl(a), ...ans({ must_include: [L.streetAlts(p.street)] }, p.street) };
      },
    }),
  },
  {
    name: 'reverse-postcode', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2, max: 50,
    phrasings: [
      'What is the postcode at the location {{coords}}?',
      'Which postal code does the map give for the point {{coords}} (latitude, longitude)?',
      'I have the coordinates {{coords}}. What postcode is that?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: (p, a) => {
        const lat = +(p.lat + (r() - 0.5) * 0.0001).toFixed(6), lon = +(p.lon + (r() - 0.5) * 0.0001).toFixed(6);
        const res = whereIs(lat, lon);
        const pcs = new Set(res.slice(0, 2).map((x) => (x.address || {}).postcode).filter(Boolean));
        const pc = (res[0] && (res[0].address || {}).postcode) || null;
        if (!pc || pcs.size !== 1 || !/^[A-Z0-9]{2,5}( ?[A-Z0-9]{3})?$/i.test(pc)) return null;
        // the Query features page lists the same postcode (reverse at zoom 18)
        return { slots: { coords: L.coordsText(lat, lon) }, start_url: L.startUrl(a), ...ans({ must_include: [pc] }, pc) };
      },
    }),
  },
];
module.exports.whereIs = whereIs;
