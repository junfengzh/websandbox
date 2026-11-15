'use strict';
// Map assets: vector tiles from MBTiles, the MapLibre style, glyphs, sprites, and the
// MapLibre GL bundle from node_modules (no CDN). All raw routes (no tenant lock/session).
const fs = require('fs');
const path = require('path');
const { TileServer } = require('../lib/tiles');

const TYPES = { '.json': 'application/json', '.png': 'image/png', '.pbf': 'application/x-protobuf', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };
const servers = new Map();
function tilesFor(req) {
  const dir = path.dirname(req.tenant.o.base);
  let t = servers.get(dir);
  if (!t) { t = new TileServer({ dataDir: dir }); servers.set(dir, t); }
  return t;
}

module.exports = async function assets(app) {
  const raw = { config: { raw: true } };

  app.get('/style.json', raw, async (req, reply) => {
    // site-relative URLs made absolute for the host the browser used (map.wa, 127.10.x.y, localhost:port)
    const s = tilesFor(req).style(`http://${req.headers.host}`);
    return reply.type('application/json').header('Cache-Control', 'no-cache').send(s);
  });

  app.get('/tiles/:z/:x/:y', raw, async (req, reply) => {
    const m = /^(\d+)$/.test(req.params.z) && /^(\d+)$/.test(req.params.x) && /^(\d+)\.pbf$/.exec(req.params.y);
    if (!m) return reply.code(404).send({ error: 'bad tile' });
    const t = tilesFor(req).tile(+req.params.z, +req.params.x, +m[1]);
    if (!t) return reply.code(204).header('Cache-Control', 'public, max-age=86400').send();
    const gz = t[0] === 0x1f && t[1] === 0x8b;
    reply.type('application/x-protobuf').header('Cache-Control', 'public, max-age=86400');
    if (gz) reply.header('Content-Encoding', 'gzip');
    return reply.send(t);
  });

  const staticFile = (kind) => async (req, reply) => {
    const p = tilesFor(req).staticFile(kind + '/' + req.params['*']);
    if (!p) return reply.code(404).send({ error: 'not found' });
    reply.type(TYPES[path.extname(p)] || 'application/octet-stream').header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(p));
  };
  app.get('/glyphs/*', raw, staticFile('glyphs'));
  app.get('/sprites/*', raw, staticFile('sprites'));

  app.get('/favicon.ico', raw, async (req, reply) => reply.redirect('/static/favicon.svg', 301));

  app.get('/vendor/:file', raw, async (req, reply) => {
    const v = tilesFor(req).vendor[req.params.file];
    if (!v) return reply.code(404).send({ error: 'not found' });
    reply.type(TYPES[path.extname(v)]).header('Cache-Control', 'public, max-age=86400');
    return reply.send(fs.createReadStream(v));
  });
};
