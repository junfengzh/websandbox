'use strict';
// Forum routes (documented in ../ROUTES.md). Static paths win over parametric ones in
// Fastify's router, so /forums, /submit, ... are not shadowed by /:sortBy.
module.exports = async function routes(app, kit) {
  for (const m of ['auth', 'listing', 'submission', 'votes', 'users', 'forums', 'messages', 'search', 'wiki']) {
    await require(`./${m}`)(app, kit);
  }
};
