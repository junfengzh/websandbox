'use strict';
// Shared helpers for the code-hosting (gitlab.wa) task generator: base.db access, seeded
// randomness, SQL literal helpers, a tiny git reader (trees/blobs from git_objects) and the
// task-line builder. Templates live in the sibling modules; index.js runs them.
const path = require('node:path');
const zlib = require('node:zlib');
const Database = require(path.join(__dirname, '..', '..', '..', 'kit', 'node_modules', 'better-sqlite3'));

const DB_PATH = process.env.CODE_DB || '$WSB_DATA_ROOT/code/base.db';
const TODAY = '2023-04-27'; // site clock "today" (UTC); data ends 2023-04-26

function openDb() {
  return new Database(DB_PATH, { readonly: true, fileMustExist: true });
}

// ---------------------------------------------------------------- randomness (seeded)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function strHash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
class Rand {
  constructor(seed) { this.r = mulberry32(seed); }
  next() { return this.r(); }
  int(n) { return Math.floor(this.r() * n); }
  pick(a) { return a[this.int(a.length)]; }
  shuffle(a) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = this.int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; }
  sample(a, n) { return this.shuffle(a).slice(0, n); }
}

// ---------------------------------------------------------------- SQL literals
const q = (s) => (s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'");
const pid = (fullPath) => `(SELECT id FROM projects WHERE full_path = ${q(fullPath)})`;
const uid = (username) => `(SELECT id FROM users WHERE username = ${q(username)})`;
const ROLE = { 10: 'Guest', 20: 'Reporter', 30: 'Developer', 40: 'Maintainer', 50: 'Owner' };

// ---------------------------------------------------------------- git reader
class Git {
  constructor(db) {
    this.db = db;
    this.objStmt = db.prepare('SELECT type, size, enc, omitted, binary, data FROM git_objects WHERE sha = ?');
  }
  object(sha) {
    const r = this.objStmt.get(sha);
    if (!r) return null;
    let data = r.data == null ? null : Buffer.from(r.data);
    if (data && r.enc === 1) data = zlib.inflateSync(data);
    return { ...r, data };
  }
  tree(sha) {
    const o = this.object(sha);
    if (!o || o.type !== 'tree' || !o.data) return null;
    const buf = o.data; const out = []; let i = 0;
    while (i < buf.length) {
      const sp = buf.indexOf(0x20, i); const nul = buf.indexOf(0, sp);
      const mode = buf.toString('latin1', i, sp);
      out.push({ mode, name: buf.toString('utf8', sp + 1, nul), sha: buf.toString('hex', nul + 1, nul + 21), type: mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : mode === '120000' ? 'link' : 'blob' });
      i = nul + 21;
    }
    return out;
  }
  commit(sha) { return this.db.prepare('SELECT * FROM commits WHERE sha = ?').get(sha); }
  // entry at path in a commit's tree (null if missing / not stored)
  entry(commitSha, filePath) {
    const c = this.commit(commitSha);
    if (!c || !c.has_tree) return null;
    let tree = this.tree(c.tree_sha);
    const parts = filePath.split('/');
    for (let k = 0; k < parts.length; k++) {
      if (!tree) return null;
      const e = tree.find((x) => x.name === parts[k]);
      if (!e) return null;
      if (k === parts.length - 1) return e;
      if (e.type !== 'tree') return null;
      tree = this.tree(e.sha);
    }
    return null;
  }
  // text content of a file (null for missing, omitted, binary or non-UTF-8)
  text(commitSha, filePath) {
    const e = this.entry(commitSha, filePath);
    if (!e || e.type !== 'blob') return null;
    const o = this.object(e.sha);
    if (!o || o.omitted || o.binary || !o.data) return null;
    const s = o.data.toString('utf8');
    if (s.includes('�')) return null;
    return s;
  }
  // [{path, sha, size}] of blobs under a commit's tree, depth-limited
  files(commitSha, maxDepth = 2) {
    const c = this.commit(commitSha);
    if (!c || !c.has_tree) return [];
    const out = [];
    const walk = (sha, prefix, d) => {
      const t = this.tree(sha);
      if (!t) return;
      for (const e of t) {
        if (e.type === 'blob') out.push({ path: prefix + e.name, sha: e.sha, mode: e.mode });
        else if (e.type === 'tree' && d < maxDepth) walk(e.sha, prefix + e.name + '/', d + 1);
      }
    };
    walk(c.tree_sha, '', 0);
    return out;
  }
  blobSize(sha) { return this.db.prepare('SELECT size, omitted, binary FROM git_objects WHERE sha = ?').get(sha); }
}

// ---------------------------------------------------------------- phrasing
// fill('Create {x} in {y}', {x, y}) ; templates use {name} slots
function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`slot ${k} missing for "${tpl}"`);
    return vars[k];
  });
}

// build one task line. t = template module, inst = {phr (index into t.phrasings or a string),
// vars, start, login, eval, skills?, difficulty?}
function makeTask(t, inst, rand) {
  const phr = typeof inst.phrasing === 'string' ? inst.phrasing : t.phrasings[inst.phrasing ?? rand.int(t.phrasings.length)];
  const intent = fill(phr, inst.vars);
  return {
    task_id: null,
    site: 'gitlab',
    intent,
    intent_template: phr.replace(/\{(\w+)\}/g, '{{$1}}'),
    intent_template_id: t.id,
    instantiation_dict: inst.vars,
    start_url: '__GITLAB__' + (inst.start || ''),
    require_login: true,
    login_user: inst.login || 'byteblaze',
    eval: inst.eval,
    source: 'generated',
    template: t.id,
    kind: t.kind,
    skills: inst.skills || t.skills,
    difficulty: inst.difficulty || t.difficulty,
    status: 'unverified',
  };
}

// projects a user can see (logged in): public + internal + own/member private
function visibleTo(db, username) {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  return db.prepare(`SELECT p.* FROM projects p WHERE p.archived = 0 AND (p.visibility IN ('public','internal')
    OR p.namespace_id IN (SELECT id FROM namespaces WHERE kind = 'user' AND owner_id = ?)
    OR p.id IN (SELECT source_id FROM members WHERE source_type = 'project' AND user_id = ? AND requested_at IS NULL))`).all(u.id, u.id);
}

// the namespace owner (a user) of a project, if a personal namespace
function ownerOf(db, projectId) {
  return db.prepare(`SELECT u.username FROM projects p JOIN namespaces n ON n.id = p.namespace_id JOIN users u ON u.id = n.owner_id
    WHERE p.id = ? AND n.kind = 'user' AND u.state = 'active'`).pluck().get(projectId);
}

const enc = (s) => s.split('/').map(encodeURIComponent).join('/');
const shortSha = (s) => s.slice(0, 8);
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

module.exports = { openDb, Rand, strHash, q, pid, uid, ROLE, Git, fill, makeTask, visibleTo, ownerOf, enc, shortSha, titleCase, TODAY, DB_PATH };
