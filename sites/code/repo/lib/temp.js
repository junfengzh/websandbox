'use strict';
// Per-tenant temp objects (kit onOpen; temp tables live in the tenant transaction, so a reset
// empties them like any other write).
//
// temp.repo_files: the current content of every file a web commit wrote, per project + branch,
// so graders can check edited files with plain SQL (a SQL function cannot read the tree: the
// connection is busy while a query runs):
//   SELECT content FROM repo_files WHERE project_id = (SELECT id FROM projects WHERE full_path = 'byteblaze/dotfiles')
//     AND branch = 'main' AND path = 'LICENSE'          -- content NULL = the file was deleted
// Rows are copied to a new branch created from a branch, and to forks.
function register(db) {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS repo_files (
    project_id INTEGER NOT NULL, branch TEXT NOT NULL, path TEXT NOT NULL,
    content TEXT, blob_sha TEXT, commit_sha TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, branch, path)) WITHOUT ROWID`);
}
module.exports = { register };
