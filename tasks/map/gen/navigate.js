'use strict';
// End-state tasks (the map is read-only): the final URL is graded by sites/map/grade.js --
// a directions page (engine + From/To near the expected places), a search page
// ("<category> near <place>") or a place page (the expected OSM object).
const L = require('./lib');
const N = require('./nearby');
const { partners, MODE } = require('./routes');
const grade = require('../../../sites/map/grade');

const T = { node: 'N', way: 'W', relation: 'R' };
const keyOf = (f) => T[f.osm_type] + f.osm_id;
const end = (p, name) => ({ ...(name ? { must_include: [name] } : {}), near: [+p.lat.toFixed(6), +p.lon.toFixed(6)], radius_m: 100 });
const q = (sql) => L.all(sql); // the grader's query function, on the same geocode.db

module.exports = [
  {
    name: 'directions-show', kind: 'navigate', skills: ['navigate', 'form-edit'], difficulty: 1, max: 55,
    phrasings: [
      'Show me {{noun}} directions from {{a}}{{where}} to {{b}}.',
      'Plan a route {{by}} from {{a}}{{where}} to {{b}} on the map.',
      'Open the directions {{by}} from {{a}}{{where}} to {{b}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 60, filter: () => true,
      make: async (A, a, used) => {
        const mode = r.pick(['car', 'bike', 'foot']);
        const [B] = partners(r, a, A, 500, mode === 'car' ? 20000 : mode === 'bike' ? 10000 : 4000, 1, used);
        if (!B) return null;
        const l = await L.route(mode, A, B);
        if (!l) return null;
        used.add(B.id);
        return { slots: { a: A.name, b: B.name, where: L.where(A), noun: MODE[mode].noun, by: MODE[mode].by }, start_url: L.startUrl(a),
          eval: { type: 'directions', directions: { engine: mode, from: end(A, A.name), to: end(B, B.name) } }, url: L.directionsUrl(mode, L.fmt(A), L.fmt(B)),
          changes: [`${mode}: ${l.dist}, ${l.time}`] };
      },
    }),
  },
  {
    name: 'directions-to-nearest', kind: 'navigate', skills: ['search', 'navigate', 'multi-step'], difficulty: 3, max: 50,
    phrasings: [
      'Show {{noun}} directions from {{name}}{{where}} to the nearest {{cat}}.',
      'I am at {{name}}{{where}} and need a {{cat}}. Open {{noun}} directions to the closest one.',
      'Find the {{cat}} closest to {{name}}{{where}} and display the route there {{by}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (p, a, used) => {
        const mode = r.pick(['foot', 'foot', 'bike']);
        const c = r.pick(N.catsFor(a).filter((x) => x.v !== 'park'));
        if (N.isCat(p, c)) return null;
        const n = N.nearest(p, c, a, 1500, used);
        if (!n || n.w.distance < 100) return null;
        const legs = [];
        for (const x of n.list.slice(0, 3)) legs.push(await L.route(mode, p, x));
        if (legs.some((l) => !l) || legs.slice(1).some((l) => l.min < Math.max(legs[0].min + 2, legs[0].min * 1.15))) return null;
        return { slots: { name: p.name, where: L.where(p), cat: c.one, noun: MODE[mode].noun, by: MODE[mode].by }, start_url: L.startUrl(a),
          ...(used.add(n.w.place_id) && {}),
          eval: { type: 'directions', directions: { engine: mode, from: end(p, p.name), to: end(n.w, n.w.name) } }, url: L.directionsUrl(mode, L.fmt(p), n.w),
          changes: [`nearest ${c.v}: ${n.w.name} ${Math.round(n.w.distance)} m straight line; ${mode}: ${n.list.slice(0, 3).map((x, i) => `${x.name || '(unnamed)'} ${legs[i].time}`).join('; ')}`] };
      },
    }),
  },
  {
    name: 'directions-from-coords', kind: 'navigate', skills: ['navigate', 'form-edit'], difficulty: 2, max: 50,
    phrasings: [
      'Show driving directions from the point {{coords}} (latitude, longitude) to {{b}}{{where}}.',
      'My car is parked at {{coords}}. Open the driving route from there to {{b}}{{where}}.',
      'Get car directions starting at the coordinates {{coords}} and ending at {{b}}{{where}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (B, a) => {
        // the start: a point near another place of the area (any, deterministic jitter), 2-15 km away
        const pool = L.areaPois(a);
        let S = null;
        for (let i = 0; i < 20 && !S; i++) {
          const x = pool[r.int(pool.length)];
          const d = L.hav(B.lat, B.lon, x.lat, x.lon);
          if (d >= 2000 && d <= 15000) S = { lat: +(x.lat + (r() - 0.5) * 0.0004).toFixed(5), lon: +(x.lon + (r() - 0.5) * 0.0004).toFixed(5) };
        }
        if (!S || !L.unambiguous(B, [[S.lon, S.lat]])) return null;
        const l = await L.route('car', S, B);
        if (!l || l.ferry) return null;
        const coords = `${S.lat}, ${S.lon}`;
        return { slots: { coords, b: B.name, where: L.where(B) }, start_url: L.startUrl(a),
          eval: { type: 'directions', directions: { engine: 'car', from: { near: [S.lat, S.lon], radius_m: 60 }, to: end(B, B.name) } }, url: L.directionsUrl('car', { ...S, display_name: coords }, L.fmt(B)),
          changes: [`car: ${l.dist}, ${l.time}`] };
      },
    }),
  },
  {
    name: 'search-category-near', kind: 'navigate', skills: ['search'], difficulty: 1, max: 55,
    phrasings: [
      'Search the map for {{cats}} near {{name}}{{where}}.',
      'Show me {{cats}} around {{name}}{{where}} on the map.',
      'I am at {{name}}{{where}}. Look up nearby {{cats}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 60, filter: () => true,
      make: async (p, a) => {
        const c = r.pick(N.catsFor(a));
        const ev = { type: 'search', search: { category: c.classes, near: [+p.lat.toFixed(6), +p.lon.toFixed(6)], radius_m: 300 } };
        const url = `/search?query=${encodeURIComponent(`${c.many} near ${p.name}`)}`;
        // the grader resolves the place words on its own (geocoder name index): it must find p
        const g = await grade.checkSearch(ev.search, url, q);
        if (!g.pass) return null;
        // the search must list something (else the agent sees "No results")
        if (!L.geo().search(`${c.many} near ${p.name}`, { center: [a.lon, a.lat], limit: 3 }).length) return null;
        return { slots: { cats: c.many, name: p.name, where: L.where(p) }, start_url: L.startUrl(a), eval: ev, url };
      },
    }),
  },
  {
    name: 'open-place', kind: 'navigate', skills: ['search', 'navigate'], difficulty: 1, max: 50,
    phrasings: [
      'Open the map page of {{name}}{{where}}.',
      'Find {{name}}{{where}} on the map and open its details page.',
      'Show me the place page for {{name}}{{where}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: (p) => ['N', 'W', 'R'].includes(p.osm_type),
      make: (p, a) => ({ slots: { name: p.name, where: L.where(p) }, start_url: L.startUrl(a), eval: { type: 'place', place: { osm: [L.osmKey(p)] } }, url: L.placeUrl(p) }),
    }),
  },
  {
    name: 'open-place-by-address', kind: 'navigate', skills: ['search', 'navigate', 'read-detail'], difficulty: 2, max: 50,
    phrasings: [
      'There is a {{kind}} at {{addr}}{{where}}. Open its page on the map.',
      'Find the {{kind}} located at {{addr}}{{where}} and open its place page.',
      'Which {{kind}} is at {{addr}}{{where}}? Open its details page on the map.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: (p) => ['N', 'W', 'R'].includes(p.osm_type) && p.housenumber && /^\d+[A-Za-z]?$/.test(p.housenumber) && p.street && L.nameOk(p.street) && require('./facts').KINDS.has(`${p.class}:${p.type}`),
      make: (p, a) => {
        const addr = `${p.housenumber} ${p.street}`;
        const city = L.cityOf(p);
        const same = L.get(`SELECT count(*) n FROM places WHERE housenumber = ? AND street = ? AND class = ? AND type = ? AND id <> ?`, p.housenumber, p.street, p.class, p.type, p.id).n;
        if (same) return null;
        const qs = [addr, city ? `${addr}, ${city}` : null].filter(Boolean);
        // searching the address lists the place (the house-number result is the POI itself)
        for (const s of qs) for (const ctr of [L.CMU, [a.lon, a.lat]]) {
          const res = L.geo().search(s, { center: ctr, limit: 5 });
          if (!res.length || !res.slice(0, 3).some((x) => x.place_id === p.id)) return null;
        }
        const kind = L.typeLabel(p).toLowerCase();
        return { slots: { kind, addr, where: city && !addr.includes(city) ? `, ${city}` : '' }, start_url: L.startUrl(a), eval: { type: 'place', place: { osm: [L.osmKey(p)] } }, url: L.placeUrl(p),
          changes: [`the ${kind} at ${addr}: ${p.name}`] };
      },
    }),
  },
  {
    name: 'open-nearest-place', kind: 'navigate', skills: ['search', 'navigate', 'compare'], difficulty: 2, max: 50,
    phrasings: [
      'Open the map page of the {{cat}} nearest to {{name}}{{where}} (straight line).',
      'Find the closest {{cat}} to {{name}}{{where}} and open its place page.',
      'Show me the details page of whichever {{cat}} is nearest to {{name}}{{where}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: (p, a, used) => {
        const c = r.pick(N.catsFor(a));
        if (N.isCat(p, c)) return null;
        const n = N.nearest(p, c, a, 1500, used);
        if (!n || !T[n.w.osm_type]) return null;
        used.add(n.w.place_id);
        return { slots: { cat: c.one, name: p.name, where: L.where(p) }, start_url: L.startUrl(a), eval: { type: 'place', place: { osm: [keyOf(n.w)] } }, url: `/${n.w.osm_type}/${n.w.osm_id}`,
          changes: [`nearest ${c.v}: ${n.w.name} ${Math.round(n.w.distance)} m; runner-up ${Math.round(n.list[1].distance)} m`] };
      },
    }),
  },
];
