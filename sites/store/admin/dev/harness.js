#!/usr/bin/env node
'use strict';
// Dev harness for the back office alone (when ../server.js or the storefront is not runnable):
// mirrors server.js's contract (admin auth with admin_users, views 'admin/x', /admin/static/).
//   node sites/store/admin/dev/harness.js --port 7350 --data $WSB_DATA_ROOT/store
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../../../../kit');
const store = require('../../shared');

const ADMIN_DIR = path.join(__dirname, '..');
const site = kit.site({
  name: 'shopping',
  title: 'Store admin (dev harness)',
  siteIndex: 3,
  dir: ADMIN_DIR, // no views/ public/ at this level -> kit defaults; resolvePath patched below
  db: { mode: 'overlay', file: 'base.db', cacheMB: 64 },
  clock: { start: '2023-06-12T16:00:00Z' },
  auth: {
    loginPath: '/admin/admin/auth/login',
    findUser: (db, login) => store.findUser(db, login, 'admin'),
    getUser: (db, id) => { const u = store.getUserBySessionId(db, id); return u && u.kind === 'admin' ? u : null; },
    idOf: (u) => store.sessionUserId(u),
    roleOf: (u) => u.role,
  },
  menu: () => [],
  jobs: {},
  views: { notFound: 'admin/error', 403: 'admin/error' },
  routes: async (app, k) => {
    const eta = site.views;
    const KIT = require('../../../../kit/lib/views').KIT_VIEWS;
    const adminViews = path.join(ADMIN_DIR, 'views');
    eta.resolvePath = function (name, options) {
      const base = options && options.filepath;
      const file = name + (path.extname(name) ? '' : '.eta');
      let found;
      if (file.startsWith('kit/')) found = path.join(KIT, file.slice(4));
      else if (file.startsWith('admin/')) found = path.join(adminViews, file.slice(6));
      else if (base && /^\.\.?\//.test(file)) found = path.join(path.dirname(base), file);
      else found = path.join(KIT, file);
      if (!fs.existsSync(found)) throw new Error(`template not found: ${name}`);
      return found;
    };
    app.register(require('../../../../kit/node_modules/@fastify/static'), { root: path.join(ADMIN_DIR, 'static'), prefix: '/admin/static/', decorateReply: false });
    app.get('/', async (req, reply) => reply.redirect('/admin'));
    await app.register(require('..'), { prefix: '/admin', kit: k, site, store });
  },
});
module.exports = site;
if (require.main === module) site.main();

// ADMIN_PROFILE=1: log statements slower than 15 ms
if (process.env.ADMIN_PROFILE) {
  const D = require('../../../../kit/node_modules/better-sqlite3');
  const S = Object.getPrototypeOf(new D(':memory:').prepare('SELECT 1'));
  for (const m of ['all', 'get', 'run', 'iterate']) {
    const f = S[m];
    S[m] = function (...a) { const t = performance.now(); const r = f.apply(this, a); const ms = performance.now() - t; if (ms > 15) console.log(`[slow ${ms.toFixed(0)}ms] ${this.source.replace(/\s+/g, ' ').slice(0, 160)}`); return r; };
  }
}
