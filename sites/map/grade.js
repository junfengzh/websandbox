'use strict';
// Map grader: the kit grader plus three map checks on the final URL (the map site is read-only,
// so WebArena's DOM checks of the last page become checks of the URL the agent ended on;
// ROUTES.md has the URL scheme):
//
//   type 'directions'  eval.directions = { engine: 'car'|'bike'|'foot' (any alias, or a list),
//                        from: {must_include: [...], near: [lat, lon], radius_m}, to: {...} }
//       The final URL is a directions page (/directions?engine=..&route=lat,lon;lat,lon&from=..&to=..,
//       the URL the directions form redirects to). engine = the selected mode (WebArena:
//       select.routing_engines selectedIndex 0 bike / 1 car / 2 foot); from/to.must_include =
//       substrings of the From/To field values (the `from`/`to` params = the geocoded display
//       names, WebArena: route_from/route_to values); near/radius_m (default 500 m) = the route
//       end point lies within that distance of the expected place.
//   type 'place'       eval.place = { osm: ['W25795401', 'R2279034', ...], must_include: [...] }
//       The final URL is a place page (/node|way|relation/<id> or /place/<place_id>); osm = the
//       accepted OSM objects (any), must_include = substrings of its name + address + other
//       names (WebArena: sidebar_content text). Either or both may be given.
//   type 'search'      eval.search = { category: [[class, type], ...], near: [lat, lon], radius_m }
//       The final URL is /search?query=<category> near|around|close to|in <place> (WebArena
//       url_match "/search?query=hotels near carnegie mellon university", but any wording of the
//       category (categories.json) and any name of the place passes: the most important object
//       whose name has all the place words (geocoder name index, via SQL) must lie within
//       radius_m (default 600 m) of `near`).
//
//   grade(task, {answer, url, query, fuzzy}) -> {pass, score, checks}
const kit = require('../../kit');
const P = require('./lib/present');
const { tokens, norm, STOP } = require('./lib/textnorm');
const CATS = require('./lib/categories.json').phrases;

const CAT = new Map();
for (const [k, v] of Object.entries(CATS)) for (const p of k.split('|')) CAT.set(norm(p), v);
const MAP_TYPES = ['directions', 'place', 'search'];

function hav(lat1, lon1, lat2, lon2) {
  const R = 6371008.8, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function parseUrl(u) {
  const s = String(u || '').trim().replace(/^__[A-Z_]+__/, 'http://x');
  try { return new URL(s, 'http://x'); } catch { return null; }
}
const inc = (text, refs) => !refs || !refs.length || kit.grader.mustInclude(text, refs);

function checkDirections(spec, url) {
  const c = { type: 'directions', reference: spec, got: url };
  const u = parseUrl(url);
  if (!u || u.pathname.replace(/\/+$/, '') !== '/directions') return { ...c, pass: false, why: 'not a directions page' };
  const q = u.searchParams;
  const eng = P.engine(q.get('engine')).mode;
  const want = [].concat(spec.engine || []).map((e) => P.engine(e).mode);
  const fails = [];
  if (want.length && !want.includes(eng)) fails.push(`engine ${eng}, want ${want.join('|')}`);
  const ends = P.parseRoute(q.get('route'));
  for (const [i, side] of ['from', 'to'].entries()) {
    const s = spec[side];
    if (!s) continue;
    const end = ends[i];
    if (!end) { fails.push(`no ${side} point`); continue; }
    const name = q.get(side) || '';
    if (s.must_include && !inc(name, s.must_include)) fails.push(`${side} "${name}" lacks ${JSON.stringify(s.must_include)}`);
    if (s.near) {
      const d = hav(end.lat, end.lon, s.near[0], s.near[1]);
      if (d > (s.radius_m || 500)) fails.push(`${side} point ${Math.round(d)} m from the expected place`);
    }
  }
  return { ...c, pass: !fails.length, why: fails.join('; ') || undefined };
}

const T = { node: 'N', way: 'W', relation: 'R' };
async function checkPlace(spec, url, query) {
  const c = { type: 'place', reference: spec, got: url };
  const u = parseUrl(url);
  const m = u && /^\/(node|way|relation)\/(\d+)\/?$/.exec(u.pathname);
  const mp = u && /^\/place\/(\d+)\/?$/.exec(u.pathname);
  if (!m && !mp) return { ...c, pass: false, why: 'not a place page' };
  const fails = [];
  const key = m ? T[m[1]] + m[2] : null;
  if (spec.osm && spec.osm.length && !(key && spec.osm.includes(key))) fails.push(`object ${key || 'place ' + mp[1]} not in ${spec.osm.join(', ')}`);
  if (spec.must_include) {
    if (!query) throw new Error('grader: place.must_include needs a query function');
    const rows = m
      ? await query(`SELECT name, display_name, names FROM places WHERE osm_type = '${T[m[1]]}' AND osm_id = ${+m[2]} ORDER BY rank LIMIT 1`)
      : await query(`SELECT name, display_name, names FROM places WHERE id = ${+mp[1]}`);
    const r = rows[0];
    if (!r) fails.push('object not in the geocoder');
    else {
      const v = Array.isArray(r) ? r : [r.name, r.display_name, r.names];
      let names = '';
      try { names = Object.values(JSON.parse(v[2] || '{}')).join(' | '); } catch { /* ignore */ }
      const text = [v[0], v[1], names].filter(Boolean).join(' | ');
      c.page = text;
      if (!inc(text, spec.must_include)) fails.push(`page lacks ${JSON.stringify(spec.must_include)}`);
    }
  }
  return { ...c, pass: !fails.length, why: fails.join('; ') || undefined };
}

const NEAR_RE = /^(.*?)\s+(?:near(?:by)?|around|close to|next to|by|at|in)\s+(.+)$/i;
const ftsq = (toks) => toks.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' AND ');
async function checkSearch(spec, url, query) {
  const c = { type: 'search', reference: spec, got: url };
  const u = parseUrl(url);
  if (!u || u.pathname.replace(/\/+$/, '') !== '/search') return { ...c, pass: false, why: 'not a search page' };
  const text = (u.searchParams.get('query') ?? u.searchParams.get('q') ?? '').trim();
  const m = NEAR_RE.exec(text);
  if (!m) return { ...c, pass: false, why: `query "${text}" is not "<category> near <place>"` };
  const fails = [];
  const cat = CAT.get(norm(m[1]).replace(/\b(the|a|an|some|any|all)\b/g, '').trim().replace(/\s+/g, ' ')) || [];
  const want = spec.category || [];
  if (want.length && !cat.some(([k, t]) => want.some(([wk, wt]) => wk === k && (!wt || wt === t)))) fails.push(`"${m[1]}" is not the category ${JSON.stringify(want)}`);
  if (spec.near) {
    const toks = tokens(m[2]).filter((t) => !STOP.has(t));
    if (!toks.length) fails.push('no place');
    else {
      if (!query) throw new Error('grader: search.near needs a query function');
      // the most important object with all the place words in its name (the geocoder's pick
      // without a map view) must lie within radius_m of the expected place
      const rows = await query(`SELECT p.name, p.lat, p.lon FROM places_fts f JOIN places p ON p.id = f.rowid
        WHERE places_fts MATCH 'name : (${ftsq(toks).replace(/'/g, "''")})' ORDER BY p.importance DESC, p.rank LIMIT 1`);
      const r = rows[0] && (Array.isArray(rows[0]) ? { name: rows[0][0], lat: rows[0][1], lon: rows[0][2] } : rows[0]);
      const n = r ? Math.round(hav(r.lat, r.lon, spec.near[0], spec.near[1])) : null;
      c.place_match = r ? `${r.name} (${n} m)` : null;
      if (r && n > (spec.radius_m || 600)) fails.push(`"${m[2]}" is ${r.name}, ${n} m from the expected place`);
      if (!r) fails.push(`"${m[2]}" names no place`);
    }
  }
  return { ...c, pass: !fails.length, why: fails.join('; ') || undefined };
}

async function grade(task, input = {}) {
  const ev = task.eval || task;
  let types = ev.type ? [].concat(ev.type) : [];
  if (!types.length) for (const t of MAP_TYPES) if (ev[t]) types.push(t);
  const own = types.filter((t) => MAP_TYPES.includes(t));
  const rest = types.filter((t) => !MAP_TYPES.includes(t));
  const checks = [];
  if (rest.length) {
    const t = { ...task, eval: { ...ev, type: rest } };
    checks.push(...(await kit.grader.grade(t, input)).checks);
  }
  for (const t of own) {
    try {
      if (t === 'directions') checks.push(checkDirections(ev.directions || {}, input.url));
      else if (t === 'place') checks.push(await checkPlace(ev.place || {}, input.url, input.query));
      else checks.push(await checkSearch(ev.search || {}, input.url, input.query));
    } catch (e) {
      checks.push({ type: t, pass: false, error: String(e.message || e) });
    }
  }
  const pass = !checks.length ? false : checks.some((c) => c.pass === false) ? false : checks.some((c) => c.pass == null) ? null : true;
  return { pass, score: pass === true ? 1 : 0, checks };
}

module.exports = grade;
module.exports.grade = grade;
module.exports.checkDirections = checkDirections;
module.exports.checkPlace = checkPlace;
module.exports.checkSearch = checkSearch;
