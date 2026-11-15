'use strict';
// Read templates: commit history (by path, author, date) and commit details.
const { q, pid } = require('./lib');

const fullProjects = (db) => db.prepare(`SELECT * FROM projects WHERE visibility = 'public' AND archived = 0 AND default_branch IS NOT NULL AND objects_policy = 'full' AND commit_count BETWEEN 5 AND 5000 ORDER BY id`).all();
const DEF = (fp) => `(SELECT default_branch FROM projects WHERE id = ${pid(fp)})`;
const BORING = /^(initial commit|first commit|init|initial|update readme(\.md)?|create readme(\.md)?|add files via upload|update|wip)$/i;
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (d) => `${months[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`;

// path filter as repo/lib/git.js pathFilterSql (file or directory), on the default branch, merges skipped
const PATH_HIST = (fp, path) => `FROM branch_commits b JOIN commits c ON c.id = b.commit_id WHERE b.project_id = ${pid(fp)} AND b.branch = ${DEF(fp)}
  AND instr(c.parents, ' ') = 0 AND EXISTS (SELECT 1 FROM commit_files f WHERE f.commit_id = c.id AND (f.path_id = (SELECT id FROM paths WHERE path = ${q(path)})
  OR f.path_id IN (SELECT id FROM paths WHERE path >= ${q(path + '/')} AND path < ${q(path + '0')})))`;

const pathHistory = {
  id: 'gen-code-path-history', kind: 'read', skills: ['navigate', 'filter-sort', 'aggregate'], difficulty: 2, cap: 80,
  phrasings: [
    'In {repo} (default branch), {what} {path}?',
    'Look at the history of {path} in the {repo} repository. {What} it?',
    'For the {repo} project, {what} the path {path} on the default branch?',
  ],
  generate({ db, git, rand }) {
    const out = [];
    for (const p of fullProjects(db)) {
      const headSha = db.prepare(`SELECT sha FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?`).pluck().get(p.id, p.default_branch);
      // candidate paths: files/dirs changed by >= 2 commits on the default branch
      const rows = db.prepare(`SELECT pa.path, count(DISTINCT c.id) n FROM branch_commits b JOIN commits c ON c.id = b.commit_id JOIN commit_files f ON f.commit_id = c.id JOIN paths pa ON pa.id = f.path_id
        WHERE b.project_id = ? AND b.branch = ? AND instr(c.parents, ' ') = 0 GROUP BY pa.path HAVING n BETWEEN 2 AND 60 ORDER BY pa.path`).all(p.id, p.default_branch);
      let made = 0;
      for (const r of rand.shuffle(rows)) {
        if (made >= 2) break;
        if (r.path.length > 60 || !/[A-Za-z]/.test(r.path)) continue;
        if (!headSha || !git.entry(headSha, r.path)) continue; // must still exist (browsable from the file tree)
        const base = PATH_HIST(p.full_path, r.path);
        const hist = db.prepare(`SELECT c.author_name, c.title, b.pos ${base} ORDER BY b.pos`).all();
        if (hist.length < 2) continue;
        const v = rand.int(3);
        if (v === 0) {
          out.push({ vars: { repo: p.full_path, path: r.path, what: 'how many commits have changed', What: 'How many commits have changed' }, start: '/' + p.full_path,
            eval: { type: 'answer', answer: { must_include: [String(hist.length)] }, answer_sql: `SELECT count(*) ${base}` } });
        } else if (v === 1) {
          if (!hist[0].author_name || hist[0].author_name.length < 3) continue;
          out.push({ vars: { repo: p.full_path, path: r.path, what: 'who authored the most recent commit that changed', What: 'Who authored the most recent commit that changed' }, start: '/' + p.full_path,
            eval: { type: 'answer', answer: { must_include: [hist[0].author_name] }, answer_sql: `SELECT c.author_name ${base} ORDER BY b.pos LIMIT 1` } });
        } else {
          const first = hist[hist.length - 1];
          if (BORING.test(first.title.trim()) || first.title.length < 10 || first.title.length > 90 || hist.filter((h) => h.title === first.title).length > 1) continue;
          out.push({ vars: { repo: p.full_path, path: r.path, what: 'what is the title of the oldest commit that touched', What: 'What is the title of the oldest commit that touched' }, start: '/' + p.full_path,
            eval: { type: 'answer', answer: { must_include: [first.title.trim()] }, answer_sql: `SELECT trim(c.title) ${base} ORDER BY b.pos DESC LIMIT 1` }, difficulty: 3 });
        }
        made++;
      }
    }
    return out;
  },
};

const authorFirstCommit = {
  id: 'gen-code-author-commit', kind: 'read', skills: ['filter-sort', 'read-detail'], difficulty: 2, cap: 70,
  phrasings: [
    'What is the title of the {which} commit {author} made to the {repo} repository (default branch)?',
    'In {repo}, filter the commit history by the author {author}. What is the title of their {which} commit?',
    'Find {author}\'s {which} commit on the default branch of {repo} and tell me its title.',
  ],
  generate({ db, rand }) {
    const out = [];
    for (const p of fullProjects(db)) {
      const authors = db.prepare(`SELECT c.author_name a, count(*) n FROM branch_commits b JOIN commits c ON c.id = b.commit_id WHERE b.project_id = ? AND b.branch = ?
        GROUP BY 1 HAVING n BETWEEN 3 AND 200 ORDER BY 1`).all(p.id, p.default_branch);
      let made = 0;
      for (const au of rand.shuffle(authors)) {
        if (made >= 2) break;
        if (!au.a || au.a.length < 5 || !/ /.test(au.a) || /bot\]?$/i.test(au.a)) continue;
        // the site's author filter is a substring of name or e-mail: the filtered list must be this author's commits only
        const lk = q('%' + au.a + '%');
        const filtered = db.prepare(`SELECT c.author_name, c.title, b.pos FROM branch_commits b JOIN commits c ON c.id = b.commit_id WHERE b.project_id = ? AND b.branch = ?
          AND (c.author_name LIKE ${lk} OR c.author_email LIKE ${lk}) ORDER BY b.pos`).all(p.id, p.default_branch);
        if (filtered.some((c) => c.author_name !== au.a)) continue;
        const which = rand.pick(['first', 'latest']);
        const c = which === 'first' ? filtered[filtered.length - 1] : filtered[0];
        if (BORING.test(c.title.trim()) || c.title.length < 10 || c.title.length > 90 || filtered.filter((x) => x.title === c.title).length > 1) continue;
        out.push({ vars: { repo: p.full_path, author: au.a, which: which === 'first' ? 'first (oldest)' : 'most recent' }, start: '/' + p.full_path,
          eval: { type: 'answer', answer: { must_include: [c.title.trim()] },
            answer_sql: `SELECT trim(c.title) FROM branch_commits b JOIN commits c ON c.id = b.commit_id WHERE b.project_id = ${pid(p.full_path)} AND b.branch = ${DEF(p.full_path)} AND (c.author_name LIKE ${lk} OR c.author_email LIKE ${lk}) ORDER BY b.pos ${which === 'first' ? 'DESC' : ''} LIMIT 1` } });
        made++;
      }
    }
    return out;
  },
};

const commitOnDate = {
  id: 'gen-code-commit-on-date', kind: 'read', skills: ['navigate', 'filter-sort', 'read-detail'], difficulty: 2, cap: 60,
  phrasings: [
    'Exactly one commit was made to the default branch of {repo} on {date} (UTC). Who authored it and what is its title?',
    'In the commit history of {repo}, find the single commit from {date}. Tell me its author and title.',
    'Who committed to {repo}\'s default branch on {date}, and what was the commit about (its title)?',
  ],
  generate({ db, rand }) {
    const out = [];
    for (const p of fullProjects(db)) {
      const days = db.prepare(`SELECT substr(c.committed_at, 1, 10) d, count(*) n, min(c.title) t, min(c.author_name) a FROM branch_commits b JOIN commits c ON c.id = b.commit_id
        WHERE b.project_id = ? AND b.branch = ? GROUP BY 1 HAVING n = 1 ORDER BY 1`).all(p.id, p.default_branch);
      let made = 0;
      for (const d of rand.shuffle(days)) {
        if (made >= 1) break;
        if (!d.a || d.a.length < 3 || d.t.length < 10 || d.t.length > 90 || /^Merge /.test(d.t)) continue;
        const base = `FROM branch_commits b JOIN commits c ON c.id = b.commit_id WHERE b.project_id = ${pid(p.full_path)} AND b.branch = ${DEF(p.full_path)} AND substr(c.committed_at, 1, 10) = ${q(d.d)}`;
        out.push({ vars: { repo: p.full_path, date: longDate(d.d) }, start: '/' + p.full_path,
          eval: { type: 'answer', answer: { must_include: [d.a, d.t.trim()] }, answer_sql: `SELECT x FROM (SELECT c.author_name x, 0 o ${base} UNION ALL SELECT trim(c.title), 1 ${base}) ORDER BY o` } });
        made++;
      }
    }
    return out;
  },
};

const commitStats = {
  id: 'gen-code-commit-stats', kind: 'read', skills: ['search', 'read-detail'], difficulty: 2, cap: 70,
  phrasings: [
    'In {repo}, how many lines were {what} by the commit titled "{title}"?',
    'Find the commit "{title}" in the {repo} repository. How many lines does it {verb}?',
    'The {repo} project has a commit called "{title}". Report its number of {noun} lines.',
  ],
  generate({ db, rand }) {
    const out = [];
    for (const p of fullProjects(db)) {
      const rows = db.prepare(`SELECT c.sha, trim(c.title) title, c.additions, c.deletions, c.files_changed FROM branch_commits b JOIN commits c ON c.id = b.commit_id
        WHERE b.project_id = ? AND b.branch = ? AND instr(c.parents, ' ') = 0 AND c.additions > 0 AND c.deletions > 0 AND c.additions != c.deletions
        AND length(c.title) BETWEEN 15 AND 80 AND c.title NOT LIKE 'Merge %'
        AND (SELECT count(*) FROM branch_commits b2 JOIN commits c2 ON c2.id = b2.commit_id WHERE b2.project_id = b.project_id AND b2.branch = b.branch AND trim(c2.title) = trim(c.title)) = 1
        ORDER BY b.pos LIMIT 400`).all(p.id, p.default_branch);
      for (const r of rand.sample(rows, 1)) {
        if (/"/.test(r.title)) continue;
        const add = rand.int(2) === 0;
        out.push({ vars: { repo: p.full_path, title: r.title, what: add ? 'added' : 'deleted', verb: add ? 'add' : 'delete', noun: add ? 'added' : 'deleted' }, start: '/' + p.full_path,
          eval: { type: 'answer', answer: { must_include: [String(add ? r.additions : r.deletions)] }, answer_sql: `SELECT c.${add ? 'additions' : 'deletions'} FROM commits c WHERE c.sha = ${q(r.sha)}` } });
      }
    }
    return out;
  },
};

module.exports = [pathHistory, authorFirstCommit, commitStats];
