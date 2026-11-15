#!/usr/bin/env node
'use strict';
// Wiki (wiki.wa) task generator: docs/GENERATOR.md. Read-only site, so every task is
// information seeking or navigation (answer / url checks).
//   (cd tasks/wiki/gen && npm install)   # node-html-parser
//   node tasks/wiki/gen/index.js --seed 1 [--out tasks/wiki/generated.jsonl] [--only gen-wiki-x,...] [--stats]
// Facts come from the stored article HTML (the HTML the site renders), parsed once into a cache
// (cache.js; rebuilt when base.db changes). Deterministic for a seed and a base.db.
// Each template: {id, skills, difficulty, cap, phrasings, generate({c, rand}) -> [inst], finish?(inst, phrasingIndex)}
// inst = {vars, eval, start?, ref (human-readable reference, kept as task.ref)}.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const L = require('./lib');
const F = require('./facts');

const MODULES = ['infobox', 'compare', 'structure', 'tables'];
const VERIFIED = new Set(fs.existsSync(path.join(__dirname, 'verified.json')) ? JSON.parse(fs.readFileSync(path.join(__dirname, 'verified.json'), 'utf8')) : []);
const DEFAULT_OUT = path.join(__dirname, '..', 'generated.jsonl');

(async () => {
  const { values: a } = parseArgs({ options: {
    seed: { type: 'string', default: '1' }, out: { type: 'string', default: DEFAULT_OUT },
    only: { type: 'string', default: '' }, stats: { type: 'boolean', default: false },
  } });
  const seed = Number(a.seed);
  const only = new Set(a.only.split(',').filter(Boolean));
  const c = await F.context();
  const lines = []; const stats = []; const seenIntent = new Set();
  for (const m of MODULES) {
    for (const t of require(`./${m}`)) {
      if (only.size && !only.has(t.id)) continue;
      const rand = new L.Rand((L.strHash(t.id) ^ seed) >>> 0);
      const t0 = Date.now();
      const insts = rand.shuffle(t.generate({ c, rand }));
      let n = 0;
      for (const inst of insts) {
        if (n >= t.cap) break;
        const pi = rand.int(t.phrasings.length);
        if (t.finish) t.finish(inst, pi);
        const task = L.makeTask(t, { ...inst, phrasing: pi }, rand);
        if (seenIntent.has(task.intent)) continue;
        seenIntent.add(task.intent);
        n++;
        task.task_id = `${t.id}-${String(n).padStart(3, '0')}`;
        task.status = VERIFIED.has(t.id) ? 'verified' : 'unverified';
        task.ref = inst.ref;
        // articles holding the reference (check.js reads them through the site)
        const ev = inst.evidence || (inst.vars.title ? [c.meta.get(c.byNorm.get(L.norm(inst.vars.title))).path] : null);
        if (ev) task.evidence = ev;
        lines.push(task);
      }
      stats.push({ template: t.id, candidates: insts.length, tasks: n, ms: Date.now() - t0 });
    }
  }
  const out = only.size && a.out === DEFAULT_OUT ? path.join((process.env.WSB_TMP || require('os').tmpdir()), 'wiki-gen-only.jsonl') : a.out;
  fs.writeFileSync(out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  if (a.stats || only.size) for (const s of stats) console.error(`${s.template.padEnd(42)} ${String(s.tasks).padStart(4)} / ${String(s.candidates).padEnd(6)} ${s.ms} ms`);
  console.error(`templates ${stats.length}, tasks ${lines.length} -> ${out}`);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
