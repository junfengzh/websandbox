#!/usr/bin/env node
'use strict';
// Check every task's reference_sql ([{site, sql, expect}]: how the reference was re-derived on
// our data) against running sites, and that each task's eval fails on a fresh tenant.
//   node tasks/cross/check_refs.js --sites shopping=URL,forum=URL,... [--tenant I] [--tasks FILE] [--ids 1,2]
// (`tasks/tools/sites.sh urls` prints the --sites argument.) Exit 1 if any check fails.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const ROOT = path.resolve(__dirname, '..', '..');
const kitGrader = require(path.join(ROOT, 'kit', 'lib', 'grader'));

(async () => {
  const { values: a } = parseArgs({ options: { sites: { type: 'string' }, tenant: { type: 'string' }, tasks: { type: 'string', default: path.join(__dirname, 'webarena.jsonl') }, ids: { type: 'string' }, fresh: { type: 'boolean', default: false } } });
  const queries = {};
  for (const kv of (a.sites || '').split(',').filter(Boolean)) { const i = kv.indexOf('='); queries[kv.slice(0, i)] = kitGrader.remoteQuery(kv.slice(i + 1), { tenant: a.tenant }); }
  const want = a.ids ? new Set(a.ids.split(',').map(Number)) : null;
  const tasks = fs.readFileSync(a.tasks, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((t) => !want || want.has(t.task_id));
  let bad = 0;
  for (const t of tasks) {
    for (const r of t.reference_sql || []) {
      if (!queries[r.site]) { console.log(`${t.task_id} reference ${r.site}: no --sites entry`); bad++; continue; }
      const rows = await queries[r.site](r.sql);
      const ok = kitGrader.stateMatch(rows, r.expect);
      if (!ok) bad++;
      console.log(`${t.task_id} reference ${r.site}: ${ok ? 'ok' : 'FAIL'} ${JSON.stringify(rows.slice(0, 10)).slice(0, 300)}`);
    }
    if (a.fresh && t.status !== 'dropped') {
      // on an untouched tenant (no answer, start URL) the task must not pass
      const own = t.grade_site;
      const g = fs.existsSync(path.join(ROOT, 'sites', { gitlab: 'code', shopping: 'store', shopping_admin: 'store' }[own] || own, 'grade.js'))
        ? require(path.join(ROOT, 'sites', { gitlab: 'code', shopping: 'store', shopping_admin: 'store' }[own] || own, 'grade.js')) : kitGrader.grade;
      const res = await (typeof g === 'function' ? g : g.grade)(t, { answer: '', url: t.start_url, query: queries[own], queries });
      if (res.pass === true) bad++;
      console.log(`${t.task_id} fresh tenant: pass=${res.pass}${res.pass === true ? ' FAIL (passes without doing anything)' : ''}`);
    }
  }
  console.log(bad ? `${bad} failing` : 'all ok');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(3); });
