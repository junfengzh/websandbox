'use strict';
// Access rules for the collaboration side, on top of the shared helpers in ../../lib/code.js
// (personal-namespace owner = Owner; project members; inherited group membership; admins).
const kit = require('../../../../kit');
const code = require('../../lib/code');

const GUEST = 10, REPORTER = 20, DEVELOPER = 30, MAINTAINER = 40, OWNER = 50;

// /:ns/:proj routes -> project row (+ access, url, base); 404 unreadable, 401/403 below `min`.
function loadProject(req, { min = 0 } = {}) {
  const p = code.loadProject(req, req.params.ns, req.params.proj, { min });
  p.base = p.url;
  return p;
}

function loadGroup(req, groupPath, { min = 0 } = {}) {
  const g = kit.sql("SELECT * FROM namespaces WHERE full_path = ? AND kind = 'group'").get(String(groupPath || ''));
  if (!g || !canReadGroup(req.user, g)) throw kit.httpError(404, 'Group not found');
  g.access = code.groupAccessLevel(req.user, g);
  g.base = `/groups/${g.full_path}`;
  g.url = `/${g.full_path}`;
  if (min && g.access < min) {
    if (!req.user) throw kit.httpError(401, 'Please sign in.');
    throw kit.httpError(403, 'You are not allowed to perform this action.');
  }
  return g;
}
function canReadGroup(user, g) {
  if (g.visibility === 'public') return true;
  if (!user) return false;
  if (g.visibility === 'internal' || user.is_admin) return true;
  return code.groupAccessLevel(user, g) >= GUEST;
}

// SQL predicate for projects (alias) the user can see
const visible = (user, alias = 'p') => ({ sql: code.visibleWhere(alias), params: code.visibleParams(user) });

// confidential issues are visible to the author, assignees and Reporter+ members
function canSeeConfidential(user, project, issue) {
  if (!issue.confidential) return true;
  if (!user) return false;
  if ((project.access || 0) >= REPORTER || user.id === issue.author_id) return true;
  return !!kit.sql('SELECT 1 FROM issue_assignees WHERE issue_id = ? AND user_id = ?').get(issue.id, user.id);
}
// SQL predicate for lists (issues alias t) in one project
function confidentialSql(user, project) {
  if ((project.access || 0) >= REPORTER) return null;
  if (!user) return { sql: 't.confidential = 0', params: [] };
  return { sql: '(t.confidential = 0 OR t.author_id = ? OR t.id IN (SELECT issue_id FROM issue_assignees WHERE user_id = ?))', params: [user.id, user.id] };
}

module.exports = { GUEST, REPORTER, DEVELOPER, MAINTAINER, OWNER, loadProject, loadGroup, canReadGroup, visible, canSeeConfidential, confidentialSql, code };
