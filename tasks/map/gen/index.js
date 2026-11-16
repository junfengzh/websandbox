#!/usr/bin/env node
'use strict';
// Map task generator (docs/GENERATOR.md). Writes tasks/map/generated.jsonl deterministically:
//   node tasks/map/gen/index.js --seed 1 [--out FILE] [--max N] [--only name,name] [--list]
// No server needed: references come from the site's own engines in process (sites/map/lib:
// Geocoder on geocode.db, router on route/ -- what the UI's worker threads run), replaying the
// UI's steps: the search box / From-To fields take the geocoder's top hit, directions round the
// end points to 5 decimals, "What's nearby?" lists by straight-line distance. WSB_MAP_DATA
// overrides the data dir; WSB_GEN_ROUTE_WORKERS (default 2) routing threads (~2 GB each).
// Templates: the family modules below. A template = phrasings with {{slots}} + generate(rng),
// an async generator of {slots, start_url, eval, answer | url, changes?}.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const L = require('./lib');

const FAMILIES = ['facts', 'reverse', 'nearby', 'routes', 'navigate'];
const TEMPLATES = FAMILIES.flatMap((f) => require(`./${f}`).map((t) => ({ ...t, family: f })));
const DEFAULT_MAX = 50;

const fill = (s, slots) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (slots[k] == null) throw new Error(`slot ${k} missing in "${s}"`);
  return String(slots[k]);
});

async function main() {
  const { values: a } = parseArgs({ options: {
    seed: { type: 'string', default: '1' }, out: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') },
    max: { type: 'string' }, only: { type: 'string' }, list: { type: 'boolean' } } });
  const seed = +a.seed;
  const names = new Set();
  for (const t of TEMPLATES) {
    if (names.has(t.name)) throw new Error(`duplicate template ${t.name}`);
    names.add(t.name);
  }
  if (a.list) { for (const t of TEMPLATES) console.log(`${t.kind}\t${t.family}\tgen-map-${t.name}\t${t.skills.join(',')}\td${t.difficulty}`); return; }
  const only = a.only ? new Set(a.only.split(',')) : null;
  const lines = [];
  const intents = new Set();
  const stats = [];
  for (const t of TEMPLATES) {
    if (only && !only.has(t.name)) continue;
    const id = `gen-map-${t.name}`;
    const max = +(a.max || t.max || DEFAULT_MAX);
    const r = L.rng(seed * 7919 + L.hash(t.name));
    const rp = L.rng(seed * 104729 + L.hash(t.name + '/phrasing'));
    let n = 0;
    const t0 = Date.now();
    for await (const x of t.generate(r)) {
      const k = rp.int(t.phrasings.length);
      const tpl = t.phrasings[k];
      const intent = fill(tpl, x.slots);
      if (intents.has(intent)) continue;
      intents.add(intent);
      n++;
      const line = {
        task_id: `${id}-${String(n).padStart(3, '0')}`, site: 'map', source: 'generated', template: id,
        intent, intent_template: tpl, intent_template_id: id, phrasing: k, instantiation_dict: x.slots,
        start_url: x.start_url || L.DEFAULT_START, require_login: false, login_user: null,
        eval: x.eval, kind: t.kind, skills: t.skills, difficulty: t.difficulty,
      };
      if (x.answer != null) line.reference_answer = x.answer;
      if (x.url != null) line.reference_url = x.url;
      // phrasingChanges: {<phrasing index>: note} -- a note on the tasks that use that phrasing
      const pc = t.phrasingChanges && t.phrasingChanges[k];
      Object.assign(line, { changes: (x.changes || []).concat(pc ? [pc] : []), status: 'verified', drop_reason: null });
      lines.push(line);
      if (n >= max) break;
    }
    stats.push([id, t.kind, n, Date.now() - t0]);
    console.error(`${id.padEnd(40)} ${t.kind.padEnd(8)} ${String(n).padStart(4)}  ${Date.now() - t0} ms`);
  }
  await L.closeRouter();
  fs.writeFileSync(a.out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const reads = lines.filter((l) => l.kind === 'read').length;
  console.error(`${lines.length} tasks (${reads} read, ${lines.length - reads} navigate), ${stats.length} templates -> ${a.out}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { TEMPLATES, fill, main };
