'use strict';
// Project issues: list with GitLab filters, new/create, show (description, timeline, sidebar),
// edit, close/reopen, assignees, labels, milestone, due date, confidentiality, lock, award
// emoji, comments (add/reply/edit/delete), delete issue, user autocomplete.
module.exports = function issues(app, ctx) {
  const { kit, U, A, I, L, P, view, back } = ctx;

  const loadIssue = (req, project) => {
    const iid = U.int(req.params.iid);
    const i = iid != null && kit.sql('SELECT * FROM issues WHERE project_id = ? AND iid = ?').get(project.id, iid);
    if (!i || !A.canSeeConfidential(req.user, project, i)) throw kit.httpError(404, 'Issue not found');
    return i;
  };
  const requireIssues = (project) => { if (!project.issues_enabled) throw kit.httpError(404, 'Issues are disabled for this project.'); };
  const canEdit = (req, project, i) => !!req.user && (project.access >= A.REPORTER || req.user.id === i.author_id);
  const canAdmin = (req, project) => !!req.user && project.access >= A.REPORTER;
  const canComment = (req, project, i) => !!req.user && (!i.discussion_locked || project.access >= A.REPORTER) && !project.archived;
  const needEdit = (req, project, i) => { if (!canEdit(req, project, i)) throw kit.httpError(403, 'You are not allowed to update this issue.'); if (project.archived) throw kit.httpError(403, 'This project is archived.'); };
  const needAdmin = (req, project) => { if (!canAdmin(req, project)) throw kit.httpError(403, 'You need at least the Reporter role to do this.'); if (project.archived) throw kit.httpError(403, 'This project is archived.'); };
  const labelIdsFor = (project) => { const all = I.projectLabels(project); return (title) => all.filter((l) => l.title === title).map((l) => l.id); };
  const issueUrl = (project, i) => `${project.base}/-/issues/${i.iid}`;

  // candidates for the assignee / reviewer pickers: project members (direct + inherited), newest first
  ctx.memberCandidates = (project, limit = 40) => kit.sql(`SELECT DISTINCT u.id, u.username, u.name, u.avatar FROM users u WHERE u.state = 'active' AND (
      u.id IN (SELECT user_id FROM members WHERE source_type = 'project' AND source_id = ? AND requested_at IS NULL)
      OR u.id IN (SELECT user_id FROM members WHERE source_type = 'namespace' AND source_id = ? AND requested_at IS NULL)
      OR u.id = (SELECT owner_id FROM namespaces WHERE id = ? AND kind = 'user'))
    ORDER BY u.username COLLATE NOCASE LIMIT ?`).all(project.id, project.namespace_id, project.namespace_id, limit);

  // picked users from a picker form: checkbox ids (field[]) + free-text usernames (field_usernames)
  ctx.pickedUsers = (body, field) => {
    const ids = U.arr(body[`${field}[]`] ?? body[field]).map(Number).filter(Boolean);
    const names = U.str(body[`${field}_usernames`]).split(/[\s,]+/).filter(Boolean);
    const found = ctx.usersByNames(names);
    const missing = found.filter((u) => u.missing).map((u) => u.missing);
    if (missing.length) throw kit.httpError(422, `User not found: ${missing.join(', ')}`);
    return [...new Set([...ids, ...found.map((u) => u.id)])];
  };

  // ------------------------------------------------------------ list
  app.get(P('issues'), async (req, reply) => {
    const project = A.loadProject(req);
    requireIssues(project);
    const r = L.list('issue', req, { projectId: project.id, labelIds: labelIdsFor(project), confidentialFilter: A.confidentialSql(req.user, project), user: req.user });
    return view(reply, 'issues', {
      title: 'Issues', project, nav: 'issues.list', kind: 'issue', r, base: `${project.base}/-/issues`,
      labels: I.projectLabels(project), milestones: I.projectMilestones(project), canCreate: !!req.user && !project.archived,
      crumbs: [['Issues', `${project.base}/-/issues`]],
    });
  });

  // ------------------------------------------------------------ new / create
  app.get(P('issues/new'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    requireIssues(project);
    const q = req.query;
    const values = { title: U.str(q['issue[title]'] || q.title), description: U.str(q['issue[description]'] || q.description), issue_type: 'issue', confidential: U.bool(q['issue[confidential]']) };
    return renderForm(req, reply, project, null, values, {});
  });
  function renderForm(req, reply, project, issue, values, errors, status) {
    return view(reply, 'issue_form', {
      title: issue ? `Edit issue #${issue.iid}` : 'New Issue', project, nav: 'issues.list', issue, values, errors,
      labels: I.projectLabels(project), milestones: I.projectMilestones(project, { state: 'active' }), members: ctx.memberCandidates(project),
      canAdmin: canAdmin(req, project),
      crumbs: issue ? [['Issues', `${project.base}/-/issues`], [`#${issue.iid}`, issueUrl(project, issue)], ['Edit']] : [['Issues', `${project.base}/-/issues`], ['New']],
    }, status);
  }

  app.post(P('issues'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    requireIssues(project);
    if (project.archived) throw kit.httpError(403, 'This project is archived.');
    const b = req.body || {};
    const values = { title: U.str(b.title), description: U.str(b.description), issue_type: U.str(b.issue_type) || 'issue', confidential: U.bool(b.confidential),
      due_date: U.str(b.due_date), milestone_id: U.int(b.milestone_id), label_ids: U.arr(b['label_ids[]'] ?? b.label_ids).map(Number), assignee_ids: U.arr(b['assignee_ids[]'] ?? b.assignee_ids).map(Number), assignee_ids_usernames: U.str(b.assignee_ids_usernames) };
    const errors = {};
    if (!values.title) errors.title = "Title can't be blank";
    else if (values.title.length > 255) errors.title = 'Title is too long (maximum is 255 characters)';
    if (!['issue', 'incident'].includes(values.issue_type)) values.issue_type = 'issue';
    const due = U.parseDate(values.due_date);
    if (due === undefined) errors.due_date = 'Due date is not a valid date (use YYYY-MM-DD)';
    let assignees = [];
    try { assignees = ctx.pickedUsers(b, 'assignee_ids'); } catch (e) { errors.assignee_ids = e.message; }
    if (Object.keys(errors).length) return renderForm(req, reply, project, null, values, errors, 422);
    const admin = canAdmin(req, project);
    const now = kit.nowSql();
    const iid = (kit.sql('SELECT max(iid) FROM issues WHERE project_id = ?').pluck().get(project.id) || 0) + 1;
    const r = kit.sql(`INSERT INTO issues (project_id, iid, title, description, state, issue_type, author_id, milestone_id, due_date, confidential, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'opened', ?, ?, ?, ?, ?, ?, ?)`).run(project.id, iid, values.title, values.description || null, values.issue_type, req.user.id,
      admin && values.milestone_id && I.projectMilestones(project).some((m) => m.id === values.milestone_id) ? values.milestone_id : null,
      admin ? due || null : null, values.confidential ? 1 : 0, now, now);
    const issue = kit.sql('SELECT * FROM issues WHERE id = ?').get(Number(r.lastInsertRowid));
    if (admin) {
      const allowed = new Set(I.projectLabels(project).map((l) => l.id));
      for (const id of values.label_ids) if (allowed.has(id)) kit.sql('INSERT OR IGNORE INTO label_links (label_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)').run(id, 'issue', issue.id, now);
      for (const uid of assignees) { kit.sql('INSERT OR IGNORE INTO issue_assignees (issue_id, user_id) VALUES (?, ?)').run(issue.id, uid); I.addTodo(uid, project, 'issue', issue, req.user, 'assigned'); }
    }
    kit.sql('UPDATE projects SET open_issues_count = open_issues_count + 1 WHERE id = ?').run(project.id);
    I.addEvent(project, req.user, 'created', 'issue', issue.id, issue.title);
    I.mentionTodos(project, 'issue', issue, req.user, issue.description, null);
    return reply.redirect(issueUrl(project, issue));
  });

  // ------------------------------------------------------------ show
  app.get(P('issues/:iid'), async (req, reply) => {
    const project = A.loadProject(req);
    requireIssues(project);
    const issue = loadIssue(req, project);
    return renderIssue(req, reply, project, issue);
  });
  function renderIssue(req, reply, project, issue, extra = {}) {
    const labels = I.labelsOf('issue', issue.id);
    const assignees = I.assigneesOf('issue', issue.id);
    const milestone = issue.milestone_id ? kit.sql('SELECT * FROM milestones WHERE id = ?').get(issue.milestone_id) : null;
    const author = kit.sql('SELECT id, username, name, avatar FROM users WHERE id = ?').get(issue.author_id);
    const closedBy = issue.closed_by_id ? kit.sql('SELECT id, username, name, avatar FROM users WHERE id = ?').get(issue.closed_by_id) : null;
    const awards = kit.sql('SELECT name, count(*) n, max(user_id = ?) mine FROM award_emoji WHERE awardable_type = ? AND awardable_id = ? GROUP BY name').all(req.user ? req.user.id : -1, 'issue', issue.id);
    const related = kit.sql(`SELECT m.iid, m.title, m.state FROM merge_requests m WHERE m.project_id = ? AND (m.description LIKE ? OR m.title LIKE ?) ORDER BY m.id DESC LIMIT 10`)
      .all(project.id, `%#${issue.iid}%`, `%#${issue.iid}%`).filter((m) => new RegExp(`#${issue.iid}(?!\\d)`).test(m.title + ' ' + (m.description || '')));
    return view(reply, 'issue', {
      title: `${issue.title} (#${issue.iid})`, project, nav: 'issues.list', issue, labels, assignees, milestone, author, closedBy, awards, related,
      timeline: I.timeline(project, 'issue', issue), participants: I.participants('issue', issue),
      allLabels: I.projectLabels(project), milestones: I.projectMilestones(project), members: ctx.memberCandidates(project),
      can: { edit: canEdit(req, project, issue), admin: canAdmin(req, project), comment: canComment(req, project, issue), delete: !!req.user && project.access >= A.OWNER },
      todo: req.user ? kit.sql("SELECT id FROM todos WHERE user_id = ? AND target_type = 'issue' AND target_id = ? AND state = 'pending' LIMIT 1").get(req.user.id, issue.id) : null,
      crumbs: [['Issues', `${project.base}/-/issues`], [`#${issue.iid}`]], ...extra,
    });
  }

  // ------------------------------------------------------------ edit title/description
  app.get(P('issues/:iid/edit'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const issue = loadIssue(req, project);
    needEdit(req, project, issue);
    return renderForm(req, reply, project, issue, { ...issue, confidential: !!issue.confidential }, {});
  });
  app.post(P('issues/:iid/edit'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const issue = loadIssue(req, project);
    needEdit(req, project, issue);
    const b = req.body || {};
    const title = U.str(b.title); const description = b.description == null ? issue.description : String(b.description).replace(/\r\n/g, '\n');
    if (!title) return renderForm(req, reply, project, issue, { ...issue, title, description }, { title: "Title can't be blank" }, 422);
    if (title.length > 255) return renderForm(req, reply, project, issue, { ...issue, title, description }, { title: 'Title is too long (maximum is 255 characters)' }, 422);
    const now = kit.nowSql();
    if (title !== issue.title) {
      kit.sql('UPDATE issues SET title = ?, updated_at = ?, updated_by_id = ?, last_edited_at = ?, last_edited_by_id = ? WHERE id = ?').run(title, now, req.user.id, now, req.user.id, issue.id);
      I.systemNote(project, 'issue', issue, req.user, `changed title from **${issue.title}** to **${title}**`, 'title');
    }
    if ((description || '') !== (issue.description || '')) {
      kit.sql('UPDATE issues SET description = ?, updated_at = ?, updated_by_id = ?, last_edited_at = ?, last_edited_by_id = ? WHERE id = ?').run(description || null, now, req.user.id, now, req.user.id, issue.id);
      I.systemNote(project, 'issue', issue, req.user, 'changed the description', 'description');
    }
    if (b.confidential != null && canAdmin(req, project)) setConfidential(project, issue, req.user, U.bool(b.confidential));
    if (b.issue_type && ['issue', 'incident'].includes(U.str(b.issue_type))) kit.sql('UPDATE issues SET issue_type = ? WHERE id = ?').run(U.str(b.issue_type), issue.id);
    req.flash('success', 'The issue was successfully updated.');
    return reply.redirect(issueUrl(project, issue));
  });

  // ------------------------------------------------------------ state
  for (const [act, state] of [['close', 'closed'], ['reopen', 'opened']]) {
    app.post(P(`issues/:iid/${act}`), { config: { login: true } }, async (req, reply) => {
      const project = A.loadProject(req);
      const issue = loadIssue(req, project);
      needEdit(req, project, issue);
      if (I.setState(project, 'issue', issue, req.user, state)) req.flash('success', state === 'closed' ? 'The issue was closed.' : 'The issue was reopened.');
      return reply.redirect(back(req, issueUrl(project, issue)));
    });
  }

  // ------------------------------------------------------------ sidebar fields
  const sidebar = (name, fn, { admin = true } = {}) => app.post(P(`issues/:iid/${name}`), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const issue = loadIssue(req, project);
    if (admin) needAdmin(req, project); else needEdit(req, project, issue);
    const res = fn(req, project, issue, req.body || {});
    if (req.headers.accept && req.headers.accept.includes('application/json')) return { ok: true, ...(res || {}) };
    return reply.redirect(back(req, issueUrl(project, issue)));
  });
  sidebar('assignees', (req, project, issue, b) => {
    let ids = ctx.pickedUsers(b, 'assignee_ids');
    if (U.bool(b.assign_self)) ids = [...new Set([...I.assigneesOf('issue', issue.id).map((u) => u.id), req.user.id])];
    if (U.bool(b.unassign_all)) ids = [];
    if (I.setAssignees(project, 'issue', issue, req.user, ids)) req.flash('success', 'Assignees updated.');
  });
  sidebar('labels', (req, project, issue, b) => {
    let ids = U.arr(b['label_ids[]'] ?? b.label_ids).map(Number);
    if (b.add_label_id) ids = [...new Set([...I.labelsOf('issue', issue.id).map((l) => l.id), Number(b.add_label_id)])];
    if (b.remove_label_id) ids = I.labelsOf('issue', issue.id).map((l) => l.id).filter((x) => x !== Number(b.remove_label_id));
    if (I.setLabels(project, 'issue', issue, req.user, ids)) req.flash('success', 'Labels updated.');
  });
  sidebar('milestone', (req, project, issue, b) => { if (I.setMilestone(project, 'issue', issue, req.user, U.int(b.milestone_id))) req.flash('success', 'Milestone updated.'); });
  sidebar('due_date', (req, project, issue, b) => {
    const d = U.bool(b.remove) ? null : U.parseDate(b.due_date);
    if (d === undefined) throw kit.httpError(422, 'Due date is not a valid date (use YYYY-MM-DD).');
    if (I.setDueDate(project, issue, req.user, d)) req.flash('success', d ? `Due date set to ${U.dateFmt(d)}.` : 'Due date removed.');
  });
  sidebar('confidential', (req, project, issue, b) => { setConfidential(project, issue, req.user, U.bool(b.confidential)); });
  sidebar('lock', (req, project, issue, b) => {
    const v = U.bool(b.locked) ? 1 : 0;
    if (v === issue.discussion_locked) return;
    kit.sql('UPDATE issues SET discussion_locked = ?, updated_at = ? WHERE id = ?').run(v, kit.nowSql(), issue.id);
    I.systemNote(project, 'issue', issue, req.user, v ? 'locked this issue' : 'unlocked this issue', 'locked');
  });
  sidebar('todo', (req, project, issue) => {
    const t = kit.sql("SELECT id FROM todos WHERE user_id = ? AND target_type = 'issue' AND target_id = ? AND state = 'pending'").get(req.user.id, issue.id);
    if (t) I.doneTodos(req.user.id, 'issue', issue.id);
    else I.addTodo(req.user.id, project, 'issue', issue, req.user, 'marked');
  }, { admin: false });
  function setConfidential(project, issue, user, on) {
    const v = on ? 1 : 0;
    if (v === issue.confidential) return;
    kit.sql('UPDATE issues SET confidential = ?, updated_at = ? WHERE id = ?').run(v, kit.nowSql(), issue.id);
    I.systemNote(project, 'issue', issue, user, v ? 'made the issue confidential' : 'made the issue visible to everyone', 'confidential');
  }
  ctx.setConfidential = setConfidential;

  // award emoji (thumbsup / thumbsdown / others) toggle on issues, MRs and notes
  ctx.toggleAward = (kind, target, user, name) => {
    const ex = kit.sql('SELECT id FROM award_emoji WHERE awardable_type = ? AND awardable_id = ? AND user_id = ? AND name = ?').get(kind, target.id, user.id, name);
    const delta = ex ? -1 : 1;
    if (ex) kit.sql('DELETE FROM award_emoji WHERE id = ?').run(ex.id);
    else kit.sql('INSERT INTO award_emoji (user_id, awardable_type, awardable_id, name, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, kind, target.id, name, kit.nowSql());
    const table = I.TABLE[kind];
    if (table && (name === 'thumbsup' || name === 'thumbsdown')) kit.sql(`UPDATE ${table} SET ${name === 'thumbsup' ? 'upvotes' : 'downvotes'} = max(0, ${name === 'thumbsup' ? 'upvotes' : 'downvotes'} + ?) WHERE id = ?`).run(delta, target.id);
    return !ex;
  };
  app.post(P('issues/:iid/award'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const issue = loadIssue(req, project);
    const name = U.str(req.body.name).replace(/[^a-z0-9_+-]/gi, '') || 'thumbsup';
    ctx.toggleAward('issue', issue, req.user, name);
    return reply.redirect(back(req, issueUrl(project, issue)));
  });

  // ------------------------------------------------------------ comments
  app.post(P('issues/:iid/notes'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const issue = loadIssue(req, project);
    if (!canComment(req, project, issue)) throw kit.httpError(403, issue.discussion_locked ? 'This issue is locked. Only project members can comment.' : 'You cannot comment here.');
    const body = String(req.body.note || req.body.body || '').replace(/\r\n/g, '\n').trim();
    const closing = U.str(req.body.close) === '1' || U.str(req.body.state_event) === 'close';
    const reopening = U.str(req.body.reopen) === '1' || U.str(req.body.state_event) === 'reopen';
    let noteId = null;
    if (body) {
      const disc = U.str(req.body.discussion_id) || null;
      if (disc && !kit.sql("SELECT 1 FROM notes WHERE discussion_id = ? AND noteable_type = 'issue' AND noteable_id = ?").get(disc, issue.id)) throw kit.httpError(422, 'Thread not found.');
      if (disc) kit.sql("UPDATE notes SET type = coalesce(type, 'DiscussionNote') WHERE discussion_id = ? AND noteable_type = 'issue' AND noteable_id = ?").run(disc, issue.id);
      noteId = I.addNote(project, 'issue', issue, req.user, body, { discussion: disc, internal: U.bool(req.body.internal) && project.access >= A.REPORTER, type: U.bool(req.body.start_thread) ? 'DiscussionNote' : null });
    } else if (!closing && !reopening) {
      req.flash('error', "Note can't be blank");
      return reply.redirect(issueUrl(project, issue));
    }
    if ((closing || reopening) && canEdit(req, project, issue)) I.setState(project, 'issue', issue, req.user, closing ? 'closed' : 'opened');
    return reply.redirect(issueUrl(project, issue) + (noteId ? `#note_${noteId}` : ''));
  });
  ctx.noteRoutes = (kind, prefix, loader) => {
    const loadNote = (req, target) => {
      const n = kit.sql('SELECT * FROM notes WHERE id = ? AND noteable_type = ? AND noteable_id = ? AND system = 0').get(U.int(req.params.note), kind, target.id);
      if (!n) throw kit.httpError(404, 'Comment not found');
      return n;
    };
    app.post(P(`${prefix}/:iid/notes/:note/edit`), { config: { login: true } }, async (req, reply) => {
      const project = A.loadProject(req); const target = loader(req, project); const n = loadNote(req, target);
      if (n.author_id !== req.user.id) throw kit.httpError(403, 'You can only edit your own comments.');
      const body = String(req.body.note || req.body.body || '').replace(/\r\n/g, '\n').trim();
      if (!body) throw kit.httpError(422, "Note can't be blank");
      kit.sql('UPDATE notes SET body = ?, updated_at = ?, last_edited_at = ? WHERE id = ?').run(body, kit.nowSql(), kit.nowSql(), n.id);
      return reply.redirect(`${project.base}/-/${prefix}/${target.iid}#note_${n.id}`);
    });
    app.post(P(`${prefix}/:iid/notes/:note/delete`), { config: { login: true } }, async (req, reply) => {
      const project = A.loadProject(req); const target = loader(req, project); const n = loadNote(req, target);
      if (n.author_id !== req.user.id && project.access < A.MAINTAINER) throw kit.httpError(403, 'You cannot delete this comment.');
      kit.sql('DELETE FROM notes WHERE id = ?').run(n.id);
      kit.sql(`UPDATE ${I.TABLE[kind]} SET user_notes_count = max(0, user_notes_count - 1) WHERE id = ?`).run(target.id);
      req.flash('success', 'Comment deleted.');
      return reply.redirect(`${project.base}/-/${prefix}/${target.iid}`);
    });
    app.post(P(`${prefix}/:iid/notes/:note/award`), { config: { login: true } }, async (req, reply) => {
      const project = A.loadProject(req); const target = loader(req, project); const n = loadNote(req, target);
      ctx.toggleAward('note', n, req.user, U.str(req.body.name).replace(/[^a-z0-9_+-]/gi, '') || 'thumbsup');
      return reply.redirect(`${project.base}/-/${prefix}/${target.iid}#note_${n.id}`);
    });
  };
  ctx.noteRoutes('issue', 'issues', loadIssue);

  // ------------------------------------------------------------ delete (Owner)
  app.post(P('issues/:iid/delete'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const issue = loadIssue(req, project);
    if (project.access < A.OWNER) throw kit.httpError(403, 'Only project owners can delete issues.');
    for (const sql of ["DELETE FROM notes WHERE noteable_type = 'issue' AND noteable_id = ?", 'DELETE FROM issue_assignees WHERE issue_id = ?',
      "DELETE FROM label_links WHERE target_type = 'issue' AND target_id = ?", "DELETE FROM resource_events WHERE target_type = 'issue' AND target_id = ?",
      "DELETE FROM todos WHERE target_type = 'issue' AND target_id = ?", "DELETE FROM award_emoji WHERE awardable_type = 'issue' AND awardable_id = ?", 'DELETE FROM issues WHERE id = ?']) kit.sql(sql).run(issue.id);
    if (issue.state === 'opened') kit.sql('UPDATE projects SET open_issues_count = max(0, open_issues_count - 1) WHERE id = ?').run(project.id);
    I.addEvent(project, req.user, 'destroyed', 'issue', issue.id, issue.title);
    req.flash('success', 'The issue was successfully deleted.');
    return reply.redirect(`${project.base}/-/issues`);
  });

  // ------------------------------------------------------------ user autocomplete (pickers)
  app.get('/-/autocomplete/users.json', async (req) => {
    const s = U.str(req.query.search).replace(/^@/, '');
    const pid = U.int(req.query.project_id);
    const like = `%${s.replace(/[\\%_]/g, (x) => '\\' + x)}%`;
    const rows = kit.sql(`SELECT u.id, u.username, u.name, u.avatar,
        (u.id IN (SELECT user_id FROM members WHERE source_type = 'project' AND source_id = ?)) AS member
      FROM users u WHERE u.state = 'active' AND u.user_type IS NULL AND (? = '' OR u.username LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')
      ORDER BY (lower(u.username) = lower(?)) DESC, member DESC, (u.username LIKE ? ESCAPE '\\') DESC, u.username COLLATE NOCASE LIMIT 20`)
      .all(pid || -1, s, like, like, s, `${s.replace(/[\\%_]/g, (x) => '\\' + x)}%`);
    return rows.map((u) => ({ id: u.id, username: u.username, name: u.name, avatar_url: u.avatar ? `/media/${u.avatar.replace(/^media\//, '')}` : null }));
  });
};
