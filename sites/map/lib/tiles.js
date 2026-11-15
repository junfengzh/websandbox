'use strict';
// Vector tiles + MapLibre assets for the map site (framework-agnostic helpers).
//
//   const { TileServer } = require('./tiles');
//   const ts = new TileServer();                  // data dir: $WSB_MAP_DATA or $WSB_DATA_ROOT/map
//   ts.tile(z, x, y)  -> Buffer (gzip-compressed MVT) or null     serve as application/x-protobuf + Content-Encoding: gzip
//   ts.style(origin)  -> style JSON with absolute URLs for origin (e.g. 'http://map.wa')
//   ts.staticFile(relPath) -> absolute path under static/ (glyphs, sprites) or null
//   ts.handle(req, res, origin) -> true if it served /tiles, /style.json, /glyphs, /sprites, /maplibre-gl.{js,css}
//
// URL layout served by handle():
//   /style.json  /tiles/{z}/{x}/{y}.pbf  /glyphs/{fontstack}/{range}.pbf  /sprites/sprite{,@2x}.{json,png}
//   /vendor/maplibre-gl.js  /vendor/maplibre-gl.css   (from node_modules, no CDN)

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA = process.env.WSB_MAP_DATA || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'map');
const TYPES = { '.json': 'application/json', '.png': 'image/png', '.pbf': 'application/x-protobuf', '.js': 'text/javascript', '.css': 'text/css' };

class TileServer {
  constructor({ dataDir = DATA, mbtiles } = {}) {
    this.dataDir = dataDir;
    this.db = new Database(mbtiles || path.join(dataDir, 'tiles', 'map.mbtiles'), { readonly: true, fileMustExist: true });
    this.getTile = this.db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
    this.metadata = Object.fromEntries(this.db.prepare('SELECT name, value FROM metadata').all().map((r) => [r.name, r.value]));
    this.staticDir = path.join(dataDir, 'static');
    this._style = JSON.parse(fs.readFileSync(path.join(this.staticDir, 'style.json'), 'utf8'));
    let mlDir = null;
    try { mlDir = path.dirname(require.resolve('maplibre-gl/dist/maplibre-gl.js')); } catch (e) { /* optional */ }
    this.vendor = mlDir ? { 'maplibre-gl.js': path.join(mlDir, 'maplibre-gl.js'), 'maplibre-gl.css': path.join(mlDir, 'maplibre-gl.css') } : {};
  }
  tile(z, x, y) {
    const row = this.getTile.get(z, x, (1 << z) - 1 - y); // MBTiles rows are TMS
    return row ? row.tile_data : null;
  }
  style(origin = '') {
    const s = JSON.parse(JSON.stringify(this._style));
    const abs = (u) => (u.startsWith('/') ? origin + u : u);
    for (const src of Object.values(s.sources)) if (src.tiles) src.tiles = src.tiles.map(abs);
    s.glyphs = abs(s.glyphs);
    s.sprite = abs(s.sprite);
    return s;
  }
  staticFile(rel) {
    const p = path.normalize(path.join(this.staticDir, rel));
    if (!p.startsWith(this.staticDir + path.sep) || !fs.existsSync(p)) return null;
    return p;
  }
  /** Minimal node:http handler. Returns true if the request was handled. */
  handle(req, res, origin) {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let m;
    if (url === '/style.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(this.style(origin || `http://${req.headers.host}`)));
      return true;
    }
    if ((m = url.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.pbf$/))) {
      const t = this.tile(+m[1], +m[2], +m[3]);
      if (!t) { res.writeHead(204); res.end(); return true; }
      const gz = t[0] === 0x1f && t[1] === 0x8b;
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf', ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'Cache-Control': 'public, max-age=86400' });
      res.end(t);
      return true;
    }
    if ((m = url.match(/^\/(glyphs|sprites)\/(.+)$/))) {
      const p = this.staticFile(m[1] + '/' + m[2]);
      if (!p) { res.writeHead(404); res.end(); return true; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(p).pipe(res);
      return true;
    }
    if ((m = url.match(/^\/vendor\/(maplibre-gl\.(?:js|css))$/)) && this.vendor[m[1]]) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(m[1])] });
      fs.createReadStream(this.vendor[m[1]]).pipe(res);
      return true;
    }
    return false;
  }
}

module.exports = { TileServer, DATA };
