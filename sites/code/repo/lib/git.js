'use strict';
// Git without git: trees, blobs, commits and refs read from the tenant DB (SCHEMA.md "Git").
// Object bodies are content-addressed (sha = sha1 of "<type> <len>\0" + body), so the
// decompressed/parsed caches below are shared by all tenants of the process safely: a sha
// always names the same content. Existence is always checked on the tenant connection.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const kit = require('../../../../kit');

// ---------------------------------------------------------------- LRU caches
class LRU {
  constructor(maxCost) { this.max = maxCost; this.cost = 0; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v === undefined) return undefined; this.m.delete(k); this.m.set(k, v); return v.v; }
  set(k, v, cost = 1) {
    if (cost > this.max / 4) return v;
    const old = this.m.get(k);
    if (old) { this.cost -= old.c; this.m.delete(k); }
    this.m.set(k, { v, c: cost }); this.cost += cost;
    while (this.cost > this.max && this.m.size) { const [k0, e] = this.m.entries().next().value; this.m.delete(k0); this.cost -= e.c; }
    return v;
  }
}
const objCache = new LRU(96 * 1024 * 1024);   // sha -> object {type,size,omitted,binary,data}
const treeCache = new LRU(200000);             // sha -> parsed entries (cost = entries)
const hlCache = new LRU(48 * 1024 * 1024);     // sha|lang -> highlighted lines

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const objectSha = (type, body) => sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));

// Returns {sha, type, size, omitted, binary, data: Buffer|null} or null when not stored.
function getObject(sha) {
  if (!sha) return null;
  const c = objCache.get(sha);
  if (c) return c;
  const r = kit.sql('SELECT type, size, enc, omitted, binary, data FROM git_objects WHERE sha = ?').get(sha);
  if (!r) return null;
  let data = r.data == null ? null : Buffer.from(r.data);
  if (data && r.enc === 1) data = zlib.inflateSync(data);
  const o = { sha, type: r.type, size: r.size, omitted: !!r.omitted, binary: !!r.binary, data };
  return objCache.set(sha, o, (data ? data.length : 0) + 100);
}

// Binary tree body -> [{mode, name, sha, type: 'tree'|'blob'|'commit'|'link'}]
function parseTree(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    const nul = buf.indexOf(0, sp);
    const mode = buf.toString('latin1', i, sp);
    const name = buf.toString('utf8', sp + 1, nul);
    const sha = buf.toString('hex', nul + 1, nul + 21);
    const type = mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : mode === '120000' ? 'link' : 'blob';
    out.push({ mode, name, sha, type });
    i = nul + 21;
  }
  return out;
}
function getTree(sha) {
  const c = treeCache.get(sha);
  if (c) return c;
  const o = getObject(sha);
  if (!o || o.type !== 'tree' || !o.data) return null;
  const e = parseTree(o.data);
  return treeCache.set(sha, e, e.length + 1);
}
// git's tree order: by name bytes, trees compared as name + '/'
const treeKey = (e) => Buffer.from(e.name + (e.mode === '40000' ? '/' : ''), 'utf8');
function serializeTree(entries) {
  const sorted = entries.slice().sort((a, b) => Buffer.compare(treeKey(a), treeKey(b)));
  return Buffer.concat(sorted.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.sha, 'hex')])));
}
// Store an object (if missing) and return its sha.
function putObject(type, body) {
  const sha = objectSha(type, body);
  if (kit.sql('SELECT 1 FROM git_objects WHERE sha = ?').get(sha)) return sha;
  const z = body.length > 256 ? zlib.deflateSync(body) : null;
  const useZ = z && z.length < body.length;
  const binary = type === 'blob' && body.subarray(0, 8000).includes(0) ? 1 : 0;
  kit.sql('INSERT INTO git_objects (sha, type, size, enc, omitted, binary, data) VALUES (?, ?, ?, ?, 0, ?, ?)').run(sha, type, body.length, useZ ? 1 : 0, binary, useZ ? z : body);
  return sha;
}

// ---------------------------------------------------------------- commits and refs
const COMMIT_COLS = 'id, sha, tree_sha, parents, author_name, author_email, authored_at, author_tz, committer_name, committer_email, committed_at, committer_tz, title, message, additions, deletions, files_changed, has_tree';
const commitBySha = (sha) => (sha ? kit.sql(`SELECT ${COMMIT_COLS} FROM commits WHERE sha = ?`).get(sha) : null);
const commitById = (id) => kit.sql(`SELECT ${COMMIT_COLS} FROM commits WHERE id = ?`).get(id);
const parentsOf = (c) => (c && c.parents ? c.parents.split(' ').filter(Boolean) : []);
const isMerge = (c) => parentsOf(c).length > 1;
const inProject = (projectId, commitId) => !!kit.sql('SELECT 1 FROM project_commits WHERE project_id = ? AND commit_id = ?').get(projectId, commitId);

// A commit of this project by full or abbreviated sha (>= 4 hex chars).
function findCommit(projectId, s) {
  s = String(s || '').toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(s)) return null;
  if (s.length === 40) { const c = commitBySha(s); return c && inProject(projectId, c.id) ? c : null; }
  const hi = s + 'g';
  const rows = kit.sql(`SELECT ${COMMIT_COLS} FROM commits WHERE sha >= ? AND sha < ? LIMIT 20`).all(s, hi);
  return rows.find((c) => inProject(projectId, c.id)) || null;
}

const branches = (projectId) => kit.sql("SELECT name, sha FROM refs WHERE project_id = ? AND kind = 'branch' ORDER BY name").all(projectId);
const tags = (projectId) => kit.sql("SELECT * FROM refs WHERE project_id = ? AND kind = 'tag' ORDER BY name").all(projectId);
const getRef = (projectId, kind, name) => kit.sql('SELECT * FROM refs WHERE project_id = ? AND kind = ? AND name = ?').get(projectId, kind, name);

// Resolve "<ref>" (branch, tag or sha) -> {name, kind, sha, commit} or null.
function resolveRef(project, ref) {
  if (ref == null || ref === '') ref = project.default_branch;
  if (ref == null) return null;
  ref = String(ref).replace(/^refs\/(heads|tags)\//, '');
  const b = getRef(project.id, 'branch', ref) || getRef(project.id, 'tag', ref);
  if (b) return { name: ref, kind: b.kind, sha: b.sha, commit: commitBySha(b.sha) };
  const c = findCommit(project.id, ref);
  if (c) return { name: ref, kind: 'commit', sha: c.sha, commit: c };
  return null;
}

// Split "<ref>/<path>" where the ref may contain slashes: the longest prefix that is a branch
// or tag wins (as GitLab), else the first segment as a commit sha.
function splitRefPath(project, rest) {
  const parts = String(rest || '').split('/').filter((x, i, a) => x !== '' || i < a.length - 1);
  if (!parts.length) return null;
  const cands = [];
  for (let i = parts.length; i >= 1; i--) cands.push(parts.slice(0, i).join('/'));
  const rows = kit.db().prepare(`SELECT kind, name, sha FROM refs WHERE project_id = ? AND kind IN ('branch', 'tag') AND name IN (${cands.map(() => '?').join(',')})`).all(project.id, ...cands);
  if (rows.length) {
    rows.sort((a, b) => b.name.length - a.name.length || (a.kind === 'branch' ? -1 : 1));
    const r = rows[0];
    const n = r.name.split('/').length;
    return { ref: { name: r.name, kind: r.kind, sha: r.sha, commit: commitBySha(r.sha) }, path: parts.slice(n).join('/') };
  }
  const c = findCommit(project.id, parts[0]);
  if (c) return { ref: { name: parts[0], kind: 'commit', sha: c.sha, commit: c }, path: parts.slice(1).join('/') };
  return null;
}

// Tree entry at `path` under root tree (path '' = root): {mode,name,sha,type} | null.
// Returns {missing: true} when a tree on the way is not stored.
function entryAt(rootTree, path) {
  let cur = { mode: '40000', name: '', sha: rootTree, type: 'tree' };
  if (!path) return cur;
  for (const seg of path.split('/').filter(Boolean)) {
    if (cur.type !== 'tree') return null;
    const t = getTree(cur.sha);
    if (!t) return { missing: true };
    const e = t.find((x) => x.name === seg);
    if (!e) return null;
    cur = e;
  }
  return cur;
}
// Directory listing: trees first, then files, each by name (as GitLab).
function listDir(treeSha) {
  const t = getTree(treeSha);
  if (!t) return null;
  return t.slice().sort((a, b) => ((a.type === 'tree') === (b.type === 'tree') ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === 'tree' ? -1 : 1));
}
// All file paths of a tree (for "Go to file"), capped.
function allPaths(treeSha, cap = 20000) {
  const out = [];
  const walk = (sha, pre) => {
    const t = getTree(sha);
    if (!t) return;
    for (const e of t) {
      if (out.length >= cap) return;
      if (e.type === 'tree') walk(e.sha, pre + e.name + '/');
      else out.push(pre + e.name);
    }
  };
  walk(treeSha, '');
  return out;
}

// ---------------------------------------------------------------- history
const hasBranchRows = (projectId, branch) => !!kit.sql('SELECT 1 FROM branch_commits WHERE project_id = ? AND branch = ? LIMIT 1').get(projectId, branch);
const likeEsc = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);

// Ids of `path` (a file) or of every file under it (a directory), or null for "no path filter".
function pathFilterSql(path) {
  if (!path) return null;
  const p = path.replace(/\/+$/, '');
  return { sql: `(f.path_id = (SELECT id FROM paths WHERE path = ?) OR f.path_id IN (SELECT id FROM paths WHERE path >= ? AND path < ?))`, params: [p, p + '/', p + '0'] };
}

// History of a ref: [{commit row}], newest first. opts: offset, limit, author (substring of
// name or email, like `git log --author`), path (file or directory; merges skipped like
// git's default history simplification), before/after (committed date bounds, 'YYYY-MM-DD').
function history(project, ref, opts = {}) {
  const { offset = 0, limit = 40 } = opts;
  const pf = pathFilterSql(opts.path);
  if (ref.kind === 'branch' && hasBranchRows(project.id, ref.name)) {
    const where = [];
    const params = [project.id, ref.name];
    if (opts.author) { where.push("(c.author_name LIKE ? ESCAPE '\\' OR c.author_email LIKE ? ESCAPE '\\')"); params.push(`%${likeEsc(opts.author)}%`, `%${likeEsc(opts.author)}%`); }
    if (opts.since) { where.push('c.committed_at >= ?'); params.push(opts.since); }
    if (opts.until) { where.push('c.committed_at < ?'); params.push(opts.until); }
    if (pf) { where.push(`instr(c.parents, ' ') = 0 AND EXISTS (SELECT 1 FROM commit_files f WHERE f.commit_id = c.id AND ${pf.sql})`); params.push(...pf.params); }
    return kit.db().prepare(`SELECT c.id, c.sha, c.tree_sha, c.parents, c.author_name, c.author_email, c.authored_at, c.committer_name, c.committer_email, c.committed_at,
        c.title, c.message, c.additions, c.deletions, c.files_changed, c.has_tree
      FROM branch_commits b JOIN commits c ON c.id = b.commit_id WHERE b.project_id = ? AND b.branch = ?${where.length ? ' AND ' + where.join(' AND ') : ''}
      ORDER BY b.pos LIMIT ? OFFSET ?`).all(...params, limit, offset);
  }
  // walk parents from the ref's commit (date-ordered, like git log)
  const out = [];
  let skipped = 0;
  const auth = opts.author ? String(opts.author).toLowerCase() : null;
  const pathStmt = pf ? kit.db().prepare(`SELECT 1 FROM commit_files f WHERE f.commit_id = ? AND ${pf.sql} LIMIT 1`) : null;
  for (const c of walk(ref.sha, { max: opts.maxScan || 30000 })) {
    if (auth && !((c.author_name || '').toLowerCase().includes(auth) || (c.author_email || '').toLowerCase().includes(auth))) continue;
    if (opts.since && c.committed_at < opts.since) continue;
    if (opts.until && c.committed_at >= opts.until) continue;
    if (pathStmt && (isMerge(c) || !pathStmt.get(c.id, ...pf.params))) continue;
    if (skipped < offset) { skipped++; continue; }
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

// Generator over commits reachable from `sha`, newest committed first.
function* walk(sha, { max = 30000, stopAt = null } = {}) {
  const seen = new Set();
  const heap = [];
  const push = (c) => { heap.push(c); heap.sort((a, b) => (a.committed_at < b.committed_at ? -1 : a.committed_at > b.committed_at ? 1 : a.id - b.id)); };
  const first = commitBySha(sha);
  if (!first) return;
  seen.add(sha);
  push(first);
  let n = 0;
  while (heap.length && n < max) {
    const c = heap.pop();
    n++;
    if (stopAt && stopAt.has(c.sha)) continue;
    yield c;
    for (const p of parentsOf(c)) {
      if (seen.has(p)) continue;
      seen.add(p);
      const pc = commitBySha(p);
      if (pc) push(pc);
    }
  }
}

// Commit count of a ref (fast for branches with rows; walks otherwise, capped).
function countCommits(project, ref, cap = 100000) {
  if (ref.kind === 'branch' && hasBranchRows(project.id, ref.name)) return kit.sql('SELECT count(*) FROM branch_commits WHERE project_id = ? AND branch = ?').pluck().get(project.id, ref.name);
  let n = 0;
  for (const _ of walk(ref.sha, { max: cap })) n++; // eslint-disable-line no-unused-vars
  return n;
}

// Newest commit touching `path` at ref (for the file/tree header), or null.
function lastCommitFor(project, ref, path) {
  if (!path) return ref.commit;
  return history(project, ref, { path, limit: 1, maxScan: 5000 })[0] || null;
}

// Last commit of each entry of directory `dir` (scans the newest `scan` commits' file lists).
function lastCommitsForDir(project, ref, dir, names, scan = 600) {
  const want = new Set(names);
  const out = {};
  const pre = dir ? dir.replace(/\/+$/, '') + '/' : '';
  const files = kit.db().prepare('SELECT p.path FROM commit_files f JOIN paths p ON p.id = f.path_id WHERE f.commit_id = ?');
  const rows = history(project, ref, { limit: scan, maxScan: scan });
  for (const c of rows) {
    if (!want.size) break;
    if (isMerge(c)) continue;
    for (const { path } of files.all(c.id)) {
      if (!path.startsWith(pre)) continue;
      const name = path.slice(pre.length).split('/')[0];
      if (want.has(name)) { out[name] = c; want.delete(name); }
    }
  }
  return out;
}

// ---------------------------------------------------------------- file content
const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', go: 'go', rs: 'rust', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', m: 'objectivec', mm: 'objectivec', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', bat: 'dos',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', scss: 'scss', less: 'less', sass: 'scss', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  sql: 'sql', lua: 'lua', pl: 'perl', pm: 'perl', r: 'r', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', clj: 'clojure', groovy: 'groovy', gradle: 'groovy',
  tex: 'latex', diff: 'diff', patch: 'diff', proto: 'protobuf', capnp: 'capnproto', cmake: 'cmake', mk: 'makefile', vim: 'vim', coffee: 'coffeescript', graphql: 'graphql', tf: 'ini',
  properties: 'properties', dockerfile: 'dockerfile', nix: 'nix', jl: 'julia', ml: 'ocaml', fs: 'fsharp', rst: 'plaintext', txt: 'plaintext', erb: 'erb', haml: 'haml', liquid: 'xml', njk: 'xml', hbs: 'handlebars',
};
const LANG_BY_NAME = { makefile: 'makefile', dockerfile: 'dockerfile', gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby', vagrantfile: 'ruby', 'cmakelists.txt': 'cmake', '.bashrc': 'bash', '.zshrc': 'bash', '.vimrc': 'vim', '.gitconfig': 'ini', '.editorconfig': 'ini' };
function languageOf(filename) {
  const base = String(filename || '').split('/').pop().toLowerCase();
  if (LANG_BY_NAME[base]) return LANG_BY_NAME[base];
  const m = /\.([a-z0-9]+)$/.exec(base);
  return m ? LANG_BY_EXT[m[1]] || null : null;
}
let hljs = null;
// Highlighted lines (HTML strings, one per line) for a blob; plain escaped lines when the
// language is unknown or the file is big.
function highlightLines(sha, text, filename) {
  const lang = languageOf(filename);
  const key = `${sha}|${lang}`;
  const c = hlCache.get(key);
  if (c) return c;
  let html = null;
  if (lang && lang !== 'plaintext' && text.length <= 400 * 1024) {
    hljs = hljs || require('highlight.js');
    if (hljs.getLanguage(lang)) {
      try { html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch (e) { html = null; }
    }
  }
  const lines = html == null ? kit.escapeHtml(text).split('\n') : splitHtmlLines(html);
  if (lines.length > 1 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  return hlCache.set(key, lines, lines.reduce((n, l) => n + l.length + 16, 0));
}
// Split highlighted HTML into lines, closing/reopening spans that cross line breaks.
function splitHtmlLines(html) {
  const out = [];
  const stack = [];
  let cur = '';
  const re = /<span[^>]*>|<\/span>|\n|[^<\n]+|</g;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    if (t === '\n') { out.push(cur + '</span>'.repeat(stack.length)); cur = stack.join(''); }
    else if (t.startsWith('<span')) { stack.push(t); cur += t; }
    else if (t === '</span>') { stack.pop(); cur += t; }
    else cur += t;
  }
  out.push(cur + '</span>'.repeat(stack.length));
  return out;
}

// Blob as {text, binary, omitted, size, sha} (text decoded as UTF-8 when not binary).
function readBlob(sha) {
  const o = getObject(sha);
  if (!o) return { missing: true, sha };
  if (o.omitted || !o.data) return { omitted: true, size: o.size, sha, binary: o.binary };
  if (o.binary) return { binary: true, size: o.size, sha, data: o.data };
  return { text: o.data.toString('utf8'), size: o.size, sha, data: o.data };
}

module.exports = {
  LRU, sha1, objectSha, getObject, parseTree, getTree, serializeTree, putObject,
  COMMIT_COLS, commitBySha, commitById, parentsOf, isMerge, inProject, findCommit,
  branches, tags, getRef, resolveRef, splitRefPath, entryAt, listDir, allPaths,
  hasBranchRows, history, walk, countCommits, lastCommitFor, lastCommitsForDir,
  languageOf, highlightLines, readBlob,
};
