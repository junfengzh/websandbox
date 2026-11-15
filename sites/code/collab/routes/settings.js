'use strict';
// Project settings (Maintainer+; advanced actions Owner): /:ns/:proj/edit (general: name,
// description, topics, visibility, features), archive / unarchive, change path (rename),
// transfer to another namespace, delete with confirmation. GitLab paths:
//   GET/POST /:ns/:proj/edit   POST /:ns/:proj/archive  /unarchive  /rename  /transfer  /remove
module.exports = function settings(app, ctx) {
  const { kit, U, A, I, view } = ctx;
  const VIS = { private: 0, internal: 10, public: 20 };

  // topics: tables `topics` / `project_topics` (main, or temp via plugin.onOpen)
  const topicsOf = (pid) => kit.sql('SELECT t.name FROM project_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.project_id = ? ORDER BY t.name COLLATE NOCASE').pluck().all(pid);
  ctx.topicsOf = topicsOf;
  function setTopics(pid, names) {
    kit.sql('DELETE FROM project_topics WHERE project_id = ?').run(pid);
    for (const n of names) {
      let id = kit.sql('SELECT id FROM topics WHERE name = ?').pluck().get(n);
      if (!id) id = Number(kit.sql('INSERT INTO topics (name, created_at) VALUES (?, ?)').run(n, kit.nowSql()).lastInsertRowid);
      kit.sql('INSERT OR IGNORE INTO project_topics (project_id, topic_id) VALUES (?, ?)').run(pid, id);
    }
  }

  const page = (req, reply, project, values, errors, status) => {
    const namespaces = transferTargets(req.user, project);
    return view(reply, 'settings', { title: 'General settings', project, nav: 'settings.general', values, errors, topics: values.topics ?? topicsOf(project.id).join(', '), namespaces, isOwner: project.access >= A.OWNER, crumbs: [['Settings'], ['General']] }, status);
  };
  function transferTargets(user, project) {
    if (!user) return [];
    const own = kit.sql("SELECT id, full_path, name, kind FROM namespaces WHERE kind = 'user' AND owner_id = ?").all(user.id);
    const groups = user.is_admin ? kit.sql("SELECT id, full_path, name, kind FROM namespaces WHERE kind = 'group' ORDER BY full_path").all()
      : kit.sql(`SELECT n.id, n.full_path, n.name, n.kind FROM namespaces n WHERE n.kind = 'group' AND n.id IN (SELECT source_id FROM members WHERE source_type = 'namespace' AND user_id = ? AND access_level >= 40 AND requested_at IS NULL) ORDER BY n.full_path`).all(user.id);
    return [...own, ...groups].filter((n) => n.id !== project.namespace_id);
  }

  app.get('/:ns/:proj/edit', { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req, { min: A.MAINTAINER });
    return page(req, reply, project, project, {});
  });
  app.post('/:ns/:proj/edit', { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req, { min: A.MAINTAINER });
    const b = req.body || {};
    const values = {
      name: b.name != null ? U.str(b.name) : project.name, description: b.description != null ? String(b.description).trim() : project.description,
      visibility: U.str(b.visibility) || project.visibility, topics: b.topics != null ? U.str(b.topics) : null,
      issues_enabled: b.issues_enabled != null ? (U.bool(b.issues_enabled) ? 1 : 0) : project.issues_enabled,
      merge_requests_enabled: b.merge_requests_enabled != null ? (U.bool(b.merge_requests_enabled) ? 1 : 0) : project.merge_requests_enabled,
      wiki_enabled: b.wiki_enabled != null ? (U.bool(b.wiki_enabled) ? 1 : 0) : project.wiki_enabled,
      forking_enabled: b.forking_enabled != null ? (U.bool(b.forking_enabled) ? 1 : 0) : project.forking_enabled,
    };
    const errors = {};
    if (!values.name) errors.name = "Name can't be blank";
    else if (values.name.length > 255) errors.name = 'Name is too long (maximum is 255 characters)';
    else if (!/^[\p{L}\p{N}_][\p{L}\p{N}_ .+-]*$/u.test(values.name)) errors.name = "Name can contain only letters, digits, emojis, '_', '.', '+', dashes, or spaces. It must start with a letter, digit, emoji, or '_'.";
    else if (values.name !== project.name && kit.sql('SELECT 1 FROM projects WHERE namespace_id = ? AND name = ? COLLATE NOCASE AND id != ?').get(project.namespace_id, values.name, project.id)) errors.name = 'Name has already been taken';
    if (!(values.visibility in VIS)) errors.visibility = 'Visibility level is invalid';
    else if (project.ns_kind === 'group') {
      const gv = kit.sql('SELECT visibility FROM namespaces WHERE id = ?').pluck().get(project.namespace_id);
      if (VIS[values.visibility] > VIS[gv]) errors.visibility = `Visibility level ${values.visibility} is not allowed in a ${gv} group.`;
    }
    if ((values.description || '').length > 2000) errors.description = 'Description is too long (maximum is 2000 characters)';
    const topics = values.topics == null ? null : [...new Set(values.topics.split(',').map((t) => t.trim()).filter(Boolean))];
    if (topics && topics.some((t) => t.length > 255)) errors.topics = 'Topics are too long';
    if (Object.keys(errors).length) return page(req, reply, project, { ...project, ...values }, errors, 422);
    const now = kit.nowSql();
    kit.sql(`UPDATE projects SET name = ?, description = ?, visibility = ?, issues_enabled = ?, merge_requests_enabled = ?, wiki_enabled = ?, forking_enabled = ?, updated_at = ?, last_activity_at = ? WHERE id = ?`)
      .run(values.name, values.description || null, values.visibility, values.issues_enabled, values.merge_requests_enabled, values.wiki_enabled, values.forking_enabled, now, now, project.id);
    if (topics) setTopics(project.id, topics);
    req.flash('success', `Project '${values.name}' was successfully updated.`);
    return reply.redirect(`${project.base}/edit`);
  });

  // ------------------------------------------------------------ advanced (Owner)
  const owner = (req) => A.loadProject(req, { min: A.OWNER });
  app.post('/:ns/:proj/archive', { config: { login: true } }, async (req, reply) => {
    const project = owner(req);
    kit.sql('UPDATE projects SET archived = 1, updated_at = ? WHERE id = ?').run(kit.nowSql(), project.id);
    I.addEvent(project, req.user, 'updated', 'project', project.id, project.name);
    req.flash('success', 'Project was successfully archived.');
    return reply.redirect(project.base);
  });
  app.post('/:ns/:proj/unarchive', { config: { login: true } }, async (req, reply) => {
    const project = owner(req);
    kit.sql('UPDATE projects SET archived = 0, updated_at = ? WHERE id = ?').run(kit.nowSql(), project.id);
    req.flash('success', 'Project was successfully unarchived.');
    return reply.redirect(project.base);
  });
  app.post('/:ns/:proj/rename', { config: { login: true } }, async (req, reply) => {
    const project = owner(req);
    const path = U.str(req.body.path);
    const err = U.validPath(path);
    const full = `${project.ns_path}/${path}`;
    if (err) { req.flash('error', err); return reply.redirect(`${project.base}/edit#advanced`); }
    if (full.toLowerCase() !== project.full_path.toLowerCase() && kit.sql('SELECT 1 FROM projects WHERE full_path = ?').get(full)) { req.flash('error', 'Path has already been taken'); return reply.redirect(`${project.base}/edit#advanced`); }
    kit.sql('UPDATE projects SET path = ?, full_path = ?, updated_at = ? WHERE id = ?').run(path, full, kit.nowSql(), project.id);
    req.flash('success', `Project '${project.name}' was successfully updated.`);
    return reply.redirect(`/${full}/edit`);
  });
  app.post('/:ns/:proj/transfer', { config: { login: true } }, async (req, reply) => {
    const project = owner(req);
    const nsId = U.int(req.body.new_namespace_id);
    const target = transferTargets(req.user, project).find((n) => n.id === nsId);
    if (!target) { req.flash('error', 'Please select a namespace you can create projects in.'); return reply.redirect(`${project.base}/edit#advanced`); }
    const full = `${target.full_path}/${project.path}`;
    if (kit.sql('SELECT 1 FROM projects WHERE full_path = ?').get(full)) { req.flash('error', `Project with the same name or path already exists in ${target.full_path}.`); return reply.redirect(`${project.base}/edit#advanced`); }
    let vis = project.visibility;
    if (target.kind === 'group') { const gv = kit.sql('SELECT visibility FROM namespaces WHERE id = ?').pluck().get(target.id); if (VIS[vis] > VIS[gv]) vis = gv; }
    kit.sql('UPDATE projects SET namespace_id = ?, full_path = ?, visibility = ?, updated_at = ? WHERE id = ?').run(target.id, full, vis, kit.nowSql(), project.id);
    // labels/milestones of the old group no longer apply
    req.flash('success', `Project '${project.name}' was successfully transferred to ${target.full_path}.`);
    return reply.redirect(`/${full}`);
  });
  // Delete a project and everything that references it (foreign keys are enforced: children first).
  function destroyProject(pid) {
    const p = kit.sql('SELECT * FROM projects WHERE id = ?').get(pid);
    if (!p) return;
    const run = (sql) => kit.sql(sql).run(pid);
    const I_ = 'SELECT id FROM issues WHERE project_id = ?'; const M_ = 'SELECT id FROM merge_requests WHERE project_id = ?';
    run(`DELETE FROM issue_assignees WHERE issue_id IN (${I_})`);
    run(`DELETE FROM label_links WHERE target_type = 'issue' AND target_id IN (${I_})`);
    run(`DELETE FROM resource_events WHERE target_type = 'issue' AND target_id IN (${I_})`);
    run(`DELETE FROM award_emoji WHERE awardable_type = 'issue' AND awardable_id IN (${I_})`);
    for (const t of ['mr_assignees', 'mr_reviewers', 'mr_approvals', 'mr_diff_files', 'mr_commits']) run(`DELETE FROM ${t} WHERE merge_request_id IN (${M_})`);
    run(`DELETE FROM label_links WHERE target_type = 'merge_request' AND target_id IN (${M_})`);
    run(`DELETE FROM resource_events WHERE target_type = 'merge_request' AND target_id IN (${M_})`);
    run(`DELETE FROM award_emoji WHERE awardable_type = 'merge_request' AND awardable_id IN (${M_})`);
    for (const sql of ['DELETE FROM notes WHERE project_id = ?', 'DELETE FROM todos WHERE project_id = ?', 'DELETE FROM events WHERE project_id = ?',
      'DELETE FROM issues WHERE project_id = ?', 'UPDATE merge_requests SET source_project_id = NULL WHERE source_project_id = ? AND project_id != source_project_id',
      'DELETE FROM merge_requests WHERE project_id = ?', "DELETE FROM members WHERE source_type = 'project' AND source_id = ?", 'DELETE FROM refs WHERE project_id = ?',
      'DELETE FROM stars WHERE project_id = ?', 'DELETE FROM label_priorities WHERE project_id = ?',
      'DELETE FROM label_links WHERE label_id IN (SELECT id FROM labels WHERE project_id = ?)', 'DELETE FROM labels WHERE project_id = ?',
      'DELETE FROM milestones WHERE project_id = ?', 'DELETE FROM protected_branches WHERE project_id = ?', 'DELETE FROM wiki_pages WHERE project_id = ?',
      'DELETE FROM project_topics WHERE project_id = ?', 'DELETE FROM project_commits WHERE project_id = ?', 'DELETE FROM branch_commits WHERE project_id = ?',
      'DELETE FROM contributors WHERE project_id = ?']) run(sql);
    if (p.forked_from_id) kit.sql('UPDATE projects SET forks_count = max(0, forks_count - 1) WHERE id = ?').run(p.forked_from_id);
    kit.sql('UPDATE projects SET forked_from_id = NULL WHERE forked_from_id = ?').run(pid);
    kit.sql('DELETE FROM projects WHERE id = ?').run(pid);
  }
  ctx.destroyProject = destroyProject;
  app.post('/:ns/:proj/remove', { config: { login: true } }, async (req, reply) => {
    const project = owner(req);
    const confirm = U.str(req.body.confirm_name);
    if (confirm !== project.full_path && confirm !== project.path) { req.flash('error', `To delete the project, enter "${project.full_path}" in the confirmation field.`); return reply.redirect(`${project.base}/edit#advanced`); }
    I.addEvent(null, req.user, 'destroyed', 'project', project.id, project.full_path);
    destroyProject(project.id);
    req.flash('success', `Project '${project.full_path}' is in the process of being deleted.`);
    return reply.redirect('/dashboard/projects');
  });
};
