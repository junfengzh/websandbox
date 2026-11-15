'use strict';
// Writes shared by issues and merge requests ("issuables"): labels, assignees, reviewers,
// milestone, due date, state, notes (comments + GitLab system notes), resource events,
// activity events, to-dos, and the denormalised counters (SCHEMA.md). Every function takes
// `kind` = 'issue' | 'merge_request' and the row.
const kit = require('../../../../kit');
const git = require('./git');

const TABLE = { issue: 'issues', merge_request: 'merge_requests' };
const ASSIGNEES = { issue: ['issue_assignees', 'issue_id'], merge_request: ['mr_assignees', 'merge_request_id'] };
const NOUN = { issue: 'issue', merge_request: 'merge request' };

let seq = 0;
// deterministic per transaction-ish discussion ids (no Math.random: graders / re-runs)
const discussionId = (kind, id) => git.sha1(`${kind}:${id}:${kit.nowSql()}:${++seq}:${kit.sql('SELECT coalesce(max(id), 0) FROM notes').pluck().get()}`);

function addNote(project, kind, target, author, body, { system = false, action = null, discussion = null, internal = false, type = null, at } = {}) {
  const now = at || kit.nowSql();
  const r = kit.sql(`INSERT INTO notes (project_id, noteable_type, noteable_id, author_id, body, system, system_action, internal, type, discussion_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(project.id, kind, target.id, author ? author.id : null, body, system ? 1 : 0, action,
    internal ? 1 : 0, type || (discussion ? 'DiscussionNote' : null), discussion || discussionId(kind, target.id), now, now);
  const id = Number(r.lastInsertRowid);
  if (!system) {
    kit.sql(`UPDATE ${TABLE[kind]} SET user_notes_count = user_notes_count + 1, updated_at = ? WHERE id = ?`).run(now, target.id);
    addEvent(project, author, 'commented', 'note', id, target.title);
    mentionTodos(project, kind, target, author, body, id);
  } else {
    kit.sql(`UPDATE ${TABLE[kind]} SET updated_at = ? WHERE id = ?`).run(now, target.id);
  }
  return id;
}
const systemNote = (project, kind, target, author, body, action) => addNote(project, kind, target, author, body, { system: true, action });

function resourceEvent(kind, target, user, fields) {
  kit.sql(`INSERT INTO resource_events (kind, target_type, target_id, user_id, action, label_id, milestone_id, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fields.kind, kind, target.id, user ? user.id : null, fields.action || null,
    fields.label_id || null, fields.milestone_id || null, fields.state || null, kit.nowSql());
  kit.sql(`UPDATE ${TABLE[kind]} SET updated_at = ? WHERE id = ?`).run(kit.nowSql(), target.id);
}

function addEvent(project, author, action, targetType, targetId, title) {
  kit.sql(`INSERT INTO events (project_id, author_id, action, target_type, target_id, target_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(project ? project.id : null, author ? author.id : null, action, targetType, targetId, title || null, kit.nowSql());
  if (project) kit.sql('UPDATE projects SET last_activity_at = ? WHERE id = ?').run(kit.nowSql(), project.id);
}

function addTodo(userId, project, kind, target, author, action, noteId = null) {
  if (!userId || (author && userId === author.id && action !== 'marked')) return;
  const dup = kit.sql("SELECT id FROM todos WHERE user_id = ? AND target_type = ? AND target_id = ? AND action = ? AND state = 'pending'").get(userId, kind, target.id, action);
  if (dup && action !== 'mentioned') return;
  kit.sql(`INSERT INTO todos (user_id, project_id, target_type, target_id, author_id, note_id, action, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(userId, project.id, kind, target.id, author ? author.id : null, noteId, action, kit.nowSql(), kit.nowSql());
}
function mentionTodos(project, kind, target, author, body, noteId) {
  const names = new Set();
  String(body || '').replace(/(^|[\s(])@([A-Za-z0-9_][A-Za-z0-9_.-]*[A-Za-z0-9_])/g, (m, p, u) => { names.add(u); return m; });
  for (const n of [...names].slice(0, 20)) {
    const u = kit.sql("SELECT id FROM users WHERE username = ? AND state = 'active'").get(n);
    if (u) addTodo(u.id, project, kind, target, author, 'mentioned', noteId);
  }
}
function doneTodos(userId, kind, targetId) {
  kit.sql("UPDATE todos SET state = 'done', updated_at = ? WHERE user_id = ? AND target_type = ? AND target_id = ? AND state = 'pending'").run(kit.nowSql(), userId, kind, targetId);
}

// ---------------------------------------------------------------- labels
// labels a project can use: its own + its ancestors' group labels
function projectLabels(project) {
  const groups = groupChain(project.namespace_id);
  const gq = groups.length ? ` OR l.group_id IN (${groups.map(() => '?').join(',')})` : '';
  return kit.sql(`SELECT l.*, lp.priority FROM labels l LEFT JOIN label_priorities lp ON lp.label_id = l.id AND lp.project_id = ?
    WHERE l.project_id = ?${gq} ORDER BY l.title COLLATE NOCASE`).all(project.id, project.id, ...groups);
}
function groupChain(nsId) {
  const out = []; let id = nsId;
  for (let i = 0; id != null && i < 20; i++) {
    const n = kit.sql('SELECT id, parent_id, kind FROM namespaces WHERE id = ?').get(id);
    if (!n) break;
    if (n.kind === 'group') out.push(n.id);
    id = n.parent_id;
  }
  return out;
}
const labelsOf = (kind, id) => kit.sql(`SELECT l.* FROM label_links ll JOIN labels l ON l.id = ll.label_id WHERE ll.target_type = ? AND ll.target_id = ? ORDER BY l.title COLLATE NOCASE`).all(kind, id);

// set the label set; writes resource label events (add/remove)
function setLabels(project, kind, target, user, ids) {
  const allowed = new Map(projectLabels(project).map((l) => [l.id, l]));
  const want = new Set(ids.map(Number).filter((x) => allowed.has(x)));
  const have = new Set(labelsOf(kind, target.id).map((l) => l.id));
  let changed = false;
  for (const id of have) if (!want.has(id)) {
    kit.sql('DELETE FROM label_links WHERE target_type = ? AND target_id = ? AND label_id = ?').run(kind, target.id, id);
    resourceEvent(kind, target, user, { kind: 'label', action: 'remove', label_id: id }); changed = true;
  }
  for (const id of want) if (!have.has(id)) {
    kit.sql('INSERT OR IGNORE INTO label_links (label_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)').run(id, kind, target.id, kit.nowSql());
    resourceEvent(kind, target, user, { kind: 'label', action: 'add', label_id: id }); changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------- assignees / reviewers
const assigneesOf = (kind, id) => {
  const [t, c] = ASSIGNEES[kind];
  return kit.sql(`SELECT u.* FROM ${t} a JOIN users u ON u.id = a.user_id WHERE a.${c} = ? ORDER BY u.username COLLATE NOCASE`).all(id);
};
function setAssignees(project, kind, target, user, userIds) {
  const [t, c] = ASSIGNEES[kind];
  const want = [...new Set(userIds.map(Number).filter(Boolean))];
  const have = assigneesOf(kind, target.id).map((u) => u.id);
  const added = want.filter((x) => !have.includes(x)); const removed = have.filter((x) => !want.includes(x));
  if (!added.length && !removed.length) return false;
  for (const id of removed) kit.sql(`DELETE FROM ${t} WHERE ${c} = ? AND user_id = ?`).run(target.id, id);
  for (const id of added) { kit.sql(`INSERT OR IGNORE INTO ${t} (${c}, user_id) VALUES (?, ?)`).run(target.id, id); addTodo(id, project, kind, target, user, 'assigned'); }
  const names = (ids) => ids.map((id) => '@' + kit.sql('SELECT username FROM users WHERE id = ?').pluck().get(id)).join(', ');
  const parts = [];
  if (added.length) parts.push(`assigned to ${names(added)}`);
  if (removed.length) parts.push(`unassigned ${names(removed)}`);
  systemNote(project, kind, target, user, parts.join(' and '), 'assignee');
  return true;
}
const reviewersOf = (id) => kit.sql(`SELECT u.*, r.state AS review_state FROM mr_reviewers r JOIN users u ON u.id = r.user_id WHERE r.merge_request_id = ? ORDER BY u.username COLLATE NOCASE`).all(id);
function setReviewers(project, mr, user, userIds) {
  const want = [...new Set(userIds.map(Number).filter(Boolean))];
  const have = reviewersOf(mr.id).map((u) => u.id);
  const added = want.filter((x) => !have.includes(x)); const removed = have.filter((x) => !want.includes(x));
  if (!added.length && !removed.length) return false;
  for (const id of removed) kit.sql('DELETE FROM mr_reviewers WHERE merge_request_id = ? AND user_id = ?').run(mr.id, id);
  for (const id of added) {
    kit.sql("INSERT OR IGNORE INTO mr_reviewers (merge_request_id, user_id, state, created_at) VALUES (?, ?, 'unreviewed', ?)").run(mr.id, id, kit.nowSql());
    addTodo(id, project, 'merge_request', mr, user, 'review_requested');
  }
  const names = (ids) => ids.map((id) => '@' + kit.sql('SELECT username FROM users WHERE id = ?').pluck().get(id)).join(', ');
  const parts = [];
  if (added.length) parts.push(`requested review from ${names(added)}`);
  if (removed.length) parts.push(`removed review request for ${names(removed)}`);
  systemNote(project, 'merge_request', mr, user, parts.join(' and '), 'reviewer');
  return true;
}

// ---------------------------------------------------------------- milestone / due date / state
function projectMilestones(project, { state = null } = {}) {
  const groups = groupChain(project.namespace_id);
  const gq = groups.length ? ` OR group_id IN (${groups.map(() => '?').join(',')})` : '';
  return kit.sql(`SELECT * FROM milestones WHERE (project_id = ?${gq})${state ? ' AND state = ?' : ''} ORDER BY due_date IS NULL, due_date, title`).all(project.id, ...groups, ...(state ? [state] : []));
}
function setMilestone(project, kind, target, user, milestoneId) {
  const mid = milestoneId ? Number(milestoneId) : null;
  if (mid && !projectMilestones(project).some((m) => m.id === mid)) throw kit.httpError(422, 'Milestone not found in this project.');
  if ((target.milestone_id || null) === mid) return false;
  kit.sql(`UPDATE ${TABLE[kind]} SET milestone_id = ?, updated_at = ? WHERE id = ?`).run(mid, kit.nowSql(), target.id);
  resourceEvent(kind, target, user, { kind: 'milestone', action: mid ? 'add' : 'remove', milestone_id: mid || target.milestone_id });
  target.milestone_id = mid;
  return true;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${String(dd).padStart(2, '0')}, ${y}`; };
function setDueDate(project, target, user, due) {
  if ((target.due_date || null) === (due || null)) return false;
  kit.sql('UPDATE issues SET due_date = ?, updated_at = ? WHERE id = ?').run(due || null, kit.nowSql(), target.id);
  systemNote(project, 'issue', target, user, due ? `changed due date to ${longDate(due)}` : 'removed due date', 'due_date');
  target.due_date = due || null;
  return true;
}

function setState(project, kind, target, user, state) {
  const now = kit.nowSql();
  const T = TABLE[kind];
  if (target.state === state) return false;
  const wasOpen = target.state === 'opened';
  if (state === 'closed') kit.sql(`UPDATE ${T} SET state = 'closed', closed_at = ?, closed_by_id = ?, updated_at = ? WHERE id = ?`).run(now, user.id, now, target.id);
  else if (state === 'opened') kit.sql(`UPDATE ${T} SET state = 'opened', closed_at = NULL, closed_by_id = NULL, updated_at = ? WHERE id = ?`).run(now, target.id);
  else if (state === 'merged') kit.sql(`UPDATE ${T} SET state = 'merged', merged_at = ?, merged_by_id = ?, updated_at = ? WHERE id = ?`).run(now, user.id, now, target.id);
  const col = kind === 'issue' ? 'open_issues_count' : 'open_merge_requests_count';
  if (wasOpen && state !== 'opened') kit.sql(`UPDATE projects SET ${col} = max(0, ${col} - 1) WHERE id = ?`).run(project.id);
  if (!wasOpen && state === 'opened') kit.sql(`UPDATE projects SET ${col} = ${col} + 1 WHERE id = ?`).run(project.id);
  resourceEvent(kind, target, user, { kind: 'state', state: state === 'opened' ? 'reopened' : state });
  addEvent(project, user, state === 'opened' ? 'reopened' : state, kind, target.id, target.title);
  target.state = state;
  return true;
}

// ---------------------------------------------------------------- timeline (notes + resource events)
function timeline(project, kind, target, { includeSystem = true } = {}) {
  const notes = kit.sql(`SELECT n.*, u.username, u.name AS author_name, u.avatar AS author_avatar FROM notes n LEFT JOIN users u ON u.id = n.author_id
    WHERE n.noteable_type = ? AND n.noteable_id = ? ${includeSystem ? '' : 'AND n.system = 0'} ORDER BY n.created_at, n.id`).all(kind, target.id);
  const items = notes.map((n) => ({ kind: n.system ? 'system' : 'note', at: n.created_at, n }));
  if (includeSystem) {
    const ev = kit.sql(`SELECT e.*, u.username, u.name AS author_name, u.avatar AS author_avatar, l.title AS label_title, l.color AS label_color, m.title AS milestone_title, m.iid AS milestone_iid
      FROM resource_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN labels l ON l.id = e.label_id LEFT JOIN milestones m ON m.id = e.milestone_id
      WHERE e.target_type = ? AND e.target_id = ? ORDER BY e.created_at, e.id`).all(kind, target.id);
    // merge label add/remove events by the same user in the same second into one line, like GitLab
    let last = null;
    for (const e of ev) {
      if (e.kind === 'label' && last && last.kind === 'labels' && last.e.user_id === e.user_id && last.at === e.created_at) { last.labels.push(e); continue; }
      const it = e.kind === 'label' ? { kind: 'labels', at: e.created_at, e, labels: [e] } : { kind: 'event', at: e.created_at, e };
      items.push(it); last = it;
    }
    items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
  // group threaded replies under the first note of their discussion
  const out = []; const byDisc = new Map();
  for (const it of items) {
    if (it.kind === 'note' && it.n.discussion_id && it.n.type === 'DiscussionNote' || (it.kind === 'note' && it.n.type === 'DiffNote')) {
      const d = byDisc.get(it.n.discussion_id);
      if (d) { d.replies.push(it.n); continue; }
      const t = { ...it, replies: [] }; byDisc.set(it.n.discussion_id, t); out.push(t); continue;
    }
    out.push(it);
  }
  return out;
}

function participants(kind, target) {
  return kit.sql(`SELECT DISTINCT u.id, u.username, u.name, u.avatar FROM users u WHERE u.id = ? OR u.id IN (SELECT author_id FROM notes WHERE noteable_type = ? AND noteable_id = ? AND system = 0)
    ORDER BY u.username COLLATE NOCASE LIMIT 50`).all(target.author_id, kind, target.id);
}

module.exports = {
  TABLE, NOUN, addNote, systemNote, resourceEvent, addEvent, addTodo, doneTodos, mentionTodos,
  projectLabels, labelsOf, setLabels, groupChain, assigneesOf, setAssignees, reviewersOf, setReviewers,
  projectMilestones, setMilestone, setDueDate, setState, timeline, participants, longDate,
};
