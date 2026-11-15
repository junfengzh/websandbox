#!/usr/bin/env node
'use strict';
// Self-check of generated tasks against a running forum tenant (fresh state, via /__rl/query):
//   node tasks/forum/gen/check.js --site http://127.0.0.1:7240 [--tasks tasks/forum/generated.jsonl] [--tenant 0]
// - answer tasks: answer_sql re-derives the static reference (no drift); the reference passes the
//   grader; an empty answer and a decoy answer fail;
// - state tasks: the state check fails on the untouched tenant (nothing is passable by doing nothing);
// - every login_user exists.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const grade = require('../../../sites/forum/grade');

async function main() {
  const { values: a } = parseArgs({ options: { site: { type: 'string', default: 'http://127.0.0.1:7240' }, tasks: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') }, tenant: { type: 'string', default: '0' } } });
  const query = kit.grader.remoteQuery(a.site, { tenant: +a.tenant });
  const tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bad = [];
  const per = new Map();
  for (const t of tasks) {
    const ev = t.eval;
    const problems = [];
    const u = await query('SELECT id FROM users WHERE normalized_username = lower(?)', [t.login_user]);
    if (!u.length) problems.push('login user missing');
    if (ev.type === 'answer') {
      const refs = ev.answer.exact != null ? [ev.answer.exact] : ev.answer.must_include;
      const rows = await query(ev.answer_sql);
      const cells = rows.length ? Object.values(rows[0]).map((v) => String(v).toLowerCase()) : [];
      for (const ref of refs) {
        const alts = String(ref).split(' |OR| ').map((x) => x.toLowerCase());
        if (!alts.some((x) => cells.some((c) => c === x || c.includes(x)))) problems.push(`drift: ref ${ref} vs sql ${JSON.stringify(rows[0])}`);
      }
      const ok = await grade(t, { answer: refs.map((r) => String(r).split(' |OR| ')[0]).join(', '), query });
      if (ok.pass !== true) problems.push('reference does not pass');
      for (const decoy of ['', 'I could not find it', '42']) {
        const g = await grade(t, { answer: decoy, query });
        if (g.pass !== false && !(decoy === '42' && refs.includes('42'))) problems.push(`decoy "${decoy}" passes`);
      }
    } else {
      const g = await grade(t, { answer: '', url: '', query });
      if (g.pass !== false) problems.push('state passes on a fresh tenant');
    }
    const s = per.get(t.template) || { n: 0, bad: 0 };
    s.n++; if (problems.length) { s.bad++; bad.push({ id: t.task_id, problems }); }
    per.set(t.template, s);
  }
  for (const [k, s] of per) console.log(`${k.padEnd(42)} ${String(s.n).padStart(4)} ${s.bad ? `FAIL ${s.bad}` : 'ok'}`);
  for (const b of bad.slice(0, 40)) console.log(JSON.stringify(b));
  console.log(`${tasks.length} tasks, ${bad.length} with problems`);
  process.exit(bad.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(3); });
