'use strict';
// Background jobs of the repository side (run on the tenant connection, site clock).
const write = require('./lib/write');

module.exports = {
  // Recompute the Contributors page numbers of a branch after a web commit / new branch.
  'repo.contributors': ({ payload }) => write.recomputeContributors(payload.project_id, payload.branch),
};
