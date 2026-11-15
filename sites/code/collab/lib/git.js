'use strict';
// Git on SQLite for the collaboration side (SCHEMA.md "Git" / "Web edits"): read objects and
// trees, write blobs/trees/commits with real git ids, merge-base and `rev-list A ^B`, tree diffs,
// 3-way tree merges (entry level), and branch updates that keep refs / project_commits /
// branch_commits / commit_count / contributors in step. Everything runs on the tenant connection.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const kit = require('../../../../kit');

class GitUnavailable extends Error {}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const objectId = (type, body) => sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));

function readObject(sha) {
  const o = kit.sql('SELECT sha, type, size, enc, omitted, binary, data FROM git_objects WHERE sha = ?').get(sha);
  if (!o) return null;
  if (o.omitted || o.data == null) return { ...o, body: null };
  const body = o.enc === 1 ? zlib.inflateSync(o.data) : Buffer.from(o.data);
  return { ...o, body };
}
let DRY = false; // mergeability checks compute ids without writing objects
function writeObject(type, body) {
  body = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const sha = objectId(type, body);
  if (DRY) { if (type === 'tree') treeCache.set(sha, parseTree(body)); return sha; }
  if (!kit.sql('SELECT 1 FROM git_objects WHERE sha = ?').get(sha)) {
    const big = body.length > 256;
    const data = big ? zlib.deflateSync(body) : body;
    const binary = type === 'blob' && body.subarray(0, 8000).includes(0) ? 1 : 0;
    kit.sql('INSERT INTO git_objects (sha, type, size, enc, omitted, binary, data) VALUES (?, ?, ?, ?, 0, ?, ?)').run(sha, type, body.length, big ? 1 : 0, binary, data);
  }
  return sha;
}

function parseTree(body) {
  const out = []; let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i); const nul = body.indexOf(0, sp);
    const mode = body.toString('latin1', i, sp);
    const name = body.toString('utf8', sp + 1, nul);
    const sha = body.toString('hex', nul + 1, nul + 21);
    out.push({ mode, name, sha, type: mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob' });
    i = nul + 21;
  }
  return out;
}
const treeCache = new Map();
function readTree(sha) {
  if (treeCache.has(sha)) return treeCache.get(sha);
  const o = readObject(sha);
  if (!o || o.type !== 'tree' || !o.body) throw new GitUnavailable(`tree ${sha} is not stored`);
  const t = parseTree(o.body);
  if (treeCache.size > 5000) treeCache.clear();
  treeCache.set(sha, t);
  return t;
}
const sortKey = (e) => (e.mode === '40000' ? e.name + '/' : e.name);
function writeTree(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(sortKey(a)), Buffer.from(sortKey(b))));
  const parts = [];
  for (const e of sorted) parts.push(Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.sha, 'hex'));
  return writeObject('tree', Buffer.concat(parts));
}
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function getCommit(sha) {
  return kit.sql('SELECT id, sha, tree_sha, parents, committed_at, author_name, author_email, title, has_tree FROM commits WHERE sha = ?').get(sha) || null;
}
const parentsOf = (c) => (c && c.parents ? c.parents.split(' ').filter(Boolean) : []);

function tzString(min) { const s = min < 0 ? '-' : '+'; const a = Math.abs(min); return `${s}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`; }

// Write a commit object + commits row (+ commit_files vs the first parent when trees allow).
function writeCommit({ tree, parents = [], author, committer, message, at }) {
  at = at || kit.nowSql();
  committer = committer || author;
  const unix = Math.floor(new Date(at.replace(' ', 'T') + 'Z').getTime() / 1000);
  const msg = message.endsWith('\n') ? message : message + '\n';
  const body = Buffer.from(`tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${author.name} <${author.email}> ${unix} ${tzString(0)}\ncommitter ${committer.name} <${committer.email}> ${unix} ${tzString(0)}\n\n${msg}`);
  const id = objectId('commit', body);
  const existing = kit.sql('SELECT id FROM commits WHERE sha = ?').pluck().get(id);
  if (existing) return { sha: id, id: existing };
  // stats vs first parent
  let files = []; let adds = 0, dels = 0;
  try {
    const p0 = parents[0] ? getCommit(parents[0]) : null;
    files = diffTrees(p0 ? p0.tree_sha : EMPTY_TREE, tree);
    for (const f of files) { const s = lineStats(f); f.additions = s.additions; f.deletions = s.deletions; adds += s.additions || 0; dels += s.deletions || 0; }
  } catch (e) { if (!(e instanceof GitUnavailable)) throw e; }
  const title = msg.split('\n')[0];
  const r = kit.sql(`INSERT INTO commits (sha, tree_sha, parents, author_name, author_email, authored_at, author_tz, committer_name, committer_email, committed_at, committer_tz,
      title, message, additions, deletions, files_changed, has_tree) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1)`)
    .run(id, tree, parents.join(' '), author.name, author.email, at, committer.name, committer.email, at, title, msg, adds, dels, files.length);
  const cid = Number(r.lastInsertRowid);
  files.slice(0, 100).forEach((f, ord) => {
    kit.sql('INSERT INTO commit_files (commit_id, ord, path_id, old_path_id, change, additions, deletions) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cid, ord, pathId(f.path), null, f.change, f.additions ?? null, f.deletions ?? null);
  });
  return { sha: id, id: cid };
}
function pathId(p) {
  const id = kit.sql('SELECT id FROM paths WHERE path = ?').pluck().get(p);
  if (id) return id;
  return Number(kit.sql('INSERT INTO paths (path) VALUES (?)').run(p).lastInsertRowid);
}

// ---------------------------------------------------------------- history walks
// Commits reachable from `a` but not from `b` (like `git rev-list a ^b`), newest first, and the
// merge base(s). Paint algorithm ordered by committer date. limit bounds the walk.
function revList(a, b, { limit = 20000 } = {}) {
  const A = 1, B = 2;
  const flags = new Map(); const info = new Map();
  const queue = [];
  const push = (sha, f) => {
    const old = flags.get(sha) || 0;
    if ((old | f) === old) return;
    flags.set(sha, old | f);
    let c = info.get(sha);
    if (c === undefined) { c = getCommit(sha); info.set(sha, c); }
    if (!c) return;
    queue.push(sha);
  };
  if (a) push(a, A);
  if (b) push(b, B);
  const only = []; const bases = []; let steps = 0; let truncated = false;
  const stale = () => queue.every((s) => flags.get(s) === (A | B) || flags.get(s) === B);
  while (queue.length) {
    if (++steps > limit) { truncated = true; break; }
    // pop newest
    let bi = 0;
    for (let i = 1; i < queue.length; i++) if ((info.get(queue[i]).committed_at || '') > (info.get(queue[bi]).committed_at || '')) bi = i;
    const sha = queue.splice(bi, 1)[0];
    const f = flags.get(sha); const c = info.get(sha);
    if (f === (A | B)) { if (!bases.length || !bases.some((x) => x === sha)) bases.push(sha); }
    for (const p of parentsOf(c)) push(p, f === (A | B) ? (A | B) : f);
    if (f === A) only.push(c);
    if (bases.length && stale()) break;
  }
  // commits first seen as A-only but later painted A|B are not exclusive
  const exclusive = only.filter((c) => flags.get(c.sha) === A);
  return { only: exclusive, base: bases[0] || null, truncated };
}
const mergeBase = (a, b) => revList(a, b).base;
const isAncestor = (anc, desc) => anc === desc || revList(anc, desc).only.length === 0;

// ---------------------------------------------------------------- tree diff / merge
// Flat list of changed files between two trees: {path, change A|M|D, oldSha, newSha, oldMode, newMode}
function diffTrees(aSha, bSha, prefix = '', out = []) {
  if (aSha === bSha) return out;
  const a = aSha && aSha !== EMPTY_TREE ? readTree(aSha) : [];
  const b = bSha && bSha !== EMPTY_TREE ? readTree(bSha) : [];
  const am = new Map(a.map((e) => [e.name, e])); const bm = new Map(b.map((e) => [e.name, e]));
  const names = [...new Set([...am.keys(), ...bm.keys()])].sort();
  for (const n of names) {
    const x = am.get(n), y = bm.get(n); const p = prefix + n;
    if (x && y && x.sha === y.sha && x.mode === y.mode) continue;
    const xt = x && x.type === 'tree', yt = y && y.type === 'tree';
    if (xt || yt) {
      if (xt && yt) { diffTrees(x.sha, y.sha, p + '/', out); continue; }
      if (xt) diffTrees(x.sha, null, p + '/', out); else if (x) out.push({ path: p, change: 'D', oldSha: x.sha, oldMode: x.mode });
      if (yt) diffTrees(null, y.sha, p + '/', out); else if (y) out.push({ path: p, change: 'A', newSha: y.sha, newMode: y.mode });
      continue;
    }
    if (x && y) out.push({ path: p, change: 'M', oldSha: x.sha, newSha: y.sha, oldMode: x.mode, newMode: y.mode });
    else if (x) out.push({ path: p, change: 'D', oldSha: x.sha, oldMode: x.mode });
    else out.push({ path: p, change: 'A', newSha: y.sha, newMode: y.mode });
  }
  return out;
}
// 3-way merge at entry level: returns { tree } or { conflicts: [paths] }
function mergeTrees(base, ours, theirs, prefix = '') {
  if (ours === theirs) return { tree: ours };
  if (base === ours) return { tree: theirs };
  if (base === theirs) return { tree: ours };
  const B = base ? readTree(base) : [], O = readTree(ours), T = readTree(theirs);
  const bm = new Map(B.map((e) => [e.name, e])), om = new Map(O.map((e) => [e.name, e])), tm = new Map(T.map((e) => [e.name, e]));
  const names = [...new Set([...bm.keys(), ...om.keys(), ...tm.keys()])];
  const result = []; const conflicts = [];
  const same = (x, y) => (!x && !y) || (x && y && x.sha === y.sha && x.mode === y.mode);
  for (const n of names) {
    const b = bm.get(n), o = om.get(n), t = tm.get(n);
    let pick;
    if (same(o, t)) pick = o;
    else if (same(b, o)) pick = t;
    else if (same(b, t)) pick = o;
    else if (o && t && o.type === 'tree' && t.type === 'tree') {
      const r = mergeTrees(b && b.type === 'tree' ? b.sha : null, o.sha, t.sha, prefix + n + '/');
      if (r.conflicts) { conflicts.push(...r.conflicts); continue; }
      pick = { mode: '40000', name: n, sha: r.tree, type: 'tree' };
    } else if (o && t && b && o.type === 'blob' && t.type === 'blob' && b.type === 'blob' && o.mode === t.mode) {
      // both sides changed a text file: apply base->theirs hunks onto ours (clean only)
      const sha = mergeBlobs(b.sha, o.sha, t.sha);
      if (!sha) { conflicts.push(prefix + n); continue; }
      pick = { mode: o.mode, name: n, sha, type: 'blob' };
    } else { conflicts.push(prefix + n); continue; }
    if (pick) result.push(pick);
  }
  if (conflicts.length) return { conflicts };
  return { tree: writeTree(result) };
}

function mergeBlobs(base, ours, theirs) {
  const B = blobText(base), O = blobText(ours), T = blobText(theirs);
  if (B == null || O == null || T == null) return null;
  Diff = Diff || codeRequire('diff');
  const patch = Diff.structuredPatch('a', 'b', B, T, '', '', { context: 3 });
  const out = Diff.applyPatch(O, patch, { fuzzFactor: 0 });
  if (out === false) return null;
  return writeObject('blob', Buffer.from(out, 'utf8'));
}

// blob sha at `path` in tree `treeSha` (null when missing / trees not stored)
function blobAt(treeSha, path) {
  let cur = treeSha;
  const parts = String(path).split('/');
  try {
    for (let i = 0; i < parts.length; i++) {
      const e = readTree(cur).find((x) => x.name === parts[i]);
      if (!e) return null;
      if (i === parts.length - 1) return e.type === 'blob' ? e.sha : null;
      if (e.type !== 'tree') return null;
      cur = e.sha;
    }
  } catch (e) { if (e instanceof GitUnavailable) return null; throw e; }
  return null;
}

// dry-run merge (no writes): { tree } or { conflicts }
function checkMerge(base, ours, theirs) {
  DRY = true;
  try { return mergeTrees(base, ours, theirs); } finally { DRY = false; }
}

// ---------------------------------------------------------------- line diffs
const codeRequire = (m) => require(require.resolve(m, { paths: [require('node:path').join(__dirname, '..', '..')] }));
let Diff = null;
const blobText = (sha) => {
  if (!sha) return '';
  const o = readObject(sha);
  if (!o) return null;
  if (!o.body) return null; // placeholder
  if (o.binary) return null;
  return o.body.toString('utf8');
};
// unified hunks (no ---/+++ header) + counts; null hunks when binary/unavailable/too large
function fileDiff(f, { maxBytes = 200000 } = {}) {
  Diff = Diff || codeRequire('diff');
  const a = f.oldSha ? blobText(f.oldSha) : '';
  const b = f.newSha ? blobText(f.newSha) : '';
  if (a == null || b == null) return { binary: true, text: null, additions: 0, deletions: 0 };
  if (a.length + b.length > maxBytes) return { tooLarge: true, text: null, ...quickCounts(a, b) };
  const p = Diff.structuredPatch('a', 'b', a, b, '', '', { context: 3 });
  let adds = 0, dels = 0; const lines = [];
  for (const h of p.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) { if (l[0] === '+') adds++; else if (l[0] === '-') dels++; if (l[0] !== '\\') lines.push(l); }
  }
  return { text: lines.join('\n'), additions: adds, deletions: dels };
}
function quickCounts(a, b) { const x = a.split('\n').length, y = b.split('\n').length; return { additions: Math.max(0, y - x), deletions: Math.max(0, x - y) }; }
function lineStats(f) { try { const d = fileDiff(f, { maxBytes: 400000 }); return { additions: d.additions, deletions: d.deletions }; } catch { return { additions: null, deletions: null }; } }

// ---------------------------------------------------------------- refs / branches
const branchHead = (projectId, name) => kit.sql("SELECT sha FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?").pluck().get(projectId, name) || null;
const branches = (projectId) => kit.sql("SELECT r.name, r.sha, c.committed_at, c.title FROM refs r LEFT JOIN commits c ON c.sha = r.sha WHERE r.project_id = ? AND r.kind = 'branch' ORDER BY c.committed_at DESC, r.name").all(projectId);

// Move branch `name` of project to `newSha` (create it if missing). Keeps project_commits,
// branch_commits (when the branch has cached rows or is the default branch), commit_count.
function updateBranch(project, name, newSha, { contributors = true } = {}) {
  const old = branchHead(project.id, name);
  if (old === newSha) return { added: [] };
  const { only } = revList(newSha, old || null, { limit: 200000 });
  // project_commits
  const ins = kit.sql('INSERT OR IGNORE INTO project_commits (project_id, commit_id) VALUES (?, ?)');
  for (const c of only) ins.run(project.id, c.id);
  if (old) kit.sql("UPDATE refs SET sha = ? WHERE project_id = ? AND kind = 'branch' AND name = ?").run(newSha, project.id, name);
  else kit.sql("INSERT INTO refs (project_id, kind, name, sha) VALUES (?, 'branch', ?, ?)").run(project.id, name, newSha);
  // branch_commits cache
  const cached = kit.sql('SELECT count(*) FROM branch_commits WHERE project_id = ? AND branch = ?').pluck().get(project.id, name);
  const isDefault = project.default_branch === name;
  if (cached || isDefault || !old) {
    const oldRows = cached ? kit.sql('SELECT bc.commit_id AS id, c.committed_at FROM branch_commits bc JOIN commits c ON c.id = bc.commit_id WHERE bc.project_id = ? AND bc.branch = ? ORDER BY bc.pos').all(project.id, name) : [];
    const fresh = [...only].sort((x, y) => (x.sha === newSha ? -1 : y.sha === newSha ? 1 : (y.committed_at || '').localeCompare(x.committed_at || '')));
    const merged = [];
    let i = 0, j = 0;
    if (fresh.length && fresh[0].sha === newSha) merged.push(fresh[i++].id);
    while (i < fresh.length || j < oldRows.length) {
      if (j >= oldRows.length || (i < fresh.length && (fresh[i].committed_at || '') >= (oldRows[j].committed_at || ''))) merged.push(fresh[i++].id);
      else merged.push(oldRows[j++].id);
    }
    kit.sql('DELETE FROM branch_commits WHERE project_id = ? AND branch = ?').run(project.id, name);
    const bi = kit.sql('INSERT INTO branch_commits (project_id, branch, pos, commit_id) VALUES (?, ?, ?, ?)');
    merged.forEach((id, pos) => bi.run(project.id, name, pos, id));
    if (isDefault) kit.sql('UPDATE projects SET commit_count = ? WHERE id = ?').run(merged.length, project.id);
  } else if (isDefault) {
    kit.sql('UPDATE projects SET commit_count = commit_count + ? WHERE id = ?').run(only.length, project.id);
  }
  kit.sql('UPDATE projects SET last_activity_at = ?, updated_at = ? WHERE id = ?').run(kit.nowSql(), kit.nowSql(), project.id);
  if (contributors) {
    // the repo side's job (same as after a web commit); ours if it is not registered
    try { kit.jobs.enqueue('repo.contributors', { project_id: project.id, branch: name }); } catch {
      try { kit.jobs.enqueue('collab.contributors', { project_id: project.id, branch: name }); } catch { recomputeContributors(project.id, name); }
    }
  }
  return { added: only, old };
}
function deleteBranch(projectId, name) {
  kit.sql("DELETE FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?").run(projectId, name);
  kit.sql('DELETE FROM branch_commits WHERE project_id = ? AND branch = ?').run(projectId, name);
  kit.sql('DELETE FROM contributors WHERE project_id = ? AND branch = ?').run(projectId, name);
}

// GitLab 15.7 contributors for a branch with cached history (SCHEMA.md "contributors").
function recomputeContributors(projectId, branch) {
  const has = kit.sql('SELECT count(*) FROM branch_commits WHERE project_id = ? AND branch = ?').pluck().get(projectId, branch);
  if (!has) return 0;
  kit.sql('DELETE FROM contributors WHERE project_id = ? AND branch = ?').run(projectId, branch);
  kit.sql(`INSERT INTO contributors (project_id, branch, author_email, author_name, commits, commits_all, additions, deletions, first_at, last_at)
    WITH nm AS (
      SELECT bc.pos, lower(c.author_email) AS em, c.author_name, c.additions, c.deletions, c.committed_at,
             row_number() OVER (ORDER BY bc.pos) AS rn
      FROM branch_commits bc JOIN commits c ON c.id = bc.commit_id
      WHERE bc.project_id = ?1 AND bc.branch = ?2 AND instr(c.parents, ' ') = 0 AND c.author_email IS NOT NULL),
    names AS (SELECT em, author_name, min(pos) FROM nm GROUP BY em)
    SELECT ?1, ?2, nm.em, names.author_name, sum(rn <= 6000), count(*), coalesce(sum(additions), 0), coalesce(sum(deletions), 0), min(committed_at), max(committed_at)
    FROM nm JOIN names ON names.em = nm.em GROUP BY nm.em`).run(projectId, branch);
  return 1;
}

module.exports = {
  GitUnavailable, sha1, objectId, readObject, writeObject, parseTree, readTree, writeTree, EMPTY_TREE,
  getCommit, parentsOf, writeCommit, pathId, revList, mergeBase, isAncestor, diffTrees, mergeTrees, checkMerge, blobAt, fileDiff, blobText,
  branchHead, branches, updateBranch, deleteBranch, recomputeContributors,
};
