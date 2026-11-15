'use strict';
// Dashboard lists across projects: /dashboard/issues, /dashboard/merge_requests (GitLab needs at
// least one filter: assignee_username / author_username / reviewer_username / label / milestone /
// search; scope=all is accepted and ignored), and the to-do list /dashboard/todos.
module.exports = function dashboard(app, ctx) {
  const { kit, U, A, L, view } = ctx;
  const FILTER_KEYS = ['assignee_username', 'assignee_username[]', 'assignee_id', 'author_username', 'reviewer_username', 'reviewer_id', 'label_name[]', 'label_name', 'milestone_title', 'search', 'my_reaction_emoji', 'not[author_username]', 'not[label_name][]', 'source_branch', 'target_branch', 'approved_by_usernames[]', 'iids[]'];

  const readableIds = (user) => { const v = A.visible(user, 'p'); return kit.sql(`SELECT p.id FROM projects p WHERE ${v.sql} AND p.archived = 0`).pluck().all(...v.params); };
  const conf = (user) => (user.is_admin ? null : { sql: `(t.confidential = 0 OR t.author_id = ? OR t.id IN (SELECT issue_id FROM issue_assignees WHERE user_id = ?)
      OR t.project_id IN (SELECT source_id FROM members WHERE source_type = 'project' AND user_id = ? AND access_level >= 20 AND requested_at IS NULL)
      OR t.project_id IN (SELECT id FROM projects WHERE namespace_id IN (SELECT id FROM namespaces WHERE owner_id = ?))
      OR t.project_id IN (SELECT id FROM projects WHERE namespace_id IN (SELECT source_id FROM members WHERE source_type = 'namespace' AND user_id = ? AND access_level >= 20)))`, params: [user.id, user.id, user.id, user.id, user.id] });

  for (const [kind, seg] of [['issue', 'issues'], ['merge_request', 'merge_requests']]) {
    app.get(`/dashboard/${seg}`, { config: { login: true } }, async (req, reply) => {
      const q = req.query || {};
      const hasFilter = FILTER_KEYS.some((k) => q[k] != null && [].concat(q[k]).some((x) => String(x).trim() !== ''));
      const base = `/dashboard/${seg}`;
      const hidden = q.scope ? [['scope', U.str(q.scope)]] : [];
      const labels = kit.sql('SELECT DISTINCT title, min(color) AS color FROM labels GROUP BY title ORDER BY title COLLATE NOCASE LIMIT 300').all();
      const data = { title: kind === 'issue' ? 'Issues' : 'Merge requests', kind, base, hidden, labels, showProject: true, crumbs: [['Your work'], [kind === 'issue' ? 'Issues' : 'Merge requests']] };
      if (!hasFilter) {
        const empty = { rows: [], counts: kind === 'issue' ? { opened: 0, closed: 0, all: 0 } : { opened: 0, merged: 0, closed: 0, all: 0 }, state: U.str(q.state) || 'opened', pager: kit.paginate(req, 0), sort: U.str(q.sort) || 'created_date', sortOptions: L.SORT_LABELS[kind], active: [] };
        return view(reply, 'dashboard_list', { ...data, r: empty, needFilter: true });
      }
      const r = L.list(kind, req, { projectIds: readableIds(req.user), confidentialFilter: kind === 'issue' ? conf(req.user) : null, user: req.user });
      return view(reply, 'dashboard_list', { ...data, r, needFilter: false });
    });
  }

  // ------------------------------------------------------------ your groups
  // groups the user is a member of (directly; subgroups of them too), filter + sort like /explore/groups
  app.get('/dashboard/groups', { config: { login: true } }, async (req, reply) => {
    const qx = U.str(req.query.filter || req.query.search);
    const SORTS = { name_asc: 'n.name COLLATE NOCASE ASC', name_desc: 'n.name COLLATE NOCASE DESC', created_desc: 'n.created_at DESC', created_asc: 'n.created_at ASC', latest_activity_desc: 'coalesce(n.updated_at, n.created_at) DESC' };
    const sortKey = SORTS[U.str(req.query.sort)] ? U.str(req.query.sort) : 'name_asc';
    const like = qx ? `%${qx.replace(/[\\%_]/g, (x) => '\\' + x)}%` : null;
    const where = `n.kind = 'group' AND n.id IN (WITH RECURSIVE t(id) AS (
        SELECT source_id FROM members WHERE source_type = 'namespace' AND user_id = ? AND requested_at IS NULL
        UNION SELECT c.id FROM namespaces c JOIN t ON c.parent_id = t.id) SELECT id FROM t)${like ? " AND (n.name LIKE ? ESCAPE '\\' OR n.path LIKE ? ESCAPE '\\')" : ''}`;
    const params = [req.user.id, ...(like ? [like, like] : [])];
    const total = kit.sql(`SELECT count(*) FROM namespaces n WHERE ${where}`).pluck().get(...params);
    const pager = kit.paginate(req, total, { perPage: 20 });
    const rows = kit.sql(`SELECT n.*, (SELECT count(*) FROM projects WHERE namespace_id = n.id) AS projects_count,
        (SELECT count(*) FROM members WHERE source_type = 'namespace' AND source_id = n.id AND user_id IS NOT NULL AND requested_at IS NULL) AS members_count,
        (SELECT max(access_level) FROM members WHERE source_type = 'namespace' AND source_id = n.id AND user_id = ?) AS my_access
      FROM namespaces n WHERE ${where} ORDER BY ${SORTS[sortKey]}, n.id LIMIT ? OFFSET ?`).all(req.user.id, ...params, pager.limit, pager.offset);
    return view(reply, 'dashboard_groups', { title: 'Groups', rows, pager, q: qx, sort: sortKey, crumbs: [['Your work'], ['Groups']] });
  });

  // ------------------------------------------------------------ to-dos
  const ACTIONS = { assigned: 'assigned you', mentioned: 'mentioned you on', build_failed: 'The pipeline failed in', marked: 'added a to do for', approval_required: 'set you as an approver for', unmergeable: 'Could not merge', directly_addressed: 'mentioned you on', merge_train_removed: 'Removed from Merge Train:', review_requested: 'requested a review of' };
  app.get('/dashboard/todos', { config: { login: true } }, async (req, reply) => {
    const q = req.query || {};
    const state = U.str(q.state) === 'done' ? 'done' : 'pending';
    const where = ['t.user_id = ?', 't.state = ?']; const params = [req.user.id, state];
    const active = [];
    const pid = U.int(q.project_id); if (pid) { where.push('t.project_id = ?'); params.push(pid); active.push(['project_id', pid]); }
    const aid = U.int(q.author_id); if (aid) { where.push('t.author_id = ?'); params.push(aid); active.push(['author_id', aid]); }
    const type = U.str(q.type); if (type === 'Issue' || type === 'MergeRequest') { where.push('t.target_type = ?'); params.push(type === 'Issue' ? 'issue' : 'merge_request'); active.push(['type', type]); }
    const act = U.str(q.action_id || q.action); if (ACTIONS[act]) { where.push('t.action = ?'); params.push(act); active.push(['action', act]); }
    const sort = U.str(q.sort) === 'created_asc' ? 't.created_at ASC, t.id ASC' : 't.created_at DESC, t.id DESC';
    const counts = { pending: kit.sql("SELECT count(*) FROM todos WHERE user_id = ? AND state = 'pending'").pluck().get(req.user.id), done: kit.sql("SELECT count(*) FROM todos WHERE user_id = ? AND state = 'done'").pluck().get(req.user.id) };
    const total = kit.sql(`SELECT count(*) FROM todos t WHERE ${where.join(' AND ')}`).pluck().get(...params);
    const pager = kit.paginate(req, total, { perPage: 20 });
    const rows = kit.sql(`SELECT t.*, u.username AS author_username, u.name AS author_name, u.avatar AS author_avatar, p.full_path AS project_path, p.name AS project_name,
        CASE t.target_type WHEN 'issue' THEN (SELECT iid FROM issues WHERE id = t.target_id) WHEN 'merge_request' THEN (SELECT iid FROM merge_requests WHERE id = t.target_id) END AS target_iid,
        CASE t.target_type WHEN 'issue' THEN (SELECT title FROM issues WHERE id = t.target_id) WHEN 'merge_request' THEN (SELECT title FROM merge_requests WHERE id = t.target_id) END AS target_title,
        CASE t.target_type WHEN 'issue' THEN (SELECT state FROM issues WHERE id = t.target_id) WHEN 'merge_request' THEN (SELECT state FROM merge_requests WHERE id = t.target_id) END AS target_state,
        (SELECT body FROM notes WHERE id = t.note_id) AS note_body
      FROM todos t LEFT JOIN users u ON u.id = t.author_id LEFT JOIN projects p ON p.id = t.project_id WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...params, pager.limit, pager.offset);
    const projects = kit.sql('SELECT DISTINCT p.id, p.full_path FROM todos t JOIN projects p ON p.id = t.project_id WHERE t.user_id = ? ORDER BY p.full_path').all(req.user.id);
    const authors = kit.sql('SELECT DISTINCT u.id, u.username, u.name FROM todos t JOIN users u ON u.id = t.author_id WHERE t.user_id = ? ORDER BY u.username COLLATE NOCASE').all(req.user.id);
    return view(reply, 'todos', { title: 'To-Do List', state, tcounts: counts, rows, pager, projects, authors, actions: ACTIONS, active, crumbs: [['Your work'], ['To-Do List']] });
  });
  const todo = (req) => { const t = kit.sql('SELECT * FROM todos WHERE id = ? AND user_id = ?').get(U.int(req.params.id), req.user.id); if (!t) throw kit.httpError(404, 'To-do not found'); return t; };
  const backTo = (req) => { const b = U.str(req.body && req.body.back); return b.startsWith('/dashboard/todos') ? b : '/dashboard/todos'; };
  app.post('/dashboard/todos/:id/done', { config: { login: true } }, async (req, reply) => {
    const t = todo(req);
    kit.sql("UPDATE todos SET state = 'done', updated_at = ? WHERE id = ?").run(kit.nowSql(), t.id);
    if (req.headers.accept && req.headers.accept.includes('application/json')) return { ok: true };
    req.flash('success', 'To-do item successfully marked as done.');
    return reply.redirect(backTo(req));
  });
  app.post('/dashboard/todos/:id/restore', { config: { login: true } }, async (req, reply) => {
    const t = todo(req);
    kit.sql("UPDATE todos SET state = 'pending', updated_at = ? WHERE id = ?").run(kit.nowSql(), t.id);
    req.flash('success', 'To-do item restored.');
    return reply.redirect(backTo(req));
  });
  app.post('/dashboard/todos/mark_all_as_done', { config: { login: true } }, async (req, reply) => {
    const n = kit.sql("UPDATE todos SET state = 'done', updated_at = ? WHERE user_id = ? AND state = 'pending'").run(kit.nowSql(), req.user.id).changes;
    req.flash('success', `${n} to-do item${n === 1 ? '' : 's'} marked as done.`);
    return reply.redirect('/dashboard/todos');
  });
};
