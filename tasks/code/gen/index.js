#!/usr/bin/env node
'use strict';
// Code hosting (gitlab.wa) task generator: docs/GENERATOR.md.
//   node tasks/code/gen/index.js --seed 1 [--out tasks/code/generated.jsonl] [--only gen-code-x,...] [--stats]
// Deterministic for a seed and a base.db. Each template module exports an array of
// templates {id, kind, skills, difficulty, cap, phrasings, generate({db, git, rand})}.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const L = require('./lib');

const MODULES = ['read_explore', 'read_repo', 'read_commits', 'read_issues', 'read_mrs', 'write_issues', 'write_repo', 'write_project'];
// templates validated by hand (2 UI instances + 1 negative, tasks/code/verify-generated.jsonl)
const VERIFIED = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'verified.json'), 'utf8')));

const { values: a } = parseArgs({ options: {
  seed: { type: 'string', default: '1' }, out: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') },
  only: { type: 'string', default: '' }, stats: { type: 'boolean', default: false },
} });
const seed = Number(a.seed);
const only = new Set(a.only.split(',').filter(Boolean));

const db = L.openDb();
const git = new L.Git(db);
const lines = [];
const stats = [];
const seenIntent = new Set();
for (const m of MODULES) {
  const file = path.join(__dirname, m + '.js');
  if (!fs.existsSync(file)) continue;
  for (const t of require(file)) {
    if (only.size && !only.has(t.id)) continue;
    const rand = new L.Rand((L.strHash(t.id) ^ seed) >>> 0);
    const t0 = Date.now();
    const insts = rand.shuffle(t.generate({ db, git, rand }));
    let n = 0;
    for (const inst of insts) {
      if (n >= t.cap) break;
      const task = L.makeTask(t, inst, rand);
      if (seenIntent.has(task.intent)) continue;
      seenIntent.add(task.intent);
      n++;
      task.task_id = `${t.id}-${String(n).padStart(3, '0')}`;
      task.status = VERIFIED.has(t.id) ? 'verified' : 'unverified';
      if (t.regradeNote) task.changes = [t.regradeNote];
      lines.push(task);
    }
    stats.push({ template: t.id, kind: t.kind, candidates: insts.length, tasks: n, ms: Date.now() - t0 });
  }
}
if (!only.size || a.out !== path.join(__dirname, '..', 'generated.jsonl')) fs.writeFileSync(a.out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
else fs.writeFileSync(path.join((process.env.WSB_TMP || require('os').tmpdir()), 'code-gen-only.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
const tot = { read: 0, write: 0 };
for (const s of stats) tot[s.kind] += s.tasks;
if (a.stats || only.size) for (const s of stats) console.error(`${s.template.padEnd(40)} ${s.kind.padEnd(5)} ${String(s.tasks).padStart(4)} / ${String(s.candidates).padEnd(6)} ${s.ms} ms`);
console.error(`templates ${stats.length}, tasks ${lines.length} (read ${tot.read}, write ${tot.write})`);
