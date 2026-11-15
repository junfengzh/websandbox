'use strict';
// Background jobs of the collaboration side (run on the tenant connection, site clock).
//   collab.contributors   {project_id, branch}   recompute contributors after a merge
const git = require('./lib/git');

module.exports = {
  'collab.contributors': ({ payload }) => ({ ok: git.recomputeContributors(payload.project_id, payload.branch) }),
};
