'use strict';
// Read templates: issues (filtered counts, details, most-discussed) and milestones.
const { q, pid, uid } = require('./lib');

const LBL = (fp, title) => `(SELECT id FROM labels WHERE project_id = ${pid(fp)} AND title = ${q(title)})`;
const HAS_LABEL = (fp, title, alias = 'i') => `EXISTS (SELECT 1 FROM label_links ll WHERE ll.target_type = 'issue' AND ll.target_id = ${alias}.id AND ll.label_id IN ${LBL(fp, title)})`;
const STATE = { open: "i.state = 'opened'", closed: "i.state = 'closed'" };

// projects with issue labels in use
function labelStats(db) {
  return db.prepare(`SELECT p.full_path, p.id pid, l.id lid, l.title, count(*) n, sum(i.state = 'opened') nopen
    FROM label_links ll JOIN labels l ON l.id = ll.label_id JOIN issues i ON i.id = ll.target_id JOIN projects p ON p.id = i.project_id
    WHERE ll.target_type = 'issue' AND l.project_id = p.id AND p.visibility = 'public' AND p.archived = 0 AND p.issues_enabled != 0
    GROUP BY l.id HAVING n >= 3 ORDER BY p.id, l.title`).all();
}

const issueFilterCount = {
  id: 'gen-code-issue-filter-count', kind: 'read', skills: ['filter-sort', 'aggregate'], difficulty: 2, cap: 80,
  phrasings: [
    'How many {state} issues in {repo} {cond}?',
    'In the {repo} project, count the {state} issues that {cond2}.',
    'Filter the issues of {repo}: how many {state} ones {cond}?',
  ],
  generate({ db, rand }) {
    const out = [];
    const stats = labelStats(db);
    const byProject = new Map();
    for (const s of stats) { if (!byProject.has(s.full_path)) byProject.set(s.full_path, []); byProject.get(s.full_path).push(s); }
    for (const [fp, labels] of byProject) {
      const P = pid(fp);
      const combos = [];
      // two labels
      for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) combos.push({ kind: 'll', a: labels[a].title, b: labels[b].title });
      // label + milestone
      const ms = db.prepare(`SELECT m.title, count(*) n FROM issues i JOIN milestones m ON m.id = i.milestone_id WHERE i.project_id = ? AND m.project_id = i.project_id GROUP BY m.id HAVING n >= 3`).all(labels[0].pid);
      for (const l of labels) for (const m of ms) combos.push({ kind: 'lm', a: l.title, m: m.title });
      // label + assignee
      const as = db.prepare(`SELECT u.username, u.name, count(*) n FROM issues i JOIN issue_assignees a ON a.issue_id = i.id JOIN users u ON u.id = a.user_id WHERE i.project_id = ? GROUP BY u.id HAVING n >= 3`).all(labels[0].pid);
      for (const l of labels) for (const u of as) combos.push({ kind: 'la', a: l.title, u });
      let made = 0;
      for (const c of rand.shuffle(combos)) {
        if (made >= 4) break;
        const state = rand.pick(['open', 'closed']);
        let where; let cond; let cond2;
        if (c.kind === 'll') { where = `${HAS_LABEL(fp, c.a)} AND ${HAS_LABEL(fp, c.b)}`; cond = `have both the labels "${c.a}" and "${c.b}"`; cond2 = `are labeled both "${c.a}" and "${c.b}"`; }
        else if (c.kind === 'lm') { where = `${HAS_LABEL(fp, c.a)} AND i.milestone_id IN (SELECT id FROM milestones WHERE project_id = ${P} AND title = ${q(c.m)})`; cond = `have the label "${c.a}" and belong to the milestone "${c.m}"`; cond2 = `carry the label "${c.a}" and are in milestone "${c.m}"`; }
        else { where = `${HAS_LABEL(fp, c.a)} AND i.id IN (SELECT issue_id FROM issue_assignees WHERE user_id = ${uid(c.u.username)})`; cond = `are labeled "${c.a}" and assigned to ${c.u.name.toLowerCase() === c.u.username.toLowerCase() ? '@' + c.u.username : `${c.u.name} (@${c.u.username})`}`; cond2 = `have the label "${c.a}" and the assignee @${c.u.username}`; }
        const sql = `SELECT count(*) FROM issues i WHERE i.project_id = ${P} AND ${STATE[state]} AND ${where}`;
        const n = db.prepare(sql).pluck().get();
        if (n < 2) continue;
        out.push({ vars: { repo: fp, state, cond, cond2 }, start: '/' + fp + '/-/issues',
          eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: sql }, difficulty: n > 20 ? 2 : 2 });
        made++;
      }
    }
    return out;
  },
};

const issueDetail = {
  id: 'gen-code-issue-detail', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2, cap: 80,
  phrasings: [
    'In {repo}, find the issue titled "{title}". {What}?',
    'There is an issue "{title}" in the {repo} project. {What}?',
    'Look up the {repo} issue called "{title}" and tell me: {what}?',
  ],
  generate({ db, rand }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, i.id, i.iid, trim(i.title) title, i.state, i.milestone_id, i.user_notes_count,
        (SELECT title FROM milestones WHERE id = i.milestone_id) ms,
        (SELECT group_concat(u.name, '|') FROM issue_assignees a JOIN users u ON u.id = a.user_id WHERE a.issue_id = i.id) asg,
        (SELECT group_concat(l.title, '|') FROM label_links ll JOIN labels l ON l.id = ll.label_id WHERE ll.target_type = 'issue' AND ll.target_id = i.id) lbl
      FROM issues i JOIN projects p ON p.id = i.project_id
      JOIN (SELECT project_id, lower(trim(title)) lt, count(*) c FROM issues GROUP BY 1, 2) d ON d.project_id = i.project_id AND d.lt = lower(trim(i.title)) AND d.c = 1
      WHERE p.visibility = 'public' AND length(i.title) BETWEEN 15 AND 80 AND instr(i.title, '"') = 0
        AND (i.milestone_id IS NOT NULL OR EXISTS (SELECT 1 FROM issue_assignees a WHERE a.issue_id = i.id)
             OR EXISTS (SELECT 1 FROM label_links ll WHERE ll.target_type = 'issue' AND ll.target_id = i.id))
      ORDER BY p.id, i.iid`).all();
    const per = new Map();
    for (const r of rand.shuffle(rows)) {
      const k = per.get(r.full_path) || 0;
      if (k >= 3) continue;
      const opts = [];
      const I = `(SELECT id FROM issues WHERE project_id = ${pid(r.full_path)} AND iid = ${r.iid})`;
      if (r.ms) opts.push(['which milestone is it in', [r.ms], `SELECT m.title FROM issues i JOIN milestones m ON m.id = i.milestone_id WHERE i.id = ${I}`]);
      if (r.asg && r.asg.split('|').length <= 3) opts.push(['who is it assigned to', r.asg.split('|'), `SELECT u.name FROM issue_assignees a JOIN users u ON u.id = a.user_id WHERE a.issue_id = ${I}`]);
      if (r.lbl && r.lbl.split('|').length <= 4 && r.lbl.split('|').every((x) => x.length >= 3)) opts.push(['which labels does it have', r.lbl.split('|'), `SELECT l.title FROM label_links ll JOIN labels l ON l.id = ll.label_id WHERE ll.target_type = 'issue' AND ll.target_id = ${I}`]);
      if (r.user_notes_count >= 2) opts.push(['how many comments does it have', [String(r.user_notes_count)], `SELECT count(*) FROM notes WHERE noteable_type = 'issue' AND noteable_id = ${I} AND system = 0`]);
      if (!opts.length) continue;
      const [what, ref, sql] = rand.pick(opts);
      out.push({ vars: { repo: r.full_path, title: r.title, what, What: what[0].toUpperCase() + what.slice(1) }, start: '/' + r.full_path,
        eval: { type: 'answer', answer: { must_include: ref }, answer_sql: sql } });
      per.set(r.full_path, k + 1);
    }
    return out;
  },
};

const mostCommented = {
  id: 'gen-code-issue-most-comments', kind: 'read', skills: ['filter-sort', 'compare'], difficulty: 3, cap: 60,
  phrasings: [
    'Which {state} issue in {repo} labeled "{label}" has the most comments?',
    'Among the {state} issues of {repo} with the label "{label}", which one is the most discussed (most comments)?',
    'In {repo}, look at the {state} "{label}" issues. Which has the highest number of comments? Give its title.',
  ],
  generate({ db }) {
    const out = [];
    for (const s of labelStats(db)) {
      for (const state of ['open', 'closed']) {
        const sql = `SELECT trim(i.title) t, i.iid, i.user_notes_count c FROM issues i WHERE i.project_id = ${pid(s.full_path)} AND ${STATE[state]} AND ${HAS_LABEL(s.full_path, s.title)} ORDER BY i.user_notes_count DESC, i.id`;
        const rows = db.prepare(sql).all();
        if (rows.length < 3 || rows.length > 40 || rows[0].c === 0 || rows[0].c === rows[1].c) continue;
        out.push({ vars: { repo: s.full_path, label: s.title, state }, start: '/' + s.full_path + '/-/issues',
          eval: { type: 'answer', answer: { must_include: [`${rows[0].t} |OR| #${rows[0].iid}`] }, answer_sql: sql.replace('SELECT trim(i.title) t, i.iid, i.user_notes_count c', "SELECT trim(i.title) || ' |OR| #' || i.iid") + ' LIMIT 1' },
          difficulty: rows.length > 20 ? 3 : 2 });
      }
    }
    return out;
  },
};

const milestoneProgress = {
  id: 'gen-code-milestone-progress', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 2, cap: 60,
  phrasings: [
    'How many issues in the milestone "{ms}" of {repo} are {state}?',
    'Open the milestone "{ms}" in the {repo} project. How many of its issues are {state}?',
    'For milestone "{ms}" in {repo}, count the {state} issues.',
  ],
  generate({ db, rand }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, m.id, m.title, sum(i.state = 'opened') o, sum(i.state = 'closed') c, count(*) n,
        (SELECT count(*) FROM milestones m2 WHERE m2.project_id = m.project_id AND m2.title = m.title) dup
      FROM milestones m JOIN projects p ON p.id = m.project_id JOIN issues i ON i.milestone_id = m.id
      WHERE p.visibility = 'public' GROUP BY m.id HAVING n >= 3 ORDER BY m.id`).all();
    for (const r of rows) {
      if (r.dup > 1) continue;
      const opts = [];
      if (r.o >= 1 && r.c >= 1) opts.push(['open', r.o, "'opened'"], ['closed', r.c, "'closed'"]);
      else opts.push(r.o ? ['open', r.o, "'opened'"] : ['closed', r.c, "'closed'"]);
      for (const [state, n, st] of opts) {
        if (opts.length > 1 && rand.next() < 0.4) continue;
        out.push({ vars: { repo: r.full_path, ms: r.title, state }, start: '/' + r.full_path + '/-/milestones',
          eval: { type: 'answer', answer: { must_include: [String(n)] }, answer_sql: `SELECT count(*) FROM issues i WHERE i.milestone_id = (SELECT id FROM milestones WHERE project_id = ${pid(r.full_path)} AND title = ${q(r.title)}) AND i.state = ${st}` } });
      }
    }
    return out;
  },
};

module.exports = [issueFilterCount, issueDetail, mostCommented, milestoneProgress];
module.exports.HAS_LABEL = HAS_LABEL;
module.exports.labelStats = labelStats;
