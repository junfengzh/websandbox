'use strict';
// Presentation helpers for the map site: place URLs, category labels, OSM-style tags,
// distance/time formatting, coordinate parsing, routing engine names.

const { formatDuration, formatDistance } = require('./route');

// OSM website routing engines (order = the <select class="routing_engines"> option order:
// selectedIndex 0 bicycle, 1 car, 2 foot -- as on the WebArena OSM site).
const ENGINES = [
  { id: 'fossgis_osrm_bike', profile: 'bike', label: 'Bicycle (OSRM)', mode: 'bike' },
  { id: 'fossgis_osrm_car', profile: 'car', label: 'Car (OSRM)', mode: 'car' },
  { id: 'fossgis_osrm_foot', profile: 'foot', label: 'Foot (OSRM)', mode: 'foot' },
];
const ENGINE_ALIASES = {
  car: 'fossgis_osrm_car', driving: 'fossgis_osrm_car', drive: 'fossgis_osrm_car', graphhopper_car: 'fossgis_osrm_car', fossgis_valhalla_car: 'fossgis_osrm_car',
  bike: 'fossgis_osrm_bike', bicycle: 'fossgis_osrm_bike', cycling: 'fossgis_osrm_bike', graphhopper_bicycle: 'fossgis_osrm_bike', fossgis_valhalla_bicycle: 'fossgis_osrm_bike',
  foot: 'fossgis_osrm_foot', walking: 'fossgis_osrm_foot', walk: 'fossgis_osrm_foot', graphhopper_foot: 'fossgis_osrm_foot', fossgis_valhalla_foot: 'fossgis_osrm_foot',
};
function engine(id) {
  const k = ENGINE_ALIASES[String(id || '').toLowerCase()] || id;
  return ENGINES.find((e) => e.id === k) || ENGINES[1];
}

// Default view: Carnegie Mellon University (the WebArena map starts there).
const DEFAULT_VIEW = { zoom: 15, lat: 40.4443, lon: -79.9436 };

const ADMIN_LABEL = { 4: 'Country', 8: 'State', 10: 'State District', 12: 'County', 14: 'Municipality', 16: 'City', 17: 'Island', 18: 'Town', 19: 'Village', 20: 'Suburb', 22: 'Quarter', 24: 'Neighbourhood' };
const TYPE_LABEL = {
  'aeroway:aerodrome': 'Airport', 'aeroway:helipad': 'Helipad', 'amenity:fuel': 'Fuel', 'amenity:fast_food': 'Fast Food',
  'amenity:ice_cream': 'Ice Cream', 'place:house': 'Address', 'place:postcode': 'Postcode', 'postcode:postcode': 'Postcode',
  'leisure:nature_reserve': 'Nature Reserve', 'boundary:national_park': 'National Park', 'boundary:protected_area': 'Protected Area',
  'building:yes': 'Building', 'tourism:attraction': 'Attraction', 'man_made:bridge': 'Bridge', 'highway:bus_stop': 'Bus Stop',
};
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** "University", "Cafe", "City", "Residential Road", ... like the OSM website's result prefixes */
function typeLabel(p) {
  const k = `${p.class}:${p.type}`;
  if (TYPE_LABEL[k]) return TYPE_LABEL[k];
  if (p.class === 'boundary' && p.type === 'administrative') return ADMIN_LABEL[p.place_rank] || 'Administrative Boundary';
  if (p.class === 'highway') {
    if (['residential', 'primary', 'secondary', 'tertiary', 'trunk', 'motorway', 'service', 'unclassified'].includes(p.type)) return titleCase(p.type) + ' Road';
    return titleCase(p.type);
  }
  if (p.class === 'building' && p.type !== 'yes') return titleCase(p.type) + ' Building';
  return titleCase(p.type || p.class);
}

/** stable page URL of a geocoder result: /node/<id>, /way/<id>, /relation/<id>, else /place/<place_id> */
function placeUrl(p) {
  if (p.osm_id != null && ['node', 'way', 'relation'].includes(p.osm_type)) return `/${p.osm_type}/${p.osm_id}`;
  return `/place/${encodeURIComponent(p.place_id)}`;
}

function title(p) {
  if (p.name) return p.name;
  const a = p.address || {};
  if (a.house_number && a.road) return `${a.house_number} ${a.road}`;
  return (p.display_name || '').split(',')[0];
}

/** OSM-style tag list [[key, value], ...] reconstructed from the geocoder row */
function tags(p) {
  const out = [];
  const seen = new Set();
  const add = (k, v) => { if (v == null || v === '' || seen.has(k)) return; seen.add(k); out.push([k, String(v)]); };
  if (p.class && p.type && p.osm_type !== 'postcode') add(p.class, p.type);
  add('name', p.name);
  for (const [k, v] of Object.entries(p.namedetails || {})) if (k !== 'name') add(k, v);
  const a = p.address || {};
  add('addr:housenumber', a.house_number);
  add('addr:street', a.road);
  add('addr:city', a.city || a.town || a.village || a.municipality);
  add('addr:state', a.state);
  add('addr:postcode', a.postcode);
  for (const [k, v] of Object.entries(p.extratags || {})) add(k, v);
  return out;
}

/** the details shown above the tag table: hours, website, phone, ... */
function details(p) {
  const x = p.extratags || {};
  const rows = [];
  const add = (label, v, kind) => { if (v) rows.push({ label, value: String(v), kind }); };
  add('Opening hours', x.opening_hours);
  add('Website', x.website || x['contact:website'] || x.url, 'url');
  add('Phone', x.phone || x['contact:phone'], 'tel');
  add('Email', x.email || x['contact:email'], 'email');
  add('Operator', x.operator);
  add('Brand', x.brand);
  add('Cuisine', x.cuisine && titleCase(x.cuisine.replace(/;/g, ', ')));
  add('Wheelchair access', x.wheelchair);
  add('Elevation', x.ele && `${x.ele} m`);
  add('Population', x.population);
  add('IATA code', x.iata);
  add('Description', x.description);
  add('Wikipedia', x.wikipedia);
  return rows;
}

const fmtCoord = (v) => (+v).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
/** "40.4437, -79.9434" */
function coords(lat, lon) { return `${fmtCoord(lat)}, ${fmtCoord(lon)}`; }

/** parse "lat,lon" (or "lat, lon" / "lat lon"); null if not coordinates */
function parseLatLon(s) {
  const m = String(s || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  return { lat, lon };
}
/** route=lat,lon;lat,lon (either side may be empty) */
function parseRoute(s) {
  const parts = String(s || '').split(';');
  return [parseLatLon(parts[0]), parseLatLon(parts[1])];
}
const llStr = (p) => (p ? `${+(+p.lat).toFixed(5)},${+(+p.lon).toFixed(5)}` : '');

/** "#map=15/40.4443/-79.9436" style hash for a point */
function mapHash(zoom, lat, lon) { return `map=${zoom}/${(+lat).toFixed(4)}/${(+lon).toFixed(4)}`; }
/** a zoom that fits a Nominatim bbox [minlat, maxlat, minlon, maxlon] */
function zoomFor(bb, fallback = 17) {
  if (!bb || bb[0] == null) return fallback;
  const span = Math.max(bb[1] - bb[0], (bb[3] - bb[2]) * Math.cos(((bb[0] + bb[1]) / 2) * Math.PI / 180));
  if (!(span > 0)) return fallback;
  return Math.max(3, Math.min(18, Math.floor(Math.log2(360 / span)) - 1));
}

const distanceText = formatDistance;
const durationText = formatDuration;
/** "0:15" -- OSM's own time format, given as well */
function hhmm(sec) { const m = Math.round(sec / 60); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; }

const MANEUVER_ICON = { depart: '●', arrive: '◎', ferry: '⛴', roundabout: '↻', 'exit roundabout': '↻', merge: '⤨', 'on ramp': '↗', 'off ramp': '↘' };
function stepIcon(m) {
  if (MANEUVER_ICON[m.type]) return MANEUVER_ICON[m.type];
  const mod = m.modifier || '';
  if (mod === 'uturn') return '↶';
  if (mod.includes('left')) return mod.includes('slight') ? '↖' : '←';
  if (mod.includes('right')) return mod.includes('slight') ? '↗' : '→';
  return '↑';
}

// Categories offered by "What's nearby" (category phrase understood by geocode.nearby)
const NEARBY = [
  ['restaurant', 'Restaurants'], ['cafe', 'Cafes'], ['fast food', 'Fast food'], ['bar', 'Bars & pubs'], ['hotel', 'Hotels'],
  ['supermarket', 'Supermarkets'], ['pharmacy', 'Pharmacies'], ['hospital', 'Hospitals'], ['parking', 'Parking'],
  ['gas station', 'Gas stations'], ['bank', 'Banks'], ['atm', 'ATMs'], ['post office', 'Post offices'], ['police', 'Police'],
  ['library', 'Libraries'], ['museum', 'Museums'], ['park', 'Parks'], ['school', 'Schools'], ['university', 'Universities'],
  ['bus stop', 'Bus stops'], ['airport', 'Airports'], ['cinema', 'Cinemas'], ['theatre', 'Theatres'],
];

module.exports = {
  ENGINES, engine, DEFAULT_VIEW, typeLabel, placeUrl, title, tags, details, coords, parseLatLon, parseRoute, llStr,
  mapHash, zoomFor, distanceText, durationText, hhmm, stepIcon, NEARBY, titleCase,
};
