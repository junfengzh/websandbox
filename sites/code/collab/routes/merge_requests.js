'use strict';
// Project merge requests: list, new (compare branches, also from a fork), create (computes
// commits + diff with the git lib and stores them like the import: mr_commits / mr_diff_files),
// show (Overview / Commits / Changes tabs from the stored diff), edit, close/reopen, draft,
// assignees / reviewers / labels / milestone, approve / unapprove, merge (merge commit or
// squash, optional source-branch deletion, "Closes #n" issues), comments, award emoji.
const zlib = require('node:zlib');

module.exports = function mergeRequests(app, ctx) {
  const { kit, U, A, I, L, P, git, view, back } = ctx;

  const loadMr = (req, project) => {
    const iid = U.int(req.params.iid);
    const m = iid != null && kit.sql('SELECT * FROM merge_requests WHERE project_id = ? AND iid = ?').get(project.id, iid);
    if (!m) throw kit.httpError(404, 'Merge request not found');
    return m;
  };
  const requireMrs = (project) => { if (!project.merge_requests_enabled) throw kit.httpError(404, 'Merge requests are disabled for this project.'); };
  const canEdit = (req, project, m) => !!req.user && (project.access >= A.DEVELOPER || req.user.id === m.author_id);
  const canAdmin = (req, project) => !!req.user && project.access >= A.DEVELOPER;
  const canComment = (req, project, m) => !!req.user && (!m.discussion_locked || project.access >= A.DEVELOPER) && !project.archived;
  const needEdit = (req, project, m) => { if (!canEdit(req, project, m)) throw kit.httpError(403, 'You are not allowed to update this merge request.'); if (project.archived) throw kit.httpError(403, 'This project is archived.'); };
  const needAdmin = (req, project) => { if (!canAdmin(req, project)) throw kit.httpError(403, 'You need at least the Developer role to do this.'); if (project.archived) throw kit.httpError(403, 'This project is archived.'); };
  const mrUrl = (project, m) => `${project.base}/-/merge_requests/${m.iid}`;
  const labelIdsFor = (project) => { const all = I.projectLabels(project); return (title) => all.filter((l) => l.title === title).map((l) => l.id); };
  const projectById = (id) => ctx.code.projectById(id);

  function isProtected(projectId, branch) {
    for (const r of kit.sql('SELECT name FROM protected_branches WHERE project_id = ?').pluck().all(projectId)) {
      if (r === branch) return true;
      if (r.includes('*') && new RegExp('^' + r.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(branch)) return true;
    }
    return false;
  }
  const mergeLevel = (project, m) => (isProtected(project.id, m.target_branch) ? A.MAINTAINER : A.DEVELOPER);

  // ------------------------------------------------------------ list
  app.get(P('merge_requests'), async (req, reply) => {
    const project = A.loadProject(req);
    requireMrs(project);
    const r = L.list('merge_request', req, { projectId: project.id, labelIds: labelIdsFor(project), user: req.user });
    return view(reply, 'merge_requests', {
      title: 'Merge requests', project, nav: 'mrs', kind: 'merge_request', r, base: `${project.base}/-/merge_requests`,
      labels: I.projectLabels(project), milestones: I.projectMilestones(project), canCreate: !!req.user && !project.archived, userHints: ctx.memberCandidates(project),
      crumbs: [['Merge requests', `${project.base}/-/merge_requests`]],
    });
  });

  // ------------------------------------------------------------ compare helpers
  // projects the MR can come from / go to: the project, its fork parent, and forks of it the user can read
  function relatedProjects(req, project) {
    const ids = new Set([project.id]);
    if (project.forked_from_id) ids.add(project.forked_from_id);
    for (const id of kit.sql('SELECT id FROM projects WHERE forked_from_id = ?').pluck().all(project.id)) ids.add(id);
    return [...ids].map(projectById).filter((p) => p && ctx.code.canRead(req.user, p));
  }
  function compare(sp, sb, tp, tb) {
    const head = git.branchHead(sp.id, sb); const target = git.branchHead(tp.id, tb);
    const out = { head, target, errors: [] };
    if (!head) out.errors.push(`Source branch "${sb}" does not exist`);
    if (!target) out.errors.push(`Target branch "${tb}" does not exist`);
    if (out.errors.length) return out;
    if (sp.id === tp.id && sb === tb) { out.errors.push('Source and target branch must be different'); return out; }
    const rv = git.revList(head, target, { limit: 50000 });
    out.commits = rv.only; out.base = rv.base; out.truncated = rv.truncated;
    if (!rv.only.length) { out.errors.push(`There are no changes: ${tb} already contains all commits of ${sb}`); return out; }
    out.files = null;
    try {
      const baseC = rv.base ? git.getCommit(rv.base) : null; const headC = git.getCommit(head);
      out.files = git.diffTrees(baseC ? baseC.tree_sha : git.EMPTY_TREE, headC.tree_sha);
    } catch (e) {
      if (!(e instanceof git.GitUnavailable)) throw e;
      // trees not stored for these commits: list the files the commits touched
      const ids = rv.only.slice(0, 200).map((c) => c.id);
      out.files = ids.length ? kit.sql(`SELECT DISTINCT p.path, cf.change FROM commit_files cf JOIN paths p ON p.id = cf.path_id WHERE cf.commit_id IN (${ids.map(() => '?').join(',')}) ORDER BY p.path`).all(...ids).map((f) => ({ path: f.path, change: f.change, unavailable: true })) : [];
      out.unavailable = true;
    }
    return out;
  }
  const humanize = (b) => { const s = String(b).split('/').pop().replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : b; };

  // ------------------------------------------------------------ new
  app.get(P('merge_requests/new'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    requireMrs(project);
    const q = req.query;
    const related = relatedProjects(req, project);
    const pick = (id) => related.find((p) => p.id === U.int(id)) || null;
    const sp = pick(q['merge_request[source_project_id]']) || project;
    const tp = pick(q['merge_request[target_project_id]']) || (project.forked_from_id && pick(project.forked_from_id) && !q['merge_request[target_project_id]'] ? pick(project.forked_from_id) : project);
    const sb = U.str(q['merge_request[source_branch]'] || q.source_branch);
    const tb = U.str(q['merge_request[target_branch]'] || q.target_branch) || tp.default_branch || '';
    const data = { title: 'New merge request', project, nav: 'mrs', related, sp, tp, sb, tb, sourceBranches: git.branches(sp.id), targetBranches: git.branches(tp.id), crumbs: [['Merge requests', `${project.base}/-/merge_requests`], ['New']] };
    if (!sb || U.str(q.change_branches)) return view(reply, 'mr_new', { ...data, step: 1 });
    const cmp = compare(sp, sb, tp, tb);
    if (cmp.errors.length) return view(reply, 'mr_new', { ...data, step: 1, errors: cmp.errors }, 422);
    const one = cmp.commits.length === 1 ? kit.sql('SELECT title, message FROM commits WHERE sha = ?').get(cmp.commits[0].sha) : null;
    const values = { title: one ? one.title : humanize(sb), description: one ? String(one.message || '').split('\n').slice(1).join('\n').trim() : '' };
    return renderForm(req, reply, { ...data, step: 2, cmp, values, errors: {} });
  });
  function renderForm(req, reply, data, status) {
    const tp = data.tp;
    return view(reply, 'mr_new', { ...data, labels: I.projectLabels(tp), milestones: I.projectMilestones(tp, { state: 'active' }), members: ctx.memberCandidates(tp), canAdmin: (ctx.code.accessLevel(req.user, tp) >= A.DEVELOPER) }, status);
  }

  // ------------------------------------------------------------ create
  app.post(P('merge_requests'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    requireMrs(project);
    const b = req.body || {};
    const related = relatedProjects(req, project);
    const pick = (id) => related.find((p) => p.id === U.int(id)) || null;
    const sp = pick(b.source_project_id) || project; const tp = pick(b.target_project_id) || project;
    tp.access = ctx.code.accessLevel(req.user, tp); tp.base = '/' + tp.full_path; tp.url = tp.base;
    if (tp.archived) throw kit.httpError(403, 'The target project is archived.');
    if (sp.id !== project.id && tp.id !== project.id) throw kit.httpError(422, 'Invalid project.');
    // creating an MR from a branch requires push access to the source project (Developer+)
    if (ctx.code.accessLevel(req.user, sp) < A.DEVELOPER) throw kit.httpError(403, 'You need at least the Developer role in the source project to create a merge request from its branches.');
    const sb = U.str(b.source_branch); const tb = U.str(b.target_branch);
    const data = { title: 'New merge request', project, nav: 'mrs', related, sp, tp, sb, tb, sourceBranches: git.branches(sp.id), targetBranches: git.branches(tp.id), crumbs: [['Merge requests', `${project.base}/-/merge_requests`], ['New']] };
    const cmp = compare(sp, sb, tp, tb);
    if (cmp.errors.length) return view(reply, 'mr_new', { ...data, step: 1, errors: cmp.errors }, 422);
    const values = { title: U.str(b.title), description: String(b.description || '').replace(/\r\n/g, '\n'), draft: U.bool(b.draft), squash: U.bool(b.squash), remove_source: U.bool(b.force_remove_source_branch),
      milestone_id: U.int(b.milestone_id), label_ids: U.arr(b['label_ids[]'] ?? b.label_ids).map(Number) };
    const errors = {};
    if (!values.title) errors.title = "Title can't be blank";
    else if (values.title.length > 255) errors.title = 'Title is too long (maximum is 255 characters)';
    let assignees = [], reviewers = [];
    try { assignees = ctx.pickedUsers(b, 'assignee_ids'); } catch (e) { errors.assignee_ids = e.message; }
    try { reviewers = ctx.pickedUsers(b, 'reviewer_ids'); } catch (e) { errors.reviewer_ids = e.message; }
    const dup = kit.sql("SELECT iid FROM merge_requests WHERE project_id = ? AND source_project_id = ? AND source_branch = ? AND target_branch = ? AND state IN ('opened','locked')").get(tp.id, sp.id, sb, tb);
    if (dup) errors.base = `Another open merge request already exists for this source branch: !${dup.iid}`;
    if (Object.keys(errors).length) return renderForm(req, reply, { ...data, step: 2, cmp, values, errors }, 422);
    let title = values.title;
    if (values.draft && !/^(draft:|\[draft\]|\(draft\))/i.test(title)) title = `Draft: ${title}`;
    const draft = /^(draft:|\[draft\]|\(draft\)|wip:)/i.test(title) ? 1 : 0;
    const now = kit.nowSql();
    const iid = (kit.sql('SELECT max(iid) FROM merge_requests WHERE project_id = ?').pluck().get(tp.id) || 0) + 1;
    const admin = tp.access >= A.DEVELOPER;
    const r = kit.sql(`INSERT INTO merge_requests (project_id, iid, title, description, state, draft, author_id, source_project_id, source_branch, target_branch, milestone_id, merge_status,
        head_sha, base_sha, start_sha, squash, commits_count, files_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'opened', ?, ?, ?, ?, ?, ?, 'unchecked', ?, ?, ?, ?, ?, ?, ?, ?)`).run(tp.id, iid, title, values.description || null, draft, req.user.id, sp.id, sb, tb,
      admin && values.milestone_id && I.projectMilestones(tp).some((m) => m.id === values.milestone_id) ? values.milestone_id : null,
      cmp.head, cmp.base, cmp.target, values.squash ? 1 : 0, cmp.commits.length, cmp.files.length, now, now);
    const mr = kit.sql('SELECT * FROM merge_requests WHERE id = ?').get(Number(r.lastInsertRowid));
    storeDiff(mr, cmp);
    kit.sql("INSERT OR REPLACE INTO refs (project_id, kind, name, sha) VALUES (?, 'mr', ?, ?)").run(tp.id, String(iid), cmp.head);
    if (admin) {
      const allowed = new Set(I.projectLabels(tp).map((l) => l.id));
      for (const id of values.label_ids) if (allowed.has(id)) kit.sql("INSERT OR IGNORE INTO label_links (label_id, target_type, target_id, created_at) VALUES (?, 'merge_request', ?, ?)").run(id, mr.id, now);
      for (const uid of assignees) { kit.sql('INSERT OR IGNORE INTO mr_assignees (merge_request_id, user_id) VALUES (?, ?)').run(mr.id, uid); I.addTodo(uid, tp, 'merge_request', mr, req.user, 'assigned'); }
    }
    for (const uid of reviewers) { kit.sql("INSERT OR IGNORE INTO mr_reviewers (merge_request_id, user_id, state, created_at) VALUES (?, ?, 'unreviewed', ?)").run(mr.id, uid, now); I.addTodo(uid, tp, 'merge_request', mr, req.user, 'review_requested'); }
    if (values.remove_source) kit.sql('UPDATE merge_requests SET merge_status = ? WHERE id = ?').run('unchecked', mr.id);
    kit.sql('UPDATE projects SET open_merge_requests_count = open_merge_requests_count + 1 WHERE id = ?').run(tp.id);
    I.addEvent(tp, req.user, 'created', 'merge_request', mr.id, mr.title);
    I.mentionTodos(tp, 'merge_request', mr, req.user, mr.description, null);
    if (values.remove_source) req.session.set(`mr_rm_src_${mr.id}`, 1);
    return reply.redirect(mrUrl(tp, mr));
  });

  // Store the latest diff version (first 100 files / 100 commits, size policy like the import)
  function storeDiff(mr, cmp) {
    kit.sql('DELETE FROM mr_diff_files WHERE merge_request_id = ?').run(mr.id);
    kit.sql('DELETE FROM mr_commits WHERE merge_request_id = ?').run(mr.id);
    let adds = 0, dels = 0, total = 0;
    cmp.files.slice(0, 100).forEach((f, ord) => {
      let d = { text: null, additions: 0, deletions: 0 };
      let omitted = 0, binary = 0, tooLarge = 0;
      if (f.unavailable) omitted = 1;
      else {
        d = git.fileDiff(f, { maxBytes: 400000 });
        if (d.binary) binary = 1;
        if (d.tooLarge) tooLarge = 1;
        if (d.text && (d.text.length > 32768 || total + d.text.length > 262144)) { omitted = 1; }
      }
      if (d.text && !omitted) total += d.text.length;
      adds += d.additions || 0; dels += d.deletions || 0;
      kit.sql(`INSERT INTO mr_diff_files (merge_request_id, ord, old_path, new_path, a_mode, b_mode, new_file, renamed_file, deleted_file, binary, too_large, diff_omitted, additions, deletions, diff)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`).run(mr.id, ord, null, f.path, f.oldMode || '0', f.newMode || '0',
        f.change === 'A' ? 1 : 0, f.change === 'D' ? 1 : 0, binary, tooLarge, omitted, d.additions || 0, d.deletions || 0,
        d.text != null && !omitted ? zlib.deflateSync(Buffer.from(d.text)) : null);
    });
    cmp.commits.slice(0, 100).forEach((c, ord) => {
      const full = kit.sql('SELECT sha, title, author_name, author_email, authored_at, committed_at FROM commits WHERE sha = ?').get(c.sha);
      kit.sql('INSERT INTO mr_commits (merge_request_id, ord, sha, title, author_name, author_email, authored_at, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(mr.id, ord, full.sha, full.title, full.author_name, full.author_email, full.authored_at, full.committed_at);
    });
    kit.sql('UPDATE merge_requests SET additions = ?, deletions = ?, files_count = ?, commits_count = ? WHERE id = ?').run(adds, dels, cmp.files.length, cmp.commits.length, mr.id);
  }

  // ------------------------------------------------------------ show (tabs)
  for (const tab of ['', 'commits', 'diffs']) {
    app.get(P(`merge_requests/:iid${tab ? '/' + tab : ''}`), async (req, reply) => {
      const project = A.loadProject(req);
      requireMrs(project);
      const mr = loadMr(req, project);
      return renderMr(req, reply, project, mr, tab || 'overview');
    });
  }
  function mergeability(req, project, mr) {
    const sp = projectById(mr.source_project_id || project.id);
    const out = { canMerge: false, reasons: [], sourceExists: false, head: null };
    if (mr.state !== 'opened') return out;
    const head = sp ? git.branchHead(sp.id, mr.source_branch) : null;
    const target = git.branchHead(project.id, mr.target_branch);
    out.head = head; out.sourceExists = !!head;
    if (!head) out.reasons.push('The source branch does not exist. Please restore it or use a different source branch.');
    if (!target) out.reasons.push('The target branch does not exist.');
    if (mr.draft) out.reasons.push("Merge blocked: merge request must not be draft. Select 'Mark as ready' to remove it from Draft status.");
    if (head && target) {
      const rv = git.revList(head, target, { limit: 50000 });
      if (!rv.only.length) out.reasons.push(`Nothing to merge: ${mr.target_branch} already contains all the commits of ${mr.source_branch}.`);
      else if (rv.base !== target) {
        try {
          const m = git.checkMerge(git.getCommit(rv.base).tree_sha, git.getCommit(target).tree_sha, git.getCommit(head).tree_sha);
          if (m.conflicts) { out.conflicts = m.conflicts; out.reasons.push(`Merge blocked: this merge request has conflicts (${m.conflicts.slice(0, 5).join(', ')}${m.conflicts.length > 5 ? ', …' : ''}).`); }
        } catch (e) {
          if (!(e instanceof git.GitUnavailable)) throw e;
          out.reasons.push('Merge blocked: the file contents of these commits are not available in this sandbox.');
        }
      }
      out.ffPossible = rv.base === target;
      out.behind = 0;
    }
    out.canMerge = !out.reasons.length;
    return out;
  }
  function renderMr(req, reply, project, mr, tab) {
    const sp = projectById(mr.source_project_id || project.id);
    const author = kit.sql('SELECT id, username, name, avatar FROM users WHERE id = ?').get(mr.author_id);
    const mergedBy = mr.merged_by_id ? kit.sql('SELECT id, username, name, avatar FROM users WHERE id = ?').get(mr.merged_by_id) : null;
    const closedBy = mr.closed_by_id ? kit.sql('SELECT id, username, name, avatar FROM users WHERE id = ?').get(mr.closed_by_id) : null;
    const approvals = kit.sql('SELECT u.id, u.username, u.name, u.avatar, a.created_at FROM mr_approvals a JOIN users u ON u.id = a.user_id WHERE a.merge_request_id = ? ORDER BY a.created_at').all(mr.id);
    const commits = tab === 'commits' ? kit.sql('SELECT * FROM mr_commits WHERE merge_request_id = ? ORDER BY ord').all(mr.id) : null;
    let files = null;
    if (tab === 'diffs') {
      files = kit.sql('SELECT * FROM mr_diff_files WHERE merge_request_id = ? ORDER BY ord').all(mr.id);
      for (const f of files) f.lines = f.diff ? parseDiff(zlib.inflateSync(f.diff).toString('utf8')) : null;
    }
    const awards = kit.sql('SELECT name, count(*) n, max(user_id = ?) mine FROM award_emoji WHERE awardable_type = ? AND awardable_id = ? GROUP BY name').all(req.user ? req.user.id : -1, 'merge_request', mr.id);
    const me = req.user;
    const can = {
      edit: canEdit(req, project, mr), admin: canAdmin(req, project), comment: canComment(req, project, mr), delete: !!me && project.access >= A.OWNER,
      approve: !!me && project.access >= A.DEVELOPER && mr.state === 'opened', merge: !!me && project.access >= mergeLevel(project, mr) && !project.archived,
    };
    const status = mergeability(req, project, mr);
    const mergeMessage = `Merge branch '${mr.source_branch}' into '${mr.target_branch}'\n\n${mr.title}\n\nSee merge request ${project.full_path}!${mr.iid}`;
    return view(reply, 'mr', {
      title: `${mr.title} (!${mr.iid})`, project, nav: 'mrs', mr, sp, tab, author, mergedBy, closedBy, approvals, commits, files, awards, can, status, mergeMessage,
      approvedByMe: !!me && approvals.some((a) => a.id === me.id),
      labels: I.labelsOf('merge_request', mr.id), assignees: I.assigneesOf('merge_request', mr.id), reviewers: I.reviewersOf(mr.id),
      milestone: mr.milestone_id ? kit.sql('SELECT * FROM milestones WHERE id = ?').get(mr.milestone_id) : null,
      timeline: tab === 'overview' ? I.timeline(project, 'merge_request', mr) : [], participants: I.participants('merge_request', mr),
      allLabels: I.projectLabels(project), milestones: I.projectMilestones(project), members: ctx.memberCandidates(project),
      todo: me ? kit.sql("SELECT id FROM todos WHERE user_id = ? AND target_type = 'merge_request' AND target_id = ? AND state = 'pending' LIMIT 1").get(me.id, mr.id) : null,
      removeSourceDefault: !!(req.session && req.user && req.session.get(`mr_rm_src_${mr.id}`)),
      crumbs: [['Merge requests', `${project.base}/-/merge_requests`], [`!${mr.iid}`]],
    });
  }
  // unified hunk text -> rows {t: 'hunk'|'add'|'del'|'ctx', o, n, s}
  function parseDiff(text) {
    const rows = []; let o = 0, n = 0;
    for (const line of text.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) { o = +h[1]; n = +h[2]; rows.push({ t: 'hunk', s: line }); continue; }
      if (line.startsWith('+')) rows.push({ t: 'add', n: n++, s: line.slice(1) });
      else if (line.startsWith('-')) rows.push({ t: 'del', o: o++, s: line.slice(1) });
      else if (line.startsWith('\\')) continue;
      else if (line.startsWith(' ') || line === '') rows.push({ t: 'ctx', o: o++, n: n++, s: line.slice(1) });
      else rows.push({ t: 'hunk', s: line });
      if (rows.length > 5000) { rows.push({ t: 'hunk', s: '… diff truncated' }); break; }
    }
    return rows;
  }

  // ------------------------------------------------------------ edit
  app.get(P('merge_requests/:iid/edit'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    needEdit(req, project, mr);
    return view(reply, 'mr_edit', { title: `Edit !${mr.iid}`, project, nav: 'mrs', mr, values: mr, errors: {}, targetBranches: git.branches(project.id), crumbs: [['Merge requests', `${project.base}/-/merge_requests`], [`!${mr.iid}`, mrUrl(project, mr)], ['Edit']] });
  });
  app.post(P('merge_requests/:iid/edit'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    needEdit(req, project, mr);
    const b = req.body || {};
    const title = U.str(b.title); const description = b.description == null ? mr.description : String(b.description).replace(/\r\n/g, '\n');
    const tb = U.str(b.target_branch) || mr.target_branch;
    const errors = {};
    if (!title) errors.title = "Title can't be blank";
    if (tb !== mr.target_branch && !git.branchHead(project.id, tb)) errors.target_branch = 'Target branch does not exist';
    if (Object.keys(errors).length) return view(reply, 'mr_edit', { title: `Edit !${mr.iid}`, project, nav: 'mrs', mr, values: { ...mr, title, description, target_branch: tb }, errors, targetBranches: git.branches(project.id) }, 422);
    const now = kit.nowSql();
    if (title !== mr.title) {
      const draft = /^(draft:|\[draft\]|\(draft\)|wip:)/i.test(title) ? 1 : 0;
      kit.sql('UPDATE merge_requests SET title = ?, draft = ?, updated_at = ?, last_edited_at = ?, last_edited_by_id = ? WHERE id = ?').run(title, draft, now, now, req.user.id, mr.id);
      I.systemNote(project, 'merge_request', mr, req.user, `changed title from **${mr.title}** to **${title}**`, 'title');
    }
    if ((description || '') !== (mr.description || '')) {
      kit.sql('UPDATE merge_requests SET description = ?, updated_at = ?, last_edited_at = ?, last_edited_by_id = ? WHERE id = ?').run(description || null, now, now, req.user.id, mr.id);
      I.systemNote(project, 'merge_request', mr, req.user, 'changed the description', 'description');
    }
    if (tb !== mr.target_branch) {
      kit.sql('UPDATE merge_requests SET target_branch = ?, updated_at = ? WHERE id = ?').run(tb, now, mr.id);
      I.systemNote(project, 'merge_request', mr, req.user, `changed target branch from \`${mr.target_branch}\` to \`${tb}\``, 'branch');
      const sp = projectById(mr.source_project_id || project.id);
      const cmp = compare(sp, mr.source_branch, project, tb);
      if (!cmp.errors.length) { storeDiff(mr, cmp); kit.sql('UPDATE merge_requests SET head_sha = ?, base_sha = ?, start_sha = ? WHERE id = ?').run(cmp.head, cmp.base, cmp.target, mr.id); }
    }
    if (b.squash != null) kit.sql('UPDATE merge_requests SET squash = ? WHERE id = ?').run(U.bool(b.squash) ? 1 : 0, mr.id);
    req.flash('success', 'The merge request was successfully updated.');
    return reply.redirect(mrUrl(project, mr));
  });

  // ------------------------------------------------------------ state, draft
  for (const [act, state] of [['close', 'closed'], ['reopen', 'opened']]) {
    app.post(P(`merge_requests/:iid/${act}`), { config: { login: true } }, async (req, reply) => {
      const project = A.loadProject(req);
      const mr = loadMr(req, project);
      needEdit(req, project, mr);
      if (mr.state === 'merged') throw kit.httpError(422, 'A merged merge request cannot be closed or reopened.');
      if (state === 'opened') {
        const sp = projectById(mr.source_project_id || project.id);
        if (!sp || !git.branchHead(sp.id, mr.source_branch)) { req.flash('error', 'Cannot reopen: the source branch does not exist.'); return reply.redirect(mrUrl(project, mr)); }
      }
      if (I.setState(project, 'merge_request', mr, req.user, state)) req.flash('success', state === 'closed' ? 'The merge request was closed.' : 'The merge request was reopened.');
      return reply.redirect(back(req, mrUrl(project, mr)));
    });
  }
  app.post(P('merge_requests/:iid/toggle_draft'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    needEdit(req, project, mr);
    const draft = mr.draft ? 0 : 1;
    const title = draft ? `Draft: ${mr.title}` : mr.title.replace(/^(draft:\s*|\[draft\]\s*|\(draft\)\s*|wip:\s*)/i, '');
    kit.sql('UPDATE merge_requests SET draft = ?, title = ?, updated_at = ? WHERE id = ?').run(draft, title, kit.nowSql(), mr.id);
    I.systemNote(project, 'merge_request', mr, req.user, draft ? 'marked this merge request as **draft**' : 'marked this merge request as **ready**', 'title');
    return reply.redirect(mrUrl(project, mr));
  });

  // ------------------------------------------------------------ sidebar
  const sidebar = (name, fn, { admin = true } = {}) => app.post(P(`merge_requests/:iid/${name}`), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    if (admin) needAdmin(req, project); else needEdit(req, project, mr);
    try { fn(req, project, mr, req.body || {}); } catch (e) { if (e.statusCode === 422) req.flash('error', e.message); else throw e; }
    return reply.redirect(back(req, mrUrl(project, mr)));
  });
  sidebar('assignees', (req, project, mr, b) => {
    let ids = ctx.pickedUsers(b, 'assignee_ids');
    if (U.bool(b.assign_self)) ids = [...new Set([...I.assigneesOf('merge_request', mr.id).map((u) => u.id), req.user.id])];
    if (U.bool(b.unassign_all)) ids = [];
    if (I.setAssignees(project, 'merge_request', mr, req.user, ids)) req.flash('success', 'Assignees updated.');
  });
  sidebar('reviewers', (req, project, mr, b) => {
    let ids = ctx.pickedUsers(b, 'reviewer_ids');
    if (U.bool(b.assign_self)) ids = [...new Set([...I.reviewersOf(mr.id).map((u) => u.id), req.user.id])];
    if (U.bool(b.unassign_all)) ids = [];
    if (I.setReviewers(project, mr, req.user, ids)) req.flash('success', 'Reviewers updated.');
  }, { admin: false });
  sidebar('labels', (req, project, mr, b) => { if (I.setLabels(project, 'merge_request', mr, req.user, U.arr(b['label_ids[]'] ?? b.label_ids).map(Number))) req.flash('success', 'Labels updated.'); });
  sidebar('milestone', (req, project, mr, b) => { if (I.setMilestone(project, 'merge_request', mr, req.user, U.int(b.milestone_id))) req.flash('success', 'Milestone updated.'); });
  sidebar('lock', (req, project, mr, b) => {
    const v = U.bool(b.locked) ? 1 : 0;
    if (v === mr.discussion_locked) return;
    kit.sql('UPDATE merge_requests SET discussion_locked = ?, updated_at = ? WHERE id = ?').run(v, kit.nowSql(), mr.id);
    I.systemNote(project, 'merge_request', mr, req.user, v ? 'locked this merge request' : 'unlocked this merge request', 'locked');
  });
  sidebar('todo', (req, project, mr) => {
    const t = kit.sql("SELECT id FROM todos WHERE user_id = ? AND target_type = 'merge_request' AND target_id = ? AND state = 'pending'").get(req.user.id, mr.id);
    if (t) I.doneTodos(req.user.id, 'merge_request', mr.id); else I.addTodo(req.user.id, project, 'merge_request', mr, req.user, 'marked');
  }, { admin: false });
  app.post(P('merge_requests/:iid/award'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    ctx.toggleAward('merge_request', mr, req.user, U.str(req.body.name).replace(/[^a-z0-9_+-]/gi, '') || 'thumbsup');
    return reply.redirect(back(req, mrUrl(project, mr)));
  });

  // ------------------------------------------------------------ approvals
  app.post(P('merge_requests/:iid/approve'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    if (project.access < A.DEVELOPER) throw kit.httpError(403, 'You need at least the Developer role to approve.');
    if (mr.state !== 'opened') throw kit.httpError(422, 'Only open merge requests can be approved.');
    if (!kit.sql('SELECT 1 FROM mr_approvals WHERE merge_request_id = ? AND user_id = ?').get(mr.id, req.user.id)) {
      kit.sql('INSERT INTO mr_approvals (merge_request_id, user_id, created_at) VALUES (?, ?, ?)').run(mr.id, req.user.id, kit.nowSql());
      kit.sql("UPDATE mr_reviewers SET state = 'reviewed' WHERE merge_request_id = ? AND user_id = ?").run(mr.id, req.user.id);
      I.systemNote(project, 'merge_request', mr, req.user, 'approved this merge request', 'approved');
      I.addEvent(project, req.user, 'approved', 'merge_request', mr.id, mr.title);
      I.doneTodos(req.user.id, 'merge_request', mr.id);
      req.flash('success', 'You approved this merge request.');
    }
    return reply.redirect(mrUrl(project, mr));
  });
  app.post(P('merge_requests/:iid/unapprove'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    if (kit.sql('DELETE FROM mr_approvals WHERE merge_request_id = ? AND user_id = ?').run(mr.id, req.user.id).changes) {
      I.systemNote(project, 'merge_request', mr, req.user, 'unapproved this merge request', 'unapproved');
      req.flash('success', 'You revoked your approval.');
    }
    return reply.redirect(mrUrl(project, mr));
  });
  // reviewer marks the review state (Reviewed / Requested changes)
  app.post(P('merge_requests/:iid/review_state'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    const st = U.str(req.body.state);
    if (!['unreviewed', 'reviewed', 'requested_changes'].includes(st)) throw kit.httpError(422, 'Invalid review state.');
    if (!kit.sql('UPDATE mr_reviewers SET state = ? WHERE merge_request_id = ? AND user_id = ?').run(st, mr.id, req.user.id).changes) throw kit.httpError(403, 'You are not a reviewer of this merge request.');
    if (st === 'requested_changes') I.systemNote(project, 'merge_request', mr, req.user, 'requested changes', 'requested_changes');
    return reply.redirect(mrUrl(project, mr));
  });

  // ------------------------------------------------------------ merge
  app.post(P('merge_requests/:iid/merge'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    if (!req.user || project.access < mergeLevel(project, mr)) throw kit.httpError(403, `You need at least the ${mergeLevel(project, mr) === A.MAINTAINER ? 'Maintainer' : 'Developer'} role to merge into ${mr.target_branch}.`);
    if (project.archived) throw kit.httpError(403, 'This project is archived.');
    const st = mergeability(req, project, mr);
    if (!st.canMerge) { req.flash('error', st.reasons[0] || 'This merge request cannot be merged.'); return reply.redirect(mrUrl(project, mr)); }
    const b = req.body || {};
    const sp = projectById(mr.source_project_id || project.id);
    const head = st.head; const target = git.branchHead(project.id, mr.target_branch);
    const rv = git.revList(head, target, { limit: 50000 });
    const headC = git.getCommit(head);
    let tree = headC.tree_sha;
    if (rv.base !== target) {
      const m = git.mergeTrees(git.getCommit(rv.base).tree_sha, git.getCommit(target).tree_sha, headC.tree_sha);
      if (m.conflicts) { req.flash('error', 'Merge failed: there are conflicts.'); return reply.redirect(mrUrl(project, mr)); }
      tree = m.tree;
    }
    const u = req.user;
    const who = { name: u.name, email: u.commit_email || u.public_email || u.email };
    const squash = b.squash != null ? U.bool(b.squash) : !!mr.squash;
    let newSha;
    if (squash) {
      const msg = U.str(b.squash_commit_message) || mr.title;
      // one squashed commit on top of the target branch (GitLab would add a merge commit after it)
      newSha = git.writeCommit({ tree, parents: [target], author: who, message: msg }).sha;
    } else {
      const msg = String(b.commit_message || '').replace(/\r\n/g, '\n').trim() || `Merge branch '${mr.source_branch}' into '${mr.target_branch}'\n\n${mr.title}\n\nSee merge request ${project.full_path}!${mr.iid}`;
      newSha = git.writeCommit({ tree, parents: [target, head], author: who, message: msg }).sha;
    }
    // commits of a fork's branch become part of the target project
    git.updateBranch(project, mr.target_branch, newSha);
    const now = kit.nowSql();
    kit.sql("UPDATE merge_requests SET state = 'merged', merged_at = ?, merged_by_id = ?, merge_commit_sha = ?, merge_status = 'can_be_merged', head_sha = ?, squash = ?, updated_at = ? WHERE id = ?")
      .run(now, u.id, newSha, head, squash ? 1 : 0, now, mr.id);
    kit.sql('UPDATE projects SET open_merge_requests_count = max(0, open_merge_requests_count - 1) WHERE id = ?').run(project.id);
    I.resourceEvent('merge_request', mr, u, { kind: 'state', state: 'merged' });
    I.addEvent(project, u, 'merged', 'merge_request', mr.id, mr.title);
    kit.sql("UPDATE todos SET state = 'done', updated_at = ? WHERE target_type = 'merge_request' AND target_id = ? AND state = 'pending'").run(now, mr.id);
    // web-edited files of the source branch (temp.repo_files, for graders) now live on the target
    const newTree = git.getCommit(newSha).tree_sha;
    for (const f of kit.sql('SELECT * FROM temp.repo_files WHERE project_id = ? AND branch = ?').all(sp ? sp.id : project.id, mr.source_branch)) {
      const at = git.blobAt(newTree, f.path);
      if ((f.content == null && at == null) || (f.blob_sha && at === f.blob_sha)) {
        kit.sql(`INSERT INTO temp.repo_files (project_id, branch, path, content, blob_sha, commit_sha, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, branch, path) DO UPDATE SET content = excluded.content, blob_sha = excluded.blob_sha, commit_sha = excluded.commit_sha, updated_at = excluded.updated_at`)
          .run(project.id, mr.target_branch, f.path, f.content, f.blob_sha, newSha, kit.nowSql());
      }
    }
    if (U.bool(b.should_remove_source_branch) && sp && !(sp.default_branch === mr.source_branch) && ctx.code.accessLevel(u, sp) >= A.DEVELOPER) {
      if (ctx.write) ctx.write.deleteBranch(sp, u, mr.source_branch);
      else git.deleteBranch(sp.id, mr.source_branch);
    }
    // "Closes #12" in the description closes issues when merging into the default branch
    if (mr.target_branch === project.default_branch) {
      const re = /\b(?:close[sd]?|closing|fix(?:e[sd]|ing)?|resolve[sd]?|resolving|implement(?:s|ed|ing)?)\s*:?\s+((?:(?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*,\s*|\s+and\s+)?)+)/gi;
      const iids = new Set(); let mm;
      while ((mm = re.exec(`${mr.title}\n${mr.description || ''}`))) for (const x of mm[1].matchAll(/(?<![\w/])#(\d+)/g)) iids.add(+x[1]);
      for (const iid of iids) {
        const is = kit.sql("SELECT * FROM issues WHERE project_id = ? AND iid = ? AND state = 'opened'").get(project.id, iid);
        if (is) { I.setState(project, 'issue', is, u, 'closed'); I.systemNote(project, 'issue', is, u, `closed via merge request !${mr.iid}`, 'closed'); }
      }
    }
    req.flash('success', `Merged! The changes were merged into ${mr.target_branch}.`);
    return reply.redirect(mrUrl(project, mr));
  });

  // ------------------------------------------------------------ comments
  app.post(P('merge_requests/:iid/notes'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    if (!canComment(req, project, mr)) throw kit.httpError(403, mr.discussion_locked ? 'This merge request is locked. Only project members can comment.' : 'You cannot comment here.');
    const body = String(req.body.note || req.body.body || '').replace(/\r\n/g, '\n').trim();
    const closing = U.str(req.body.close) === '1'; const reopening = U.str(req.body.reopen) === '1';
    let noteId = null;
    if (body) {
      const disc = U.str(req.body.discussion_id) || null;
      if (disc && !kit.sql("SELECT 1 FROM notes WHERE discussion_id = ? AND noteable_type = 'merge_request' AND noteable_id = ?").get(disc, mr.id)) throw kit.httpError(422, 'Thread not found.');
      if (disc) kit.sql("UPDATE notes SET type = coalesce(type, 'DiscussionNote') WHERE discussion_id = ? AND noteable_type = 'merge_request' AND noteable_id = ?").run(disc, mr.id);
      noteId = I.addNote(project, 'merge_request', mr, req.user, body, { discussion: disc, internal: U.bool(req.body.internal) && project.access >= A.REPORTER, type: U.bool(req.body.start_thread) ? 'DiscussionNote' : null });
    } else if (!closing && !reopening) {
      req.flash('error', "Note can't be blank");
      return reply.redirect(mrUrl(project, mr));
    }
    if ((closing || reopening) && canEdit(req, project, mr) && mr.state !== 'merged') I.setState(project, 'merge_request', mr, req.user, closing ? 'closed' : 'opened');
    return reply.redirect(mrUrl(project, mr) + (noteId ? `#note_${noteId}` : ''));
  });
  ctx.noteRoutes('merge_request', 'merge_requests', loadMr);

  app.post(P('merge_requests/:iid/delete'), { config: { login: true } }, async (req, reply) => {
    const project = A.loadProject(req);
    const mr = loadMr(req, project);
    if (project.access < A.OWNER) throw kit.httpError(403, 'Only project owners can delete merge requests.');
    for (const sql of ["DELETE FROM notes WHERE noteable_type = 'merge_request' AND noteable_id = ?", 'DELETE FROM mr_assignees WHERE merge_request_id = ?', 'DELETE FROM mr_reviewers WHERE merge_request_id = ?',
      'DELETE FROM mr_approvals WHERE merge_request_id = ?', 'DELETE FROM mr_diff_files WHERE merge_request_id = ?', 'DELETE FROM mr_commits WHERE merge_request_id = ?',
      "DELETE FROM label_links WHERE target_type = 'merge_request' AND target_id = ?", "DELETE FROM resource_events WHERE target_type = 'merge_request' AND target_id = ?",
      "DELETE FROM todos WHERE target_type = 'merge_request' AND target_id = ?", 'DELETE FROM merge_requests WHERE id = ?']) kit.sql(sql).run(mr.id);
    kit.sql("DELETE FROM refs WHERE project_id = ? AND kind = 'mr' AND name = ?").run(project.id, String(mr.iid));
    if (mr.state === 'opened' || mr.state === 'locked') kit.sql('UPDATE projects SET open_merge_requests_count = max(0, open_merge_requests_count - 1) WHERE id = ?').run(project.id);
    req.flash('success', 'The merge request was successfully deleted.');
    return reply.redirect(`${project.base}/-/merge_requests`);
  });

  ctx.mrCompare = compare;
};
