'use strict';
// Groups: new (/groups/new, optional parent and initial members), overview (/groups/:group and
// '/<group>' via plugin.groupPage), activity, issues / merge requests across the group's
// projects, group labels, settings (/groups/:group/-/edit: name, description, visibility,
// path, request access, delete). Group milestones and members live in milestones.js / members.js.
module.exports = function groups(app, ctx) {
  const { kit, U, A, I, L, view, back } = ctx;

  // ------------------------------------------------------------ new
  app.get('/groups/new', { config: { login: true } }, async (req, reply) => {
    const parent = U.int(req.query.parent_id) ? kit.sql("SELECT * FROM namespaces WHERE id = ? AND kind = 'group'").get(U.int(req.query.parent_id)) : null;
    return renderNew(req, reply, { visibility: parent ? parent.visibility : 'private', parent_id: parent ? parent.id : '' }, {}, parent);
  });
  function renderNew(req, reply, values, errors, parent, status) {
    return view(reply, 'group_new', { title: 'New group', values, errors, parent, crumbs: [['Groups', '/dashboard/groups'], ['New group']], levels: [[10, 'Guest'], [20, 'Reporter'], [30, 'Developer'], [40, 'Maintainer'], [50, 'Owner']] }, status);
  }
  app.post('/groups', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    const parent = U.int(b.parent_id) ? kit.sql("SELECT * FROM namespaces WHERE id = ? AND kind = 'group'").get(U.int(b.parent_id)) : null;
    const values = { name: U.str(b.name), path: U.str(b.path), visibility: U.str(b.visibility) || 'private', description: U.str(b.description), parent_id: parent ? parent.id : '', invitees: U.str(b.invitees), invite_access_level: U.int(b.invite_access_level, 30) };
    if (!values.path && values.name) values.path = U.slugify(values.name);
    const errors = {};
    if (parent && ctx.code.groupAccessLevel(req.user, parent) < A.MAINTAINER) errors.parent_id = 'You are not allowed to create subgroups in this group.';
    if (!parent && !req.user.can_create_group && !req.user.is_admin) errors.name = 'You are not allowed to create groups.';
    if (!values.name) errors.name = "Name can't be blank";
    else if (values.name.length > 255) errors.name = 'Name is too long';
    else if (!/^[\p{L}\p{N}_][\p{L}\p{N}_ ().-]*$/u.test(values.name)) errors.name = 'Name can contain only letters, digits, emojis, underscores, dashes, dots, spaces and parentheses. It must start with a letter, digit, emoji, or underscore.';
    const pe = U.validPath(values.path);
    if (pe) errors.path = pe;
    const full = parent ? `${parent.full_path}/${values.path}` : values.path;
    if (!errors.path && kit.sql('SELECT 1 FROM namespaces WHERE full_path = ?').get(full)) errors.path = 'Group path has already been taken';
    if (!['private', 'internal', 'public'].includes(values.visibility)) errors.visibility = 'Visibility level is invalid';
    if (parent && order(values.visibility) > order(parent.visibility)) errors.visibility = `Visibility can't be more open than the parent group (${parent.visibility}).`;
    const invitees = [];
    for (const n of values.invitees.split(/[\s,;]+/).filter(Boolean)) {
      const u = kit.sql("SELECT * FROM users WHERE (username = ? OR email = ? COLLATE NOCASE) AND state = 'active'").get(n.replace(/^@/, ''), n);
      if (!u) { errors.invitees = `User not found: ${n}`; break; }
      if (u.id !== req.user.id) invitees.push(u);
    }
    if (Object.keys(errors).length) return renderNew(req, reply, values, errors, parent, 422);
    const now = kit.nowSql();
    const r = kit.sql(`INSERT INTO namespaces (kind, path, name, full_path, parent_id, owner_id, description, visibility, request_access_enabled, created_at, updated_at)
      VALUES ('group', ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`).run(values.path, values.name, full, parent ? parent.id : null, values.description || null, values.visibility, now, now);
    const gid = Number(r.lastInsertRowid);
    kit.sql("INSERT INTO members (source_type, source_id, user_id, access_level, created_by_id, invite_accepted_at, created_at, updated_at) VALUES ('namespace', ?, ?, 50, ?, ?, ?, ?)").run(gid, req.user.id, req.user.id, now, now, now);
    kit.sql("INSERT INTO events (group_id, author_id, action, target_type, target_id, target_title, created_at) VALUES (?, ?, 'created', 'group', ?, ?, ?)").run(gid, req.user.id, gid, values.name, now);
    const g = kit.sql('SELECT * FROM namespaces WHERE id = ?').get(gid); g.access = 50;
    const level = [10, 20, 30, 40, 50].includes(values.invite_access_level) ? values.invite_access_level : 30;
    for (const u of invitees) ctx.addMember({ group: { ...g, base: `/groups/${g.full_path}`, url: `/${g.full_path}` } }, req.user, { id: u.id, username: u.username }, level, null);
    req.flash('success', `Group '${values.name}' was successfully created.`);
    return reply.redirect(`/${full}`);
  });
  const order = (v) => ({ private: 0, internal: 10, public: 20 }[v] ?? 0);

  // ------------------------------------------------------------ overview
  function groupPage(c, req, reply, ns) {
    const g = A.loadGroup(req, ns.full_path || ns);
    const q = U.str(req.query.filter || req.query.search);
    const vis = A.visible(req.user, 'p');
    const like = q ? `%${q.replace(/[\\%_]/g, (x) => '\\' + x)}%` : null;
    const sort = { name_asc: 'p.name COLLATE NOCASE ASC', name_desc: 'p.name COLLATE NOCASE DESC', created_desc: 'p.created_at DESC', created_asc: 'p.created_at ASC', latest_activity_desc: 'p.last_activity_at DESC', stars_desc: 'p.star_count DESC' }[U.str(req.query.sort)] || 'p.last_activity_at DESC';
    const projects = kit.sql(`${c.code.PROJECT_SELECT} WHERE p.namespace_id = ? AND ${vis.sql}${like ? " AND (p.name LIKE ? ESCAPE '\\' OR p.path LIKE ? ESCAPE '\\')" : ''} ORDER BY ${sort}`).all(g.id, ...vis.params, ...(like ? [like, like] : []));
    const subgroups = kit.sql("SELECT * FROM namespaces WHERE parent_id = ? AND kind = 'group' ORDER BY name COLLATE NOCASE").all(g.id).filter((s) => A.canReadGroup(req.user, s));
    const memberCount = kit.sql("SELECT count(*) FROM members WHERE source_type = 'namespace' AND source_id = ? AND user_id IS NOT NULL AND requested_at IS NULL").pluck().get(g.id);
    const parent = g.parent_id ? kit.sql('SELECT * FROM namespaces WHERE id = ?').get(g.parent_id) : null;
    return c.view(reply, 'group', { title: g.name, group: g, nav: 'group', projects, subgroups, memberCount, parent, q, sort: U.str(req.query.sort), canCreate: g.access >= A.DEVELOPER, canAdmin: g.access >= A.OWNER,
      canRequest: !!req.user && g.access < A.GUEST && g.request_access_enabled !== 0, crumbs: parent ? [] : [] });
  }
  module.exports.groupPage = groupPage;
  app.get('/groups/:group', async (req, reply) => groupPage(ctx, req, reply, { full_path: req.params.group }));
  app.get('/groups/:group/-/activity', async (req, reply) => {
    const g = A.loadGroup(req, req.params.group);
    const events = ctx.code.loadEvents('(e.group_id = ? OR e.project_id IN (SELECT id FROM projects WHERE namespace_id = ?))', [g.id, g.id], { user: req.user, limit: 40, offset: (Math.max(1, U.int(req.query.page, 1)) - 1) * 40 });
    return view(reply, 'group_activity', { title: 'Activity', group: g, nav: 'group.activity', events, page: Math.max(1, U.int(req.query.page, 1)), crumbs: [['Activity']] });
  });

  // ------------------------------------------------------------ issues / MRs across the group
  for (const [kind, seg, nav] of [['issue', 'issues', 'group.issues'], ['merge_request', 'merge_requests', 'group.mrs']]) {
    app.get(`/groups/:group/-/${seg}`, async (req, reply) => {
      const g = A.loadGroup(req, req.params.group);
      const ids = kit.sql(`SELECT p.id FROM projects p WHERE p.namespace_id IN (WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM namespaces n JOIN t ON n.parent_id = t.id) SELECT id FROM t) AND ${A.visible(req.user, 'p').sql}`).pluck().all(g.id, ...A.visible(req.user, 'p').params);
      const conf = req.user ? { sql: '(t.confidential = 0 OR t.author_id = ? OR t.id IN (SELECT issue_id FROM issue_assignees WHERE user_id = ?) OR t.project_id IN (SELECT source_id FROM members WHERE source_type = \'project\' AND user_id = ? AND access_level >= 20)' + (g.access >= 20 ? ' OR 1' : '') + ')', params: [req.user.id, req.user.id, req.user.id] } : { sql: 't.confidential = 0', params: [] };
      const r = L.list(kind, req, { projectIds: ids, confidentialFilter: kind === 'issue' ? conf : null, user: req.user });
      const labels = kit.sql(`SELECT * FROM labels WHERE group_id = ? ORDER BY title COLLATE NOCASE`).all(g.id);
      const milestones = kit.sql('SELECT * FROM milestones WHERE group_id = ? ORDER BY due_date').all(g.id);
      return view(reply, seg === 'issues' ? 'issues' : 'merge_requests', { title: kind === 'issue' ? 'Issues' : 'Merge requests', group: g, nav, kind, r, base: `${g.base}/-/${seg}`, labels, milestones, showProject: true, canCreate: false, crumbs: [[kind === 'issue' ? 'Issues' : 'Merge requests']] });
    });
  }

  // ------------------------------------------------------------ group labels
  app.get('/groups/:group/-/labels', async (req, reply) => {
    const g = A.loadGroup(req, req.params.group);
    const r = ctx.listLabels(req, { groupIds: [g.id] });
    return view(reply, 'labels', { title: 'Labels', group: g, nav: 'group', r, prioritized: [], other: r.rows, sortOptions: [['name_asc', 'Name'], ['name_desc', 'Name, descending'], ['created_desc', 'Last created'], ['created_asc', 'Oldest created']], canAdmin: g.access >= A.REPORTER, base: `${g.base}/-/labels`, crumbs: [['Labels']] });
  });
  const needG = (g) => { if (g.access < A.REPORTER) throw kit.httpError(403, 'You need at least the Reporter role to manage labels.'); };
  const gForm = (reply, g, l, values, errors, status) => view(reply, 'label_form', { title: l ? 'Edit label' : 'New label', group: g, nav: 'group', label: l, values, errors, action: l ? `${g.base}/-/labels/${l.id}/edit` : `${g.base}/-/labels`, cancel: `${g.base}/-/labels`, colors: U.LABEL_COLORS }, status);
  app.get('/groups/:group/-/labels/new', { config: { login: true } }, async (req, reply) => { const g = A.loadGroup(req, req.params.group); needG(g); return gForm(reply, g, null, { color: '#6699cc' }, {}); });
  app.post('/groups/:group/-/labels', { config: { login: true } }, async (req, reply) => {
    const g = A.loadGroup(req, req.params.group); needG(g);
    const { values, errors } = ctx.labelValidate(req.body || {}, { col: 'group_id', id: g.id });
    if (Object.keys(errors).length) return gForm(reply, g, null, values, errors, 422);
    kit.sql('INSERT INTO labels (group_id, title, color, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(g.id, values.title, values.color.toLowerCase(), values.description || null, kit.nowSql(), kit.nowSql());
    req.flash('success', `Label ${values.title} was created.`);
    return reply.redirect(`${g.base}/-/labels`);
  });
  const gLabel = (req, g) => { const l = kit.sql('SELECT * FROM labels WHERE id = ? AND group_id = ?').get(U.int(req.params.id), g.id); if (!l) throw kit.httpError(404, 'Label not found'); return l; };
  app.get('/groups/:group/-/labels/:id/edit', { config: { login: true } }, async (req, reply) => { const g = A.loadGroup(req, req.params.group); needG(g); const l = gLabel(req, g); return gForm(reply, g, l, l, {}); });
  app.post('/groups/:group/-/labels/:id/edit', { config: { login: true } }, async (req, reply) => {
    const g = A.loadGroup(req, req.params.group); needG(g); const l = gLabel(req, g);
    const { values, errors } = ctx.labelValidate(req.body || {}, { col: 'group_id', id: g.id }, l.id);
    if (Object.keys(errors).length) return gForm(reply, g, l, values, errors, 422);
    kit.sql('UPDATE labels SET title = ?, color = ?, description = ?, updated_at = ? WHERE id = ?').run(values.title, values.color.toLowerCase(), values.description || null, kit.nowSql(), l.id);
    return reply.redirect(`${g.base}/-/labels`);
  });
  app.post('/groups/:group/-/labels/:id/delete', { config: { login: true } }, async (req, reply) => {
    const g = A.loadGroup(req, req.params.group); needG(g); const l = gLabel(req, g);
    ctx.deleteLabel(l);
    req.flash('success', `${l.title} was removed`);
    return reply.redirect(`${g.base}/-/labels`);
  });

  // ------------------------------------------------------------ settings
  app.get('/groups/:group/-/edit', { config: { login: true } }, async (req, reply) => {
    const g = A.loadGroup(req, req.params.group, { min: A.OWNER });
    return view(reply, 'group_edit', { title: 'General settings', group: g, nav: 'group.settings', values: g, errors: {}, crumbs: [['Settings']] });
  });
  app.post('/groups/:group/-/edit', { config: { login: true } }, async (req, reply) => {
    const g = A.loadGroup(req, req.params.group, { min: A.OWNER });
    const b = req.body || {};
    const values = { name: U.str(b.name) || g.name, description: b.description != null ? U.str(b.description) : g.description, visibility: U.str(b.visibility) || g.visibility, request_access_enabled: b.request_access_enabled != null ? (U.bool(b.request_access_enabled) ? 1 : 0) : g.request_access_enabled };
    const errors = {};
    if (!['private', 'internal', 'public'].includes(values.visibility)) errors.visibility = 'Visibility level is invalid';
    const vis = order(values.visibility);
    if (!errors.visibility && kit.sql(`SELECT 1 FROM projects WHERE namespace_id = ? AND (CASE visibility WHEN 'public' THEN 20 WHEN 'internal' THEN 10 ELSE 0 END) > ?`).get(g.id, vis)) errors.visibility = 'Visibility can\'t be more restrictive than a project of the group. Change the projects first.';
    if (Object.keys(errors).length) return view(reply, 'group_edit', { title: 'General settings', group: g, nav: 'group.settings', values: { ...g, ...values }, errors }, 422);
    kit.sql('UPDATE namespaces SET name = ?, description = ?, visibility = ?, request_access_enabled = ?, updated_at = ? WHERE id = ?').run(values.name, values.description || null, values.visibility, values.request_access_enabled, kit.nowSql(), g.id);
    req.flash('success', `Group '${values.name}' was successfully updated.`);
    return reply.redirect(`${g.base}/-/edit`);
  });
  app.post('/groups/:group/-/transfer_path', { config: { login: true } }, async (req, reply) => {
    const g = A.loadGroup(req, req.params.group, { min: A.OWNER });
    const path = U.str(req.body.path);
    const pe = U.validPath(path);
    const parentPath = g.parent_id ? kit.sql('SELECT full_path FROM namespaces WHERE id = ?').pluck().get(g.parent_id) : null;
    const full = parentPath ? `${parentPath}/${path}` : path;
    if (pe || (full.toLowerCase() !== g.full_path.toLowerCase() && kit.sql('SELECT 1 FROM namespaces WHERE full_path = ?').get(full))) {
      req.flash('error', pe || 'Group path has already been taken'); return reply.redirect(`${g.base}/-/edit`);
    }
    renameNamespace(g, path, full);
    req.flash('success', 'Group path was successfully updated.');
    return reply.redirect(`/groups/${full}/-/edit`);
  });
  function renameNamespace(g, path, full) {
    const old = g.full_path;
    kit.sql('UPDATE namespaces SET path = ?, full_path = ?, updated_at = ? WHERE id = ?').run(path, full, kit.nowSql(), g.id);
    // descendants and projects keep their relative paths
    kit.sql("UPDATE namespaces SET full_path = ? || substr(full_path, ?) WHERE full_path LIKE ? ESCAPE '\\' AND id != ?").run(full, old.length + 1, old.replace(/[\\%_]/g, (x) => '\\' + x) + '/%', g.id);
    kit.sql("UPDATE projects SET full_path = ? || substr(full_path, ?) WHERE full_path LIKE ? ESCAPE '\\'").run(full, old.length + 1, old.replace(/[\\%_]/g, (x) => '\\' + x) + '/%');
  }
  ctx.renameNamespace = renameNamespace;
  app.post('/groups/:group/-/delete', { config: { login: true } }, async (req, reply) => {
    const g = A.loadGroup(req, req.params.group, { min: A.OWNER });
    if (U.str(req.body.confirm_name) !== g.full_path && U.str(req.body.confirm_name) !== g.name) { req.flash('error', `To delete the group, type its path "${g.full_path}" in the confirmation field.`); return reply.redirect(`${g.base}/-/edit`); }
    const nsIds = kit.sql('WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT n.id FROM namespaces n JOIN t ON n.parent_id = t.id) SELECT id FROM t').pluck().all(g.id);
    const ph = nsIds.map(() => '?').join(',');
    for (const pid of kit.sql(`SELECT id FROM projects WHERE namespace_id IN (${ph})`).pluck().all(...nsIds)) ctx.destroyProject(pid);
    kit.sql(`DELETE FROM members WHERE source_type = 'namespace' AND source_id IN (${ph})`).run(...nsIds);
    kit.sql(`DELETE FROM label_links WHERE label_id IN (SELECT id FROM labels WHERE group_id IN (${ph}))`).run(...nsIds);
    kit.sql(`DELETE FROM label_priorities WHERE label_id IN (SELECT id FROM labels WHERE group_id IN (${ph}))`).run(...nsIds);
    kit.sql(`DELETE FROM labels WHERE group_id IN (${ph})`).run(...nsIds);
    kit.sql(`UPDATE issues SET milestone_id = NULL WHERE milestone_id IN (SELECT id FROM milestones WHERE group_id IN (${ph}))`).run(...nsIds);
    kit.sql(`UPDATE merge_requests SET milestone_id = NULL WHERE milestone_id IN (SELECT id FROM milestones WHERE group_id IN (${ph}))`).run(...nsIds);
    kit.sql(`DELETE FROM milestones WHERE group_id IN (${ph})`).run(...nsIds);
    kit.sql(`DELETE FROM namespaces WHERE id IN (${ph})`).run(...nsIds);
    req.flash('success', `Group '${g.name}' was scheduled for deletion.`);
    return reply.redirect('/dashboard/groups');
  });
  void back;
};
