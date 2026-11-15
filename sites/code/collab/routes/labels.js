'use strict';
// Project labels (/-/labels): list (prioritized + other, search, sort), new, edit, delete,
// prioritize / unprioritize, promote is not offered. Group labels are listed read-only in
// projects and managed at /groups/:group/-/labels.
module.exports = function labels(app, ctx) {
  const { kit, U, A, I, P, view, back } = ctx;
  const SORTS = { name_asc: 'l.title COLLATE NOCASE ASC', name_desc: 'l.title COLLATE NOCASE DESC', created_desc: 'l.created_at DESC, l.id DESC', created_asc: 'l.created_at ASC, l.id ASC', updated_desc: 'l.updated_at DESC', updated_asc: 'l.updated_at ASC' };
  const SORT_LABELS = [['name_asc', 'Name'], ['name_desc', 'Name, descending'], ['created_desc', 'Last created'], ['created_asc', 'Oldest created'], ['updated_desc', 'Updated date'], ['updated_asc', 'Oldest updated']];
  const COLOR_RE = /^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{3}$/;

  function counts(kind, ids) {
    if (!ids.length) return new Map();
    const table = kind === 'issue' ? 'issues' : 'merge_requests';
    return new Map(kit.sql(`SELECT ll.label_id, count(*) n FROM label_links ll JOIN ${table} t ON t.id = ll.target_id
      WHERE ll.target_type = ? AND ll.label_id IN (${ids.map(() => '?').join(',')}) AND t.state = 'opened' GROUP BY ll.label_id`).all(kind, ...ids).map((r) => [r.label_id, r.n]));
  }

  function listLabels(req, { projectId = null, groupIds = [], prioProject = null }) {
    const q = U.str(req.query.search);
    const sort = SORTS[U.str(req.query.sort)] ? U.str(req.query.sort) : 'name_asc';
    const where = []; const params = [];
    const scope = [];
    if (projectId) { scope.push('l.project_id = ?'); params.push(projectId); }
    if (groupIds.length) { scope.push(`l.group_id IN (${groupIds.map(() => '?').join(',')})`); params.push(...groupIds); }
    where.push(`(${scope.join(' OR ') || '0'})`);
    if (q) { where.push("(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[\\%_]/g, (x) => '\\' + x)}%`; params.push(like, like); }
    const rows = kit.sql(`SELECT l.*, lp.priority FROM labels l LEFT JOIN label_priorities lp ON lp.label_id = l.id AND lp.project_id = ?
      WHERE ${where.join(' AND ')} ORDER BY ${SORTS[sort]}, l.id`).all(prioProject || -1, ...params);
    const ids = rows.map((l) => l.id);
    const ic = counts('issue', ids), mc = counts('merge_request', ids);
    for (const l of rows) { l.open_issues = ic.get(l.id) || 0; l.open_mrs = mc.get(l.id) || 0; }
    return { rows, sort, q };
  }
  ctx.listLabels = listLabels;

  app.get(P('labels'), async (req, reply) => {
    const project = A.loadProject(req);
    const groups = I.groupChain(project.namespace_id);
    const r = listLabels(req, { projectId: project.id, groupIds: groups, prioProject: project.id });
    const prioritized = r.rows.filter((l) => l.priority != null).sort((a, b) => a.priority - b.priority);
    const other = r.rows.filter((l) => l.priority == null);
    return view(reply, 'labels', { title: 'Labels', project, nav: 'labels', r, prioritized, other, sortOptions: SORT_LABELS, canAdmin: project.access >= A.REPORTER && !project.archived, base: `${project.base}/-/labels`, crumbs: [['Labels']] });
  });

  // ------------------------------------------------------------ CRUD (project)
  const formView = (reply, project, label, values, errors, status) => view(reply, 'label_form', {
    title: label ? 'Edit label' : 'New label', project, nav: 'labels', label, values, errors, action: label ? `${project.base}/-/labels/${label.id}/edit` : `${project.base}/-/labels`,
    cancel: `${project.base}/-/labels`, colors: U.LABEL_COLORS, crumbs: [['Labels', `${project.base}/-/labels`], [label ? 'Edit' : 'New']],
  }, status);
  const need = (req, project) => { if (project.access < A.REPORTER) throw kit.httpError(403, 'You need at least the Reporter role to manage labels.'); if (project.archived) throw kit.httpError(403, 'This project is archived.'); };
  const validate = (b, scope, exceptId) => {
    const values = { title: U.str(b.title), description: U.str(b.description), color: U.str(b.color) || '#6699cc' };
    const errors = {};
    if (!values.title) errors.title = "Title can't be blank";
    else if (values.title.length > 255) errors.title = 'Title is too long (maximum is 255 characters)';
    else if (/[,]/.test(values.title)) errors.title = 'Title is invalid (commas are not allowed)';
    else if (kit.sql(`SELECT 1 FROM labels WHERE ${scope.col} = ? AND title = ? AND id != ?`).get(scope.id, values.title, exceptId || -1)) errors.title = 'Title has already been taken';
    if (!COLOR_RE.test(values.color)) errors.color = 'Color must be a valid color code (e.g. #FF0000)';
    return { values, errors };
  };
  ctx.labelValidate = validate;
  ctx.labelFormView = formView;

  app.get(P('labels/new'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req); need(req, project);
    return formView(reply, project, null, { color: U.LABEL_COLORS[(kit.sql('SELECT count(*) FROM labels WHERE project_id = ?').pluck().get(project.id)) % U.LABEL_COLORS.length] }, {});
  });
  app.post(P('labels'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req); need(req, project);
    const { values, errors } = validate(req.body || {}, { col: 'project_id', id: project.id });
    if (Object.keys(errors).length) return formView(reply, project, null, values, errors, 422);
    const now = kit.nowSql();
    kit.sql('INSERT INTO labels (project_id, title, color, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(project.id, values.title, values.color.toLowerCase(), values.description || null, now, now);
    req.flash('success', `Label ${values.title} was created.`);
    return reply.redirect(back(req, `${project.base}/-/labels`));
  });
  const loadLabel = (req, project) => {
    const l = kit.sql('SELECT * FROM labels WHERE id = ? AND project_id = ?').get(U.int(req.params.id), project.id);
    if (!l) throw kit.httpError(404, 'Label not found');
    return l;
  };
  app.get(P('labels/:id/edit'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req); need(req, project);
    const l = loadLabel(req, project);
    return formView(reply, project, l, l, {});
  });
  app.post(P('labels/:id/edit'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req); need(req, project);
    const l = loadLabel(req, project);
    const { values, errors } = validate(req.body || {}, { col: 'project_id', id: project.id }, l.id);
    if (Object.keys(errors).length) return formView(reply, project, l, values, errors, 422);
    kit.sql('UPDATE labels SET title = ?, color = ?, description = ?, updated_at = ? WHERE id = ?').run(values.title, values.color.toLowerCase(), values.description || null, kit.nowSql(), l.id);
    req.flash('success', `Label ${values.title} was updated.`);
    return reply.redirect(`${project.base}/-/labels`);
  });
  app.post(P('labels/:id/delete'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req); need(req, project);
    const l = loadLabel(req, project);
    deleteLabel(l);
    req.flash('success', `${l.title} was removed`);
    return reply.redirect(`${project.base}/-/labels`);
  });
  function deleteLabel(l) {
    kit.sql('DELETE FROM label_links WHERE label_id = ?').run(l.id);
    kit.sql('DELETE FROM label_priorities WHERE label_id = ?').run(l.id);
    kit.sql('DELETE FROM labels WHERE id = ?').run(l.id);
  }
  ctx.deleteLabel = deleteLabel;
  // prioritize (project or inherited group label)
  app.post(P('labels/:id/toggle_priority'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req); need(req, project);
    const l = I.projectLabels(project).find((x) => x.id === U.int(req.params.id));
    if (!l) throw kit.httpError(404, 'Label not found');
    if (l.priority != null) kit.sql('DELETE FROM label_priorities WHERE project_id = ? AND label_id = ?').run(project.id, l.id);
    else {
      const next = (kit.sql('SELECT max(priority) FROM label_priorities WHERE project_id = ?').pluck().get(project.id) ?? -1) + 1;
      kit.sql('INSERT INTO label_priorities (project_id, label_id, priority, created_at) VALUES (?, ?, ?, ?)').run(project.id, l.id, next, kit.nowSql());
    }
    return reply.redirect(back(req, `${project.base}/-/labels`));
  });
  // move a prioritized label up/down
  app.post(P('labels/:id/move'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req); need(req, project);
    const rows = kit.sql('SELECT label_id, priority FROM label_priorities WHERE project_id = ? ORDER BY priority').all(project.id);
    const i = rows.findIndex((r) => r.label_id === U.int(req.params.id));
    const j = U.str(req.body.direction) === 'up' ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < rows.length) { [rows[i], rows[j]] = [rows[j], rows[i]]; rows.forEach((r, k) => kit.sql('UPDATE label_priorities SET priority = ? WHERE project_id = ? AND label_id = ?').run(k, project.id, r.label_id)); }
    return reply.redirect(`${project.base}/-/labels`);
  });
};
