'use strict';
// Diffs computed from stored blobs: tree-vs-tree changes and unified line diffs.
const Diff = require('diff');
const kit = require('../../../../kit');
const git = require('./git');

const MAX_SIDE = 384 * 1024;   // bytes per side for a line diff
const MAX_LINES_TOTAL = 6000;  // rendered diff lines per page (rest collapsed)

// Changes between two trees (either may be null = empty): [{path, oldPath, change A|M|D, oldSha, newSha, oldMode, newMode}]
// `missing` is set when a needed tree is not stored.
function diffTrees(aSha, bSha, prefix = '', out = [], state = { missing: false, cap: 3000 }) {
  if (aSha === bSha || out.length >= state.cap) return out;
  const a = aSha ? git.getTree(aSha) : [];
  const b = bSha ? git.getTree(bSha) : [];
  if (!a || !b) { state.missing = true; out.missing = true; return out; }
  const am = new Map(a.map((e) => [e.name, e]));
  const bm = new Map(b.map((e) => [e.name, e]));
  const names = [...new Set([...am.keys(), ...bm.keys()])].sort();
  for (const n of names) {
    const x = am.get(n), y = bm.get(n), p = prefix + n;
    if (x && y && x.sha === y.sha && x.mode === y.mode) continue;
    const xt = x && x.type === 'tree', yt = y && y.type === 'tree';
    if (xt || yt) {
      if (xt && yt) diffTrees(x.sha, y.sha, p + '/', out, state);
      else {
        if (xt) diffTrees(x.sha, null, p + '/', out, state); else if (x) out.push({ path: p, change: 'D', oldSha: x.sha, oldMode: x.mode });
        if (yt) diffTrees(null, y.sha, p + '/', out, state); else if (y) out.push({ path: p, change: 'A', newSha: y.sha, newMode: y.mode });
      }
      continue;
    }
    if (!x) out.push({ path: p, change: 'A', newSha: y.sha, newMode: y.mode });
    else if (!y) out.push({ path: p, change: 'D', oldSha: x.sha, oldMode: x.mode });
    else out.push({ path: p, change: x.mode !== y.mode && x.sha === y.sha ? 'T' : 'M', oldSha: x.sha, newSha: y.sha, oldMode: x.mode, newMode: y.mode });
    if (out.length >= state.cap) { out.truncated = true; break; }
  }
  if (state.missing) out.missing = true;
  return out;
}

// Unified diff of two blobs: {hunks: [{header, lines: [{t: '+'|'-'|' ', o, n, s}]}], additions, deletions}
// or {binary} / {tooLarge} / {unavailable} (blob not stored) / {omitted}.
function blobDiff(oldSha, newSha) {
  const a = oldSha ? git.readBlob(oldSha) : { text: '' };
  const b = newSha ? git.readBlob(newSha) : { text: '' };
  if (a.missing || b.missing) return { unavailable: true };
  if (a.omitted || b.omitted) return { omitted: true, size: (b.omitted ? b.size : a.size) };
  if (a.binary || b.binary) return { binary: true };
  if (a.text.length > MAX_SIDE || b.text.length > MAX_SIDE) return { tooLarge: true };
  let patch;
  try {
    patch = Diff.structuredPatch('a', 'b', a.text, b.text, '', '', { context: 3, timeout: 300 });
  } catch (e) { return { tooLarge: true }; }
  if (!patch) return { tooLarge: true };
  let additions = 0, deletions = 0;
  const hunks = patch.hunks.map((h) => {
    let o = h.oldStart, n = h.newStart;
    const lines = [];
    for (const l of h.lines) {
      const t = l[0];
      if (t === '\\') continue;
      const s = l.slice(1);
      if (t === '+') { lines.push({ t, n: n++, s }); additions++; }
      else if (t === '-') { lines.push({ t, o: o++, s }); deletions++; }
      else lines.push({ t: ' ', o: o++, n: n++, s });
    }
    return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines };
  });
  return { hunks, additions, deletions };
}

// Files changed by a commit, with diffs where both trees are stored.
// Returns {files: [{path, oldPath, change, additions, deletions, diff}], treesAvailable, truncated}
function commitDiff(project, c, { withDiffs = true, maxFiles = 100 } = {}) {
  const parent = git.parentsOf(c)[0] ? git.commitBySha(git.parentsOf(c)[0]) : null;
  const listed = kit.sql(`SELECT f.ord, f.change, f.additions, f.deletions, p.path, op.path AS old_path FROM commit_files f JOIN paths p ON p.id = f.path_id
    LEFT JOIN paths op ON op.id = f.old_path_id WHERE f.commit_id = ? ORDER BY f.ord`).all(c.id);
  const treesAvailable = !!c.has_tree && (!parent || !!parent.has_tree) && !!git.getTree(c.tree_sha) && (!parent || !!git.getTree(parent.tree_sha));
  let files;
  if (listed.length || !treesAvailable) {
    files = listed.map((f) => ({ path: f.path, oldPath: f.old_path, change: f.change, additions: f.additions, deletions: f.deletions }));
  } else {
    files = diffTrees(parent ? parent.tree_sha : null, c.tree_sha).map((f) => ({ path: f.path, change: f.change, oldSha: f.oldSha, newSha: f.newSha }));
  }
  const truncated = files.length > maxFiles || (c.files_changed || 0) > files.length;
  files = files.slice(0, maxFiles);
  if (withDiffs && treesAvailable) {
    let budget = MAX_LINES_TOTAL;
    for (const f of files) {
      if (f.oldSha === undefined && f.newSha === undefined) {
        const ne = f.change === 'D' ? null : git.entryAt(c.tree_sha, f.path);
        const oe = f.change === 'A' || !parent ? null : git.entryAt(parent.tree_sha, f.oldPath || f.path);
        f.newSha = ne && !ne.missing ? ne.sha : null;
        f.oldSha = oe && !oe.missing ? oe.sha : null;
        if ((ne && ne.type === 'commit') || (oe && oe.type === 'commit')) { f.diff = { submodule: true }; continue; }
      }
      if (budget <= 0) { f.diff = { collapsed: true }; continue; }
      f.diff = blobDiff(f.oldSha, f.newSha);
      if (f.diff.hunks) {
        const n = f.diff.hunks.reduce((s, h) => s + h.lines.length, 0);
        budget -= n;
        if (f.additions == null) { f.additions = f.diff.additions; f.deletions = f.diff.deletions; }
      }
    }
  }
  return { files, treesAvailable, truncated, parent };
}

// Diff between two commits' trees (compare page).
function compareDiff(from, to, { maxFiles = 200 } = {}) {
  if (!from.has_tree || !to.has_tree) return { treesAvailable: false, files: [] };
  const changes = diffTrees(from.tree_sha, to.tree_sha);
  if (changes.missing) return { treesAvailable: false, files: [] };
  let budget = MAX_LINES_TOTAL;
  const files = changes.slice(0, maxFiles).map((f) => {
    const d = budget > 0 ? blobDiff(f.oldSha, f.newSha) : { collapsed: true };
    if (d.hunks) budget -= d.hunks.reduce((s, h) => s + h.lines.length, 0);
    return { ...f, diff: d, additions: d.additions, deletions: d.deletions };
  });
  return { treesAvailable: true, files, truncated: changes.length > maxFiles || changes.truncated };
}

// Line counts of a text change (web edits): {additions, deletions}
function lineStats(oldText, newText) {
  if (oldText == null) oldText = '';
  if (newText == null) newText = '';
  let additions = 0, deletions = 0;
  for (const part of Diff.diffLines(oldText, newText, { timeout: 500 }) || []) {
    const n = part.count || 0;
    if (part.added) additions += n; else if (part.removed) deletions += n;
  }
  return { additions, deletions };
}

module.exports = { diffTrees, blobDiff, commitDiff, compareDiff, lineStats };
