'use strict';
// View-model helpers for repository pages (tree, README, permissions, URLs, blame).
const Diff = require('diff');
const kit = require('../../../../kit');
const code = require('../../lib/code');
const git = require('./git');

const enc = code.encPath;
const treeUrl = (p, ref, path) => `/${p.full_path}/-/tree/${enc(ref)}${path ? '/' + enc(path) : ''}`;
const blobUrl = (p, ref, path) => `/${p.full_path}/-/blob/${enc(ref)}/${enc(path)}`;
const rawUrl = (p, ref, path) => `/${p.full_path}/-/raw/${enc(ref)}/${enc(path)}`;
const commitsUrl = (p, ref, path) => `/${p.full_path}/-/commits/${enc(ref)}${path ? '/' + enc(path) : ''}`;
const commitUrl = (p, sha) => `/${p.full_path}/-/commit/${sha}`;

// protected_branches names may be wildcards (release/*)
function isProtected(projectId, branch) {
  for (const r of kit.sql('SELECT name FROM protected_branches WHERE project_id = ?').all(projectId)) {
    if (r.name === branch) return true;
    if (r.name.includes('*') && new RegExp('^' + r.name.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(branch)) return true;
  }
  return false;
}
// May `user` commit to `ref` (a branch; null = a new branch)?
function canPush(user, p, ref) {
  if (!user) return false;
  const access = p.access != null ? p.access : code.accessLevel(user, p);
  if (p.archived) return false;
  if (!ref) return access >= code.ACCESS.DEVELOPER;
  if (ref.kind && ref.kind !== 'branch') return false;
  return access >= (isProtected(p.id, ref.name) ? code.ACCESS.MAINTAINER : code.ACCESS.DEVELOPER);
}
function suggestBranch(req, p, ref) {
  if (ref && ref.kind === 'branch' && canPush(req.user, p, ref)) return ref.name;
  const base = `${req.user ? req.user.username : 'user'}-${ref && ref.kind === 'branch' ? ref.name : 'main'}-patch-`;
  let n = 1;
  while (n < 1000 && git.getRef(p.id, 'branch', base + n)) n++;
  return base + n;
}
// Branch + tag names for the ref switcher (capped).
function refOptions(p) {
  return {
    branches: kit.sql("SELECT name FROM refs WHERE project_id = ? AND kind = 'branch' ORDER BY name = ? DESC, name LIMIT 200").pluck().all(p.id, p.default_branch || ''),
    tags: kit.sql("SELECT name FROM refs WHERE project_id = ? AND kind = 'tag' ORDER BY name DESC LIMIT 100").pluck().all(p.id),
  };
}
const refCounts = (p) => kit.sql("SELECT sum(kind = 'branch') AS branches, sum(kind = 'tag') AS tags FROM refs WHERE project_id = ? AND kind IN ('branch', 'tag')").get(p.id);

const TRUNCATED_MSG = 'History truncated: the file contents of this commit are not stored in this sandbox (only the newest commits of this large repository keep their files). Commit metadata and statistics are complete.';
function truncatedView(p, ref, path) {
  return { truncated: true, truncatedMsg: TRUNCATED_MSG, ref: ref.name, refInfo: ref, path: path || '', entries: [], lastCommits: {}, last: ref.commit, readme: null, refs: refOptions(p), counts: refCounts(p) };
}

const lastCache = new git.LRU(4000);
function lastCommitsCached(p, ref, dir, names) {
  const key = `${ref.sha}|${ref.kind === 'branch' ? ref.name : ''}|${dir}`;
  let v = lastCache.get(key);
  if (!v) {
    const raw = git.lastCommitsForDir(p, ref, dir, names, 1500);
    v = {};
    for (const [k, c] of Object.entries(raw)) v[k] = { sha: c.sha, title: c.title, committed_at: c.committed_at, author_name: c.author_name };
    lastCache.set(key, v, names.length + 1);
  }
  return v;
}
const README_RE = /^readme(\.(md|markdown|mdown|mkd|txt|rst|adoc|org))?$/i;

// Tree page model: {entries, lastCommits, last, readme, ...} | {redirect} | throws 404.
function treeView(req, p, ref, path) {
  path = (path || '').replace(/\/+$/, '');
  const c = ref.commit;
  if (!c || !c.has_tree) return truncatedView(p, ref, path);
  const e = git.entryAt(c.tree_sha, path);
  if (!e) throw kit.httpError(404, 'Path not found');
  if (e.missing) return truncatedView(p, ref, path);
  if (e.type !== 'tree') return { redirect: blobUrl(p, ref.name, path) };
  const entries = git.listDir(e.sha) || [];
  const lastCommits = entries.length <= 400 ? lastCommitsCached(p, ref, path, entries.map((x) => x.name)) : {};
  const last = git.lastCommitFor(p, ref, path) || c;
  let readme = null;
  const rm = entries.filter((x) => x.type === 'blob' && README_RE.test(x.name)).sort((a, b) => (/\.(md|markdown)$/i.test(b.name) ? 1 : 0) - (/\.(md|markdown)$/i.test(a.name) ? 1 : 0))[0];
  if (rm) {
    const b = git.readBlob(rm.sha);
    const rpath = (path ? path + '/' : '') + rm.name;
    if (b.text != null) readme = { name: rm.name, path: rpath, html: /\.(md|markdown|mdown|mkd)$/i.test(rm.name) || !/\./.test(rm.name) ? code.md(b.text, { project: p, ref: ref.name, dir: path }) : `<pre>${kit.escapeHtml(b.text)}</pre>` };
    else readme = { name: rm.name, path: rpath, html: '<p class="muted">The README is too large to be displayed.</p>' };
  }
  return { ref: ref.name, refInfo: ref, path, entries, lastCommits, last, readme, refs: refOptions(p), counts: refCounts(p), canPush: canPush(req.user, p, ref), canCommitNew: canPush(req.user, p, null) };
}

// subsequence match for "Go to file"
function fuzzy(s, q) {
  if (s.includes(q)) return true;
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

// Blame from the stored history of the file (newest 60 versions; older lines are
// attributed to the oldest stored version).
function blame(p, ref, path) {
  const c = ref.commit;
  if (!c.has_tree) return { truncated: true, msg: TRUNCATED_MSG };
  const e = git.entryAt(c.tree_sha, path);
  if (!e || e.type === 'tree') return { notFound: true };
  if (e.missing) return { truncated: true, msg: TRUNCATED_MSG };
  const head = git.readBlob(e.sha);
  if (head.text == null) return { binary: true };
  if (head.text.length > 300 * 1024) return { tooLarge: true };
  const hist = git.history(p, ref, { path, limit: 60, maxScan: 20000 });
  if (!hist.length || hist[0].sha !== c.sha) hist.unshift(c);
  // versions newest -> oldest; stop at the first one without the file
  const versions = [];
  let prevSha = null;
  for (const h of hist) {
    if (!h.has_tree) break;
    const he = git.entryAt(h.tree_sha, path);
    if (!he || he.missing || he.type !== 'blob') break;
    if (he.sha === prevSha) { versions[versions.length - 1].commit = h; continue; }
    const b = git.readBlob(he.sha);
    if (b.text == null) break;
    versions.push({ commit: h, text: b.text });
    prevSha = he.sha;
  }
  versions.reverse();
  let lines = null;
  for (const v of versions) {
    const vl = v.text.split('\n');
    if (vl.length && vl[vl.length - 1] === '') vl.pop();
    if (!lines) { lines = vl.map(() => v.commit); lines.textCache = vl; continue; }
    const prevText = lines.textCache;
    const out = [];
    let i = 0;
    for (const part of Diff.diffArrays(prevText || [], vl)) {
      const n = part.value.length;
      if (part.removed) { i += n; continue; }
      for (let k = 0; k < n; k++) out.push(part.added ? v.commit : lines[i + k]);
      if (!part.added) i += n;
    }
    lines = out;
    lines.textCache = vl;
  }
  const hl = git.highlightLines(e.sha, head.text, path);
  const groups = [];
  (lines || []).forEach((cm, i) => {
    const g = groups[groups.length - 1];
    if (g && g.commit.sha === cm.sha) g.lines.push(i);
    else groups.push({ commit: cm, lines: [i] });
  });
  return { groups, hl, partial: versions.length >= 60 };
}

module.exports = { treeUrl, blobUrl, rawUrl, commitsUrl, commitUrl, isProtected, canPush, suggestBranch, refOptions, refCounts, truncatedView, treeView, fuzzy, blame, TRUNCATED_MSG };
