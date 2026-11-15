'use strict';
// Milestones (project and group scope): list (state, search, sort) with progress, new, show
// (dates, progress, issues by column, merge requests), edit, close/reopen, delete.
// URLs: /:ns/:proj/-/milestones[/:iid[/edit]]  and  /groups/:group/-/milestones[/:iid[/edit]]
module.exports = function milestones(app, ctx) {
  const { kit, U, A, I, L, P, view, back } = ctx;
  const SORTS = { due_date_asc: 'm.due_date IS NULL, m.due_date ASC', due_date_desc: 'm.due_date IS NULL, m.due_date DESC', start_date_asc: 'm.start_date IS NULL, m.start_date ASC', start_date_desc: 'm.start_date IS NULL, m.start_date DESC', name_asc: 'm.title COLLATE NOCASE ASC', name_desc: 'm.title COLLATE NOCASE DESC', created_desc: 'm.created_at DESC', created_asc: 'm.created_at ASC' };
  const SORT_LABELS = [['due_date_asc', 'Due soon'], ['due_date_desc', 'Due later'], ['start_date_asc', 'Start soon'], ['start_date_desc', 'Start later'], ['name_asc', 'Name, ascending'], ['name_desc', 'Name, descending'], ['created_desc', 'Created date'], ['created_asc', 'Oldest created']];

  // scope: {project} | {group}
  const scopeOf = (s) => (s.project ? { col: 'project_id', id: s.project.id, base: `${s.project.base}/-/milestones`, access: s.project.access, archived: s.project.archived } : { col: 'group_id', id: s.group.id, base: `${s.group.base}/-/milestones`, access: s.group.access });
  function stats(ids) {
    if (!ids.length) return new Map();
    const ph = ids.map(() => '?').join(',');
    const m = new Map(ids.map((id) => [id, { issues: 0, closed: 0, open: 0, mrs: 0, merged: 0 }]));
    for (const r of kit.sql(`SELECT milestone_id, state, count(*) n FROM issues WHERE milestone_id IN (${ph}) GROUP BY 1, 2`).all(...ids)) { const s = m.get(r.milestone_id); s.issues += r.n; if (r.state === 'closed') s.closed += r.n; else s.open += r.n; }
    for (const r of kit.sql(`SELECT milestone_id, state, count(*) n FROM merge_requests WHERE milestone_id IN (${ph}) GROUP BY 1, 2`).all(...ids)) { const s = m.get(r.milestone_id); s.mrs += r.n; if (r.state === 'merged') s.merged += r.n; }
    for (const s of m.values()) s.pct = U.pct(s.closed, s.issues);
    return m;
  }

  function list(req, reply, s) {
    const sc = scopeOf(s);
    const state = ['opened', 'closed', 'all'].includes(U.str(req.query.state)) ? U.str(req.query.state) : 'opened';
    const sort = SORTS[U.str(req.query.sort)] ? U.str(req.query.sort) : 'due_date_asc';
    const q = U.str(req.query.search_title || req.query.title);
    const where = []; const params = [];
    if (s.project) {
      const groups = I.groupChain(s.project.namespace_id);
      where.push(`(m.project_id = ?${groups.length ? ` OR m.group_id IN (${groups.map(() => '?').join(',')})` : ''})`); params.push(s.project.id, ...groups);
    } else { where.push('m.group_id = ?'); params.push(s.group.id); }
    if (q) { where.push("m.title LIKE ? ESCAPE '\\'"); params.push(`%${q.replace(/[\\%_]/g, (x) => '\\' + x)}%`); }
    const counts = {};
    for (const st of ['opened', 'closed', 'all']) counts[st] = kit.sql(`SELECT count(*) FROM milestones m WHERE ${where.join(' AND ')}${st === 'all' ? '' : st === 'opened' ? " AND m.state = 'active'" : " AND m.state = 'closed'"}`).pluck().get(...params);
    const total = counts[state];
    const pager = kit.paginate(req, total, { perPage: 20 });
    const rows = kit.sql(`SELECT m.* FROM milestones m WHERE ${where.join(' AND ')}${state === 'all' ? '' : state === 'opened' ? " AND m.state = 'active'" : " AND m.state = 'closed'"} ORDER BY ${SORTS[sort]}, m.id LIMIT ? OFFSET ?`).all(...params, pager.limit, pager.offset);
    const st = stats(rows.map((m) => m.id));
    for (const m of rows) { m.stats = st.get(m.id); m.url = m.project_id ? (s.project && m.project_id === s.project.id ? `${sc.base}/${m.iid}` : null) : `/groups/${kit.sql('SELECT full_path FROM namespaces WHERE id = ?').pluck().get(m.group_id)}/-/milestones/${m.iid}`; }
    return view(reply, 'milestones', { title: 'Milestones', project: s.project, group: s.group, nav: s.project ? 'issues.milestones' : 'group.issues', rows, counts, state, sort, sortOptions: SORT_LABELS, q, pager, base: sc.base, canAdmin: sc.access >= A.REPORTER && !sc.archived, crumbs: [['Milestones']] });
  }
  app.get(P('milestones'), async (req, reply) => list(req, reply, { project: A.loadProject(req) }));
  app.get('/groups/:group/-/milestones', async (req, reply) => list(req, reply, { group: A.loadGroup(req, req.params.group) }));

  // ------------------------------------------------------------ CRUD
  const need = (sc) => { if (sc.access < A.REPORTER) throw kit.httpError(403, 'You need at least the Reporter role to manage milestones.'); if (sc.archived) throw kit.httpError(403, 'This project is archived.'); };
  const formView = (reply, s, m, values, errors, status) => {
    const sc = scopeOf(s);
    return view(reply, 'milestone_form', { title: m ? 'Edit Milestone' : 'New Milestone', project: s.project, group: s.group, nav: s.project ? 'issues.milestones' : 'group.issues', m, values, errors,
      action: m ? `${sc.base}/${m.iid}/edit` : sc.base, cancel: m ? `${sc.base}/${m.iid}` : sc.base, crumbs: [['Milestones', sc.base], [m ? 'Edit' : 'New']] }, status);
  };
  function validate(b, sc, exceptId) {
    const values = { title: U.str(b.title), description: String(b.description || '').replace(/\r\n/g, '\n'), start_date: U.str(b.start_date), due_date: U.str(b.due_date) };
    const errors = {};
    if (!values.title) errors.title = "Title can't be blank";
    else if (values.title.length > 255) errors.title = 'Title is too long (maximum is 255 characters)';
    else if (kit.sql(`SELECT 1 FROM milestones WHERE ${sc.col} = ? AND title = ? AND id != ?`).get(sc.id, values.title, exceptId || -1)) errors.title = 'Title already being used for another group or project milestone.';
    const sd = U.parseDate(values.start_date), dd = U.parseDate(values.due_date);
    if (sd === undefined) errors.start_date = 'Start date is invalid (use YYYY-MM-DD)';
    if (dd === undefined) errors.due_date = 'Due date is invalid (use YYYY-MM-DD)';
    if (sd && dd && dd < sd) errors.due_date = 'Due date must be greater than start date';
    values.sd = sd || null; values.dd = dd || null;
    return { values, errors };
  }
  const loadMs = (req, sc) => {
    const m = kit.sql(`SELECT * FROM milestones WHERE ${sc.col} = ? AND iid = ?`).get(sc.id, U.int(req.params.iid));
    if (!m) throw kit.httpError(404, 'Milestone not found');
    return m;
  };
  const both = (method, suffix, handler, cfg = {}) => {
    app.route({ method, url: P(`milestones${suffix}`), config: cfg, handler: (req, reply) => handler(req, reply, { project: A.loadProject(req) }) });
    app.route({ method, url: `/groups/:group/-/milestones${suffix}`, config: cfg, handler: (req, reply) => handler(req, reply, { group: A.loadGroup(req, req.params.group) }) });
  };
  both('GET', '/new', async (req, reply, s) => { need(scopeOf(s)); return formView(reply, s, null, {}, {}); }, { login: true });
  both('POST', '', async (req, reply, s) => {
    const sc = scopeOf(s); need(sc);
    const { values, errors } = validate(req.body || {}, sc);
    if (Object.keys(errors).length) return formView(reply, s, null, values, errors, 422);
    const iid = (kit.sql(`SELECT max(iid) FROM milestones WHERE ${sc.col} = ?`).pluck().get(sc.id) || 0) + 1;
    const now = kit.nowSql();
    const r = kit.sql(`INSERT INTO milestones (${sc.col}, iid, title, description, state, start_date, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
      .run(sc.id, iid, values.title, values.description || null, values.sd, values.dd, now, now);
    if (s.project) I.addEvent(s.project, req.user, 'created', 'milestone', Number(r.lastInsertRowid), values.title);
    else kit.sql("INSERT INTO events (group_id, author_id, action, target_type, target_id, target_title, created_at) VALUES (?, ?, 'created', 'milestone', ?, ?, ?)").run(s.group.id, req.user.id, Number(r.lastInsertRowid), values.title, now);
    req.flash('success', `Milestone ${values.title} was created.`);
    return reply.redirect(`${sc.base}/${iid}`);
  }, { login: true });

  both('GET', '/:iid', async (req, reply, s) => {
    const sc = scopeOf(s);
    const m = loadMs(req, sc);
    const st = stats([m.id]).get(m.id);
    const visible = s.project ? null : A.visible(req.user, 'p');
    const issueRows = kit.sql(`SELECT t.* FROM issues t JOIN projects p ON p.id = t.project_id WHERE t.milestone_id = ?${visible ? ` AND ${visible.sql}` : ''} AND (t.confidential = 0 OR ? = 1) ORDER BY t.state DESC, t.updated_at DESC LIMIT 300`)
      .all(m.id, ...(visible ? visible.params : []), sc.access >= A.REPORTER ? 1 : 0);
    L.decorate('issue', issueRows);
    const mrRows = kit.sql(`SELECT t.* FROM merge_requests t JOIN projects p ON p.id = t.project_id WHERE t.milestone_id = ?${visible ? ` AND ${visible.sql}` : ''} ORDER BY t.updated_at DESC LIMIT 200`).all(m.id, ...(visible ? visible.params : []));
    L.decorate('merge_request', mrRows);
    const tab = U.str(req.query.tab) === 'merge_requests' ? 'merge_requests' : U.str(req.query.tab) === 'labels' ? 'labels' : 'issues';
    const labelsUsed = kit.sql(`SELECT l.*, count(*) n FROM label_links ll JOIN labels l ON l.id = ll.label_id JOIN issues i ON i.id = ll.target_id AND ll.target_type = 'issue' WHERE i.milestone_id = ? GROUP BY l.id ORDER BY l.title`).all(m.id);
    const parts = new Set(); for (const i of issueRows) for (const a of i.assignees) parts.add(a.username);
    return view(reply, 'milestone', {
      title: m.title, project: s.project, group: s.group, nav: s.project ? 'issues.milestones' : 'group.issues', m, st, tab, base: `${sc.base}/${m.iid}`, listBase: sc.base,
      unstarted: issueRows.filter((i) => i.state === 'opened' && !i.assignees.length), ongoing: issueRows.filter((i) => i.state === 'opened' && i.assignees.length), closed: issueRows.filter((i) => i.state === 'closed'),
      mrRows, labelsUsed, participants: parts.size, canAdmin: sc.access >= A.REPORTER && !sc.archived,
      issuesHref: s.project ? `${s.project.base}/-/issues?milestone_title=${encodeURIComponent(m.title)}` : `${s.group.base}/-/issues?milestone_title=${encodeURIComponent(m.title)}`,
      crumbs: [['Milestones', sc.base], [m.title]],
    });
  });
  both('GET', '/:iid/edit', async (req, reply, s) => { const sc = scopeOf(s); need(sc); const m = loadMs(req, sc); return formView(reply, s, m, m, {}); }, { login: true });
  both('POST', '/:iid/edit', async (req, reply, s) => {
    const sc = scopeOf(s); need(sc);
    const m = loadMs(req, sc);
    const { values, errors } = validate(req.body || {}, sc, m.id);
    if (Object.keys(errors).length) return formView(reply, s, m, values, errors, 422);
    kit.sql('UPDATE milestones SET title = ?, description = ?, start_date = ?, due_date = ?, updated_at = ? WHERE id = ?').run(values.title, values.description || null, values.sd, values.dd, kit.nowSql(), m.id);
    req.flash('success', 'Milestone was updated.');
    return reply.redirect(`${sc.base}/${m.iid}`);
  }, { login: true });
  for (const [act, state] of [['close', 'closed'], ['reopen', 'active']]) {
    both('POST', `/:iid/${act}`, async (req, reply, s) => {
      const sc = scopeOf(s); need(sc);
      const m = loadMs(req, sc);
      kit.sql('UPDATE milestones SET state = ?, updated_at = ? WHERE id = ?').run(state, kit.nowSql(), m.id);
      if (s.project) I.addEvent(s.project, req.user, state === 'closed' ? 'closed' : 'reopened', 'milestone', m.id, m.title);
      req.flash('success', state === 'closed' ? `Milestone ${m.title} was closed.` : `Milestone ${m.title} was reopened.`);
      return reply.redirect(back(req, `${sc.base}/${m.iid}`));
    }, { login: true });
  }
  both('POST', '/:iid/delete', async (req, reply, s) => {
    const sc = scopeOf(s); need(sc);
    const m = loadMs(req, sc);
    kit.sql('UPDATE issues SET milestone_id = NULL WHERE milestone_id = ?').run(m.id);
    kit.sql('UPDATE merge_requests SET milestone_id = NULL WHERE milestone_id = ?').run(m.id);
    kit.sql('DELETE FROM milestones WHERE id = ?').run(m.id);
    if (s.project) I.addEvent(s.project, req.user, 'destroyed', 'milestone', m.id, m.title);
    req.flash('success', `Milestone ${m.title} was deleted.`);
    return reply.redirect(sc.base);
  }, { login: true });
};
