#!/usr/bin/env node
'use strict';
// Dev harness for the collaboration plugin alone (when the repo side's routes are incomplete):
// reuses server.js's kit config (auth, locals, skins, clock) and view resolution, mounts ../ at
// the root prefix, and adds a minimal sign-in plus stub project/group pages.
//   node sites/code/collab/dev/harness.js --tenants 1 --port 7450 --data $WSB_DATA_ROOT/code
// Set WSB_FULL=1 to run the real server.js instead (once the repo side is complete).
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../../../../kit');
const CODE = path.join(__dirname, '..', '..');
if (process.env.WSB_FULL) { const s = require(path.join(CODE, 'server.js')); module.exports = s; if (require.main === module) s.main(); return; }
const real = require(path.join(CODE, 'server.js'));
const code = require(path.join(CODE, 'lib', 'code'));
const kitRequire = (m) => require(require.resolve(m, { paths: [path.join(CODE, '..', '..', 'kit')] }));

const cfg = real.cfg;
const site = kit.site({
  ...cfg,
  dir: CODE,
  jobs: { ...(cfg.jobs || {}) },
  routes: async (app, k) => {
    patchViews(site);
    app.register(kitRequire('@fastify/static'), { root: path.join(__dirname, '..', 'static'), prefix: '/static/collab/', decorateReply: false });
    const collab = require('..');
    await app.register(collab, { kit: k, code, site });
    // minimal sign-in (repo side owns the real one)
    app.get('/users/sign_in', async (req, reply) => reply.render('kit/login', { title: 'Sign in', next: req.query.next || '', values: {}, error: null, loginPath: '/users/sign_in' }));
    app.post('/users/sign_in', async (req, reply) => {
      const b = req.body || {};
      const u = await req.authenticate(b.login || b['user[login]'], b.password || b['user[password]']);
      if (!u) return reply.render('kit/login', { title: 'Sign in', next: b.next || '', values: { login: b.login }, error: 'Invalid login or password.', loginPath: '/users/sign_in' });
      await req.login(u);
      return reply.redirect(typeof b.next === 'string' && b.next.startsWith('/') ? b.next : '/');
    });
    app.post('/users/sign_out', async (req, reply) => { req.logout(); return reply.redirect('/'); });
    app.get('/', async (req, reply) => reply.redirect(req.user ? `/dashboard/issues?assignee_username=${req.user.username}` : '/users/sign_in'));
    app.get('/:ns', async (req, reply) => {
      const ns = code.namespaceByPath(req.params.ns);
      if (ns && ns.kind === 'group') return collab.groupPage(req, reply, ns);
      throw k.httpError(404, 'Not found (dev harness)');
    });
    app.get('/:ns/:proj', async (req, reply) => reply.redirect(`/${req.params.ns}/${req.params.proj}/-/issues`));
  },
});

function patchViews(rt) {
  const eta = rt.views;
  const KIT = require('../../../../kit/lib/views').KIT_VIEWS;
  const shared = path.join(CODE, 'views');
  const pref = { 'collab/': path.join(CODE, 'collab', 'views'), 'repo/': path.join(CODE, 'repo', 'views') };
  eta.resolvePath = function (name, options) {
    const base = options && options.filepath;
    const file = name + (path.extname(name) ? '' : '.eta');
    const pk = Object.keys(pref).find((p) => file.startsWith(p));
    let found;
    if (file.startsWith('kit/')) found = path.join(KIT, file.slice(4));
    else if (pk) found = path.join(pref[pk], file.slice(pk.length));
    else if (base && /^\.\.?\//.test(file)) found = path.join(path.dirname(base), file);
    else found = [shared, KIT].map((d) => path.join(d, file)).find((f) => fs.existsSync(f));
    if (!found || !fs.existsSync(found)) throw new Error(`template not found: ${name}`);
    return found;
  };
}

module.exports = site;
if (require.main === module) site.main();
