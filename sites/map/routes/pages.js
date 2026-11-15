'use strict';
// HTML pages (server-rendered; the page script swaps #sidebar on navigation and draws the
// map). Every answer an agent needs (results, addresses, coordinates, route summary and
// steps) is text in the DOM. URL scheme: ../ROUTES.md.
const P = require('../lib/present');
const { E, center } = require('./util');

module.exports = async function pages(app, kit) {
  const raw = { config: { raw: true } };

  // the sidebar's map instructions, read by public/map.js (#map-data JSON)
  const render = (reply, view, data, mapData, status) => reply.render(view, { P, mapData: mapData || {}, ...data }, status);

  app.get('/', raw, async (req, reply) => render(reply, 'home', { title: null }));

  app.get('/about', raw, async (req, reply) => render(reply, 'about', { title: 'About' }));
  app.get('/copyright', raw, async (req, reply) => render(reply, 'about', { title: 'Copyright and License', copyright: true }));

  // ---------------------------------------------------------------- search / where is this
  app.get('/search', raw, async (req, reply) => {
    const q = String(req.query.query ?? req.query.q ?? '').trim().slice(0, 300);
    const lat = req.query.lat, lon = req.query.lon;
    if (!q && lat != null && lon != null && Number.isFinite(+lat) && Number.isFinite(+lon)) return whereIs(req, reply, +lat, +lon);
    if (!q) return render(reply, 'search', { title: 'Search', query: '', results: [] });
    // a pasted coordinate pair: "40.4443, -79.9436" -> where is this
    const ll = P.parseLatLon(q);
    if (ll) return whereIs(req, reply, ll.lat, ll.lon, q);
    const t0 = Date.now();
    const results = await E(req).geo('search', q, { center: center(req), limit: 15 });
    const near = results.length && results.every((r) => r.distance != null) && /\b(near|nearby|around|close to|next to|in)\b/i.test(q);
    return render(reply, 'search', { title: q, query: q, results, near, ms: Date.now() - t0 }, {
      fit: true,
      markers: results.map((r, i) => ({ lat: r.lat, lon: r.lon, label: P.title(r), href: P.placeUrl(r), n: i + 1 })),
    });
  });

  async function whereIs(req, reply, lat, lon, query) {
    const zoom = req.query.zoom != null && Number.isFinite(+req.query.zoom) ? Math.round(+req.query.zoom) : 18;
    const levels = [Math.max(zoom, 17), 16, 12, 10]; // building, street, neighbourhood, city (county/state searches are slow; they are in the address)
    const seen = new Set(), results = [];
    for (const r of await Promise.all(levels.map((z) => E(req).geo('reverse', lat, lon, { zoom: z })))) {
      if (!r || !r.display_name || seen.has(r.display_name)) continue;
      seen.add(r.display_name);
      results.push(r);
    }
    return render(reply, 'whereis', { title: 'Where is this?', lat, lon, query: query || P.coords(lat, lon), results }, {
      view: { lat, lon, zoom: Math.min(Math.max(zoom, 15), 18) },
      markers: [{ lat, lon, label: P.coords(lat, lon), kind: 'point' }],
    });
  }

  // ---------------------------------------------------------------- place pages
  async function nearbyOf(req, p) {
    const rows = await E(req).geo('nearby', p.lat, p.lon, { limit: 60, radius: 250, maxRadius: 250 });
    return rows.filter((r) => r.name && r.place_rank >= 28 && r.class !== 'highway' && r.place_id !== p.place_id
      && !(r.osm_type === p.osm_type && r.osm_id === p.osm_id) && r.name !== p.name).slice(0, 10);
  }
  async function placePage(req, reply, p) {
    if (!p) throw kit.httpError(404, 'Sorry, this object could not be found. It may not be in the map data.');
    const nearby = await nearbyOf(req, p);
    const bb = p.boundingbox;
    const box = bb && bb[0] != null && bb[0] !== bb[1] ? [bb[2], bb[0], bb[3], bb[1]] : null;
    return render(reply, 'place', { title: P.title(p), p, nearby }, {
      view: { lat: p.lat, lon: p.lon, zoom: P.zoomFor(bb, 17) },
      bbox: box,
      markers: [{ lat: p.lat, lon: p.lon, label: P.title(p) }],
    });
  }
  const T = { node: 'N', way: 'W', relation: 'R' };
  for (const type of Object.keys(T)) {
    app.get(`/${type}/:id`, raw, async (req, reply) => {
      if (!/^\d+$/.test(req.params.id)) throw kit.httpError(404, 'No such object');
      return placePage(req, reply, await E(req).geo('lookup', T[type], +req.params.id));
    });
  }
  app.get('/place/:pid', raw, async (req, reply) => {
    const pid = req.params.pid;
    if (!/^(\d+|a:\d+:\d+)$/.test(pid)) throw kit.httpError(404, 'No such place');
    return placePage(req, reply, await E(req).geo('get', /^\d+$/.test(pid) ? +pid : pid));
  });

  // ---------------------------------------------------------------- query features / what's nearby
  app.get('/query', raw, async (req, reply) => {
    const lat = +req.query.lat, lon = +req.query.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw kit.httpError(400, 'lat and lon are required');
    const category = String(req.query.category || '').trim().slice(0, 60);
    let nearby = [], enclosing = [], label = null;
    if (category) {
      nearby = await E(req).geo('nearby', lat, lon, { category, limit: 20, radius: 1000, maxRadius: 20000 });
      label = (P.NEARBY.find((c) => c[0] === category.toLowerCase()) || [null, P.titleCase(category)])[1];
    } else {
      const rows = await E(req).geo('nearby', lat, lon, { limit: 80, radius: 60, maxRadius: 60 });
      nearby = rows.filter((r) => r.name && r.place_rank >= 26).slice(0, 25);
      const r = await E(req).geo('reverse', lat, lon, { zoom: 18 });
      if (r && r.address) {
        const skip = new Set(['country_code', 'postcode', 'house_number']);
        for (const [k, v] of Object.entries(r.address)) if (!skip.has(k)) enclosing.push({ key: k, label: P.titleCase(k === 'road' ? 'street' : k), name: v });
        if (r.address.postcode) enclosing.push({ key: 'postcode', label: 'Postcode', name: r.address.postcode });
      }
    }
    return render(reply, 'query', { title: category ? `${label} nearby` : 'Query Features', lat, lon, category, label, nearby, enclosing }, {
      view: { lat, lon, zoom: 17 }, fit: !!category,
      markers: [{ lat, lon, label: P.coords(lat, lon), kind: 'point' }].concat(nearby.map((r, i) => ({ lat: r.lat, lon: r.lon, label: P.title(r), href: P.placeUrl(r), n: i + 1 }))),
    });
  });

  // ---------------------------------------------------------------- directions
  // Canonical: /directions?engine=fossgis_osrm_car&route=lat,lon;lat,lon[&from=<name>&to=<name>]
  // Form submit (no JS too): /directions?engine=..&route_from=<text>&route_to=<text>[&from_ll=..&to_ll=..]
  //   -> geocoded (top hit near the map view) and redirected to the canonical URL.
  app.get('/directions', raw, async (req, reply) => {
    const qy = req.query;
    const eng = P.engine(qy.engine);
    if (qy.route_from != null || qy.route_to != null) {
      const sides = [];
      const errors = [];
      for (const [text, ll, prevName, label] of [[qy.route_from, qy.from_ll, qy.from, 'from'], [qy.route_to, qy.to_ll, qy.to, 'to']]) {
        const t = String(text || '').trim();
        const keep = P.parseLatLon(ll);
        if (!t) { sides.push(null); continue; }
        if (keep && prevName != null && t === String(prevName).trim()) { sides.push({ ...keep, name: t }); continue; }
        const c = P.parseLatLon(t);
        if (c) { sides.push({ ...c, name: P.coords(c.lat, c.lon) }); continue; }
        const r = (await E(req).geo('search', t, { center: center(req), limit: 1 }))[0];
        if (!r) { errors.push({ side: label, text: t }); sides.push({ name: t, missing: true }); continue; }
        sides.push({ lat: r.lat, lon: r.lon, name: r.display_name });
      }
      if (errors.length) {
        return render(reply, 'directions', { title: 'Directions', eng, from: sides[0], to: sides[1], geoErrors: errors });
      }
      return reply.redirect(directionsUrl(eng, sides[0], sides[1]));
    }
    const [a, b] = P.parseRoute(qy.route);
    const names = [qy.from, qy.to];
    const ends = [];
    for (const [i, p] of [a, b].entries()) {
      if (!p) { ends.push(null); continue; }
      let name = names[i] != null && String(names[i]).trim() ? String(names[i]).trim().slice(0, 300) : null;
      if (!name) {
        const r = await E(req).geo('reverse', p.lat, p.lon, { zoom: 18 });
        name = r && r.display_name ? r.display_name : P.coords(p.lat, p.lon);
      }
      ends.push({ ...p, name });
    }
    let route = null, error = null;
    if (ends[0] && ends[1]) {
      const r = await E(req).route(eng.profile, [ends[0].lon, ends[0].lat], [ends[1].lon, ends[1].lat]);
      if (r.code === 'Ok') route = r; else error = r.message || 'No route found between these points.';
    }
    const markers = ends.map((e, i) => e && { lat: e.lat, lon: e.lon, label: e.name, kind: i ? 'to' : 'from' }).filter(Boolean);
    return render(reply, 'directions', {
      title: route ? `Directions from ${ends[0].name.split(',')[0]} to ${ends[1].name.split(',')[0]}` : 'Directions',
      eng, from: ends[0], to: ends[1], route, error,
      swapUrl: ends[0] || ends[1] ? directionsUrl(eng, ends[1], ends[0]) : null,
      engineUrls: P.ENGINES.map((e) => ({ e, href: directionsUrl(e, ends[0], ends[1]) })),
    }, {
      markers,
      route: route ? { url: `/api/route?engine=${eng.id}&route=${encodeURIComponent(P.llStr(ends[0]) + ';' + P.llStr(ends[1]))}`, bbox: route.bbox, profile: eng.profile } : null,
      fit: true,
    });
  });

  function directionsUrl(eng, a, b) {
    const u = new URLSearchParams();
    u.set('engine', eng.id);
    u.set('route', `${P.llStr(a)};${P.llStr(b)}`);
    if (a && a.name) u.set('from', a.name);
    if (b && b.name) u.set('to', b.name);
    return '/directions?' + u.toString().replace(/%2C/g, ',').replace(/%3B/g, ';');
  }
};
