'use strict';
// Write templates: issues and merge requests (create, comment+close, reopen, relabel, milestone/due
// date, assign, review requests).
const { q, pid, uid } = require('./lib');
const { HAS_LABEL, labelStats } = require('./read_issues');

const NEW = "'2023-04-27'"; // rows created by the rollout (site clock starts 2023-04-27 16:00)
const ISSUE = (fp, iid) => `(SELECT id FROM issues WHERE project_id = ${pid(fp)} AND iid = ${iid})`;
const LABELS_OF = (I) => `(SELECT group_concat(t, '|') FROM (SELECT l.title t FROM label_links ll JOIN labels l ON l.id = ll.label_id WHERE ll.target_type = 'issue' AND ll.target_id = ${I} ORDER BY l.title))`;
const sortedJoin = (a) => a.slice().sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).join('|');

// who performs writes on a project: byteblaze where he has the access, else the personal namespace owner
function actor(db, p, minLevel) {
  const bb = db.prepare(`SELECT max(access_level) FROM members WHERE source_type = 'project' AND source_id = ? AND user_id = (SELECT id FROM users WHERE username = 'byteblaze') AND requested_at IS NULL`).pluck().get(p.id);
  if (bb && bb >= minLevel) return 'byteblaze';
  return db.prepare(`SELECT u.username FROM namespaces n JOIN users u ON u.id = n.owner_id WHERE n.id = ? AND n.kind = 'user' AND u.state = 'active'`).pluck().get(p.namespace_id) || null;
}
const userLabel = (u) => (u.name && u.name.toLowerCase() !== u.username.toLowerCase() ? `${u.name} (@${u.username})` : `@${u.username}`);

const ISSUE_TITLES = ['Document the release process', 'Add a troubleshooting section to the docs', 'Flaky test on CI', 'Update the contributing guide', 'Support configuration via environment variables',
  'Improve error message for invalid input', 'Add dark mode support', 'Broken link in the README', 'Deprecation warnings on startup', 'Add examples for the new API',
  'Crash when the config file is empty', 'Typo in the installation instructions', 'Clarify the license of bundled assets', 'Add a changelog entry for the next release',
  'Remove unused dependencies', 'Slow startup on large projects', 'Missing translations in the settings page', 'Add keyboard shortcuts', 'Review accessibility of the main menu',
  'Upgrade the build toolchain', 'Write migration notes for the next major version', 'Cache build artifacts', 'Add a code of conduct', 'Set up automated security scanning'];
const COMMENTS = ['Fixed in the latest release, closing.', 'Closing as this is no longer reproducible.', 'Duplicate of an existing issue, closing.', 'Resolved by the recent refactoring.',
  'Closing: this works as intended.', 'No response from the reporter, closing for now.', 'Done, thanks everyone for the input!', 'This has been addressed on the default branch.'];

const createIssue = {
  id: 'gen-code-create-issue-full', kind: 'write', skills: ['create', 'form-edit'], difficulty: 3, cap: 80,
  phrasings: [
    'Create an issue in {repo} titled "{title}" with the label(s) {labels}, assign it to {assignee} and put it in the milestone "{ms}".',
    'Open a new issue "{title}" in the {repo} project. It should have the label(s) {labels}, the milestone "{ms}" and {assignee} as assignee.',
    'In {repo}, file an issue called "{title}"; label it {labels}, add it to milestone "{ms}" and assign {assignee}.',
  ],
  generate({ db, rand }) {
    const out = [];
    const projects = db.prepare(`SELECT p.* FROM projects p WHERE p.visibility IN ('public','private') AND p.archived = 0 AND p.issues_enabled = 1
      AND (SELECT count(*) FROM labels l WHERE l.project_id = p.id) >= 2 AND EXISTS (SELECT 1 FROM milestones m WHERE m.project_id = p.id AND m.state = 'active') ORDER BY p.id`).all();
    for (const p of projects) {
      const login = actor(db, p, 20);
      if (!login) continue;
      const labels = db.prepare(`SELECT title FROM labels WHERE project_id = ? AND length(title) <= 30 AND instr(title, '"') = 0 GROUP BY title HAVING count(*) = 1 ORDER BY title`).pluck().all(p.id);
      const mss = db.prepare(`SELECT title FROM milestones WHERE project_id = ? AND state = 'active' AND length(title) <= 40 GROUP BY title HAVING count(*) = 1 ORDER BY title`).pluck().all(p.id);
      const people = db.prepare(`SELECT DISTINCT u.username, u.name FROM issue_assignees a JOIN issues i ON i.id = a.issue_id JOIN users u ON u.id = a.user_id WHERE i.project_id = ? AND u.state = 'active' ORDER BY u.username`).all(p.id);
      const pool = people.length ? people : [db.prepare('SELECT username, name FROM users WHERE username = ?').get(login)];
      if (labels.length < 1 || !mss.length) continue;
      for (let k = 0; k < 3; k++) {
        const ls = rand.sample(labels, Math.min(labels.length, 1 + rand.int(2)));
        const ms = rand.pick(mss); const as = rand.pick(pool); const title = rand.pick(ISSUE_TITLES);
        const I = 'i.id';
        out.push({ vars: { repo: p.full_path, title, labels: ls.map((l) => `"${l}"`).join(' and '), assignee: as.username === login ? 'yourself' : userLabel(as), ms }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT (lower(trim(i.title)) = lower(${q(title)}) AND ${LABELS_OF(I)} = ${q(sortedJoin(ls))}
            AND i.milestone_id = (SELECT id FROM milestones WHERE project_id = ${pid(p.full_path)} AND title = ${q(ms)})
            AND EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id AND a.user_id = ${uid(as.username)})) AS ok
            FROM issues i WHERE i.project_id = ${pid(p.full_path)} AND i.author_id = ${uid(login)} AND i.created_at >= ${NEW} AND lower(trim(i.title)) = lower(${q(title)}) ORDER BY i.id DESC LIMIT 1`, state_expect: 1 } });
      }
    }
    return out;
  },
};

const closeWithComment = {
  id: 'gen-code-close-issue-comment', kind: 'write', skills: ['form-edit', 'navigate'], difficulty: 2, cap: 70,
  phrasings: [
    'Close issue #{iid} ("{title}") in {repo} and leave the comment "{comment}".',
    'In the {repo} project, comment "{comment}" on the issue "{title}" and close it.',
    'Find the open issue "{title}" in {repo}, post the comment "{comment}", then close the issue.',
  ],
  generate({ db, rand }) {
    const out = [];
    const projects = db.prepare(`SELECT p.* FROM projects p WHERE p.visibility IN ('public','private') AND p.archived = 0 AND p.open_issues_count >= 3 ORDER BY p.id`).all();
    for (const p of projects) {
      const login = actor(db, p, 20);
      if (!login) continue;
      const iss = db.prepare(`SELECT iid, trim(title) title FROM issues i WHERE project_id = ? AND state = 'opened' AND length(title) BETWEEN 10 AND 80 AND instr(title, '"') = 0 ORDER BY iid`).all(p.id);
      for (const it of rand.sample(iss, 2)) {
        const comment = rand.pick(COMMENTS); const I = ISSUE(p.full_path, it.iid);
        out.push({ vars: { repo: p.full_path, iid: String(it.iid), title: it.title, comment }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT (i.state = 'closed' AND EXISTS (SELECT 1 FROM notes n WHERE n.noteable_type = 'issue' AND n.noteable_id = i.id AND n.system = 0 AND n.author_id = ${uid(login)}
            AND n.created_at >= ${NEW} AND instr(lower(n.body), lower(${q(comment)})) > 0)) AS ok FROM issues i WHERE i.id = ${I}`, state_expect: 1 } });
      }
    }
    return out;
  },
};

const reopenLatest = {
  id: 'gen-code-reopen-latest-closed', kind: 'write', skills: ['filter-sort', 'multi-step'], difficulty: 3, cap: 50,
  phrasings: [
    'Reopen the most recently updated closed issue in {repo} that has the label "{label}".',
    'In {repo}, among the closed issues labeled "{label}", find the one updated most recently and reopen it.',
    'The closed "{label}" issue of {repo} with the latest update date was closed by mistake. Reopen it.',
  ],
  generate({ db }) {
    const out = [];
    for (const s of labelStats(db)) {
      if (s.n - s.nopen < 2) continue;
      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(s.pid);
      const login = actor(db, p, 20);
      if (!login) continue;
      const rows = db.prepare(`SELECT i.iid, i.updated_at FROM issues i WHERE i.project_id = ? AND i.state = 'closed' AND i.updated_at IS NOT NULL AND ${HAS_LABEL(s.full_path, s.title)} ORDER BY i.updated_at DESC`).all(s.pid);
      if (rows.length < 2 || rows[0].updated_at === rows[1].updated_at) continue;
      const I = ISSUE(s.full_path, rows[0].iid);
      out.push({ vars: { repo: s.full_path, label: s.title }, login, start: '/' + s.full_path + '/-/issues',
        eval: { type: 'state', state_sql: [
          `SELECT state FROM issues WHERE id = ${I}`,
          `SELECT count(*) FROM issues i WHERE i.project_id = ${pid(s.full_path)} AND i.state = 'opened' AND ${HAS_LABEL(s.full_path, s.title)}`,
        ], state_expect: ['opened', s.nopen + 1] } });
    }
    return out;
  },
};

const relabel = {
  id: 'gen-code-issue-relabel', kind: 'write', skills: ['form-edit', 'navigate'], difficulty: 2, cap: 70,
  phrasings: [
    'On issue #{iid} of {repo}, remove the label "{rm}" and add the label "{add}".',
    'Relabel the {repo} issue "{title}": take off "{rm}" and put on "{add}" instead.',
    'In {repo}, the issue "{title}" should no longer be labeled "{rm}"; label it "{add}" instead.',
  ],
  generate({ db, rand }) {
    const out = [];
    const projects = db.prepare(`SELECT p.* FROM projects p WHERE p.archived = 0 AND p.visibility IN ('public','private') AND (SELECT count(*) FROM labels WHERE project_id = p.id) >= 3 ORDER BY p.id`).all();
    for (const p of projects) {
      const login = actor(db, p, 20);
      if (!login) continue;
      const labels = db.prepare(`SELECT title FROM labels WHERE project_id = ? AND instr(title, '"') = 0 GROUP BY title HAVING count(*) = 1`).pluck().all(p.id);
      const iss = db.prepare(`SELECT i.id, i.iid, trim(i.title) title, (SELECT group_concat(l.title, '|') FROM label_links ll JOIN labels l ON l.id = ll.label_id WHERE ll.target_type = 'issue' AND ll.target_id = i.id) lbl
        FROM issues i WHERE i.project_id = ? AND i.state = 'opened' AND length(i.title) BETWEEN 10 AND 80 AND instr(i.title, '"') = 0
        AND EXISTS (SELECT 1 FROM label_links ll WHERE ll.target_type = 'issue' AND ll.target_id = i.id) ORDER BY i.iid`).all(p.id);
      for (const it of rand.sample(iss, 2)) {
        const cur = it.lbl.split('|');
        if (cur.some((c) => !labels.includes(c))) continue;
        const rm = rand.pick(cur); const add = rand.pick(labels.filter((l) => !cur.includes(l)));
        if (!add) continue;
        const want = sortedJoin([...cur.filter((c) => c !== rm), add]);
        out.push({ vars: { repo: p.full_path, iid: String(it.iid), title: it.title, rm, add }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT ${LABELS_OF(ISSUE(p.full_path, it.iid))}`, state_expect: want } });
      }
    }
    return out;
  },
};

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const milestoneDue = {
  id: 'gen-code-issue-milestone-due', kind: 'write', skills: ['form-edit', 'search'], difficulty: 2, cap: 60,
  phrasings: [
    'In {repo}, move the issue "{title}" to the milestone "{ms}" and set its due date to {date}.',
    'Set the milestone of {repo} issue #{iid} to "{ms}" and give it a due date of {date}.',
    'Plan the {repo} issue "{title}": milestone "{ms}", due {date}.',
  ],
  generate({ db, rand }) {
    const out = [];
    const projects = db.prepare(`SELECT p.* FROM projects p WHERE p.archived = 0 AND p.visibility IN ('public','private') AND (SELECT count(*) FROM milestones m WHERE m.project_id = p.id AND m.state = 'active') >= 1 ORDER BY p.id`).all();
    for (const p of projects) {
      const login = actor(db, p, 20);
      if (!login) continue;
      const mss = db.prepare(`SELECT id, title FROM milestones WHERE project_id = ? AND state = 'active' GROUP BY title HAVING count(*) = 1`).all(p.id);
      const iss = db.prepare(`SELECT iid, trim(title) title, milestone_id FROM issues WHERE project_id = ? AND state = 'opened' AND due_date IS NULL AND length(title) BETWEEN 10 AND 80 AND instr(title, '"') = 0 ORDER BY iid`).all(p.id);
      for (const it of rand.sample(iss, 3)) {
        const m = rand.pick(mss.filter((x) => x.id !== it.milestone_id));
        if (!m) continue;
        const y = 2023 + rand.int(2); const mo = 5 + rand.int(8); const d = 1 + rand.int(28);
        const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        out.push({ vars: { repo: p.full_path, iid: String(it.iid), title: it.title, ms: m.title, date: `${months[mo - 1]} ${d}, ${y}` }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT (i.milestone_id = (SELECT id FROM milestones WHERE project_id = ${pid(p.full_path)} AND title = ${q(m.title)}) AND i.due_date = '${iso}') AS ok FROM issues i WHERE i.id = ${ISSUE(p.full_path, it.iid)}`, state_expect: 1 } });
      }
    }
    return out;
  },
};

const assignToAuthor = {
  id: 'gen-code-assign-most-commented', kind: 'write', skills: ['filter-sort', 'compare', 'multi-step'], difficulty: 3, cap: 50,
  phrasings: [
    'Find the open issue with the most comments in {repo} among those labeled "{label}" and assign it to its author.',
    'In {repo}, which open "{label}" issue has the most comments? Assign that issue to the person who opened it.',
    'Look at the open issues of {repo} with the label "{label}"; assign the most commented one to whoever reported it.',
  ],
  generate({ db }) {
    const out = [];
    for (const s of labelStats(db)) {
      const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(s.pid);
      const login = actor(db, p, 20);
      if (!login) continue;
      const rows = db.prepare(`SELECT i.id, i.iid, i.user_notes_count c, u.username, u.id uid FROM issues i JOIN users u ON u.id = i.author_id WHERE i.project_id = ? AND i.state = 'opened' AND ${HAS_LABEL(s.full_path, s.title)} ORDER BY c DESC`).all(s.pid);
      if (rows.length < 2 || rows.length > 40 || rows[0].c === rows[1].c || rows[0].c === 0) continue;
      const top = rows[0];
      if (top.username === 'root' || top.username === login) continue;
      const already = db.prepare('SELECT 1 FROM issue_assignees WHERE issue_id = ? AND user_id = ?').get(top.id, top.uid);
      if (already) continue;
      out.push({ vars: { repo: s.full_path, label: s.title }, login, start: '/' + s.full_path + '/-/issues',
        eval: { type: 'state', state_sql: `SELECT count(*) FROM issue_assignees a WHERE a.issue_id = ${ISSUE(s.full_path, top.iid)} AND a.user_id = ${uid(top.username)}`, state_expect: 1 } });
    }
    return out;
  },
};

const requestReview = {
  id: 'gen-code-mr-request-review', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 60,
  phrasings: [
    'Request a review from {user} on the merge request "{title}" in {repo}.',
    'In {repo}, add {user} as a reviewer of merge request !{iid}.',
    'Ask {user} to review the {repo} merge request titled "{title}".',
  ],
  generate({ db, rand }) {
    const out = [];
    const projects = db.prepare(`SELECT p.* FROM projects p WHERE p.archived = 0 AND p.visibility IN ('public','private') AND p.open_merge_requests_count >= 2 ORDER BY p.id`).all();
    for (const p of projects) {
      const login = actor(db, p, 30);
      if (!login) continue;
      const mrs = db.prepare(`SELECT id, iid, trim(title) title FROM merge_requests WHERE project_id = ? AND state = 'opened' AND length(title) BETWEEN 10 AND 80 AND instr(title, '"') = 0 ORDER BY iid`).all(p.id);
      const people = db.prepare(`SELECT DISTINCT u.username, u.name FROM mr_reviewers r JOIN merge_requests m ON m.id = r.merge_request_id JOIN users u ON u.id = r.user_id WHERE m.project_id = ? AND u.state = 'active'
        UNION SELECT u.username, u.name FROM members mm JOIN users u ON u.id = mm.user_id WHERE mm.source_type = 'project' AND mm.source_id = ? AND u.state = 'active' ORDER BY 1`).all(p.id, p.id)
        .filter((u) => u.username !== login);
      const pool = people.length ? people : db.prepare(`SELECT username, name FROM users WHERE username IN ('abisubramanya27', 'yjlou', 'Roshanjossey', 'lahwaacz', 'koush') ORDER BY username`).all();
      for (const m of rand.sample(mrs, 2)) {
        const u = rand.pick(pool);
        if (db.prepare('SELECT 1 FROM mr_reviewers WHERE merge_request_id = ? AND user_id = (SELECT id FROM users WHERE username = ?)').get(m.id, u.username)) continue;
        out.push({ vars: { repo: p.full_path, iid: String(m.iid), title: m.title, user: userLabel(u) }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT count(*) FROM mr_reviewers WHERE merge_request_id = (SELECT id FROM merge_requests WHERE project_id = ${pid(p.full_path)} AND iid = ${m.iid}) AND user_id = ${uid(u.username)}`, state_expect: 1 } });
      }
    }
    return out;
  },
};

module.exports = [createIssue, closeWithComment, reopenLatest, relabel, milestoneDue, assignToAuthor, requestReview];
module.exports.actor = actor;
module.exports.userLabel = userLabel;
