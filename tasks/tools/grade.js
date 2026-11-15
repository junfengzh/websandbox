#!/usr/bin/env node
'use strict';
// Grade a converted task line against a running site tenant (control API), and optionally
// log the run to the site's verify.jsonl.
//
//   node tasks/tools/grade.js --site http://127.0.0.1:7200 --tasks tasks/forum/webarena.jsonl --id 27 \
//        [--answer "..."] [--url "http://.../f/books"] [--tenant I] [--grader sites/forum/grade.js] \
//        [--log tasks/forum/verify.jsonl --how "steps..." --notes "..." [--expect-fail]]
//
// --grader defaults to sites/<task.site>/grade.js when it exists (site URL canonicalisation),
// else the kit grader. Prints {task_id, pass, checks}; exit 0 pass, 1 fail, 2 pending (fuzzy
// judge), 3 error. With --log, appends {task_id, when, how, final_url, observed, ok, notes}
// (observed = the answer given and each check's got/reference). --expect-fail marks a
// negative check (ok = the grader failed it) and logs it with "negative": true.
// --fuzzy-exact: grade fuzzy answers by WebArena-cleaned exact match instead of leaving them
// pending (offline verification only; real runs use the LLM judge).
// --sql-only: just print answer_sql / state_sql results of the task (no grading).
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const ROOT = path.resolve(__dirname, '..', '..');
const kitGrader = require(path.join(ROOT, 'kit', 'lib', 'grader'));

(async () => {
  const { values: a } = parseArgs({ options: {
    site: { type: 'string', default: 'http://127.0.0.1:7200' }, tasks: { type: 'string' }, id: { type: 'string' },
    answer: { type: 'string', default: '' }, url: { type: 'string', default: '' }, tenant: { type: 'string' },
    grader: { type: 'string' }, token: { type: 'string' }, log: { type: 'string' }, how: { type: 'string', default: '' },
    notes: { type: 'string', default: '' }, 'expect-fail': { type: 'boolean', default: false }, 'sql-only': { type: 'boolean', default: false },
    'fuzzy-exact': { type: 'boolean', default: false },
  } });
  if (!a.tasks || !a.id) { console.error('usage: grade.js --site URL --tasks FILE.jsonl --id ID [--answer S] [--url U] [--log verify.jsonl --how ... --notes ...]'); process.exit(3); }
  const tasks = fs.readFileSync(a.tasks, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const task = tasks.find((t) => String(t.task_id) === a.id);
  if (!task) throw new Error(`task ${a.id} not in ${a.tasks}`);
  const query = kitGrader.remoteQuery(a.site, { tenant: a.tenant, token: a.token || process.env.WSB_CONTROL_TOKEN });
  if (a['sql-only']) {
    const ev = task.eval || {};
    for (const q of [].concat(ev.answer_sql || [], ev.state_sql || [])) console.log(JSON.stringify({ sql: q, rows: await query(q) }));
    return;
  }
  let gpath = a.grader;
  if (!gpath && task.site && fs.existsSync(path.join(ROOT, 'sites', task.site, 'grade.js'))) gpath = path.join(ROOT, 'sites', task.site, 'grade.js');
  const g = gpath ? require(path.resolve(gpath)) : kitGrader.grade;
  // --fuzzy-exact: offline stand-in for the LLM judge (cleaned answer == reference); the RL
  // stack passes its real judge as `fuzzy`.
  const fuzzy = a['fuzzy-exact'] ? ({ answer, reference }) => kitGrader.exactMatch(answer, [].concat(reference).join(', ')) : undefined;
  const r = await (typeof g === 'function' ? g : g.grade)(task, { answer: a.answer, url: a.url, query, fuzzy });
  const out = { task_id: task.task_id, pass: r.pass, checks: r.checks };
  console.log(JSON.stringify(out, null, 1));
  if (a.log) {
    const ok = a['expect-fail'] ? r.pass === false : r.pass === true;
    const observed = { answer: a.answer || undefined, checks: r.checks.map((c) => ({ type: c.type, mode: c.mode, pass: c.pass, got: c.got, reference: c.reference, drift: c.drift, error: c.error })) };
    const line = { task_id: task.task_id, when: new Date().toISOString(), how: a.how, final_url: a.url || null, observed, ok, notes: a.notes };
    if (a['expect-fail']) line.negative = true;
    fs.appendFileSync(a.log, JSON.stringify(line) + '\n');
    console.error(`logged ${task.task_id} ok=${ok} -> ${a.log}`);
  }
  process.exit(r.pass === true ? 0 : r.pass === null ? 2 : 1);
})().catch((e) => { console.error(String(e.stack || e)); process.exit(3); });
