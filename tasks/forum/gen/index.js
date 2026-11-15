#!/usr/bin/env node
'use strict';
// Forum task generator (docs/GENERATOR.md). Writes tasks/forum/generated.jsonl deterministically:
//   node tasks/forum/gen/index.js --seed 1 [--out FILE] [--max N] [--only name,name] [--list]
// Templates: the family modules below (one array of templates each). A template = phrasings with
// {{slots}} + generate(rng) yielding {slots, login_user, start_url?, eval, changes?}; every eval is
// computed by SQL on base.db at generation time (WSB_FORUM_DATA overrides the data dir).
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const L = require('./lib');

const FAMILIES = ['listings', 'search', 'threads', 'users', 'forums', 'votes', 'comments', 'posts', 'profile', 'messages', 'moderation'];
const TEMPLATES = FAMILIES.flatMap((f) => require(`./${f}`).map((t) => ({ ...t, family: f })));
const DEFAULT_MAX = 60;

const fill = (s, slots) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (slots[k] == null) throw new Error(`slot ${k} missing in "${s}"`);
  return String(slots[k]);
});

function main() {
  const { values: a } = parseArgs({ options: {
    seed: { type: 'string', default: '1' }, out: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') },
    max: { type: 'string' }, only: { type: 'string' }, list: { type: 'boolean' } } });
  const seed = +a.seed;
  const names = new Set();
  for (const t of TEMPLATES) {
    if (names.has(t.name)) throw new Error(`duplicate template ${t.name}`);
    names.add(t.name);
  }
  if (a.list) { for (const t of TEMPLATES) console.log(`${t.kind}\t${t.family}\tgen-forum-${t.name}\t${t.skills.join(',')}\td${t.difficulty}`); return; }
  const only = a.only ? new Set(a.only.split(',')) : null;
  const lines = [];
  const intents = new Set();
  const stats = [];
  for (const t of TEMPLATES) {
    if (only && !only.has(t.name)) continue;
    const id = `gen-forum-${t.name}`;
    const max = +(a.max || t.max || DEFAULT_MAX);
    const r = L.rng(seed * 7919 + L.hash(t.name));
    const rp = L.rng(seed * 104729 + L.hash(t.name + '/phrasing'));
    let n = 0;
    const t0 = Date.now();
    for (const x of t.generate(r)) {
      const k = rp.int(t.phrasings.length);
      const tpl = t.phrasings[k];
      const intent = fill(tpl, x.slots).replace(/([.!?])"([.?])/g, '$1"'); // '..."Thanks!".' -> '..."Thanks!"'
      const key = `${intent}\n${x.login_user}`;
      if (intents.has(key)) continue;
      intents.add(key);
      if (!x.login_user || !L.get('SELECT 1 FROM users WHERE normalized_username = lower(?)', x.login_user)) throw new Error(`${id}: login user ${x.login_user} missing`);
      n++;
      lines.push({
        task_id: `${id}-${String(n).padStart(3, '0')}`, site: 'forum', source: 'generated', template: id,
        intent, intent_template: tpl, intent_template_id: id, phrasing: k, instantiation_dict: x.slots,
        start_url: x.start_url || '__REDDIT__', require_login: true, login_user: x.login_user,
        eval: x.eval, kind: t.kind, skills: t.skills, difficulty: t.difficulty,
        changes: x.changes || [], status: 'verified', drop_reason: null,
      });
      if (n >= max) break;
    }
    stats.push([id, t.kind, n, Date.now() - t0]);
  }
  fs.writeFileSync(a.out, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const [id, kind, n, ms] of stats) console.error(`${id.padEnd(42)} ${kind.padEnd(5)} ${String(n).padStart(4)}  ${ms} ms`);
  const reads = lines.filter((l) => l.kind === 'read').length;
  console.error(`${lines.length} tasks (${reads} read, ${lines.length - reads} write), ${stats.length} templates -> ${a.out}`);
}

if (require.main === module) main();
module.exports = { TEMPLATES, fill };
