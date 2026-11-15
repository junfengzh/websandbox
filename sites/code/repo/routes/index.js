'use strict';
// Repository-side routes of the code hosting site. Registered by ../../server.js after collab/.
module.exports = async function repoRoutes(app, kit, opts) {
  for (const m of ['auth', 'dashboard', 'explore', 'search', 'profile', 'project', 'files', 'commits', 'refs', 'users']) {
    await require('./' + m)(app, kit, opts);
  }
};
