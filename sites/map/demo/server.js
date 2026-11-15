'use strict';
// Minimal demo: MapLibre GL with the local vector tiles + style, plus JSON endpoints for the
// geocoder and router. Not the site UI (that is built on the kit); it proves the data works.
//
//   node demo/server.js [--port 7600]      then open http://localhost:7600/
//
// Endpoints: /api/search?q=&lat=&lon=  /api/reverse?lat=&lon=&zoom=  /api/nearby?lat=&lon=&category=
//            /api/route?from=lon,lat&to=lon,lat&profile=car|bike|foot

const fs = require('fs');
const http = require('http');
const path = require('path');
const { TileServer, DATA } = require('../lib/tiles');

const port = +(process.argv[process.argv.indexOf('--port') + 1] || 0) || 7600;
const tiles = new TileServer();
let geo = null, router = null;
try { geo = new (require('../lib/geocode').Geocoder)(path.join(DATA, 'geocode.db')); } catch (e) { console.warn('geocoder unavailable:', e.message); }
const routerReady = require('../lib/route').createRouter({ dir: path.join(DATA, 'route') })
  .then((r) => { router = r; }).catch((e) => console.warn('router unavailable:', e.message));

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  try {
    if (tiles.handle(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const p = Object.fromEntries(u.searchParams);
    const ll = (s) => s.split(',').map(Number);
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    if (u.pathname === '/api/search' && geo) {
      const center = p.lat ? [+p.lon, +p.lat] : undefined;
      return json(res, 200, geo.search(p.q || '', { center, limit: +p.limit || 10, autocomplete: p.autocomplete === '1' }));
    }
    if (u.pathname === '/api/reverse' && geo) return json(res, 200, geo.reverse(+p.lat, +p.lon, { zoom: p.zoom ? +p.zoom : 18 }));
    if (u.pathname === '/api/nearby' && geo) return json(res, 200, geo.nearby(+p.lat, +p.lon, { category: p.category, limit: +p.limit || 10 }));
    if (u.pathname === '/api/route') {
      await routerReady;
      if (!router) return json(res, 503, { error: 'router unavailable' });
      return json(res, 200, await router.route({ from: ll(p.from), to: ll(p.to), profile: p.profile || 'car' }));
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(port, () => console.log(`map demo on http://localhost:${port}/`));
