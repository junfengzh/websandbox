'use strict';
// Project list queries shared by dashboard / explore / user pages.
const kit = require('../../../../kit');
const code = require('../../lib/code');

const SORTS = {
  options: { latest_activity: 'p.last_activity_at', name: 'p.name COLLATE NOCASE', created: 'p.created_at', stars: 'p.star_count', path: 'p.path COLLATE NOCASE' },
  labels: { latest_activity_desc: 'Updated date', latest_activity_asc: 'Oldest updated', name_asc: 'Name', name_desc: 'Name, descending', created_desc: 'Last created', created_asc: 'Oldest created', stars_desc: 'Most stars', stars_asc: 'Least stars' },
};
const SORT_MENU = ['latest_activity_desc', 'latest_activity_asc', 'name_asc', 'name_desc', 'created_desc', 'created_asc', 'stars_desc', 'stars_asc'];

// where/params: extra condition on projects alias p. Applies visibility for req.user,
// ?name= filter (GitLab's "Filter by name"), ?visibility=, ?archived=, sort and pagination.
function listProjects(req, where, params, { defaultSort = 'latest_activity_desc', perPage = 20, extra = '' } = {}) {
  const sort = kit.sorter(req, { options: SORTS.options, default: defaultSort, tiebreak: 'p.id', labels: SORTS.labels });
  const conds = [`(${where})`, code.visibleWhere('p')];
  const ps = [...params, ...code.visibleParams(req.user)];
  const name = String(req.query.name || req.query.search || '').trim();
  if (name) { conds.push("(p.name LIKE ? ESCAPE '\\' OR p.path LIKE ? ESCAPE '\\' OR p.full_path LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')"); const l = `%${name.replace(/[\\%_]/g, (m) => '\\' + m)}%`; ps.push(l, l, l, l); }
  if (['public', 'internal', 'private'].includes(req.query.visibility)) { conds.push('p.visibility = ?'); ps.push(req.query.visibility); }
  if (req.query.archived === 'only') conds.push('p.archived = 1');
  else if (req.query.archived !== 'true') conds.push('p.archived = 0');
  const from = `FROM projects p JOIN namespaces n ON n.id = p.namespace_id WHERE ${conds.join(' AND ')}`;
  const total = kit.db().prepare(`SELECT count(*) ${from}`).pluck().get(...ps);
  const pager = kit.paginate(req, total, { perPage });
  const rows = kit.db().prepare(`SELECT p.*, n.name AS ns_name, n.kind AS ns_kind, n.owner_id AS ns_owner_id ${extra} ${from} ORDER BY ${sort.orderBy} LIMIT ? OFFSET ?`).all(...ps, pager.limit, pager.offset);
  if (req.user) for (const r of rows) r.my_access = code.accessLevel(req.user, r);
  return { rows, pager, sort, name, total, sortMenu: SORT_MENU.map((v) => ({ value: v, label: SORTS.labels[v], selected: v === sort.value })) };
}

// "Your projects": personal namespace + project memberships + group memberships.
const MEMBER_WHERE = `p.namespace_id IN (SELECT id FROM namespaces WHERE kind = 'user' AND owner_id = ?)
  OR p.id IN (SELECT source_id FROM members WHERE source_type = 'project' AND user_id = ? AND requested_at IS NULL)
  OR p.namespace_id IN (SELECT source_id FROM members WHERE source_type = 'namespace' AND user_id = ? AND requested_at IS NULL)`;
const memberParams = (u) => [u.id, u.id, u.id];
const STARRED_WHERE = 'p.id IN (SELECT project_id FROM stars WHERE user_id = ?)';

function counts(user) {
  if (!user) return {};
  return {
    yours: kit.db().prepare(`SELECT count(*) FROM projects p WHERE (${MEMBER_WHERE}) AND p.archived = 0`).pluck().get(...memberParams(user)),
    starred: kit.sql(`SELECT count(*) FROM stars s JOIN projects p ON p.id = s.project_id WHERE s.user_id = ?`).pluck().get(user.id),
  };
}

module.exports = { SORTS, SORT_MENU, listProjects, MEMBER_WHERE, memberParams, STARRED_WHERE, counts };
