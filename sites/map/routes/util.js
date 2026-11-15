'use strict';
const path = require('path');
const engines = require('../lib/engines');
const P = require('../lib/present');

/** the process-wide engines for this tenant's data dir (geocode.db is the kit's shared "base" DB) */
const E = (req) => engines.get(path.dirname(req.tenant.o.base));

/**
 * Reference point for search ranking: the map view centre sent by the page script
 * (X-Map-Center: lon,lat -- like the viewbox the OSM website passes to Nominatim), else
 * the default view (CMU). Not part of the URL, so a search URL is shareable.
 */
function center(req) {
  const h = String(req.headers['x-map-center'] || '');
  const m = h.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (m && Math.abs(+m[1]) <= 180 && Math.abs(+m[2]) <= 90) return [+m[1], +m[2]];
  return [P.DEFAULT_VIEW.lon, P.DEFAULT_VIEW.lat];
}

module.exports = { E, center };
