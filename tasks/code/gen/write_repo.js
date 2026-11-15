'use strict';
// Write templates: repository (branches, tags, web-editor edits, new files, branch + edit + MR).
const { q, pid, uid } = require('./lib');
const { actor } = require('./write_issues');

const REF = (fp, kind, name) => `(SELECT sha FROM refs WHERE project_id = ${pid(fp)} AND kind = '${kind}' AND name = ${q(name)})`;
const RF = (fp, branch, path) => `(SELECT content FROM repo_files WHERE project_id = ${pid(fp)} AND branch = ${q(branch)} AND path = ${q(path)})`;
// file content normalised: no CR, no trailing newlines
const NORM = (x) => `rtrim(replace(${x}, char(13), ''), char(10))`;
const normJs = (s) => s.replace(/\r/g, '').replace(/\n+$/, '');

const writableProjects = (db, policyFull = false) => db.prepare(`SELECT p.* FROM projects p WHERE p.archived = 0 AND p.default_branch IS NOT NULL AND p.visibility IN ('public','private')
  ${policyFull ? "AND p.objects_policy = 'full'" : ''} ORDER BY p.id`).all();
const head = (db, p, b) => db.prepare(`SELECT sha FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?`).pluck().get(p.id, b || p.default_branch);

const branchFromTag = {
  id: 'gen-code-branch-from-tag', kind: 'write', skills: ['create', 'navigate'], difficulty: 2, cap: 60,
  phrasings: [
    'Create a new branch named "{branch}" in {repo} starting from the tag {tag}.',
    'In the {repo} repository, branch off the tag "{tag}" into a new branch called "{branch}".',
    'I need a branch "{branch}" in {repo} that points at the same commit as tag {tag}. Create it.',
  ],
  generate({ db, rand }) {
    const out = [];
    for (const p of writableProjects(db)) {
      const login = actor(db, p, 30);
      if (!login) continue;
      const tags = db.prepare(`SELECT r.name, r.sha FROM refs r WHERE r.project_id = ? AND r.kind = 'tag' AND length(r.name) <= 30 AND r.sha != (SELECT sha FROM refs WHERE project_id = r.project_id AND kind = 'branch' AND name = ?) ORDER BY r.name`).all(p.id, p.default_branch);
      for (const t of rand.sample(tags, 1)) {
        const branch = rand.pick(['hotfix', 'maint', 'backport', 'support', 'patch']) + '-' + t.name.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
        if (db.prepare(`SELECT 1 FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?`).get(p.id, branch)) continue;
        out.push({ vars: { repo: p.full_path, tag: t.name, branch }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT (${REF(p.full_path, 'branch', branch)} = ${q(t.sha)}) AS ok`, state_expect: 1 } });
      }
    }
    return out;
  },
};

const createTag = {
  id: 'gen-code-create-tag', kind: 'write', skills: ['create', 'form-edit'], difficulty: 2, cap: 60,
  phrasings: [
    'Create a tag "{tag}" on the latest commit of the {branch} branch in {repo}, with the message "{msg}".',
    'Tag the head of branch {branch} in {repo} as {tag} (annotated, message: "{msg}").',
    'In {repo}, add the tag {tag} pointing at the current tip of "{branch}" and use "{msg}" as its message.',
  ],
  generate({ db, rand }) {
    const out = [];
    for (const p of writableProjects(db)) {
      const login = actor(db, p, 30);
      if (!login) continue;
      const branches = db.prepare(`SELECT name, sha FROM refs WHERE project_id = ? AND kind = 'branch' AND length(name) <= 30 AND name NOT LIKE 'github/%' AND name NOT LIKE 'dependabot/%' ORDER BY name`).all(p.id);
      for (const b of rand.sample(branches, 1)) {
        const tag = `v${1 + rand.int(9)}.${rand.int(20)}.${rand.int(10)}-${rand.pick(['rc1', 'beta', 'sandbox', 'review', 'snapshot'])}`;
        if (db.prepare(`SELECT 1 FROM refs WHERE project_id = ? AND kind = 'tag' AND name = ?`).get(p.id, tag)) continue;
        const msg = rand.pick(['Release candidate', 'Snapshot before refactoring', 'Checkpoint for review', 'Pre-release build', 'Milestone build']) + ` ${tag}`;
        out.push({ vars: { repo: p.full_path, branch: b.name, tag, msg }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT (r.sha = ${q(b.sha)} AND instr(lower(coalesce(r.tag_message, '')), lower(${q(msg)})) > 0) AS ok FROM refs r WHERE r.project_id = ${pid(p.full_path)} AND r.kind = 'tag' AND r.name = ${q(tag)}`, state_expect: 1 } });
      }
    }
    return out;
  },
};

const editFile = {
  id: 'gen-code-edit-file-replace', kind: 'write', skills: ['form-edit', 'navigate'], difficulty: 2, cap: 80,
  phrasings: [
    'In {repo}, edit {path} on the {branch} branch: replace "{old}" with "{new}" (only that change) and commit it directly to {branch}.',
    'Use the web editor to change "{old}" to "{new}" in the file {path} of {repo} ({branch} branch). Commit the change to {branch}.',
    'Fix {path} in the {repo} repository: the text "{old}" should read "{new}". Commit straight to the {branch} branch.',
  ],
  generate({ db, git, rand }) {
    const out = [];
    for (const p of writableProjects(db, true)) {
      const login = actor(db, p, 40);
      if (!login) continue;
      const h = head(db, p);
      if (!h) continue;
      const files = git.files(h, 1).filter((f) => /(^|\/)(README|CONTRIBUTING|CHANGELOG|LICENSE|AUTHORS)[^/]*$|\.(md|txt|rst|html|yml|yaml|cfg|toml)$/i.test(f.path) && f.mode !== '120000');
      let made = 0;
      for (const f of rand.shuffle(files)) {
        if (made >= 2) break;
        const s = git.text(h, f.path);
        if (!s || s.length > 6000 || s.length < 80 || /\r/.test(s)) continue;
        let old; let neu;
        const yl = s.split('\n').find((l) => /(copyright|\(c\))/i.test(l) && /\b(19|20)\d\d\b/.test(l));
        if (/LICEN[CS]E/i.test(f.path) && yl) {
          if (s.split(yl).length !== 2) continue;
          old = yl.trim();
          neu = old.replace(/\b(19|20)\d\d\b(?!.*\b(19|20)\d\d\b)/, '2023');
          if (old === neu || old.length > 100) continue;
        } else {
          // a phrase of 2-4 words that occurs exactly once
          const words = s.match(/[A-Za-z][A-Za-z']{3,}(?: [A-Za-z][A-Za-z']{2,}){1,3}/g) || [];
          const cands = words.filter((w) => w.length >= 10 && w.length <= 40 && s.split(w).length === 2 && s.toLowerCase().split(w.toLowerCase()).length === 2);
          if (!cands.length) continue;
          old = rand.pick(cands);
          const ws = old.split(' ');
          const rep = rand.pick(['updated', 'revised', 'improved', 'current', 'new']);
          neu = ws.length > 2 ? [ws[0], rep, ...ws.slice(1)].join(' ') : `${old} (${rep})`;
          if (s.includes(neu)) continue;
        }
        const want = normJs(s.replace(old, neu));
        if (want.split(neu).length !== 2) continue;
        const C = RF(p.full_path, p.default_branch, f.path);
        out.push({ vars: { repo: p.full_path, path: f.path, branch: p.default_branch, old, new: neu }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT (${C} IS NOT NULL AND ${NORM(C)} = ${q(want)}) AS ok`, state_expect: 1 } });
        made++;
      }
    }
    return out;
  },
};

const NEW_FILES = [
  ['.nvmrc', () => '18'], ['.editorconfig', () => 'root = true\n\n[*]\nindent_style = space\nindent_size = 2'],
  ['CODEOWNERS', (u) => `* @${u}`], ['docs/MAINTAINERS.md', (u) => `# Maintainers\n\n- @${u}`],
  ['SECURITY.md', () => '# Security Policy\n\nPlease report vulnerabilities by opening a confidential issue.'],
  ['.gitattributes', () => '* text=auto eol=lf'], ['VERSION', (u, r) => `${1 + r.int(4)}.${r.int(10)}.${r.int(10)}`],
  ['docs/ROADMAP.md', () => '# Roadmap\n\n- Improve documentation\n- Add more tests'], ['.github/FUNDING.yml', (u) => `github: ${u}`],
];
const createFile = {
  id: 'gen-code-create-file', kind: 'write', skills: ['create', 'form-edit'], difficulty: 2, cap: 70,
  phrasings: [
    'Add a new file {path} to the {branch} branch of {repo} with exactly this content:\n{content}\nUse the commit message "{msg}".',
    'In {repo}, create the file {path} on branch {branch}. Its content must be:\n{content}\nCommit message: "{msg}".',
    'Create {path} in the {repo} repository (branch {branch}) containing the following, and commit it as "{msg}":\n{content}',
  ],
  generate({ db, git, rand }) {
    const out = [];
    for (const p of writableProjects(db, true)) {
      const login = actor(db, p, 40);
      if (!login) continue;
      const h = head(db, p);
      if (!h) continue;
      for (const [path, mk] of rand.sample(NEW_FILES, 1)) {
        if (git.entry(h, path)) continue;
        const content = mk(login, rand);
        const msg = `Add ${path}`;
        const C = RF(p.full_path, p.default_branch, path);
        out.push({ vars: { repo: p.full_path, path, branch: p.default_branch, content, msg }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: [
            `SELECT (${C} IS NOT NULL AND trim(replace(${C}, char(13), ''), char(10) || ' ') = ${q(content)}) AS ok`,
            `SELECT (trim(c.title) = ${q(msg)}) AS ok FROM commits c WHERE c.sha = (SELECT commit_sha FROM repo_files WHERE project_id = ${pid(p.full_path)} AND branch = ${q(p.default_branch)} AND path = ${q(path)})`,
          ], state_expect: [1, 1] } });
      }
    }
    return out;
  },
};

const branchEditMr = {
  id: 'gen-code-branch-edit-mr', kind: 'write', skills: ['create', 'form-edit', 'multi-step'], difficulty: 3, cap: 50,
  phrasings: [
    'In {repo}, create a branch "{branch}" from {base}, append the line "{line}" at the end of {path} on that branch, and open a merge request from "{branch}" into {base} titled "{title}".',
    'Propose a change to {repo}: on a new branch named "{branch}" (based on {base}) add the line "{line}" to the end of {path}, then submit a merge request into {base} with the title "{title}".',
  ],
  generate({ db, git, rand }) {
    const out = [];
    const LINES = ['See CONTRIBUTING for how to get involved.', 'Questions? Open an issue in this project.', 'This project is maintained on a best-effort basis.', 'Thanks to all contributors!'];
    for (const p of writableProjects(db, true)) {
      const login = actor(db, p, 30);
      if (!login || !p.merge_requests_enabled) continue;
      const h = head(db, p);
      if (!h) continue;
      const commit = git.commit(h);
      const root = commit && commit.has_tree ? git.tree(commit.tree_sha) || [] : [];
      const rd = root.find((e) => /^readme(\.md|\.markdown|\.txt|\.rst)?$/i.test(e.name) && e.type === 'blob');
      if (!rd) continue;
      const s = git.text(h, rd.name);
      if (!s || /\r/.test(s) || s.length > 20000) continue;
      const line = rand.pick(LINES);
      if (s.includes(line)) continue;
      const branch = rand.pick(['docs', 'readme', 'update']) + '-' + rand.pick(['note', 'footer', 'contact', 'thanks']) + '-' + (100 + rand.int(900));
      const title = rand.pick(['Add a note to the README', 'README: add a closing line', 'Docs: extend the README']);
      const C = RF(p.full_path, branch, rd.name);
      out.push({ vars: { repo: p.full_path, branch, base: p.default_branch, line, path: rd.name, title }, login, start: '/' + p.full_path,
        eval: { type: 'state', state_sql: [
          `SELECT (${C} IS NOT NULL AND substr(${NORM(C)}, -${line.length}) = ${q(line)} AND instr(${C}, ${q(normJs(s).slice(-Math.min(60, normJs(s).length)))}) > 0) AS ok`,
          `SELECT count(*) FROM merge_requests m WHERE m.project_id = ${pid(p.full_path)} AND m.source_project_id = m.project_id AND m.source_branch = ${q(branch)} AND m.target_branch = ${q(p.default_branch)} AND m.state = 'opened' AND lower(trim(CASE WHEN m.title LIKE 'Draft:%' THEN substr(m.title, 7) ELSE m.title END)) = lower(${q(title)})`,
        ], state_expect: [1, 1] } });
    }
    return out;
  },
};

const deleteMergedBranch = {
  id: 'gen-code-delete-merged-branch', kind: 'write', skills: ['navigate', 'multi-step'], difficulty: 2, cap: 50,
  phrasings: [
    'Merge request !{iid} in {repo} has been merged. Delete its source branch, which is still in the repository.',
    'Clean up {repo}: the source branch of the merged merge request "{title}" is no longer needed. Delete that branch.',
    'In the {repo} project, delete the leftover source branch of the already merged MR !{iid}.',
  ],
  generate({ db }) {
    const out = [];
    for (const p of writableProjects(db)) {
      const login = actor(db, p, 40);
      if (!login) continue;
      const rows = db.prepare(`SELECT m.iid, trim(m.title) title, m.source_branch, m.merged_at FROM merge_requests m WHERE m.project_id = ? AND m.state = 'merged' AND m.source_project_id = m.project_id
        AND m.source_branch != ? AND EXISTS (SELECT 1 FROM refs r WHERE r.project_id = m.project_id AND r.kind = 'branch' AND r.name = m.source_branch)
        AND NOT EXISTS (SELECT 1 FROM merge_requests o WHERE o.source_project_id = m.project_id AND o.source_branch = m.source_branch AND o.state IN ('opened','locked')) ORDER BY m.iid DESC`).all(p.id, p.default_branch);
      const nb = db.prepare(`SELECT count(*) FROM refs WHERE project_id = ? AND kind = 'branch'`).pluck().get(p.id);
      const seen = new Set();
      for (const r of rows) {
        if (seen.size >= 4) break;
        if (seen.has(r.source_branch) || /"/.test(r.title) || r.title.length > 90) continue;
        seen.add(r.source_branch);
        if (rows.filter((x) => x.source_branch === r.source_branch).length > 1) continue; // one MR per branch
        if (db.prepare('SELECT 1 FROM protected_branches WHERE project_id = ? AND name = ?').get(p.id, r.source_branch)) continue;
        out.push({ vars: { repo: p.full_path, iid: String(r.iid), title: r.title }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: [
            `SELECT count(*) FROM refs WHERE project_id = ${pid(p.full_path)} AND kind = 'branch' AND name = ${q(r.source_branch)}`,
            `SELECT count(*) FROM refs WHERE project_id = ${pid(p.full_path)} AND kind = 'branch'`,
          ], state_expect: [0, nb - 1] } });
      }
    }
    return out;
  },
};

module.exports = [branchFromTag, createTag, editFile, createFile, branchEditMr, deleteMergedBranch];
