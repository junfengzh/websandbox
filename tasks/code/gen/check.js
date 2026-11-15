#!/usr/bin/env node
'use strict';
// Bulk self-check of tasks/code/generated.jsonl against a FRESH tenant (no rollout writes):
//   read tasks: the static reference (joined) passes, answer_sql shows no drift, an empty answer fails;
//   write tasks: the untouched state fails (graders are not trivially passable), and no SQL errors.
//   node tasks/code/gen/check.js --site http://127.0.0.1:7462 [--file tasks/code/generated.jsonl]
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const G = require(path.join(__dirname, '..', '..', '..', 'kit', 'lib', 'grader'));
const { values: a } = parseArgs({ options: { site: { type: 'string', default: 'http://127.0.0.1:7462' }, file: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') } } });
(async () => {
  await fetch(a.site + '/__rl/reset', { method: 'POST' });
  const query = G.remoteQuery(a.site, {});
  const tasks = fs.readFileSync(a.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const bad = []; const per = {};
  for (const t of tasks) {
    const s = (per[t.template] ||= { n: 0, bad: 0 }); s.n++;
    let problem = null;
    try {
      if (t.kind === 'read') {
        const refs = [].concat(...[].concat(t.eval.answer).map((sp) => [].concat(sp.must_include || sp.exact || [])));
        const ans = refs.map((r) => String(r).split(' |OR| ')[0]).join(' ; ');
        const r1 = await G.grade(t, { answer: ans, query });
        const r0 = await G.grade(t, { answer: '', query });
        const drift = r1.checks.some((c) => c.drift);
        if (r1.pass !== true) problem = 'reference fails: ' + JSON.stringify(r1.checks);
        else if (drift) problem = 'drift: ' + JSON.stringify(r1.checks.map((c) => c.sql_reference));
        else if (r0.pass !== false) problem = 'empty answer passes';
      } else {
        const r = await G.grade(t, { query });
        if (r.checks.some((c) => c.error)) problem = 'error: ' + JSON.stringify(r.checks.map((c) => c.error));
        else if (r.pass !== false) problem = 'fresh state passes';
      }
    } catch (e) { problem = 'exception: ' + e.message; }
    if (problem) { s.bad++; bad.push({ id: t.task_id, problem: problem.slice(0, 300) }); }
  }
  for (const [k, v] of Object.entries(per)) console.log(`${k.padEnd(40)} ${v.n} ${v.bad ? 'BAD ' + v.bad : 'ok'}`);
  for (const b of bad.slice(0, 60)) console.log(JSON.stringify(b));
  console.log(`checked ${tasks.length}, problems ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})();
