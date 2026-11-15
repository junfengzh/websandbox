#!/usr/bin/env node
'use strict';
// websandbox map (map.wa): an OpenStreetMap-website-like map on the websandbox kit --
// MapLibre GL slippy map on local vector tiles, Nominatim-like search, place pages,
// OSRM-like directions (car/bike/foot), "Where is this?" and "Query features".
// usage: node sites/map/server.js --tenants 2 --port 7600 --data $WSB_DATA_ROOT/map
// Routes: ROUTES.md. Data: SCHEMA.md. Everything is read-only: shared DB mode (geocode.db
// is the kit's base DB, used by graders via /__rl/query); geocoding and routing run in
// worker threads shared by all tenants of the process (lib/engines.js).
const path = require('path');
const kit = require('../../kit');
const engines = require('./lib/engines');

const site = kit.site({
  name: 'map',
  title: 'OpenStreetMap',
  siteIndex: 7,
  dir: __dirname,
  db: { mode: 'shared', file: 'geocode.db', cacheMB: 8 },
  clock: { start: '2023-06-01T12:00:00Z' },
  menu: () => [
    { id: 'search', label: 'Search', href: '/search' },
    { id: 'directions', label: 'Directions', href: '/directions' },
    { id: 'about', label: 'About', href: '/about' },
  ],
  skins: {
    default: {},
    dark: { theme: 'dark' },
    right: { nav: 'side', css: '#content{flex-direction:row-reverse}#sidebar{border-right:0;border-left:1px solid var(--line)}', labels: { 'search.go': 'Search', 'menu.directions': 'Route planner', 'search.placeholder': 'Find a place' } },
  },
  skinFor: () => 'default',
  // start the engines (routing graph load ~10 s) as soon as the first tenant opens
  onOpen: (db, tenant) => { engines.get(path.dirname(tenant.o.base)); },
  routes: require('./routes'),
  views: { notFound: 'error', 403: 'error' },
});

// close the engine worker threads with the server (tests)
const start = site.start;
site.start = async (o) => {
  const s = await start(o);
  const close = s.close;
  s.close = async () => { await close(); await engines.closeAll(); };
  return s;
};
site.engines = engines;
module.exports = site;

if (require.main === module) site.main();
