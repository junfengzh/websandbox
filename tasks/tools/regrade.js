#!/usr/bin/env node
'use strict';
// Re-grade every task file and its verification log with the current graders (kit grader +
// sites/<dir>/grade.js), against running sites (tasks/tools/sites.sh up --bind rl ...).
//
//   node tasks/tools/regrade.js [--base 7900] [--tenant 0] [--out FILE.jsonl] [--only forum,code,...]
//
// Per task (on a freshly reset tenant):
//   empty    the task must not pass with an empty answer and no actions (final URL = start_url,
//            and also an empty URL); fuzzy checks graded by the offline exact stand-in.
//   ref      answer tasks: the stored reference answer passes every answer check (reference =
//            task.reference_answer / task.ref, else built from the eval: exact value, the first
//            alternative of each must_include item, numeric value + unit, answer_sql rows);
//            url tasks: the reference URL (task.reference_url, else the first eval.url) passes.
//            Static references with answer_sql must not drift on a fresh tenant.
//   replay   every recorded verify run (answer + final_url) is graded again; the recorded
//            outcome (pass, or fail for negative checks) must hold. Tasks with state checks:
//            only their answer/url/map checks are compared, per check, with the recorded checks.
// Prints a summary per file; --out writes one JSON line per problem.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const ROOT = path.resolve(__dirname, '..', '..');
const kitGrader = require(path.join(ROOT, 'kit', 'lib', 'grader'));

const { values: a } = parseArgs({ options: {
  base: { type: 'string', default: '7900' }, tenant: { type: 'string', default: '0' }, out: { type: 'string' },
  only: { type: 'string' }, token: { type: 'string' }, 'no-reset': { type: 'boolean', default: false },
} });
const BASE = +a.base;
const SITE_K = { store: 0, forum: 1, code: 2, wiki: 3, map: 4 };
const DIRS = { shopping: 'store', shopping_admin: 'store', gitlab: 'code', reddit: 'forum', forum: 'forum', wiki: 'wiki', map: 'map' };
const ctl = (dir) => `http://127.0.0.1:${BASE + SITE_K[dir] * 10}`;
const qo = { tenant: a.tenant, token: a.token || process.env.WSB_CONTROL_TOKEN };
const queries = {};
for (const s of ['shopping', 'shopping_admin', 'gitlab', 'forum', 'reddit', 'wiki', 'map']) queries[s] = kitGrader.remoteQuery(ctl(DIRS[s]), qo);

const FILES = [
  ['forum', 'tasks/forum/webarena.jsonl', ['tasks/forum/verify.jsonl']],
  ['store', 'tasks/store/webarena-shopping.jsonl', ['tasks/store/verify-shopping.jsonl']],
  ['store', 'tasks/store/webarena-admin.jsonl', ['tasks/store/verify-admin.jsonl']],
  ['code', 'tasks/code/webarena-a.jsonl', ['tasks/code/verify-a.jsonl']],
  ['code', 'tasks/code/webarena-b.jsonl', ['tasks/code/verify-b.jsonl']],
  ['map', 'tasks/map/webarena.jsonl', ['tasks/map/verify.jsonl']],
  ['cross', 'tasks/cross/webarena.jsonl', ['tasks/cross/verify.jsonl']],
  ['forum', 'tasks/forum/generated.jsonl', ['tasks/forum/verify-generated.jsonl']],
  ['code', 'tasks/code/generated.jsonl', ['tasks/code/verify-generated.jsonl']],
  ['wiki', 'tasks/wiki/generated.jsonl', ['tasks/wiki/verify-generated.jsonl']],
  ['map', 'tasks/map/generated.jsonl', ['tasks/map/verify-generated.jsonl']],
  ['store', 'tasks/store/generated-shopping.jsonl', ['tasks/store/verify-generated.jsonl']],
  ['store', 'tasks/store/generated-admin.jsonl', ['tasks/store/verify-generated.jsonl']],
];
const readJsonl = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const graders = {};
function graderFor(task) {
  const own = task.grade_site || task.site;
  const dir = DIRS[own] || own;
  if (!(dir in graders)) {
    const p = path.join(ROOT, 'sites', dir, 'grade.js');
    graders[dir] = fs.existsSync(p) ? require(p) : kitGrader.grade;
  }
  const g = graders[dir];
  return typeof g === 'function' ? g : g.grade;
}
const fuzzy = ({ answer, reference }) => kitGrader.exactMatch(answer, [].concat(reference).join(', '));
const grade = (task, answer, url) => graderFor(task)(task, { answer, url, query: queries[task.grade_site || task.site], queries, fuzzy });

const typesOf = (ev) => {
  const t = ev.type ? [].concat(ev.type) : [];
  if (!t.length) {
    if (ev.answer || ev.answer_sql) t.push('answer');
    if (ev.url) t.push('url');
    if (ev.state_sql || ev.state) t.push('state');
    for (const m of ['directions', 'place', 'search']) if (ev[m]) t.push(m);
  }
  return t;
};
const firstAlt = (s) => String(s).split(' |OR| ')[0];
async function referenceAnswer(task) {
  if (task.reference_answer != null) return String(task.reference_answer);
  if (task.ref != null) return String(task.ref);
  const ev = task.eval;
  let sqlRef = null;
  if (ev.answer_sql) {
    const own = task.grade_site || task.site;
    const q = ev.answer_site && queries[ev.answer_site] ? queries[ev.answer_site] : queries[own];
    const rows = await q(ev.answer_sql);
    sqlRef = rows.map((r) => (Array.isArray(r) ? r[0] : r && typeof r === 'object' ? Object.values(r)[0] : r)).map((v) => (v == null ? '' : String(v)));
  }
  const parts = [];
  const specs = Array.isArray(ev.answer) ? ev.answer : ev.answer ? [ev.answer] : [];
  if (!specs.length && sqlRef) parts.push(...sqlRef.map(firstAlt));
  for (const sp of specs) {
    const isSql = (v) => v == null || v === '$sql';
    if ('exact' in sp) parts.push(isSql(sp.exact) ? sqlRef[0] : sp.exact);
    else if ('must_include' in sp) parts.push(...(isSql(sp.must_include) ? sqlRef : [].concat(sp.must_include)).map(firstAlt));
    else if ('fuzzy' in sp) parts.push(isSql(sp.fuzzy) ? sqlRef.join(', ') : [].concat(sp.fuzzy).join(', '));
    else if ('numeric' in sp) for (const n of [].concat(sp.numeric)) parts.push(n.unit === 'deg' ? String(n.value) : `${n.value} ${n.unit}`);
  }
  // a lone exact/fuzzy reference must be the whole answer
  return parts.length === 1 ? String(parts[0]) : parts.join('; ');
}

(async () => {
  if (!a['no-reset']) {
    for (const dir of Object.keys(SITE_K)) {
      const r = await fetch(ctl(dir) + '/__rl/reset', { method: 'POST', headers: { 'x-wsb-tenant': a.tenant, ...(qo.token ? { 'x-wsb-control': qo.token } : {}) } });
      if (!r.ok) throw new Error(`reset ${dir}: ${r.status}`);
    }
  }
  const only = a.only ? a.only.split(',') : null;
  const out = a.out ? fs.openSync(a.out, 'w') : null;
  const problem = (o) => { if (out) fs.writeSync(out, JSON.stringify(o) + '\n'); };
  const total = {};
  for (const [site, file, logs] of FILES) {
    if (only && !only.includes(site)) continue;
    const tasks = readJsonl(file);
    const byId = new Map(tasks.map((t) => [String(t.task_id), t]));
    const s = { tasks: 0, empty_ok: 0, empty_fail: 0, ref_n: 0, ref_ok: 0, drift: 0, url_ref_n: 0, url_ref_ok: 0,
      replay_n: 0, replay_ok: 0, replay_partial_n: 0, replay_partial_ok: 0, replay_skipped: 0, replay_lenient: 0, replay_bad: 0 };
    for (const t of tasks) {
      if (t.status === 'dropped') continue;
      s.tasks++;
      const ev = t.eval;
      const types = typesOf(ev);
      // (a) empty answer, no actions
      try {
        const r1 = await grade(t, '', t.start_url);
        const r2 = await grade(t, '', '');
        if (r1.pass === true || r2.pass === true) { s.empty_fail++; problem({ file, task_id: t.task_id, check: 'empty', result: (r1.pass === true ? r1 : r2).checks }); } else s.empty_ok++;
      } catch (e) { s.empty_fail++; problem({ file, task_id: t.task_id, check: 'empty', error: String(e.message || e) }); }
      // (b) reference answer / reference url
      if (types.includes('answer')) {
        s.ref_n++;
        try {
          const ref = await referenceAnswer(t);
          const refUrl = types.includes('url') ? [].concat(ev.url)[0] : t.reference_url || '';
          const r = await grade(t, ref, refUrl);
          const ac = r.checks.filter((c) => c.type === 'answer' || (c.type === 'url' && refUrl));
          const ok = ac.length && ac.every((c) => c.pass === true);
          const drift = r.checks.filter((c) => c.drift);
          if (drift.length) {
            // cosmetic drift (alternatives, formatting) when the SQL values themselves pass the static check
            const sqlAns = drift[0].sql_reference.map(firstAlt).join('; ');
            const r2 = await grade(t, sqlAns, refUrl);
            const real = r2.checks.some((c) => c.type === 'answer' && c.pass === false);
            if (real) { s.drift++; problem({ file, task_id: t.task_id, check: 'drift', checks: drift }); } else s.drift_cosmetic = (s.drift_cosmetic || 0) + 1;
          }
          if (ok) s.ref_ok++; else problem({ file, task_id: t.task_id, check: 'ref', answer: ref, url: refUrl, checks: ac });
        } catch (e) { problem({ file, task_id: t.task_id, check: 'ref', error: String(e.message || e) }); }
      } else if (types.includes('url') || t.reference_url) {
        s.url_ref_n++;
        const refUrl = t.reference_url || [].concat(ev.url)[0];
        const r = await grade(t, '', refUrl);
        const uc = r.checks.filter((c) => c.type !== 'state' && c.type !== 'answer');
        if (uc.length && uc.every((c) => c.pass === true)) s.url_ref_ok++;
        else problem({ file, task_id: t.task_id, check: 'url_ref', url: refUrl, checks: uc });
      }
    }
    // (c) replay recorded verify runs. A mismatching run followed by a later run of the same task and
    // kind (positive / negative) that matches counts as superseded (the task was fixed in between).
    const runs = [];
    for (const log of logs) {
      for (const v of readJsonl(log)) {
        const t = byId.get(String(v.task_id));
        if (!t) continue; // the other file of a shared log
        if (v.superseded) { s.replay_skipped++; continue; }
        const want = v.negative ? !v.ok : !!v.ok;
        const obs = v.observed && typeof v.observed === 'object' ? v.observed : {};
        const answer = obs.answer || '';
        const url = v.final_url || '';
        const types = typesOf(t.eval);
        const run = { log, v, key: `${t.task_id}|${!!v.negative}`, base: { file, log, task_id: t.task_id, when: v.when, negative: !!v.negative, recorded_ok: v.ok, answer, url } };
        runs.push(run);
        let r;
        try { r = await grade(t, answer, url); } catch (e) { run.verdict = 'bad'; run.detail = { error: String(e.message || e) }; continue; }
        if (!types.includes('state')) {
          if (r.checks.some((c) => c.mode === 'fuzzy')) { run.verdict = 'skip'; continue; } // judged by hand (LLM judge)
          run.kind = 'full';
          if (r.pass === want) run.verdict = 'ok';
          else if (r.pass === true && !v.negative) { run.verdict = 'lenient'; run.detail = { note: 'a failed run now passes', checks: r.checks }; }
          else { run.verdict = 'bad'; run.detail = { checks: r.checks }; }
        } else {
          // per-check comparison of the offline-gradable checks (answer/url/map) with the recorded ones
          const now = r.checks.filter((c) => c.type !== 'state' && c.mode !== 'fuzzy');
          if (!now.length) { run.verdict = 'skip'; continue; }
          run.kind = 'partial';
          const recByType = {};
          for (const c of (obs.checks || []).filter((x) => x.type !== 'state')) (recByType[c.type] = recByType[c.type] || []).push(c);
          const idx = {}; const diffs = []; let bad = false; let restored = false;
          for (const c of now) {
            const i = idx[c.type] = (idx[c.type] || 0) + 1;
            const rc = (recByType[c.type] || [])[i - 1];
            if (!rc) {
              // a check the task did not have when the run was logged (restored url checks)
              if (v.negative || (c.type === 'url' && !url)) continue;
              if (c.pass === true) restored = true; else { bad = true; diffs.push({ type: c.type, now: c.pass, recorded: 'absent', reference: c.reference, got: c.got }); }
              continue;
            }
            if (rc.pass == null || rc.pass === c.pass) continue;
            diffs.push({ type: c.type, now: c.pass, recorded: rc.pass, reference: c.reference, got: c.got });
            if (!(c.pass === true && !v.negative && !v.ok)) bad = true;
          }
          run.verdict = bad ? 'bad' : diffs.length ? 'lenient' : 'ok';
          if (restored) run.restored = true;
          if (diffs.length) run.detail = { diffs };
        }
      }
    }
    for (const [i, run] of runs.entries()) {
      if (run.verdict === 'bad' && runs.slice(i + 1).some((x) => x.key === run.key && x.verdict === 'ok')) run.verdict = 'superseded';
      const k = run.kind === 'partial' ? 'replay_partial_' : 'replay_';
      if (run.verdict === 'skip') { s.replay_skipped++; continue; }
      if (run.verdict === 'bad' && !run.kind) { s.replay_bad++; problem({ ...run.base, check: 'replay', ...run.detail }); continue; }
      s[k + 'n']++;
      if (run.restored) s.restored_url_ok = (s.restored_url_ok || 0) + 1;
      if (run.verdict === 'ok') s[k + 'ok']++;
      else if (run.verdict === 'lenient') { s.replay_lenient++; problem({ ...run.base, check: 'replay', severity: 'info', ...run.detail }); }
      else if (run.verdict === 'superseded') { s.replay_superseded = (s.replay_superseded || 0) + 1; problem({ ...run.base, check: 'replay', severity: 'superseded', ...run.detail }); }
      else { s.replay_bad++; problem({ ...run.base, check: 'replay', ...run.detail }); }
    }
    total[file] = s;
    console.log(file, JSON.stringify(s));
  }
  if (out) fs.closeSync(out);
  fs.writeFileSync(path.join((process.env.WSB_TMP || require('os').tmpdir()), 'regrade/summary.json'), JSON.stringify(total, null, 1));
})().catch((e) => { console.error(e.stack || e); process.exit(3); });
