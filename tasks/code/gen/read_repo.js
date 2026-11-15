'use strict';
// Read templates: repository facts (branches, tags, files, README, package.json, contributors, members).
const { q, pid, uid, ROLE } = require('./lib');

const STALE_CUTOFF = '2023-01-27 16:00:00'; // site "now" (2023-04-27 16:00 UTC) - 90 days
const BRANCH_HEAD = (fp, b) => `(SELECT sha FROM refs WHERE project_id = ${pid(fp)} AND kind = 'branch' AND name = ${q(b)})`;

// file-content references come from the blobs (zlib, not readable in SQL): the answer_sql returns
// the reference while the branch head is still the commit it was computed from (else no row = drift)
const HEAD_GUARD = (fp, b, sha, ref) => `SELECT ${q(ref)} FROM refs WHERE project_id = ${pid(fp)} AND kind = 'branch' AND name = ${q(b)} AND sha = ${q(sha)}`;
const readable = (db) => db.prepare(`SELECT * FROM projects WHERE visibility IN ('public','internal') AND archived = 0 AND default_branch IS NOT NULL ORDER BY id`).all();
const plainName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const defaultBranchHead = {
  id: 'gen-code-default-branch-head', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1, cap: 60,
  phrasings: [
    'What is the default branch of the {repo} repository, and who authored the most recent commit on it?',
    'In {repo}, which branch is the default one? Also tell me the author of its latest commit.',
    'Tell me the default branch of {repo} and the name of the person who made the newest commit there.',
  ],
  generate({ db }) {
    const out = [];
    for (const p of readable(db)) {
      const c = db.prepare(`SELECT c.author_name FROM refs r JOIN commits c ON c.sha = r.sha WHERE r.project_id = ? AND r.kind = 'branch' AND r.name = ?`).get(p.id, p.default_branch);
      if (!c || !c.author_name || c.author_name.length < 3) continue;
      out.push({ vars: { repo: p.full_path }, start: '',
        eval: { type: 'answer', answer: { must_include: [p.default_branch, c.author_name] },
          answer_sql: `SELECT x FROM (SELECT default_branch AS x, 0 AS o FROM projects WHERE id = ${pid(p.full_path)} UNION ALL SELECT c.author_name, 1 FROM commits c WHERE c.sha = ${BRANCH_HEAD(p.full_path, p.default_branch)}) ORDER BY o` } });
    }
    return out;
  },
};

const branchLatestCommit = {
  id: 'gen-code-branch-latest-commit', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2, cap: 70,
  phrasings: [
    'What is the title of the latest commit on the "{branch}" branch of {repo}?',
    'In the {repo} project, open the branch "{branch}". What is the message title of its most recent commit?',
    'Check the "{branch}" branch in {repo}: what does the newest commit there say (its title)?',
  ],
  generate({ db }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, p.default_branch, r.name, c.title, c.author_name FROM refs r JOIN projects p ON p.id = r.project_id JOIN commits c ON c.sha = r.sha
      WHERE r.kind = 'branch' AND p.visibility IN ('public','internal') AND p.archived = 0 AND r.name != p.default_branch AND length(r.name) <= 40
      AND length(c.title) BETWEEN 12 AND 90 ORDER BY p.id, r.name`).all();
    const perProject = new Map();
    for (const r of rows) {
      const k = (perProject.get(r.full_path) || 0);
      if (k >= 4) continue; // spread over projects
      if (/^Merge /.test(r.title)) continue;
      perProject.set(r.full_path, k + 1);
      out.push({ vars: { repo: r.full_path, branch: r.name }, start: '/' + r.full_path,
        eval: { type: 'answer', answer: { must_include: [r.title.trim()] }, answer_sql: `SELECT trim(title) FROM commits WHERE sha = ${BRANCH_HEAD(r.full_path, r.name)}` } });
    }
    return out;
  },
};

const fileLine = {
  id: 'gen-code-file-line', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2, cap: 70,
  phrasings: [
    'What is written on line {n} of the file {path} in the {repo} repository (default branch)?',
    'Open {path} in {repo} on its default branch. What does line {n} contain?',
    'In {repo}, look at the file {path}. Quote line number {n}.',
  ],
  generate({ db, git, rand }) {
    const out = [];
    for (const p of readable(db)) {
      if (p.objects_policy !== 'full') continue;
      const head = db.prepare(`SELECT sha FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?`).pluck().get(p.id, p.default_branch);
      if (!head) continue;
      const files = git.files(head, 1).filter((f) => f.mode !== '120000' && !/\.(md|markdown|mdown|mkd|min\.js|map|svg|json|lock|csv|txt)$/i.test(f.path) && !/LICEN[CS]E|COPYING/i.test(f.path));
      let made = 0;
      for (const f of rand.shuffle(files)) {
        if (made >= 2) break;
        const s = git.text(head, f.path);
        if (!s || s.length > 60000) continue;
        const ls = s.split('\n');
        if (ls.length < 12 || ls.length > 600) continue;
        const cands = [];
        for (let i = 4; i < Math.min(ls.length, 200); i++) {
          const t = ls[i].trim();
          if (t.length < 20 || t.length > 90 || /[\t]/.test(ls[i]) || /^[#/*;\s-]*$/.test(t) || !/[a-z]{3}/i.test(t)) continue;
          if (ls.filter((x) => x.trim() === t).length !== 1) continue;
          if (ls.filter((x) => x.includes(t)).length !== 1) continue;
          cands.push(i);
        }
        if (!cands.length) continue;
        const i = rand.pick(cands);
        const line = ls[i].trim().replace(/[,;]+$/, '').trim();
        out.push({ vars: { repo: p.full_path, path: f.path, n: String(i + 1) }, start: '/' + p.full_path,
          eval: { type: 'answer', answer: { must_include: [line] }, answer_sql: HEAD_GUARD(p.full_path, p.default_branch, head, line) } });
        made++;
      }
    }
    return out;
  },
};

// strip simple markdown from a heading
const mdText = (h) => h.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/<[^>]+>/g, '').replace(/\s+#+\s*$/, '').trim();

const readmeHeading = {
  id: 'gen-code-readme-heading', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1, cap: 50,
  phrasings: [
    'What is the {which} in the README of {repo}?',
    'Open the README of the {repo} project. What does its {which} say?',
    'Tell me the {which} of {repo}\'s README file.',
  ],
  generate({ db, git }) {
    const out = [];
    for (const p of readable(db)) {
      const head = db.prepare(`SELECT sha FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?`).pluck().get(p.id, p.default_branch);
      if (!head) continue;
      const commit = git.commit(head);
      if (!commit || !commit.has_tree) continue;
      const root = git.tree(commit.tree_sha) || [];
      const rd = root.find((e) => /^readme\.(md|markdown)$/i.test(e.name));
      if (!rd) continue;
      const s = git.text(head, rd.name);
      if (!s) continue;
      const lines = s.replace(/\r/g, '').split('\n');
      let inCode = false;
      const h2 = [];
      for (const l of lines) {
        if (/^```/.test(l)) inCode = !inCode;
        if (!inCode && /^##\s+\S/.test(l)) h2.push(mdText(l.replace(/^##\s+/, '')));
      }
      const first = h2[0];
      if (!first || first.length < 5 || first.length > 60 || /[<>[\]]/.test(first)) continue;
      if (h2.filter((x) => x === first).length > 1) continue;
      out.push({ vars: { repo: p.full_path, which: 'first section heading (the first "##" heading)' }, start: '/' + p.full_path,
        eval: { type: 'answer', answer: { must_include: [first] }, answer_sql: HEAD_GUARD(p.full_path, p.default_branch, head, first) } });
      // last section heading too
      const last = h2[h2.length - 1];
      if (h2.length >= 3 && last && last.length >= 5 && last.length <= 60 && !/[<>[\]]/.test(last) && h2.filter((x) => x === last).length === 1) {
        out.push({ vars: { repo: p.full_path, which: 'last section heading (the last "##" heading)' }, start: '/' + p.full_path,
          eval: { type: 'answer', answer: { must_include: [last] }, answer_sql: HEAD_GUARD(p.full_path, p.default_branch, head, last) } });
      }
    }
    return out;
  },
};

const packageField = {
  id: 'gen-code-package-json', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2, cap: 60,
  phrasings: [
    'According to the package.json of {repo} (default branch), {what}?',
    'Open package.json in the {repo} repository. {What}?',
    'Check {repo}\'s package.json: {what}?',
  ],
  generate({ db, git }) {
    const out = [];
    for (const p of readable(db)) {
      const head = db.prepare(`SELECT sha FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?`).pluck().get(p.id, p.default_branch);
      if (!head) continue;
      const s = git.text(head, 'package.json');
      if (!s) continue;
      let j; try { j = JSON.parse(s); } catch { continue; }
      const add = (what, val) => {
        if (typeof val !== 'string' || val.length < 2 || val.length > 60) return;
        out.push({ vars: { repo: p.full_path, what, What: what[0].toUpperCase() + what.slice(1) }, start: '/' + p.full_path, eval: { type: 'answer', answer: { must_include: [val] }, answer_sql: HEAD_GUARD(p.full_path, p.default_branch, head, val) } });
      };
      if (j.version && j.version !== '0.0.0') add('what version number does the package have', j.version);
      if (typeof j.license === 'string' && p.full_path !== 'x') add('which license is declared', j.license);
      if (typeof j.main === 'string') add('what is the "main" entry point file', j.main);
      for (const sec of ['dependencies', 'devDependencies']) {
        const deps = Object.entries(j[sec] || {}).filter(([, v]) => typeof v === 'string' && /\d/.test(v));
        for (const [dep, v] of deps.slice(0, 40).filter((_, i) => i % 7 === 3).slice(0, 2)) add(`which version (range) of the ${sec === 'dependencies' ? 'dependency' : 'dev dependency'} "${dep}" is required`, v);
      }
    }
    return out;
  },
};

const refCount = {
  id: 'gen-code-ref-count', kind: 'read', skills: ['navigate', 'aggregate'], difficulty: 2, cap: 70,
  phrasings: [
    'How many {what} does the {repo} repository have?',
    'Count the {what} in {repo}.',
    'In the {repo} project, how many {what} are there?',
  ],
  generate({ db }) {
    const out = [];
    for (const p of readable(db)) {
      const br = db.prepare(`SELECT r.name, c.committed_at FROM refs r LEFT JOIN commits c ON c.sha = r.sha WHERE r.project_id = ? AND r.kind = 'branch'`).all(p.id);
      const tags = db.prepare(`SELECT count(*) FROM refs WHERE project_id = ? AND kind = 'tag'`).pluck().get(p.id);
      const nearCut = br.some((b) => b.committed_at && Math.abs(Date.parse(b.committed_at + 'Z') - Date.parse(STALE_CUTOFF + 'Z')) < 3 * 86400e3);
      const stale = br.filter((b) => (b.committed_at || '') < STALE_CUTOFF).length;
      const base = `FROM refs r LEFT JOIN commits c ON c.sha = r.sha WHERE r.project_id = ${pid(p.full_path)} AND r.kind = 'branch'`;
      if (br.length >= 3) out.push({ vars: { repo: p.full_path, what: 'branches' }, start: '/' + p.full_path, eval: { type: 'answer', answer: { must_include: [String(br.length)] }, answer_sql: `SELECT count(*) ${base}` }, difficulty: 1 });
      if (tags >= 3) out.push({ vars: { repo: p.full_path, what: 'tags' }, start: '/' + p.full_path, eval: { type: 'answer', answer: { must_include: [String(tags)] }, answer_sql: `SELECT count(*) FROM refs WHERE project_id = ${pid(p.full_path)} AND kind = 'tag'` }, difficulty: 1 });
      if (!nearCut && br.length >= 3 && stale >= 1 && stale < br.length) {
        out.push({ vars: { repo: p.full_path, what: 'stale branches (no commits in the last 90 days)' }, start: '/' + p.full_path, eval: { type: 'answer', answer: { must_include: [String(stale)] }, answer_sql: `SELECT count(*) ${base} AND coalesce(c.committed_at, '') < '${STALE_CUTOFF}'` } });
        out.push({ vars: { repo: p.full_path, what: 'active branches (with commits in the last 90 days)' }, start: '/' + p.full_path, eval: { type: 'answer', answer: { must_include: [String(br.length - stale)] }, answer_sql: `SELECT count(*) ${base} AND coalesce(c.committed_at, '') >= '${STALE_CUTOFF}'` } });
      }
    }
    return out;
  },
};

const tagCommit = {
  id: 'gen-code-tag-commit', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2, cap: 60,
  phrasings: [
    'Which commit does the tag "{tag}" of {repo} point to? Give the commit title.',
    'In {repo}, find the tag {tag}. What is the title of the commit it was created on?',
    'What is the commit message title of the commit tagged "{tag}" in the {repo} project?',
  ],
  generate({ db }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, r.name, c.title, (SELECT count(*) FROM refs r2 WHERE r2.project_id = r.project_id AND r2.kind = 'tag') nt
      FROM refs r JOIN projects p ON p.id = r.project_id JOIN commits c ON c.sha = r.sha
      WHERE r.kind = 'tag' AND p.visibility = 'public' AND length(c.title) BETWEEN 12 AND 90 ORDER BY p.id, r.name`).all();
    const per = new Map();
    for (const r of rows) {
      if (r.nt < 3) continue;
      const k = per.get(r.full_path) || 0;
      if (k >= 3) continue;
      // the title must not just repeat the tag name
      if (r.title.toLowerCase().includes(r.name.toLowerCase().replace(/^v/, ''))) continue;
      per.set(r.full_path, k + 1);
      out.push({ vars: { repo: r.full_path, tag: r.name }, start: '/' + r.full_path,
        eval: { type: 'answer', answer: { must_include: [r.title.trim()] }, answer_sql: `SELECT trim(c.title) FROM refs r JOIN commits c ON c.sha = r.sha WHERE r.project_id = ${pid(r.full_path)} AND r.kind = 'tag' AND r.name = ${q(r.name)}` } });
    }
    return out;
  },
};

const contributorStats = {
  id: 'gen-code-contributor-lines', kind: 'read', skills: ['navigate', 'compare', 'aggregate'], difficulty: 2, cap: 60,
  phrasings: [
    'On the contributors page of {repo} for the branch {branch}, {what}?',
    'Look at the contributor statistics of {repo} ({branch} branch). {What}?',
    'For the {branch} branch of {repo}, {what} according to the contributors chart?',
  ],
  generate({ db }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, c.branch, (c.branch = p.default_branch) isdef, count(*) n FROM contributors c JOIN projects p ON p.id = c.project_id
      WHERE p.visibility = 'public' AND p.archived = 0 AND length(c.branch) <= 30 GROUP BY 1, 2 HAVING n >= 3 ORDER BY 1, 2`).all();
    const per = new Map();
    for (const r of rows) {
      const k = per.get(r.full_path) || 0;
      if (k >= 2 || (!r.isdef && k >= 1)) continue;
      const cs = db.prepare(`SELECT author_name, additions, deletions, commits FROM contributors WHERE project_id = ${pid(r.full_path)} AND branch = ?`).all(r.branch);
      const base = `FROM contributors WHERE project_id = ${pid(r.full_path)} AND branch = ${q(r.branch)}`;
      const names = new Set(cs.map((c) => c.author_name.toLowerCase()));
      if (names.size !== cs.length) continue;
      let made = false;
      for (const [col, what] of [['additions', 'which contributor added the most lines'], ['deletions', 'which contributor deleted the most lines']]) {
        const s = cs.slice().sort((a, b) => b[col] - a[col]);
        if (s[0][col] === s[1][col] || s[0][col] === 0) continue;
        // must differ from the top committer, else it is just "top contributor"
        const topC = cs.slice().sort((a, b) => b.commits - a.commits)[0];
        if (topC.author_name === s[0].author_name) continue;
        out.push({ vars: { repo: r.full_path, branch: r.branch, what, What: what[0].toUpperCase() + what.slice(1) }, start: '/' + r.full_path,
          eval: { type: 'answer', answer: { must_include: [s[0].author_name] }, answer_sql: `SELECT author_name ${base} ORDER BY ${col} DESC LIMIT 1` } });
        made = true;
      }
      if (cs.length <= 80) {
        out.push({ vars: { repo: r.full_path, branch: r.branch, what: 'how many different contributors are listed', What: 'How many different contributors are listed' }, start: '/' + r.full_path,
          eval: { type: 'answer', answer: { must_include: [String(cs.length)] }, answer_sql: `SELECT count(*) ${base}` } });
        made = true;
      }
      if (made) per.set(r.full_path, k + 1);
    }
    return out;
  },
};

const memberRole = {
  id: 'gen-code-member-role', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1, cap: 40,
  phrasings: [
    'What role does {user} have in the {repo} project?',
    'Check the members of {repo}. Which role (Guest, Reporter, Developer, Maintainer or Owner) is {user} given?',
    'In {repo}, what is the access level of the member {user}?',
  ],
  generate({ db }) {
    const out = [];
    const rows = db.prepare(`SELECT p.full_path, u.username, u.name, m.access_level FROM members m JOIN projects p ON p.id = m.source_id JOIN users u ON u.id = m.user_id
      JOIN namespaces n ON n.id = p.namespace_id
      WHERE m.source_type = 'project' AND m.requested_at IS NULL AND u.state = 'active' AND NOT (n.kind = 'user' AND n.owner_id = u.id) AND m.access_level IN (10,20,30,40,50)
      AND (p.visibility = 'public' OR p.id IN (SELECT source_id FROM members WHERE source_type = 'project' AND user_id = ${uid('byteblaze')}))
      ORDER BY p.id, u.id`).all();
    for (const r of rows) {
      out.push({ vars: { repo: r.full_path, user: `${r.name} (@${r.username})` }, start: '/' + r.full_path,
        eval: { type: 'answer', answer: { must_include: [ROLE[r.access_level]] },
          answer_sql: `SELECT CASE m.access_level WHEN 10 THEN 'Guest' WHEN 20 THEN 'Reporter' WHEN 30 THEN 'Developer' WHEN 40 THEN 'Maintainer' WHEN 50 THEN 'Owner' END FROM members m WHERE m.source_type = 'project' AND m.source_id = ${pid(r.full_path)} AND m.user_id = ${uid(r.username)} AND m.requested_at IS NULL` } });
    }
    return out;
  },
};

module.exports = [defaultBranchHead, branchLatestCommit, fileLine, readmeHeading, packageField, refCount, tagCommit, contributorStats];
module.exports.STALE_CUTOFF = STALE_CUTOFF;
