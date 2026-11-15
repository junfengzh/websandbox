'use strict';
// Repository writes inside the tenant transaction (SCHEMA.md "Web edits"): web-editor commits,
// branches, tags, forks, new projects, stars, contributor statistics.
const kit = require('../../../../kit');
const code = require('../../lib/code');
const git = require('./git');
const { lineStats } = require('./diff');

const unix = (sqlTs) => Math.floor(code.toDate(sqlTs).getTime() / 1000);
const pathId = (p) => {
  kit.sql('INSERT OR IGNORE INTO paths (path) VALUES (?)').run(p);
  return kit.sql('SELECT id FROM paths WHERE path = ?').pluck().get(p);
};
const BRANCH_RE = /^(?!\/|.*(?:\/\.|\/\/|\.\.|@\{|\\))[^\0- ~^:?*[\x7f]+(?<!\.lock|\/|\.)$/;
const validRefName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 255 && BRANCH_RE.test(n) && n !== 'HEAD' && !n.startsWith('-');
const validPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 4096 && !p.split('/').some((s) => s === '' || s === '.' || s === '..' || s === '.git') && !/[\0]/.test(p);

// Rewrite the tree `treeSha` (null = empty) with `fn(entries) -> entries` applied at `dirParts`.
function rewriteTree(treeSha, dirParts, fn, depth = 0) {
  const entries = treeSha ? git.getTree(treeSha) : [];
  if (entries == null) throw kit.httpError(409, 'The files of this commit are not available in this sandbox.');
  let next;
  if (!dirParts.length) next = fn(entries.slice());
  else {
    const [head, ...rest] = dirParts;
    next = entries.slice();
    const i = next.findIndex((e) => e.name === head);
    if (i >= 0 && next[i].type !== 'tree') throw kit.httpError(422, `A file with the name '${head}' already exists.`);
    const sub = rewriteTree(i >= 0 ? next[i].sha : null, rest, fn, depth + 1);
    if (sub === null) { if (i >= 0) next.splice(i, 1); }
    else if (i >= 0) next[i] = { mode: '40000', name: head, sha: sub, type: 'tree' };
    else next.push({ mode: '40000', name: head, sha: sub, type: 'tree' });
  }
  if (!next.length && depth > 0) return null; // an empty subtree disappears (git has no empty dirs)
  return git.putObject('tree', git.serializeTree(next));
}

// Apply file actions to a root tree. actions: [{action: 'create'|'update'|'delete'|'move', path, previousPath, content}]
// Returns {tree, changes: [{path, oldPath, change, additions, deletions}]}
function applyActions(rootTree, actions) {
  let tree = rootTree;
  const changes = [];
  for (const a of actions) {
    if (!validPath(a.path)) throw kit.httpError(422, `Invalid file path: ${a.path}`);
    const parts = a.path.split('/');
    const name = parts.pop();
    const existing = tree ? git.entryAt(tree, a.path) : null;
    if (existing && existing.missing) throw kit.httpError(409, 'The files of this commit are not available in this sandbox.');
    let oldText = null;
    if (a.action === 'create') {
      if (existing) throw kit.httpError(422, 'A file with this name already exists');
    } else if (a.action === 'update' || a.action === 'delete') {
      if (!existing || existing.type === 'tree') throw kit.httpError(422, 'The file has been changed or deleted since you started editing it.');
      const b = git.readBlob(existing.sha);
      oldText = b.text != null ? b.text : null;
    } else if (a.action === 'move') {
      if (!validPath(a.previousPath)) throw kit.httpError(422, 'Invalid file path');
      const prev = git.entryAt(tree, a.previousPath);
      if (!prev || prev.type === 'tree') throw kit.httpError(422, 'The file has been changed or deleted since you started editing it.');
      if (existing) throw kit.httpError(422, 'A file with this name already exists');
      const b = git.readBlob(prev.sha);
      oldText = b.text != null ? b.text : null;
      const pp = a.previousPath.split('/'); const pn = pp.pop();
      tree = rewriteTree(tree, pp, (es) => es.filter((e) => e.name !== pn));
    }
    if (a.action === 'delete') {
      tree = rewriteTree(tree, parts, (es) => es.filter((e) => e.name !== name));
      const st = lineStats(oldText, '');
      changes.push({ path: a.path, change: 'D', ...st });
      continue;
    }
    let content = a.content == null ? '' : String(a.content);
    content = content.replace(/\r\n/g, '\n');
    const blob = git.putObject('blob', Buffer.from(content, 'utf8'));
    const mode = existing && existing.mode === '100755' ? '100755' : '100644';
    tree = rewriteTree(tree, parts, (es) => {
      const i = es.findIndex((e) => e.name === name);
      const e = { mode, name, sha: blob, type: 'blob' };
      if (i >= 0) es[i] = e; else es.push(e);
      return es;
    });
    const st = lineStats(oldText, content);
    changes.push({ path: a.path, oldPath: a.action === 'move' ? a.previousPath : null, change: a.action === 'create' ? 'A' : a.action === 'move' ? 'R' : 'M', ...st });
  }
  return { tree, changes };
}

// Create a commit on `branch` (optionally starting it from `startRef` = {sha} when the branch is
// new). user: users row. Returns the commit row.
function commitFiles(project, user, { branch, startSha, actions, message }) {
  if (!validRefName(branch)) throw kit.httpError(422, 'Branch name is invalid');
  const existingBranch = git.getRef(project.id, 'branch', branch);
  const headSha = existingBranch ? existingBranch.sha : startSha || null;
  const head = headSha ? git.commitBySha(headSha) : null;
  if (headSha && !head) throw kit.httpError(409, 'Unknown start commit');
  if (head && !head.has_tree) throw kit.httpError(409, 'The files of this commit are not available in this sandbox.');
  const { tree, changes } = applyActions(head ? head.tree_sha : null, actions);
  if (head && tree === head.tree_sha) throw kit.httpError(422, 'No changes were made to the file.');
  const now = kit.nowSql();
  const ts = unix(now);
  const email = user.commit_email || user.email;
  const msg = String(message || '').replace(/\r\n/g, '\n').trim() || `Update ${actions[0].path}`;
  const body = `tree ${tree}\n${head ? `parent ${head.sha}\n` : ''}author ${user.name} <${email}> ${ts} +0000\ncommitter ${user.name} <${email}> ${ts} +0000\n\n${msg}\n`;
  const sha = git.objectSha('commit', Buffer.from(body, 'utf8'));
  const title = msg.split('\n')[0];
  const adds = changes.reduce((s, c) => s + c.additions, 0), dels = changes.reduce((s, c) => s + c.deletions, 0);
  if (!git.commitBySha(sha)) {
    kit.sql(`INSERT INTO commits (sha, tree_sha, parents, author_name, author_email, authored_at, author_tz, committer_name, committer_email, committed_at, committer_tz,
      title, message, additions, deletions, files_changed, has_tree) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1)`)
      .run(sha, tree, head ? head.sha : '', user.name, email, now, user.name, email, now, title, msg, adds, dels, changes.length);
  }
  const c = git.commitBySha(sha);
  if (!kit.sql('SELECT 1 FROM commit_files WHERE commit_id = ?').get(c.id)) {
    changes.forEach((ch, i) => kit.sql('INSERT INTO commit_files (commit_id, ord, path_id, old_path_id, change, additions, deletions) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, i, pathId(ch.path), ch.oldPath ? pathId(ch.oldPath) : null, ch.change, ch.additions, ch.deletions));
  }
  kit.sql('INSERT OR IGNORE INTO project_commits (project_id, commit_id) VALUES (?, ?)').run(project.id, c.id);
  const created = !existingBranch;
  if (created) createBranchRef(project, branch, head, { commit: c });
  else {
    kit.sql("UPDATE refs SET sha = ? WHERE project_id = ? AND kind = 'branch' AND name = ?").run(sha, project.id, branch);
    if (git.hasBranchRows(project.id, branch)) {
      const minPos = kit.sql('SELECT min(pos) FROM branch_commits WHERE project_id = ? AND branch = ?').pluck().get(project.id, branch);
      kit.sql('INSERT INTO branch_commits (project_id, branch, pos, commit_id) VALUES (?, ?, ?, ?)').run(project.id, branch, minPos - 1, c.id);
    }
  }
  if (!project.default_branch) kit.sql('UPDATE projects SET default_branch = ? WHERE id = ?').run(branch, project.id);
  if (branch === (project.default_branch || branch)) kit.sql('UPDATE projects SET commit_count = commit_count + 1 WHERE id = ?').run(project.id);
  bumpContributor(project.id, branch, c);
  kit.jobs.enqueue('repo.contributors', { project_id: project.id, branch });
  code.touchProject(project.id);
  code.addEvent({ project_id: project.id, author_id: user.id, action: 'pushed', push_ref: branch, push_ref_type: 'branch', push_action: created ? 'created' : 'pushed',
    push_commit_count: 1, push_commit_from: head ? head.sha : null, push_commit_to: sha, push_commit_title: title });
  return c;
}

// Incremental contributor stats for one new non-merge commit (the job recomputes the 6000 window).
function bumpContributor(projectId, branch, c) {
  if (git.isMerge(c)) return;
  const email = String(c.author_email || '').toLowerCase();
  const r = kit.sql('SELECT 1 FROM contributors WHERE project_id = ? AND branch = ? AND author_email = ?').get(projectId, branch, email);
  if (r) {
    kit.sql(`UPDATE contributors SET commits = commits + 1, commits_all = commits_all + 1, additions = additions + ?, deletions = deletions + ?, author_name = ?, last_at = ?
      WHERE project_id = ? AND branch = ? AND author_email = ?`).run(c.additions || 0, c.deletions || 0, c.author_name, c.committed_at, projectId, branch, email);
  } else {
    kit.sql(`INSERT INTO contributors (project_id, branch, author_email, author_name, commits, commits_all, additions, deletions, first_at, last_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`)
      .run(projectId, branch, email, c.author_name, c.additions || 0, c.deletions || 0, c.committed_at, c.committed_at);
  }
}

// Recompute `commits` (newest 6000 non-merge commits, by lower(email); name from the newest) for a branch.
function recomputeContributors(projectId, branch) {
  const project = code.projectById(projectId);
  if (!project) return { skipped: true };
  const ref = git.getRef(projectId, 'branch', branch);
  if (!ref) { kit.sql('DELETE FROM contributors WHERE project_id = ? AND branch = ?').run(projectId, branch); return { deleted: true }; }
  const counts = new Map();
  const add = (c) => {
    const e = String(c.author_email || '').toLowerCase();
    const x = counts.get(e);
    if (x) x.n++; else counts.set(e, { n: 1, name: c.author_name, first: c.committed_at, last: c.committed_at });
    if (x && c.committed_at < x.first) x.first = c.committed_at;
  };
  if (git.hasBranchRows(projectId, branch)) {
    for (const c of kit.db().prepare(`SELECT c.author_email, c.author_name, c.committed_at FROM branch_commits b JOIN commits c ON c.id = b.commit_id
      WHERE b.project_id = ? AND b.branch = ? AND instr(c.parents, ' ') = 0 ORDER BY b.pos LIMIT 6000`).iterate(projectId, branch)) add(c);
  } else {
    let n = 0;
    for (const c of git.walk(ref.sha, { max: 60000 })) { if (git.isMerge(c)) continue; add(c); if (++n >= 6000) break; }
  }
  const had = kit.sql('SELECT count(*) FROM contributors WHERE project_id = ? AND branch = ?').pluck().get(projectId, branch);
  kit.sql('UPDATE contributors SET commits = 0 WHERE project_id = ? AND branch = ?').run(projectId, branch);
  for (const [email, x] of counts) {
    const ex = kit.sql('SELECT 1 FROM contributors WHERE project_id = ? AND branch = ? AND author_email = ?').get(projectId, branch, email);
    if (ex) kit.sql('UPDATE contributors SET commits = ?, author_name = ? WHERE project_id = ? AND branch = ? AND author_email = ?').run(x.n, x.name, projectId, branch, email);
    else kit.sql('INSERT INTO contributors (project_id, branch, author_email, author_name, commits, commits_all, additions, deletions, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)')
      .run(projectId, branch, email, x.name, x.n, x.n, x.first, x.last);
  }
  kit.sql('DELETE FROM contributors WHERE project_id = ? AND branch = ? AND commits = 0 AND commits_all = 0').run(projectId, branch);
  return { authors: counts.size, had };
}

// New branch ref `name` at commit `from` (row); copies the source branch's cached history
// (branch_commits / contributors) when the start is a branch head that has them.
function createBranchRef(project, name, from, { commit = null } = {}) {
  if (git.getRef(project.id, 'branch', name)) throw kit.httpError(422, 'Branch already exists');
  const tip = commit || from;
  kit.sql("INSERT INTO refs (project_id, kind, name, sha) VALUES (?, 'branch', ?, ?)").run(project.id, name, tip.sha);
  // source branch with cached rows whose head is `from`
  let src = null;
  if (from) src = kit.sql("SELECT r.name FROM refs r WHERE r.project_id = ? AND r.kind = 'branch' AND r.sha = ? AND r.name <> ? AND EXISTS (SELECT 1 FROM branch_commits b WHERE b.project_id = r.project_id AND b.branch = r.name) ORDER BY r.name = ? DESC LIMIT 1")
    .get(project.id, from.sha, name, project.default_branch || '');
  let base = 0;
  if (src) {
    const n = kit.sql('SELECT count(*) FROM branch_commits WHERE project_id = ? AND branch = ?').pluck().get(project.id, src.name);
    if (n <= 30000) {
      kit.sql('INSERT INTO branch_commits (project_id, branch, pos, commit_id) SELECT project_id, ?, pos, commit_id FROM branch_commits WHERE project_id = ? AND branch = ?').run(name, project.id, src.name);
      kit.sql(`INSERT INTO contributors (project_id, branch, author_email, author_name, commits, commits_all, additions, deletions, first_at, last_at)
        SELECT project_id, ?, author_email, author_name, commits, commits_all, additions, deletions, first_at, last_at FROM contributors WHERE project_id = ? AND branch = ?`).run(name, project.id, src.name);
      base = kit.sql('SELECT min(pos) FROM branch_commits WHERE project_id = ? AND branch = ?').pluck().get(project.id, name);
      if (commit) kit.sql('INSERT INTO branch_commits (project_id, branch, pos, commit_id) VALUES (?, ?, ?, ?)').run(project.id, name, base - 1, commit.id);
    }
  } else if (!from && commit) {
    kit.sql('INSERT INTO branch_commits (project_id, branch, pos, commit_id) VALUES (?, ?, 0, ?)').run(project.id, name, commit.id);
  }
}

function createBranch(project, user, name, fromRef) {
  name = String(name || '').trim();
  if (!validRefName(name)) throw kit.httpError(422, 'Branch name is invalid');
  if (git.getRef(project.id, 'branch', name)) throw kit.httpError(422, 'Branch already exists');
  const r = git.resolveRef(project, fromRef);
  if (!r || !r.commit) throw kit.httpError(422, 'Invalid reference name: ' + fromRef);
  createBranchRef(project, name, r.commit);
  if (!git.hasBranchRows(project.id, name)) kit.jobs.enqueue('repo.contributors', { project_id: project.id, branch: name });
  code.touchProject(project.id);
  code.addEvent({ project_id: project.id, author_id: user.id, action: 'pushed', push_ref: name, push_ref_type: 'branch', push_action: 'created', push_commit_count: 0, push_commit_to: r.sha, push_commit_title: r.commit.title });
  return name;
}

function deleteBranch(project, user, name) {
  const r = git.getRef(project.id, 'branch', name);
  if (!r) throw kit.httpError(404, 'Branch not found');
  if (name === project.default_branch) throw kit.httpError(422, 'The default branch of a project cannot be deleted.');
  kit.sql("DELETE FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?").run(project.id, name);
  kit.sql('DELETE FROM branch_commits WHERE project_id = ? AND branch = ?').run(project.id, name);
  kit.sql('DELETE FROM contributors WHERE project_id = ? AND branch = ?').run(project.id, name);
  code.touchProject(project.id);
  code.addEvent({ project_id: project.id, author_id: user.id, action: 'pushed', push_ref: name, push_ref_type: 'branch', push_action: 'removed', push_commit_count: 0, push_commit_from: r.sha });
}

function createTag(project, user, { name, ref, message }) {
  name = String(name || '').trim();
  if (!validRefName(name)) throw kit.httpError(422, 'Tag name invalid');
  if (git.getRef(project.id, 'tag', name)) throw kit.httpError(422, `Tag ${name} already exists`);
  const r = git.resolveRef(project, ref);
  if (!r || !r.commit) throw kit.httpError(422, 'Target ' + ref + ' is invalid');
  const msg = String(message || '').trim();
  const now = kit.nowSql();
  let tagSha = null;
  if (msg) {
    const email = user.commit_email || user.email;
    tagSha = git.objectSha('tag', Buffer.from(`object ${r.sha}\ntype commit\ntag ${name}\ntagger ${user.name} <${email}> ${unix(now)} +0000\n\n${msg}\n`));
  }
  kit.sql("INSERT INTO refs (project_id, kind, name, sha, tag_sha, tag_message, tagger_name, tagger_email, tagged_at) VALUES (?, 'tag', ?, ?, ?, ?, ?, ?, ?)")
    .run(project.id, name, r.sha, tagSha, msg || null, msg ? user.name : null, msg ? user.commit_email || user.email : null, msg ? now : null);
  code.touchProject(project.id);
  code.addEvent({ project_id: project.id, author_id: user.id, action: 'pushed', push_ref: name, push_ref_type: 'tag', push_action: 'created', push_commit_count: 0, push_commit_to: r.sha, push_commit_title: r.commit.title });
}
function deleteTag(project, user, name) {
  const r = git.getRef(project.id, 'tag', name);
  if (!r) throw kit.httpError(404, 'Tag not found');
  kit.sql("DELETE FROM refs WHERE project_id = ? AND kind = 'tag' AND name = ?").run(project.id, name);
  code.addEvent({ project_id: project.id, author_id: user.id, action: 'pushed', push_ref: name, push_ref_type: 'tag', push_action: 'removed', push_commit_count: 0, push_commit_from: r.sha });
}

// ---------------------------------------------------------------- stars
function setStar(project, user, on) {
  const has = !!kit.sql('SELECT 1 FROM stars WHERE user_id = ? AND project_id = ?').get(user.id, project.id);
  if (on && !has) {
    kit.sql('INSERT INTO stars (user_id, project_id, created_at) VALUES (?, ?, ?)').run(user.id, project.id, kit.nowSql());
    kit.sql('UPDATE projects SET star_count = star_count + 1 WHERE id = ?').run(project.id);
  } else if (!on && has) {
    kit.sql('DELETE FROM stars WHERE user_id = ? AND project_id = ?').run(user.id, project.id);
    kit.sql('UPDATE projects SET star_count = max(star_count - 1, 0) WHERE id = ?').run(project.id);
  }
  return kit.sql('SELECT star_count FROM projects WHERE id = ?').pluck().get(project.id);
}

// ---------------------------------------------------------------- projects
const PATH_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
function validateProjectPath(nsFull, path, name) {
  const errors = {};
  if (!name || !String(name).trim()) errors.name = "Project name can't be blank";
  else if (String(name).length > 255) errors.name = 'Project name is too long (maximum is 255 characters)';
  else if (!/^[\p{L}\p{N}_][\p{L}\p{N}_. +-]*$/u.test(String(name).trim())) errors.name = "Name can contain only letters, digits, emojis, '_', '.', '+', dashes, or spaces. It must start with a letter, digit, emoji, or '_'.";
  if (!path) errors.path = "Project URL can't be blank";
  else if (!PATH_RE.test(path) || /\.(git|atom)$/.test(path) || path.endsWith('.') || path.includes('..')) errors.path = "Path can contain only letters, digits, '_', '-' and '.'. Cannot start with '-', end in '.git' or end in '.atom'";
  else if (code.projectByPath(`${nsFull}/${path}`)) errors.path = 'has already been taken';
  return errors;
}
const slugPath = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/-{2,}/g, '-');

function insertProject(ns, user, f) {
  const now = kit.nowSql();
  const r = kit.sql(`INSERT INTO projects (namespace_id, path, name, full_path, description, visibility, creator_id, default_branch, star_count, forks_count, forked_from_id,
    commit_count, repository_size, import_url, objects_policy, template_name, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
    .run(ns.id, f.path, f.name, `${ns.full_path}/${f.path}`, f.description || null, f.visibility || 'private', user.id, f.default_branch || null, f.forked_from_id || null,
      f.commit_count || 0, f.repository_size || 0, f.objects_policy || 'full', f.template_name || null, now, now, now);
  const id = Number(r.lastInsertRowid);
  if (ns.kind === 'user' && ns.owner_id === user.id) {
    kit.sql("INSERT INTO members (source_type, source_id, user_id, access_level, created_by_id, created_at, updated_at) VALUES ('project', ?, ?, 50, ?, ?, ?)").run(id, user.id, user.id, now, now);
  } else if (code.groupAccessLevel(user, ns) < 50) {
    kit.sql("INSERT INTO members (source_type, source_id, user_id, access_level, created_by_id, created_at, updated_at) VALUES ('project', ?, ?, 40, ?, ?, ?)").run(id, user.id, user.id, now, now);
  }
  return code.projectById(id);
}

// Fork `parent` into namespace `ns` (refs + project_commits + cached history copied; objects shared).
function forkProject(parent, user, ns, { name, path, description, visibility }) {
  const p = insertProject(ns, user, {
    name, path, description: description ?? parent.description, visibility, default_branch: parent.default_branch, forked_from_id: parent.id,
    commit_count: parent.commit_count, repository_size: parent.repository_size, objects_policy: parent.objects_policy,
  });
  kit.sql(`INSERT INTO refs (project_id, kind, name, sha, tag_sha, tag_message, tagger_name, tagger_email, tagged_at)
    SELECT ?, kind, name, sha, tag_sha, tag_message, tagger_name, tagger_email, tagged_at FROM refs WHERE project_id = ? AND kind IN ('branch', 'tag')`).run(p.id, parent.id);
  kit.sql('INSERT INTO project_commits (project_id, commit_id) SELECT ?, commit_id FROM project_commits WHERE project_id = ?').run(p.id, parent.id);
  kit.sql('INSERT INTO branch_commits (project_id, branch, pos, commit_id) SELECT ?, branch, pos, commit_id FROM branch_commits WHERE project_id = ?').run(p.id, parent.id);
  kit.sql(`INSERT INTO contributors (project_id, branch, author_email, author_name, commits, commits_all, additions, deletions, first_at, last_at)
    SELECT ?, branch, author_email, author_name, commits, commits_all, additions, deletions, first_at, last_at FROM contributors WHERE project_id = ?`).run(p.id, parent.id);
  kit.sql("INSERT INTO protected_branches (project_id, name, allow_force_push, created_at) SELECT ?, name, allow_force_push, ? FROM protected_branches WHERE project_id = ?").run(p.id, kit.nowSql(), parent.id);
  kit.sql('UPDATE projects SET forks_count = forks_count + 1 WHERE id = ?').run(parent.id);
  code.addEvent({ project_id: p.id, author_id: user.id, action: 'created', target_type: null });
  return p;
}

// New project: blank (optionally with a README commit) or from a built-in template.
function createProject(user, ns, { name, path, description, visibility, readme, template }) {
  let tpl = null;
  if (template) {
    tpl = kit.sql('SELECT * FROM project_templates WHERE name = ?').get(template);
    if (!tpl) throw kit.httpError(422, 'Unknown template');
  }
  const p = insertProject(ns, user, { name, path, description, visibility, template_name: tpl ? tpl.name : null, default_branch: tpl ? tpl.default_branch : null });
  code.addEvent({ project_id: p.id, author_id: user.id, action: 'created', target_type: null });
  if (tpl) {
    const head = git.commitBySha(tpl.commit_sha);
    kit.sql("INSERT INTO refs (project_id, kind, name, sha) VALUES (?, 'branch', ?, ?)").run(p.id, tpl.default_branch, tpl.commit_sha);
    let pos = 0;
    const ins = kit.db().prepare('INSERT OR IGNORE INTO project_commits (project_id, commit_id) VALUES (?, ?)');
    const insB = kit.db().prepare('INSERT INTO branch_commits (project_id, branch, pos, commit_id) VALUES (?, ?, ?, ?)');
    for (const c of git.walk(head.sha, { max: 20000 })) { ins.run(p.id, c.id); insB.run(p.id, tpl.default_branch, pos++, c.id); }
    kit.sql('UPDATE projects SET commit_count = ? WHERE id = ?').run(pos, p.id);
    recomputeContributors(p.id, tpl.default_branch);
  } else if (readme) {
    const branch = 'main';
    commitFiles({ ...p, default_branch: null }, user, { branch, actions: [{ action: 'create', path: 'README.md', content: `# ${name}\n\n${description ? description + '\n' : ''}` }], message: 'Initial commit' });
  }
  return code.projectById(p.id);
}

module.exports = {
  validRefName, validPath, applyActions, commitFiles, recomputeContributors, createBranch, createBranchRef, deleteBranch, createTag, deleteTag,
  setStar, validateProjectPath, slugPath, forkProject, createProject, insertProject,
};
