'use strict';
// Read templates: merge requests (reviewer counts, changes, details).
const { q, pid, uid } = require('./lib');

const MR_STATE = { open: "m.state IN ('opened','locked')", merged: "m.state = 'merged'", closed: "m.state = 'closed'" };
const MR = (fp, iid) => `(SELECT id FROM merge_requests WHERE project_id = ${pid(fp)} AND iid = ${iid})`;

const reviewerCount = {
  id: 'gen-code-mr-reviewer-count', kind: 'read', skills: ['filter-sort', 'aggregate'], difficulty: 2, cap: 60,
  phrasings: [
    'How many {state} merge requests in {repo} have {user} as a reviewer?',
    'In the {repo} project, count the {state} merge requests where {user} was requested as reviewer.',
    'Filter {repo}\'s merge requests by reviewer {user}. How many are {state}?',
  ],
  generate({ db }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, u.username, u.name, sum(m.state IN ('opened','locked')) open, sum(m.state = 'merged') merged, sum(m.state = 'closed') closed
      FROM mr_reviewers r JOIN merge_requests m ON m.id = r.merge_request_id JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = r.user_id
      WHERE p.visibility = 'public' AND u.state = 'active' GROUP BY p.id, u.id HAVING count(*) >= 3 ORDER BY p.id, u.id`).all();
    for (const r of rows) {
      for (const state of ['open', 'merged', 'closed']) {
        if (r[state] < 2) continue;
        const user = r.name.toLowerCase() === r.username.toLowerCase() ? `@${r.username}` : `${r.name} (@${r.username})`;
        out.push({ vars: { repo: r.full_path, user, state }, start: '/' + r.full_path + '/-/merge_requests',
          eval: { type: 'answer', answer: { must_include: [String(r[state])] },
            answer_sql: `SELECT count(*) FROM merge_requests m WHERE m.project_id = ${pid(r.full_path)} AND ${MR_STATE[state]} AND m.id IN (SELECT merge_request_id FROM mr_reviewers WHERE user_id = ${uid(r.username)})` } });
      }
    }
    return out;
  },
};

const mrChanges = {
  id: 'gen-code-mr-changes', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2, cap: 70,
  phrasings: [
    'Which file(s) does merge request !{iid} in {repo} change? {extra}',
    'Open the changes of merge request !{iid} ("{title}") in {repo}. {Extra2}',
    'Look at {repo}!{iid}. {Extra2}',
  ],
  generate({ db, rand }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, m.id, m.iid, trim(m.title) title, m.files_count FROM merge_requests m JOIN projects p ON p.id = m.project_id
      WHERE p.visibility = 'public' AND m.files_count BETWEEN 1 AND 3 AND length(m.title) BETWEEN 8 AND 80 AND instr(m.title, '"') = 0
      AND (SELECT count(*) FROM mr_diff_files f WHERE f.merge_request_id = m.id) = m.files_count
      AND NOT EXISTS (SELECT 1 FROM mr_diff_files f WHERE f.merge_request_id = m.id AND (f.diff_omitted = 1 OR f.binary = 1))
      ORDER BY m.id`).all();
    const per = new Map();
    for (const r of rand.shuffle(rows)) {
      const k = per.get(r.full_path) || 0;
      if (k >= 3) continue;
      const files = db.prepare('SELECT new_path, additions, deletions FROM mr_diff_files WHERE merge_request_id = ? ORDER BY ord').all(r.id);
      const add = files.reduce((s, f) => s + f.additions, 0); const del = files.reduce((s, f) => s + f.deletions, 0);
      const v = rand.int(2);
      if (v === 0) {
        if (files.some((f) => f.new_path.length > 70)) continue;
        out.push({ vars: { repo: r.full_path, iid: String(r.iid), title: r.title, extra: 'List their paths.', Extra2: 'Which file paths does it modify?' }, start: '/' + r.full_path + '/-/merge_requests',
          eval: { type: 'answer', answer: { must_include: files.map((f) => f.new_path) }, answer_sql: `SELECT new_path FROM mr_diff_files WHERE merge_request_id = ${MR(r.full_path, r.iid)} ORDER BY ord` } });
      } else {
        if (add === del || add === 0 || del === 0) continue;
        const addQ = rand.int(2) === 0;
        out.push({ vars: { repo: r.full_path, iid: String(r.iid), title: r.title, extra: `Also, how many lines does it ${addQ ? 'add' : 'remove'} in total?`, Extra2: `How many lines does it ${addQ ? 'add' : 'remove'} in total (over all files)?` },
          phrasing: rand.int(2) ? 1 : 2, start: '/' + r.full_path + '/-/merge_requests',
          eval: { type: 'answer', answer: { must_include: [String(addQ ? add : del)] },
            answer_sql: `SELECT sum(${addQ ? 'additions' : 'deletions'}) FROM mr_diff_files WHERE merge_request_id = ${MR(r.full_path, r.iid)}` } });
      }
      per.set(r.full_path, k + 1);
    }
    return out;
  },
};

const mrDetail = {
  id: 'gen-code-mr-branches', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2, cap: 60,
  phrasings: [
    'The merge request "{title}" in {repo}: {what}?',
    'Find the merge request titled "{title}" in the {repo} project. {What}?',
    'In {repo}, search the merge requests for "{title}". {What}?',
  ],
  generate({ db, rand }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, m.iid, trim(m.title) title, m.source_branch, m.target_branch, m.commits_count, m.state, m.source_project_id = m.project_id same
      FROM merge_requests m JOIN projects p ON p.id = m.project_id
      WHERE p.visibility = 'public' AND length(m.title) BETWEEN 15 AND 80 AND instr(m.title, '"') = 0 AND m.source_branch != m.target_branch
      AND length(m.source_branch) BETWEEN 4 AND 50 AND m.source_branch NOT IN ('master', 'main')
      ORDER BY m.id`).all();
    const dup = new Set(db.prepare(`SELECT p.full_path || '|' || lower(trim(m.title)) FROM merge_requests m JOIN projects p ON p.id = m.project_id GROUP BY m.project_id, lower(trim(m.title)) HAVING count(*) > 1`).pluck().all());
    const per = new Map();
    for (const r of rand.shuffle(rows)) {
      if (dup.has(r.full_path + '|' + r.title.toLowerCase())) continue;
      const k = per.get(r.full_path) || 0;
      if (k >= 3) continue;
      const M = MR(r.full_path, r.iid);
      const v = rand.int(2);
      if (v === 0) {
        out.push({ vars: { repo: r.full_path, title: r.title, what: 'which source branch does it want to merge', What: 'What is its source branch (the branch being merged)' }, start: '/' + r.full_path,
          eval: { type: 'answer', answer: { must_include: [r.source_branch] }, answer_sql: `SELECT source_branch FROM merge_requests WHERE id = ${M}` } });
      } else {
        if (r.commits_count < 2 || r.commits_count > 100) continue;
        out.push({ vars: { repo: r.full_path, title: r.title, what: 'how many commits does it contain', What: 'How many commits does it contain' }, start: '/' + r.full_path,
          eval: { type: 'answer', answer: { must_include: [String(r.commits_count)] }, answer_sql: `SELECT commits_count FROM merge_requests WHERE id = ${M}` } });
      }
      per.set(r.full_path, k + 1);
    }
    return out;
  },
};

module.exports = [reviewerCount, mrChanges, mrDetail];
