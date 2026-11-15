'use strict';
// websandbox code hosting -- collaboration side (gitlab.wa): issues, merge requests, labels,
// milestones, project/group members and invites, groups, project settings, wiki, to-dos,
// dashboard issue/MR lists. A Fastify plugin registered by ../server.js at the root prefix
// (contract at the top of server.js); routes keep GitLab's URL schemes and are documented in
// ../ROUTES.md ("Collaboration"). Every write is a plain SQL change in the tenant transaction.
const path = require('node:path');
const U = require('./lib/util');
const A = require('./lib/access');
const I = require('./lib/issuable');
const L = require('./lib/lists');
const git = require('./lib/git');
const jobs = require('./jobs');

const MODULES = ['issues', 'merge_requests', 'labels', 'milestones', 'members', 'groups', 'settings', 'wiki', 'dashboard'];
const STYLES = ['/static/collab/collab.css'];
const SCRIPTS = ['/static/collab/collab.js'];

let CTX = null;

async function collab(app, opts = {}) {
  const kit = opts.kit || require('../../../kit');
  const code = opts.code || require('../lib/code');
  if (opts.site && opts.site.cfg) {
    const cfg = opts.site.cfg;
    cfg.jobs = { ...(cfg.jobs || {}), ...jobs };
  }
  const ctx = {
    kit, code, U, A, I, L, git, site: opts.site || null,
    // render a collab page with its stylesheet/script
    view: (reply, name, data = {}, status) => reply.render(`collab/${name}`, {
      U, today: kit.nowSql().slice(0, 10), ...data, styles: STYLES.concat(data.styles || []), scripts: SCRIPTS.concat(data.scripts || []),
    }, status),
    back: (req, fallback) => { const b = U.str(req.body && (req.body.back || req.body.redirect_to)); return b.startsWith('/') && !b.startsWith('//') ? b : fallback; },
    usersByNames: (names) => {
      const out = [];
      for (const n of names) {
        const s = String(n).trim().replace(/^@/, '');
        if (!s) continue;
        const u = kit.sql("SELECT * FROM users WHERE (username = ? OR email = ? COLLATE NOCASE) AND state = 'active'").get(s, s);
        out.push(u ? u : { missing: s });
      }
      return out;
    },
    // project-scoped route: /:ns/:proj/-/<suffix>
    P: (suffix) => `/:ns/:proj/-/${suffix}`,
  };
  CTX = ctx;
  for (const m of MODULES) {
    const f = path.join(__dirname, 'routes', m + '.js');
    if (require('node:fs').existsSync(f)) require(f)(app, ctx);
  }
}

// '/<group>' (a group namespace): repo's /:ns handler delegates here
collab.groupPage = (req, reply, ns) => require('./routes/groups').groupPage(CTX, req, reply, ns);
collab.jobs = jobs;
module.exports = collab;
