'use strict';
// Geocoder for the map site (Nominatim-like) on the SQLite DB built by build/build_geocode.py.
//
//   const { Geocoder } = require('./geocode');
//   const g = new Geocoder('$WSB_DATA_ROOT/map/geocode.db');
//   g.search('starbucks craig street', { center: [lon, lat], limit: 10 });
//   g.search('restaurants near Carnegie Mellon University');
//   g.search('401 Shady Ave, Pittsburgh');
//   g.autocomplete('carnegie mel', { center });
//   g.reverse(lat, lon, { zoom: 18 });
//   g.nearby(lat, lon, { category: 'cafe', radius: 1000 });
//   g.get(placeId);  g.lookup('W', 123);
//
// Results look like Nominatim's jsonv2 output: { place_id, osm_type, osm_id, lat, lon, class, type,
// name, display_name, importance, boundingbox: [minlat, maxlat, minlon, maxlon], address: {...},
// extratags: {...}, distance (m, when a reference point was given) }.

const path = require('path');
const Database = require('better-sqlite3');
const { tokens, norm, prefixCanon, STOP } = require('./textnorm');
const CATS = require('./categories.json').phrases;

const DEFAULT_DB = process.env.WSB_MAP_DATA ? path.join(process.env.WSB_MAP_DATA, 'geocode.db')
  : '$WSB_DATA_ROOT/map/geocode.db';
const OSM_TYPE = { N: 'node', W: 'way', R: 'relation', P: 'postcode' };

// phrase (normalised) -> [[class, type], ...]
const CAT = new Map();
for (const [k, v] of Object.entries(CATS)) for (const p of k.split('|')) CAT.set(norm(p), v);
const KEY_RANK = { neighbourhood: 24, quarter: 22, suburb: 20, hamlet: 20, borough: 20, city_district: 19, village: 19,
  town: 18, island: 17, city: 16, municipality: 14, county: 12, state_district: 10, state: 8 };
const LOW_CLASSES = new Set(['public_transport', 'railway', 'highway:bus_stop', 'man_made', 'amenity:parking_entrance']);
const CAT_WORDS = new Set(['theatre', 'theater', 'cinema', 'movie', 'restaurant', 'cafe', 'coffee', 'hotel', 'store', 'shop',
  'market', 'supermarket', 'station', 'museum', 'park', 'library', 'hospital', 'pharmacy', 'bar', 'pub', 'mall', 'center', 'ctr']);
const GENERIC_WORDS = new Set(['building', 'bldg', 'hall', 'place', 'location', 'office', 'the', 'grocery', 'groceries', 'food', 'foods']);
const MAX_CAT_WORDS = Math.max(...[...CAT.keys()].map((k) => k.split(' ').length));

function hav(lon1, lat1, lon2, lat2) {
  const R = 6371008.8, d = Math.PI / 180;
  const dp = (lat2 - lat1) * d, dl = (lon2 - lon1) * d;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
const q = (t) => '"' + t.replace(/"/g, '""') + '"';

// US state codes after a comma or at the end ("Scranton, PA", "Bridgeport CT") -> full names
// (addresses carry the full state name; "ct" would otherwise fold to "court")
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
// a few colloquial city names
const CITY_ALIASES = { nyc: 'New York', philly: 'Philadelphia' };
function expandStates(qs) {
  qs = qs.replace(/\b(nyc|philly)\b/gi, (m) => CITY_ALIASES[m.toLowerCase()]);
  return qs.replace(/(,\s*|\s)([A-Za-z]{2})(?=\s*(?:,|\d{5}(?:-\d{4})?)?\s*(?:,\s*(?:USA?|United States))?\s*$|\s*,)/g, (m, pre, code, off) => {
    const st = STATES[code.toUpperCase()];
    // a bare trailing code needs a comma before it or an upper-case code ("Bridgeport CT", not "Penn ct")
    if (!st || (!pre.includes(',') && code !== code.toUpperCase()) || off === 0) return m;
    return pre + st;
  });
}

class Geocoder {
  constructor(dbPath = DEFAULT_DB) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma('cache_size = -64000');
    this.combos = new Map();
    const P = (s) => this.db.prepare(s);
    this.st = {
      combo: P('SELECT * FROM combos WHERE id = ?'),
      place: P('SELECT * FROM places WHERE id = ?'),
      osm: P('SELECT * FROM places WHERE osm_type = ? AND osm_id = ? ORDER BY rank LIMIT 1'),
      fts: P(`SELECT rowid AS id, bm25(places_fts, 10.0, 2.0, 1.0) AS score FROM places_fts WHERE places_fts MATCH ? ORDER BY rank LIMIT ?`),
      ftsBox: P(`SELECT f.rowid AS id, bm25(places_fts, 10.0, 2.0, 1.0) AS score FROM places_fts f
                 JOIN places_rtree r ON r.id = f.rowid
                 WHERE places_fts MATCH ? AND r.minlon >= ? AND r.maxlon <= ? AND r.minlat >= ? AND r.maxlat <= ?
                 ORDER BY rank LIMIT ?`),
      box: P(`SELECT p.* FROM places_rtree r JOIN places p ON p.id = r.id
              WHERE r.minlon >= ? AND r.maxlon <= ? AND r.minlat >= ? AND r.maxlat <= ?`),
      // same, filtered in SQL by "class:type" / class (JSON lists): ~10x faster for wide boxes
      boxCls: P(`SELECT p.* FROM places_rtree r JOIN places p ON p.id = r.id
              WHERE r.minlon >= ? AND r.maxlon <= ? AND r.minlat >= ? AND r.maxlat <= ?
                AND ((p.class || ':' || p.type) IN (SELECT value FROM json_each(?)) OR p.class IN (SELECT value FROM json_each(?)))`),
      addrByStreet: P('SELECT * FROM addresses WHERE street_id = ? AND hn_key = ?'),
      addrNumbers: P('SELECT * FROM addresses WHERE street_id = ?'),
      addrById: P('SELECT * FROM addresses WHERE street_id = ? AND id = ?'),
      ways: P(`SELECT w.id, w.street_id, w.coords FROM street_ways_rtree r JOIN street_ways w ON w.id = r.id
               WHERE r.maxlon >= ? AND r.minlon <= ? AND r.maxlat >= ? AND r.minlat <= ?`),
      meta: P("SELECT value FROM meta WHERE key = 'info'"),
    };
    const m = this.st.meta.get();
    this.meta = m ? JSON.parse(m.value) : {};
  }

  close() { this.db.close(); }

  // ------------------------------------------------------------------ formatting
  combo(id) {
    let c = this.combos.get(id);
    if (!c) {
      const r = this.st.combo.get(id);
      c = r ? { parts: JSON.parse(r.parts), country: r.country, country_code: r.country_code, region: r.region, postcode: r.postcode }
        : { parts: [], country: null };
      if (this.combos.size > 50000) this.combos.clear();
      this.combos.set(id, c);
    }
    return c;
  }
  _address(row) {
    const c = this.combo(row.combo);
    const a = {};
    if (row.name && row.class !== 'highway' && row.class !== 'boundary' && row.class !== 'place') a[row.type] = row.name;
    if (row.housenumber) a.house_number = row.housenumber;
    if (row.street) a.road = row.street;
    else if (row.class === 'highway') a.road = row.name;
    for (const [k, nm] of c.parts) {
      if (row.rank < 26 && (KEY_RANK[k] || 30) >= row.rank) continue;
      if (!(k in a)) a[k] = nm;
    }
    if (row.postcode || c.postcode) a.postcode = row.postcode || c.postcode;
    if (c.country) a.country = c.country;
    if (c.country_code) a.country_code = c.country_code;
    return a;
  }
  _fmt(row, ref) {
    const out = {
      place_id: row.id, osm_type: OSM_TYPE[row.osm_type] || row.osm_type, osm_id: row.osm_id,
      lat: row.lat, lon: row.lon, class: row.class, type: row.type, category: row.class,
      place_rank: row.rank, importance: row.importance, addresstype: row.type,
      name: row.name || '', display_name: row.display_name,
      boundingbox: [row.minlat, row.maxlat, row.minlon, row.maxlon],
      address: this._address(row),
      extratags: row.extratags ? JSON.parse(row.extratags) : {},
      namedetails: row.names ? JSON.parse(row.names) : {},
    };
    if (ref) out.distance = Math.round(hav(ref[0], ref[1], row.lon, row.lat) * 10) / 10;
    return out;
  }
  _fmtAddress(a, ref) {
    const street = a.street_id ? this.st.place.get(a.street_id) : null;
    const c = this.combo(a.combo != null ? a.combo : street ? street.combo : -1);
    const lat = a.lat_e7 / 1e7, lon = a.lon_e7 / 1e7;
    a = { ...a, lat, lon, postcode: a.postcode || (street ? street.postcode : null) };
    const streetName = a.street || (street && street.name) || '';
    if (a.place_id) {
      const p = this.st.place.get(a.place_id);
      if (p) return this._fmt(p, ref);
    }
    const parts = [a.housenumber, streetName, ...c.parts.map((x) => x[1])];
    const pc = a.postcode || c.postcode;
    if (pc) parts.push(pc);
    if (c.country) parts.push(c.country);
    const address = { house_number: a.housenumber, road: streetName };
    for (const [k, nm] of c.parts) if (!(k in address)) address[k] = nm;
    if (pc) address.postcode = pc;
    if (c.country) address.country = c.country;
    if (c.country_code) address.country_code = c.country_code;
    const out = {
      place_id: `a:${a.street_id}:${a.id}`, osm_type: null, osm_id: null,
      lat: a.lat, lon: a.lon, class: 'place', type: 'house', category: 'place', place_rank: 30, importance: 0,
      addresstype: 'place', name: '', display_name: parts.filter(Boolean).join(', '),
      boundingbox: [a.lat, a.lat, a.lon, a.lon], address, extratags: {}, namedetails: {},
    };
    if (a.interpolated) out.extratags.interpolated = 'yes';
    if (ref) out.distance = Math.round(hav(ref[0], ref[1], a.lon, a.lat) * 10) / 10;
    return out;
  }

  // ------------------------------------------------------------------ lookups
  get(placeId) {
    const m = String(placeId).match(/^a:(\d+):(\d+)$/);   // house-number results
    if (m) {
      const a = this.st.addrById.get(+m[1], +m[2]);
      return a ? this._fmtAddress(a) : null;
    }
    const r = this.st.place.get(placeId);
    return r ? this._fmt(r) : null;
  }
  lookup(osmType, osmId) {
    const t = String(osmType)[0].toUpperCase();
    const r = this.st.osm.get(t, osmId);
    return r ? this._fmt(r) : null;
  }

  // ------------------------------------------------------------------ search
  /**
   * Forward search. opts: limit (10), center [lon,lat] or viewbox [minlon,minlat,maxlon,maxlat]
   * (ranking boost by proximity), bounded (only inside viewbox), autocomplete (prefix match of the
   * last word), countrycodes ['us', ...]. (_search: nameOnly = all words in the name only.)
   */
  search(query, opts = {}) {
    const limit = opts.limit || 10;
    const qs = expandStates(String(query || '').trim());
    if (!qs) return [];
    const ref = this._ref(opts);
    // "X near Y", "X around Y", "X close to Y", "X nearby Y"
    let m = qs.match(/^(.*?)\s+(?:near(?:by)?|around|close to|next to|by|at)\s+(.+)$/i);
    if (m) {
      const r = this._nearQuery(m[1], m[2], limit, opts, false);
      if (r) return r;
    }
    m = qs.match(/^(.*?)\s+in\s+(.+)$/i);
    if (m && this._category(m[1])) {
      const r = this._nearQuery(m[1], m[2], limit, opts, true);
      if (r) return r;
    }
    // bare category: near the map view
    const cat = this._category(qs);
    if (cat) {
      if (ref) return this.nearby(ref[1], ref[0], { classes: cat, limit, radius: 2000, maxRadius: 50000 });
    }
    // category + place without "near"/"in": "hotels pittsburgh", "pittsburgh hotels"
    const toks = tokens(qs);
    for (let k = Math.min(MAX_CAT_WORDS, toks.length - 1); k >= 1; k--) {
      const head = toks.slice(0, k).join(' '), tail = toks.slice(k).join(' ');
      const tailHead = toks.slice(toks.length - k).join(' '), rest = toks.slice(0, toks.length - k).join(' ');
      for (const [c, loc] of [[head, tail], [tailHead, rest]]) {
        const cc = CAT.get(c);
        if (!cc) continue;
        const l = this._bestPlace(loc, opts, 22);
        if (l) {
          const named = this._search(qs, opts, limit);
          const strong = named.filter((x) => x._cov >= 1);
          if (strong.length) return strong.slice(0, limit).map(clean);
          return this.nearby(l.lat, l.lon, { classes: cc, limit, radius: 1000, maxRadius: 20000, within: l });
        }
      }
    }
    const hn = this._houseNumberSearch(qs, opts, limit);
    if (hn && hn.length) return hn;
    let res = this._search(qs, opts, limit);
    if (!res.length && !opts.autocomplete) res = this._search(qs, { ...opts, autocomplete: true }, limit);
    if (!res.length && cat) return this.nearby((ref || [0, 0])[1], (ref || [0, 0])[0], { classes: cat, limit, radius: 5000 });
    if (!res.length) {
      // "AMC theatre pittsburgh": drop category words the name does not contain, keep them as a preference
      const words = toks.filter((t) => !CAT_WORDS.has(t));
      if (words.length && words.length < toks.length) {
        const catHits = toks.map((t) => CAT.get(t)).filter(Boolean).flat();
        res = this._search(words.join(' '), opts, limit * 3);
        if (catHits.length) res.sort((a, b) => (catHits.some(([c, t]) => a.class === c && a.type === t) ? 0 : 1)
          - (catHits.some(([c, t]) => b.class === c && b.type === t) ? 0 : 1));
      }
    }
    // nothing has all the words in its name ("CMU Hunt library", "AMC theatre pittsburgh"):
    // try <name words> + <place words>
    if (!res.length || !this._covers(res[0], toks)) res = this._nameNearPlace(toks, opts, limit) || res;
    return res.slice(0, limit).map(clean);
  }

  /** every content word of the query is in the result's name(s) or address */
  _covers(r, toks) {
    const have = new Set(tokens(r.display_name));
    for (const v of Object.values(r.namedetails || {})) for (const t of tokens(v)) have.add(t);
    return toks.filter((t) => !STOP.has(t)).every((t) => have.has(t));
  }

  /**
   * Last resort for "<name words> <place>" where the place is not in the object's address
   * ("AMC theatre pittsburgh" -> AMC Waterfront 22 in West Homestead, "gates building CMU" ->
   * Gates and Hillman Centers): the trailing words name a place, the leading words (minus
   * generic words such as theatre/building) are searched in names near it (within 30 km).
   */
  _nameNearPlace(toks, opts, limit) {
    const words = toks.filter((t) => !STOP.has(t));
    if (words.length > 6) return null;
    const tries = [];
    // name ... place (place of up to 3 words), then a short place first ("CMU gates building")
    for (let k = words.length - 1; k >= Math.max(1, words.length - 3); k--) tries.push([words.slice(0, k), words.slice(k), true]);
    for (let k = 1; k <= Math.min(2, words.length - 1); k++) tries.push([words.slice(k), words.slice(0, k), true]);
    // prefer the split that matches the most name words ("CMU Hunt library": name "hunt library"
    // near "CMU", not name "CMU" near "Hunt Library")
    let best = null;
    const places = new Map();
    for (const [h, p, strip] of tries) {
      if (best && h.length <= best.n) continue;
      const pq = p.join(' ');
      if (!places.has(pq)) places.set(pq, this._bestPlace(pq, { ...opts, nameOnly: true }, 30));
      const loc = places.get(pq);
      if (!loc) continue;
      // the name words as typed ("posner hall"), else without generic words ("gates building" -> "gates")
      const heads = strip ? [h, h.filter((t) => !CAT_WORDS.has(t) && !GENERIC_WORDS.has(t))] : [h];
      for (const head of heads) {
        if (!head.length) continue;
        const hq = head.join(' ');
        // POIs only (no streets / areas): "Carnegie Music Hall in New York" must not become
        // "New York Street" near Carnegie Music Hall
        const res = this._search(hq, { ...opts, center: [loc.lon, loc.lat], proximityKm: 3, nameOnly: true }, 200)
          .filter((x) => x._cov >= 1 && x.distance <= 30000 && x.place_id !== loc.place_id && x.place_rank >= 28 && x.class !== 'highway');
        if (!res.length) continue;
        // ... and the name words must not be a city/state themselves ("Lash New York" for "... in New York")
        if (this._search(hq, { ...opts, nameOnly: true }, 3).some((x) => x._cov >= 1 && x.place_rank <= 16 && norm(x.name) === hq)) continue;
        best = { n: h.length, res: res.slice(0, limit) };
        break;
      }
    }
    return best ? best.res : null;
  }

  /** prefix search for search-as-you-type */
  autocomplete(query, opts = {}) {
    const res = this._search(query, { ...opts, autocomplete: true }, opts.limit || 8);
    return res.slice(0, opts.limit || 8).map(clean);
  }

  _ref(opts) {
    if (opts.center) return opts.center;
    if (opts.viewbox) { const v = opts.viewbox; return [(v[0] + v[2]) / 2, (v[1] + v[3]) / 2]; }
    return null;
  }
  _category(s) { return CAT.get(norm(s).replace(/\b(the|a|an|some|any|all)\b/g, '').trim().replace(/\s+/g, ' ')) || null; }

  _bestPlace(locq, opts, maxRank = 30) {
    const r = this._search(locq, opts, 5).filter((x) => x._cov >= 1 && x.place_rank <= maxRank);
    return r[0] || null;
  }

  _nearQuery(what, where, limit, opts, inside) {
    const loc = this._search(where, opts, 5)[0];
    if (!loc) return null;
    const cat = this._category(what);
    if (cat) {
      const r = this.nearby(loc.lat, loc.lon, { classes: cat, limit, radius: inside ? 3000 : 1000, maxRadius: inside ? 30000 : 10000, within: inside ? loc : null });
      // rare categories ("airports near CMU"): look further rather than finding nothing
      if (!r.length && !inside) return this.nearby(loc.lat, loc.lon, { classes: cat, limit, radius: 25000, maxRadius: 50000 });
      return r;
    }
    // a name near a place: rank name matches by distance to the place
    // (within 30 km of the place; "gates building at CMU" -> "gates" if "gates building" is not there)
    const wt = tokens(what).filter((t) => !STOP.has(t));
    let res = [];
    for (const w of [what, wt.filter((t) => !CAT_WORDS.has(t) && !GENERIC_WORDS.has(t)).join(' ')]) {
      if (!w) continue;
      res = this._search(w, { ...opts, center: [loc.lon, loc.lat], proximityKm: 2 }, 50)
        .filter((x) => x._cov >= 1 && x.distance <= 30000);
      if (res.length) break;
    }
    if (!res.length) return null;
    res.sort((a, b) => a.distance - b.distance);
    return res.slice(0, limit).map(clean);
  }

  _ftsExpr(toks, autocomplete, col) {
    const parts = toks.map((t, i) => {
      if (autocomplete && i === toks.length - 1) {
        const alts = [q(t) + '*', ...prefixCanon(t).map(q)];
        return alts.length > 1 ? '(' + alts.join(' OR ') + ')' : alts[0];
      }
      return q(t);
    });
    const e = parts.join(' AND ');
    return col ? `${col} : (${e})` : e;
  }

  _candidates(expr, ref, n) {
    const out = new Map();
    try {
      for (const r of this.st.fts.all(expr, n)) out.set(r.id, r.score);
      if (ref) {
        const d = 0.25;
        for (const r of this.st.ftsBox.all(expr, ref[0] - d / Math.cos(ref[1] * Math.PI / 180), ref[0] + d / Math.cos(ref[1] * Math.PI / 180), ref[1] - d, ref[1] + d, n)) {
          out.set(r.id, r.score);
        }
      }
    } catch (e) {
      if (!/fts5|syntax/i.test(e.message)) throw e;
    }
    return out;
  }

  _search(query, opts, limit) {
    const ref = this._ref(opts);
    const segs = String(query).split(',').map((s) => s.trim()).filter(Boolean);
    let toks = tokens(query);
    const content = toks.filter((t) => !STOP.has(t));
    if (content.length) toks = content;
    if (!toks.length) return [];
    const ac = !!opts.autocomplete;
    const cand = new Map();
    const add = (m) => { for (const [id, s] of m) if (!cand.has(id) || cand.get(id) > s) cand.set(id, s); };
    // 1. all words in the name
    add(this._candidates(this._ftsExpr(toks, ac, 'name'), ref, 200));
    // 2. name = leading words, address = the rest (comma split first)
    if (segs.length > 1 && !opts.nameOnly) {
      const nt = tokens(segs[0]).filter((t) => !STOP.has(t));
      const at = tokens(segs.slice(1).join(' ')).filter((t) => !STOP.has(t));
      if (nt.length && at.length) add(this._candidates(this._ftsExpr(nt, false, 'name') + ' AND ' + this._ftsExpr(at, ac, '{addr name}'), ref, 200));
    }
    if (cand.size < limit && toks.length > 1 && !opts.nameOnly) {
      for (let k = toks.length - 1; k >= 1 && cand.size < limit * 3; k--) {
        add(this._candidates(this._ftsExpr(toks.slice(0, k), false, 'name') + ' AND ' + this._ftsExpr(toks.slice(k), ac, '{addr cat}'), ref, 200));
      }
    }
    // 3. anything (name, address, category words)
    if (cand.size < limit && !opts.nameOnly) add(this._candidates(this._ftsExpr(toks, ac, null), ref, 200));
    const rows = [];
    for (const id of cand.keys()) {
      const r = this.st.place.get(id);
      if (r) rows.push(r);
    }
    const viewbox = opts.viewbox;
    const scored = [];
    const qset = toks;
    const seg0 = segs.length > 1 ? tokens(segs[0]).filter((t) => !STOP.has(t)).join(' ') : null;
    for (const r of rows) {
      if (opts.countrycodes) {
        const c = this.combo(r.combo);
        if (c.country_code && !opts.countrycodes.includes(c.country_code)) continue;
      }
      if (opts.bounded && viewbox && !(r.lon >= viewbox[0] && r.lon <= viewbox[2] && r.lat >= viewbox[1] && r.lat <= viewbox[3])) continue;
      const nameToks = new Set();
      for (const t of tokens(r.name)) nameToks.add(t);
      if (r.names) for (const v of Object.values(JSON.parse(r.names))) for (const t of tokens(v)) nameToks.add(t);
      let inName = 0;
      qset.forEach((t, i) => {
        if (nameToks.has(t)) inName++;
        else if (ac && i === qset.length - 1 && [...nameToks].some((n) => n.startsWith(t))) inName++;
      });
      const mainToks = tokens(r.name);
      const cov = inName / qset.length;
      const qn = qset.join(' ');
      // exact name: the whole query, or its first comma segment ("Scranton, Pennsylvania")
      let exact = norm(r.name) === qn || (seg0 && norm(r.name) === seg0) ? 1 : 0;
      if (!exact && r.names) {
        for (const v of Object.values(JSON.parse(r.names))) if (String(v).split(';').some((x) => norm(x) === qn)) { exact = 0.9; break; }
      }
      const extra = Math.max(0, mainToks.length - inName);
      let s = 2 * cov + 1.2 * exact - 0.08 * extra + 1.5 * r.importance;
      if (LOW_CLASSES.has(r.class) || LOW_CLASSES.has(r.class + ':' + r.type)) s -= 0.2;
      let dist = null;
      if (ref) {
        dist = hav(ref[0], ref[1], r.lon, r.lat);
        const km = opts.proximityKm || 15;
        s += 0.6 * Math.exp(-dist / 1000 / km);
      }
      if (viewbox && r.lon >= viewbox[0] && r.lon <= viewbox[2] && r.lat >= viewbox[1] && r.lat <= viewbox[3]) s += 0.3;
      const f = this._fmt(r, ref);
      // big settlements before same-named states/counties (Nominatim gets this from Wikipedia importance)
      if ((r.class === 'boundary' || r.class === 'place') && r.rank >= 10 && r.rank <= 18 &&
          +String(f.extratags.population || '0').replace(/[^0-9]/g, '') >= 100000) s += 0.15;
      f._score = s;
      f._cov = cov;
      scored.push(f);
    }
    scored.sort((a, b) => b._score - a._score);
    // de-duplicate identical display names (Nominatim does the same)
    const seen = new Set(), out = [];
    for (const f of scored) {
      const k = f.display_name + '|' + f.class;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(f);
      if (out.length >= Math.max(limit, 10)) break;
    }
    return out;
  }

  _houseNumberSearch(qs, opts, limit) {
    // "5000 Fifth Avenue, Pittsburgh" / "401 Shady Ave" / "Shady Ave 401"
    const m = qs.match(/^\s*(\d+[a-zA-Z]?(?:-\d+)?)\s*,?\s+(.+)$/) || qs.match(/^(.+?)\s+(\d+[a-zA-Z]?)\s*(?:,(.*))?$/);
    if (!m) return null;
    let hn, rest;
    if (/^\s*\d/.test(qs)) { hn = m[1]; rest = m[2]; } else { hn = m[2]; rest = m[1] + (m[3] ? ', ' + m[3] : ''); }
    const segs = rest.split(',').map((s) => s.trim()).filter(Boolean);
    const stoks = tokens(segs[0]).filter((t) => !STOP.has(t));
    const ltoks = tokens(segs.slice(1).join(' ')).filter((t) => !STOP.has(t));
    if (!stoks.length) return null;
    const ref = this._ref(opts);
    // streets matching the street words (+ locality words in the address column)
    const ids = new Map();
    const tryExpr = (e) => { for (const [id, s] of this._candidates(e, ref, 300)) ids.set(id, s); };
    if (ltoks.length) tryExpr(this._ftsExpr(stoks, false, 'name') + ' AND ' + this._ftsExpr(ltoks, !!opts.autocomplete, '{addr}'));
    if (!ids.size) {
      // locality might be glued to the street part ("401 shady ave pittsburgh")
      for (let k = stoks.length; k >= 1 && !ids.size; k--) {
        const st = stoks.slice(0, k), loc = stoks.slice(k).concat(ltoks);
        tryExpr(this._ftsExpr(st, k === stoks.length && !!opts.autocomplete, 'name') + (loc.length ? ' AND ' + this._ftsExpr(loc, !!opts.autocomplete, '{addr}') : ''));
      }
    }
    const streets = [];
    for (const id of ids.keys()) {
      const r = this.st.place.get(id);
      if (r && r.class === 'highway' && norm(r.name).split(' ').every((t) => stoks.includes(t) || STOP.has(t))) streets.push(r);
    }
    if (!streets.length) return null;
    // rank streets: proximity to ref, then importance
    if (ref) streets.sort((a, b) => hav(ref[0], ref[1], a.lon, a.lat) - hav(ref[0], ref[1], b.lon, b.lat));
    else streets.sort((a, b) => b.importance - a.importance);
    const hnn = String(hn).toLowerCase().replace(/ /g, '');
    const out = [];
    for (const s of streets.slice(0, 30)) {
      for (const a of this.st.addrByStreet.all(s.id, hnn)) out.push(this._fmtAddress(a, ref));
    }
    if (!out.length) {
      // closest house number with the same parity on the best street (approximate, like interpolation)
      const target = parseInt(hn, 10);
      let best = null;
      for (const s of streets.slice(0, 10)) {
        for (const a of this.st.addrNumbers.all(s.id)) {
          const v = parseInt(a.housenumber, 10);
          if (a.place_id) continue;
          if (Number.isNaN(v)) continue;
          const d = Math.abs(v - target) + ((v - target) % 2 ? 1000 : 0);
          if (!best || d < best.d) best = { d, a, s };
        }
        if (best) break;
      }
      if (best && best.d < 400) {
        const f = this._fmtAddress({ ...best.a, place_id: null, housenumber: hn }, ref);
        f.extratags.approximate = 'yes';
        out.push(f);
      } else {
        out.push(this._fmt(streets[0], ref));
      }
    }
    const seen = new Set();
    return out.filter((f) => (seen.has(f.display_name) ? false : seen.add(f.display_name))).slice(0, limit);
  }

  // ------------------------------------------------------------------ nearby / reverse
  /**
   * POIs of a category around a point, nearest first.
   * opts: category (phrase, e.g. 'cafe', 'supermarket') or classes [[class, type], ...] or
   * class/type strings; radius (m, default 1000) grows x2 up to maxRadius until `limit` results;
   * name (optional substring filter); within (a result whose bbox limits the search).
   */
  nearby(lat, lon, opts = {}) {
    let classes = opts.classes;
    if (!classes && opts.category) classes = this._category(opts.category);
    if (!classes && opts.class) classes = [[opts.class, opts.type || null]];
    const limit = opts.limit || 10;
    let radius = opts.radius || 1000;
    const maxRadius = Math.max(radius, opts.maxRadius || 10000);
    const nameFilter = opts.name ? norm(opts.name) : null;
    let res = [];
    for (;;) {
      const dlat = radius / 111320, dlon = dlat / Math.cos(lat * Math.PI / 180);
      const rows = classes
        ? this.st.boxCls.all(lon - dlon, lon + dlon, lat - dlat, lat + dlat, JSON.stringify(classes.filter(([, t]) => t).map(([c, t]) => c + ':' + t)), JSON.stringify(classes.filter(([, t]) => !t).map(([c]) => c)))
        : this.st.box.all(lon - dlon, lon + dlon, lat - dlat, lat + dlat);
      res = [];
      for (const r of rows) {
        if (classes && !classes.some(([c, t]) => r.class === c && (!t || r.type === t))) continue;
        if (nameFilter && !norm(r.name).includes(nameFilter)) continue;
        const d = hav(lon, lat, r.lon, r.lat);
        if (d > radius) continue;
        res.push([d, r]);
      }
      if (res.length >= limit || radius >= maxRadius) break;
      radius = Math.min(maxRadius, radius * 2);
    }
    res.sort((a, b) => a[0] - b[0]);
    return res.slice(0, limit).map(([d, r]) => this._fmt(r, [lon, lat]));
  }

  /** Reverse geocoding (Nominatim-like). zoom >= 17: building/POI/address or street; 14-16 street; <= 13 area. */
  reverse(lat, lon, opts = {}) {
    const zoom = opts.zoom == null ? 18 : opts.zoom;
    const ref = [lon, lat];
    const street = this._nearestStreet(lat, lon, 1500);
    if (zoom >= 17) {
      let best = null;
      const d = 60 / 111320, dl = d / Math.cos(lat * Math.PI / 180);
      for (const r of this.st.box.all(lon - dl, lon + dl, lat - d, lat + d)) {
        if (r.rank < 26 || r.class === 'highway') continue;
        const dd = hav(lon, lat, r.lon, r.lat);
        if (!best || dd < best.d) best = { d: dd, row: r };
      }
      let bestA = null;
      // house numbers on the streets around the point
      for (const sid of this._streetsNear(lat, lon, 120)) {
        for (const a of this.st.addrNumbers.all(sid)) {
          const dd = hav(lon, lat, a.lon_e7 / 1e7, a.lat_e7 / 1e7);
          if (!bestA || dd < bestA.d) bestA = { d: dd, a };
        }
      }
      const streetD = street ? street.d : Infinity;
      const lim = Math.max(streetD, 25) + 15;
      const cands = [];
      if (best && best.d <= Math.min(lim, 60)) cands.push({ d: best.d, f: () => this._fmt(best.row, ref) });
      if (bestA && bestA.d <= Math.min(lim, 60)) cands.push({ d: bestA.d - 3, f: () => this._fmtAddress(bestA.a, ref) });
      cands.sort((a, b) => a.d - b.d);
      if (cands.length) return cands[0].f();
    }
    if (street && zoom >= 14) return this._fmt(street.row, ref);
    // area level: the address parts of the nearest street (or nearest place)
    const base = street ? street.row : null;
    if (!base) return null;
    const c = this.combo(base.combo);
    const cut = zoom >= 12 ? 24 : zoom >= 10 ? 16 : zoom >= 8 ? 12 : 8;
    const keyRank = { neighbourhood: 24, quarter: 22, suburb: 20, hamlet: 20, borough: 20, city_district: 19, village: 19, town: 18, city: 16, island: 17, municipality: 14, county: 12, state_district: 10, state: 8 };
    const parts = c.parts.filter(([k]) => (keyRank[k] || 30) <= cut);
    if (!parts.length) return this._fmt(base, ref);
    const [k, nm] = parts[0];
    // find the matching admin/place row
    // the admin/place row of that name that contains the point (else the nearest one):
    // "Oakland" here is the Pittsburgh neighbourhood, not Oakland, NJ
    const inBox = (x) => { const b = x.boundingbox; return b && b[0] != null && lat >= b[0] && lat <= b[1] && lon >= b[2] && lon <= b[3]; };
    const rows = this.search(nm, { center: ref, limit: 10 }).filter((x) => x.name === nm && (x.class === 'boundary' || x.class === 'place'))
      .sort((a, b) => (inBox(b) - inBox(a)) || (a.distance - b.distance));
    if (rows.length && (inBox(rows[0]) || rows[0].distance < 20000)) return rows[0];
    return { place_id: null, lat, lon, class: 'place', type: k, name: nm, display_name: [...parts.map((x) => x[1]), c.country].filter(Boolean).join(', '), address: { [k]: nm, country: c.country } };
  }

  _streetsNear(lat, lon, m) {
    const d = m / 111320, dl = d / Math.cos(lat * Math.PI / 180);
    const ids = new Set();
    for (const w of this.st.ways.all(lon - dl, lon + dl, lat - d, lat + d)) ids.add(w.street_id);
    return [...ids].slice(0, 40);
  }

  _nearestStreet(lat, lon, maxM) {
    let r = 100;
    const kx = Math.cos(lat * Math.PI / 180);
    while (r <= maxM) {
      const d = r / 111320, dl = d / kx;
      let best = null;
      for (const w of this.st.ways.all(lon - dl, lon + dl, lat - d, lat + d)) {
        const cs = new Int32Array(w.coords.buffer, w.coords.byteOffset, w.coords.byteLength / 4);
        for (let i = 0; i + 3 < cs.length; i += 2) {
          const ax = cs[i] / 1e7, ay = cs[i + 1] / 1e7, bx = cs[i + 2] / 1e7, by = cs[i + 3] / 1e7;
          const dx = (bx - ax) * kx, dy = by - ay, L = dx * dx + dy * dy;
          let t = L > 0 ? (((lon - ax) * kx) * dx + (lat - ay) * dy) / L : 0;
          t = Math.max(0, Math.min(1, t));
          const dd = hav(lon, lat, ax + t * (bx - ax), ay + t * dy);
          if (!best || dd < best.d) best = { d: dd, street: w.street_id };
        }
      }
      if (best && best.d <= r) return { d: best.d, row: this.st.place.get(best.street) };
      r *= 2;
    }
    return null;
  }
}

function clean(f) {
  delete f._score;
  delete f._cov;
  return f;
}

module.exports = { Geocoder, DEFAULT_DB, CATEGORIES: CAT };
