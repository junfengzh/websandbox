'use strict';
// Shared helpers for the map task generator (docs/GENERATOR.md): the site's own engines
// (sites/map/lib: the Geocoder and the router, in process -- the same code the UI runs in its
// worker threads), seeded RNG, sampling areas, place pools with unambiguous names, the
// directions-form replica (top hit -> rounded canonical coordinates -> route) and answer specs.
// Templates live in the family modules next to this file; index.js runs them.
const path = require('path');

const MAP = path.join(__dirname, '../../../sites/map');
const { Geocoder } = require(path.join(MAP, 'lib/geocode'));
const { createRouter } = require(path.join(MAP, 'lib/route'));
const P = require(path.join(MAP, 'lib/present'));
const { tokens, norm, STOP } = require(path.join(MAP, 'lib/textnorm'));
const CATS = require(path.join(MAP, 'lib/categories.json')).phrases;

const DATA = process.env.WSB_MAP_DATA || '$WSB_DATA_ROOT/map';
const MAX_SLOW_KM = +process.env.WSB_MAP_MAX_SLOW_KM || 250; // as lib/engines.js
const CMU = [P.DEFAULT_VIEW.lon, P.DEFAULT_VIEW.lat]; // ranking centre of a plain page load

let G;
const geo = () => G || (G = new Geocoder(path.join(DATA, 'geocode.db')));
const all = (sql, ...p) => geo().db.prepare(sql).all(...p);
const get = (sql, ...p) => geo().db.prepare(sql).get(...p);

// ---------------------------------------------------------------- RNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (n) => Math.floor(r() * n);
  r.pick = (xs) => xs[r.int(xs.length)];
  r.shuffle = (xs) => { const b = [...xs]; for (let i = b.length - 1; i > 0; i--) { const j = r.int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  r.sample = (xs, k) => r.shuffle(xs).slice(0, k);
  r.weighted = (xs, w = (x) => x.w) => { const tot = xs.reduce((s, x) => s + w(x), 0); let u = r() * tot; for (const x of xs) { u -= w(x); if (u <= 0) return x; } return xs[xs.length - 1]; };
  return r;
}
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

function hav(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------- sampling areas
// Every region of the data (US Northeast cities, San Francisco, Greater London, Singapore).
// Tasks in an area start at its view (#map=13/lat/lon); weights spread tasks across regions.
const AREAS = [
  { id: 'pittsburgh', name: 'Pittsburgh', lat: 40.4406, lon: -79.9959, r: 9000, w: 3 },
  { id: 'manhattan', name: 'Manhattan', lat: 40.758, lon: -73.9855, r: 6000, w: 3 },
  { id: 'brooklyn', name: 'Brooklyn', lat: 40.6782, lon: -73.9442, r: 6000, w: 1.2 },
  { id: 'boston', name: 'Boston', lat: 42.3601, lon: -71.0589, r: 7000, w: 2.5 },
  { id: 'philadelphia', name: 'Philadelphia', lat: 39.9526, lon: -75.1652, r: 7000, w: 2 },
  { id: 'buffalo', name: 'Buffalo', lat: 42.8864, lon: -78.8784, r: 7000, w: 0.8 },
  { id: 'providence', name: 'Providence', lat: 41.824, lon: -71.4128, r: 6000, w: 0.8 },
  { id: 'newhaven', name: 'New Haven', lat: 41.3083, lon: -72.9279, r: 5000, w: 0.6 },
  { id: 'albany', name: 'Albany', lat: 42.6526, lon: -73.7562, r: 6000, w: 0.6 },
  { id: 'rochester', name: 'Rochester', lat: 43.1566, lon: -77.6088, r: 6000, w: 0.6 },
  { id: 'portland', name: 'Portland, Maine', lat: 43.6591, lon: -70.2568, r: 5000, w: 0.5 },
  { id: 'burlington', name: 'Burlington, Vermont', lat: 44.4759, lon: -73.2121, r: 5000, w: 0.4 },
  { id: 'sf', name: 'San Francisco', lat: 37.7749, lon: -122.4194, r: 7000, w: 3 },
  { id: 'london', name: 'London', lat: 51.5072, lon: -0.1276, r: 9000, w: 5 },
  { id: 'singapore', name: 'Singapore', lat: 1.2897, lon: 103.8501, r: 10000, w: 3 },
];
const US = new Set(['pittsburgh', 'manhattan', 'brooklyn', 'boston', 'philadelphia', 'buffalo', 'providence', 'newhaven', 'albany', 'rochester', 'portland', 'burlington', 'sf']);
const areaById = (id) => AREAS.find((a) => a.id === id);
const viewOf = (a, zoom = 13) => `#map=${zoom}/${a.lat.toFixed(4)}/${a.lon.toFixed(4)}`;
const startUrl = (a, zoom) => `__MAP__/${viewOf(a, zoom)}`;
const DEFAULT_START = '__MAP__/#map=15/40.4443/-79.9436';

// ---------------------------------------------------------------- place pools
// Named POIs a person would look up. Classes/types that are not "places" (parking, post boxes,
// bike docks, platforms, apartments ...) are left out.
const AMENITY = new Set(['restaurant', 'cafe', 'fast_food', 'pub', 'bar', 'library', 'pharmacy', 'bank', 'cinema', 'theatre', 'arts_centre',
  'place_of_worship', 'university', 'college', 'hospital', 'community_centre', 'post_office', 'police', 'fire_station', 'townhall',
  'ice_cream', 'nightclub', 'clinic', 'school', 'marketplace', 'courthouse', 'dentist', 'veterinary', 'kindergarten', 'fuel', 'bus_station']);
const TOURISM = new Set(['museum', 'hotel', 'gallery', 'attraction', 'hostel', 'guest_house', 'zoo', 'aquarium', 'viewpoint', 'motel', 'theme_park']);
const LEISURE = new Set(['park', 'garden', 'sports_centre', 'stadium', 'fitness_centre', 'playground', 'nature_reserve', 'swimming_pool', 'golf_course', 'pitch', 'marina']);
const HISTORIC = new Set(['monument', 'castle', 'building', 'church', 'fort', 'ruins', 'archaeological_site']);
function placeClassOk(r) {
  if (r.class === 'amenity') return AMENITY.has(r.type);
  if (r.class === 'tourism') return TOURISM.has(r.type);
  if (r.class === 'leisure') return LEISURE.has(r.type);
  if (r.class === 'historic') return HISTORIC.has(r.type);
  if (r.class === 'shop') return !['vacant', 'yes', 'no'].includes(r.type);
  return false;
}
// Names that survive being quoted in an intent and typed into a search box: Latin letters
// (accents fold in the geocoder), no quotes/semicolons, 4-45 chars, a real word in it.
const NAME_RE = /^[A-Za-z0-9À-ÖØ-öø-ÿ][A-Za-z0-9À-ÖØ-öø-ÿ '&.\-()!+]{2,44}$/; // no commas: names go into lists
const CAT_NORM = new Set();
for (const k of Object.keys(CATS)) for (const p of k.split('|')) CAT_NORM.add(norm(p));
const GENERIC = new Set(['park', 'garden', 'playground', 'church', 'school', 'library', 'cafe', 'pub', 'bar', 'restaurant', 'hotel', 'museum', 'market',
  'pharmacy', 'bank', 'post office', 'police', 'parking', 'pizza', 'deli', 'chinese', 'thai', 'subway', 'starbucks', 'mcdonalds', 'dunkin']);
function nameOk(name) {
  if (!name || !NAME_RE.test(name) || /\s{2}/.test(name)) return false;
  if (!/[A-Za-zÀ-ÿ]{3}/.test(name)) return false;
  const n = norm(name);
  if (!n || CAT_NORM.has(n) || GENERIC.has(n)) return false;
  const content = tokens(name).filter((t) => !STOP.has(t));
  if (!content.length) return false;
  // all-generic words ("The Park", "Main Street Cafe" is fine)
  if (content.every((t) => CAT_NORM.has(t) || GENERIC.has(t))) return false;
  if (/\b(unnamed|untitled|test|todo|fixme)\b/i.test(name)) return false;
  return true;
}

const cache = {};
const once = (k, f) => (k in cache ? cache[k] : (cache[k] = f()));

/** POI rows (geocoder places rows + formatted fields) of an area, sorted by id (deterministic) */
function areaPois(a) {
  return once('pois:' + a.id, () => {
    const dlat = a.r / 111320, dlon = dlat / Math.cos(a.lat * Math.PI / 180);
    const rows = all(`SELECT p.* FROM places_rtree r JOIN places p ON p.id = r.id
      WHERE r.minlon >= ? AND r.maxlon <= ? AND r.minlat >= ? AND r.maxlat <= ? AND p.rank >= 28 AND p.name IS NOT NULL
        AND p.class IN ('amenity', 'tourism', 'leisure', 'historic', 'shop') ORDER BY p.id`, a.lon - dlon, a.lon + dlon, a.lat - dlat, a.lat + dlat);
    return rows.filter((r) => placeClassOk(r) && nameOk(r.name) && hav(a.lat, a.lon, r.lat, r.lon) <= a.r)
      .map((r) => ({ ...r, area: a.id, tags: r.extratags ? JSON.parse(r.extratags) : {} }));
  });
}

/** other places whose (alt) name normalises to the same text */
function sameNamed(p) {
  const want = norm(p.name);
  const toks = tokens(p.name).filter((t) => !STOP.has(t));
  if (!toks.length) return 99;
  const expr = 'name : (' + toks.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' AND ') + ')';
  let n = 0;
  for (const r of all(`SELECT p.id, p.name, p.names FROM places_fts f JOIN places p ON p.id = f.rowid WHERE places_fts MATCH ? LIMIT 2000`, expr)) {
    if (r.id === p.id) continue;
    if (norm(r.name) === want) { n++; continue; }
    if (r.names) { try { if (Object.values(JSON.parse(r.names)).some((v) => norm(v) === want)) n++; } catch { /* ignore */ } }
  }
  return n;
}

/** the geocoder's top hit for a text typed into the search box / a directions field */
const topHit = (text, center) => geo().search(text, { center, limit: 1 })[0] || null;
const isHit = (h, p) => h && h.place_id === p.id;

/**
 * An unambiguous place: no other object anywhere has the same name, and the name typed into the
 * search box (or a From/To field) finds it as the top hit both from a plain page load (CMU
 * ranking) and from the task's view (+ extra centres, e.g. the other end of a route).
 */
function unambiguous(p, centers = []) {
  const k = 'u:' + p.id;
  if (!(k in cache)) {
    const a = areaById(p.area);
    cache[k] = sameNamed(p) === 0 && isHit(topHit(p.name, CMU), p) && isHit(topHit(p.name, [a.lon, a.lat]), p);
  }
  if (!cache[k]) return false;
  return centers.every((c) => isHit(topHit(p.name, c), p));
}

/** a pool of unambiguous POIs of an area matching a filter, shuffled by rng, lazily checked */
function* pick(r, a, filter, centers) {
  for (const p of r.shuffle(areaPois(a).filter(filter))) if (unambiguous(p, centers)) yield p;
}

/**
 * Per-area streams of unambiguous places: next(area) -> place | null (area exhausted).
 * Places already used by this template (`used`) are skipped.
 */
function streams(r, filter, used = new Set()) {
  const m = new Map();
  return (a) => {
    if (!m.has(a.id)) m.set(a.id, pick(r, a, filter));
    for (;;) {
      const x = m.get(a.id).next();
      if (x.done) return null;
      if (!used.has(x.value.id)) return x.value;
    }
  };
}
/**
 * The common sampling loop: pick a weighted area, take the next place of it, `make` it into a
 * task (or null to reject); stop after `max` tasks or too many attempts. make(p, area) may be async.
 */
async function* loop(r, { filter, areas = AREAS, max = 60, tries = 4000, make }) {
  const used = new Set();
  const next = streams(r, filter, used);
  let live = areas.slice();
  let n = 0;
  for (let i = 0; i < tries && n < max && live.length; i++) {
    const a = r.weighted(live);
    const p = next(a);
    if (!p) { live = live.filter((x) => x !== a); continue; }
    used.add(p.id);
    const t = await make(p, a, used);
    if (t) { n++; yield t; }
  }
}

/** the formatted geocoder result of a place row (what the place page shows) */
const fmt = (p) => geo().get(p.id);
/** city-level name of a place for intents ("in Boston") */
function cityOf(p) {
  const f = fmt(p);
  const ad = (f && f.address) || {};
  if (ad.country_code === 'gb') return 'London';
  if (ad.country_code === 'sg') return 'Singapore';
  if (p.area === 'sf' && !ad.city && !ad.town) return 'San Francisco';
  const c = ad.city || ad.town || ad.village || ad.municipality || null;
  return c ? c.replace(/^(City|Town|Village|Borough) of /, '') : null;
}
/**
 * " in <city>" when the name + city typed together ("X, Boston" / "X Boston") still finds the
 * place first, else "" (the intent then names the place alone).
 */
function where(p) {
  const k = 'w:' + p.id;
  if (k in cache) return cache[k];
  const c = cityOf(p);
  const a = areaById(p.area);
  let w = '';
  if (c && !norm(p.name).includes(norm(c)) && [`${p.name}, ${c}`, `${p.name} ${c}`, `${p.name} in ${c}`].every((q) => isHit(topHit(q, CMU), p) && isHit(topHit(q, [a.lon, a.lat]), p))) w = ` in ${c}`;
  return (cache[k] = w);
}
/** human label of a POI kind, e.g. "Cafe", "Fast Food" (the place page's category) */
const typeLabel = (p) => P.typeLabel({ class: p.class, type: p.type, place_rank: p.rank });

// ---------------------------------------------------------------- routing (directions form replica)
let routerP = null;
const router = () => routerP || (routerP = createRouter({ dir: path.join(DATA, 'route'), workers: +process.env.WSB_GEN_ROUTE_WORKERS || 2 }));
const routeCache = new Map();
/** canonical directions coordinates: the form rounds endpoints to 5 decimals (P.llStr) */
const ll5 = (p) => { const s = P.llStr(p).split(','); return { lat: +s[0], lon: +s[1] }; };
/**
 * route(mode, a, b): the route the UI shows for endpoints a, b ({lat, lon}), via the same rounding
 * and the same bike/foot length limit as the site; null if there is no route.
 * -> {meters, secs, min (as shown, rounded), dist (text), time (text), steps}
 */
async function route(mode, a, b) {
  const A = ll5(a), B = ll5(b);
  const k = `${mode}|${A.lat},${A.lon}|${B.lat},${B.lon}`;
  if (routeCache.has(k)) return routeCache.get(k);
  let out = null;
  if (mode === 'car' || hav(A.lat, A.lon, B.lat, B.lon) <= MAX_SLOW_KM * 1000) {
    const R = await router();
    const r = await R.route({ from: [A.lon, A.lat], to: [B.lon, B.lat], profile: mode });
    if (r && r.code === 'Ok') {
      out = { meters: Math.round(r.distance), secs: Math.round(r.duration), min: Math.round(r.duration / 60),
        dist: P.distanceText(r.distance), time: P.durationText(r.duration), steps: r.steps, ferry: (r.steps || []).some((s) => s.mode === 'ferry') };
    }
  }
  routeCache.set(k, out);
  return out;
}
async function closeRouter() { if (routerP) { const R = await routerP; await R.close(); routerP = null; } }

/** canonical directions URL of a route between two places (what the form redirects to) */
function directionsUrl(mode, a, b) {
  const eng = P.engine(mode);
  const u = new URLSearchParams();
  u.set('engine', eng.id);
  u.set('route', `${P.llStr(a)};${P.llStr(b)}`);
  if (a.display_name) u.set('from', a.display_name);
  if (b.display_name) u.set('to', b.display_name);
  return '/directions?' + u.toString().replace(/%2C/g, ',').replace(/%3B/g, ';');
}

// ---------------------------------------------------------------- answer specs (as tasks/map/convert.js)
// durations in minutes: short trips +-1 min, else 10 % (3 % / >= 5 min over 2 h)
function durSpec(min) {
  if (min <= 10) return { value: min, unit: 'min', tol_abs: 1 };
  if (min > 120) return { value: min, unit: 'min', tol_pct: 3, tol_abs: 5 };
  return { value: min, unit: 'min', tol_pct: 10, tol_abs: 1 };
}
const distSpec = (meters) => (meters < 1000 ? { value: meters, unit: 'm', tol_pct: 10, tol_abs: 30 } : { value: +(meters / 1000).toFixed(2), unit: 'km', tol_pct: 10 });
const straightSpec = (meters) => (meters < 1000 ? { value: Math.round(meters), unit: 'm', tol_pct: 10, tol_abs: 20 } : { value: +(meters / 1000).toFixed(2), unit: 'km', tol_pct: 10 });
const fmtMin = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min`);
const fmtDist = (m) => P.distanceText(m);
/** answer text that passes a spec (for self-checks): "12 min", "4.2 km", "40.1234, -79.5" */
function specText(s) {
  if (s.unit === 'min') return fmtMin(s.value);
  if (s.unit === 'm') return `${s.value} m`;
  if (s.unit === 'km') return `${s.value} km`;
  if (s.unit === 'deg') return String(s.value);
  return `${s.value} ${s.unit}`;
}

// street name alternatives: as shown, and with the usual abbreviations ("South Craig Street" |OR| "S Craig St")
const ABBR = [[/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bRoad\b/g, 'Rd'], [/\bBoulevard\b/g, 'Blvd'], [/\bDrive\b/g, 'Dr'],
  [/\bPlace\b/g, 'Pl'], [/\bLane\b/g, 'Ln'], [/\bCourt\b/g, 'Ct'], [/\bSquare\b/g, 'Sq'], [/\bTerrace\b/g, 'Ter'], [/\bParkway\b/g, 'Pkwy'],
  [/\bHighway\b/g, 'Hwy'], [/^North\b/g, 'N'], [/^South\b/g, 'S'], [/^East\b/g, 'E'], [/^West\b/g, 'W'], [/\bSaint\b/g, 'St']];
function streetAlts(s) {
  const alts = new Set([s]);
  let b = s;
  for (const [re, v] of ABBR) b = b.replace(re, v);
  alts.add(b);
  const c = b.replace(/\b(St|Ave|Rd|Blvd|Dr|Pl|Ln|Ct|Sq|Ter|Pkwy|Hwy|N|S|E|W)\b/g, '$1.');
  alts.add(c);
  return [...alts].join(' |OR| ');
}

const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const osmKey = (p) => (p.osm_type || '')[0].toUpperCase() + p.osm_id;
const placeUrl = (p) => P.placeUrl({ osm_type: { N: 'node', W: 'way', R: 'relation' }[p.osm_type] || p.osm_type, osm_id: p.osm_id, place_id: p.id });
const coordsText = (lat, lon) => P.coords(lat, lon);

module.exports = {
  P, MAP, DATA, CMU, geo, all, get, rng, hash, hav, AREAS, US, areaById, viewOf, startUrl, DEFAULT_START,
  areaPois, sameNamed, topHit, isHit, unambiguous, pick, streams, loop, fmt, cityOf, where, typeLabel, nameOk, tokens, norm, STOP, CATS,
  route, closeRouter, directionsUrl, ll5, durSpec, distSpec, straightSpec, fmtMin, fmtDist, specText, streetAlts, lit, osmKey, placeUrl, coordsText,
  once, cache,
};
