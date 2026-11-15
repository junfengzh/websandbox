'use strict';
// JSON API used by the page script (and handy for task conversion): Nominatim-like search,
// reverse, nearby; OSRM-like route. All raw routes: no tenant lock, no session.
const P = require('../lib/present');
const { E, center } = require('./util');

module.exports = async function api(app, kit) {
  const raw = { config: { raw: true } };
  const num = (v, name) => {
    const x = +v;
    if (v == null || v === '' || !Number.isFinite(x)) throw kit.httpError(400, `${name} is required`);
    return x;
  };

  app.get('/api/search', raw, async (req) => {
    const q = String(req.query.q || req.query.query || '').slice(0, 300);
    const limit = Math.min(50, +req.query.limit || 10);
    return E(req).geo('search', q, { center: center(req), limit });
  });

  app.get('/api/autocomplete', raw, async (req) => {
    const q = String(req.query.q || '').slice(0, 200);
    if (q.trim().length < 2) return [];
    const r = await E(req).geo('autocomplete', q, { center: center(req), limit: +req.query.limit || 8 });
    return r.map((x) => ({ display_name: x.display_name, name: x.name, type: P.typeLabel(x), lat: x.lat, lon: x.lon, url: P.placeUrl(x) }));
  });

  app.get('/api/reverse', raw, async (req) => {
    const lat = num(req.query.lat, 'lat'), lon = num(req.query.lon, 'lon');
    return (await E(req).geo('reverse', lat, lon, { zoom: req.query.zoom != null ? +req.query.zoom : 18 })) || { error: 'Unable to geocode' };
  });

  app.get('/api/nearby', raw, async (req) => {
    const lat = num(req.query.lat, 'lat'), lon = num(req.query.lon, 'lon');
    return E(req).geo('nearby', lat, lon, { category: req.query.category || undefined, limit: Math.min(50, +req.query.limit || 10), radius: +req.query.radius || 1000 });
  });

  // /api/route?engine=fossgis_osrm_car&route=lat,lon;lat,lon  (same parameters as /directions)
  app.get('/api/route', raw, async (req, reply) => {
    const eng = P.engine(req.query.engine || req.query.profile);
    const [a, b] = P.parseRoute(req.query.route);
    if (!a || !b) { reply.code(400); return { code: 'InvalidQuery', message: 'route=lat,lon;lat,lon is required' }; }
    const r = await E(req).route(eng.profile, [a.lon, a.lat], [b.lon, b.lat]);
    if (r.code !== 'Ok') { reply.code(200); return { code: r.code, message: r.message || 'No route found' }; }
    const out = { code: 'Ok', engine: eng.id, profile: eng.profile, distance: r.distance, duration: r.duration,
      distance_text: P.distanceText(r.distance), duration_text: P.durationText(r.duration), bbox: r.bbox, geometry: r.geometry, waypoints: r.waypoints };
    if (req.query.steps === 'true' || req.query.steps === '1') out.steps = r.steps.map(({ geometry, ...s }) => s);
    return out;
  });
};
