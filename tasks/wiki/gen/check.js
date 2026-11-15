#!/usr/bin/env node
'use strict';
// Bulk self-check of tasks/wiki/generated.jsonl against a running wiki site:
//  - answer_sql re-run through the control API (/__rl/query) and compared with the static reference
//    (the kit grader: the reference answer must pass);
//  - every must_include reference (one of its |OR| alternatives) appears in the visible text of the
//    rendered evidence article(s) (/wiki/<path>); numeric references: the shown value appears;
//  - url tasks: the reference URL serves 200 (after redirects) and, for a section, the page has
//    an element with that id;
//  - the grader passes the reference answer / URL and fails an empty answer / the Main Page.
//   node tasks/wiki/gen/check.js --site http://127.0.0.1:7540 [--tasks tasks/wiki/generated.jsonl] [--only tmpl,...]
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const ROOT = path.join(__dirname, '..', '..', '..');
const kitGrader = require(path.join(ROOT, 'kit', 'lib', 'grader'));
const grade = require(path.join(ROOT, 'sites', 'wiki', 'grade.js'));

const { values: a } = parseArgs({ options: {
  site: { type: 'string', default: 'http://127.0.0.1:7540' },
  tasks: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') },
  only: { type: 'string', default: '' },
} });
const only = new Set(a.only.split(',').filter(Boolean));
const query = kitGrader.remoteQuery(a.site, {});
const pageCache = new Map();
async function page(p) {
  if (pageCache.has(p)) return pageCache.get(p);
  const r = await fetch(a.site + '/wiki/' + encodeURIComponent(p).replace(/%2F/g, '/'));
  const html = await r.text();
  const text = html.replace(/<span style="display:none">[\s\S]*?<\/span>/g, ' ').replace(/<span class="mw-ref reference"[\s\S]*?<\/a><\/span>/g, ' ')
    .replace(/<\/?(sup|sub|abbr|b|i|span|a)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[   ]/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  const v = { status: r.status, text, html };
  if (pageCache.size > 500) pageCache.clear();
  pageCache.set(p, v);
  return v;
}
const clean = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

(async () => {
  const tasks = fs.readFileSync(a.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => !only.size || only.has(t.template));
  const bad = []; const per = {};
  for (const t of tasks) {
    const ev = t.eval; const errs = [];
    per[t.template] = per[t.template] || { n: 0, bad: 0 };
    per[t.template].n++;
    try {
      if (ev.answer_sql) {
        const rows = await query(ev.answer_sql);
        const got = rows.map((r) => String(Object.values(r)[0]));
        const want = ev.answer.must_include;
        if (!want.every((w) => got.some((g) => kitGrader.mustInclude(g, [w])))) errs.push(`answer_sql ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
      }
      const ansRef = ev.answer && ev.answer.must_include;
      if (ansRef && t.evidence && !/compare|whatlinkshere|redirect|count/.test(t.template)) {
        const texts = await Promise.all(t.evidence.map((p) => page(p).then((x) => x.text)));
        for (const w of ansRef) if (!w.split(' |OR| ').some((alt) => texts.some((tx) => tx.includes(clean(alt))))) errs.push(`"${w.slice(0, 60)}" not on ${t.evidence.join(', ')}`);
      }
      if (ev.answer && ev.answer.numeric && t.evidence) {
        const tx = (await page(t.evidence[0])).text;
        const shown = String(t.ref).toLowerCase().replace(/\s+/g, ' ').split(' (')[0].replace(/km2/, 'km2');
        if (!tx.includes(shown.replace(/km2/, 'km2')) && !tx.includes(shown.replace('km2', 'km 2'))) errs.push(`numeric shown "${shown}" not on page`);
      }
      if (ev.url) {
        const u = new URL(ev.url.replace(/^__WIKIPEDIA__/, a.site));
        const r = await fetch(a.site + u.pathname + u.search);
        if (r.status !== 200) errs.push(`url ${r.status}`);
        if (u.hash) { const html = await r.text(); const id = decodeURIComponent(u.hash.slice(1)); if (!html.includes(`id="${id.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)) errs.push(`no id ${id}`); }
      }
      // grader: the reference passes, an empty / wrong attempt fails
      const refAnswer = ev.answer ? (ev.answer.must_include ? ev.answer.must_include.map((w) => w.split(' |OR| ')[0]).join('; ') : ev.answer.numeric ? String(t.ref) : '') : undefined;
      const ok = await grade(t, { answer: refAnswer, url: ev.url ? ev.url.replace(/^__WIKIPEDIA__/, 'http://x') : undefined, query });
      if (ok.pass !== true) errs.push(`reference does not pass: ${JSON.stringify(ok.checks).slice(0, 200)}`);
      const no = await grade(t, { answer: 'I could not find it', url: 'http://x/wiki/Main_Page', query });
      if (no.pass !== false) errs.push('negative passes');
      if (ev.url && /#/.test(ev.url)) {
        const nofrag = await grade(t, { answer: undefined, url: ev.url.replace(/^__WIKIPEDIA__/, 'http://x').split('#')[0], query });
        if (nofrag.pass !== false) errs.push('section check passes without fragment');
      }
    } catch (e) { errs.push('error ' + e.message); }
    if (errs.length) { bad.push({ id: t.task_id, errs }); per[t.template].bad++; }
  }
  for (const [k, v] of Object.entries(per)) console.log(`${k.padEnd(42)} ${v.n - v.bad}/${v.n}`);
  for (const b of bad.slice(0, 60)) console.log(b.id, b.errs.join(' | '));
  console.log(`checked ${tasks.length}, bad ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
})();
