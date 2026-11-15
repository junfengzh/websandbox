#!/usr/bin/env node
'use strict';
// Self-check of the generated map tasks against a running map server (sites/map/server.js):
//   node tasks/map/gen/check.js [--site http://127.0.0.1:7640] [--tasks tasks/map/generated.jsonl] [--only tpl,tpl] [--ui]
// Every task: the reference (reference_answer / reference_url) passes sites/map/grade.js; an empty
// answer, "I could not find it" and a perturbed answer (numbers x1.6, another name) / the home
// page fail; answer_sql re-derives the static reference (no drift).
// --ui additionally replays the UI path over HTTP, from a plain load (CMU ranking) and with the
// task view's centre (X-Map-Center, as the page script sends it):
//   place facts / open-place: search the name -> first result -> place page; the page text passes
//     the answer check / the page URL passes the place check;
//   single-leg routes: the directions form (route_from/route_to = the names) -> the shown time /
//     distance passes the numeric check;
//   directions tasks: the form's redirect URL passes the directions check.
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const kit = require('../../../kit');
const grade = require('../../../sites/map/grade');

const { values: A } = parseArgs({ options: { site: { type: 'string', default: 'http://127.0.0.1:7640' }, tasks: { type: 'string', default: path.join(__dirname, '..', 'generated.jsonl') },
  only: { type: 'string' }, ui: { type: 'boolean' } } });
const query = kit.grader.remoteQuery(A.site, {});

const viewCentre = (u) => { const m = /#map=\d+\/(-?[\d.]+)\/(-?[\d.]+)/.exec(u); return m ? `${m[2]},${m[1]}` : null; };
async function get(u, centre) {
  const r = await fetch(new URL(u, A.site), { headers: centre ? { 'x-map-center': centre } : {}, redirect: 'follow' });
  return { url: r.url.replace(/^https?:\/\/[^/]+/, ''), html: await r.text(), status: r.status };
}
const text = (html) => {
  const m = /<article class="place"[\s\S]*?<\/article>/.exec(html);
  return (m ? m[0] : html).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#x([0-9a-f]+);/gi, (x, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (x, n) => String.fromCodePoint(+n)).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
};
const firstResult = (html) => { const m = /<a class="set_position" href="([^"]+)"/.exec(html); return m ? m[1] : null; };

function perturb(t) {
  const ev = t.eval;
  if (ev.type !== 'answer') return null;
  // numbers x1.6 (+3), names replaced: must fail
  let s = String(t.reference_answer).replace(/-?\d+(\.\d+)?/g, (x) => String(+(Math.abs(+x) * 1.6 + 3).toFixed(x.includes('.') ? 4 : 0)));
  const specs = [].concat(ev.answer);
  if (specs.every((x) => x.must_include)) s = 'Somewhere Else Entirely 999';
  return s;
}

async function main() {
  let tasks = fs.readFileSync(A.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  if (A.only) { const o = new Set(A.only.split(',')); tasks = tasks.filter((t) => o.has(t.template.replace(/^gen-map-/, ''))); }
  const per = new Map();
  const bad = [];
  let i = 0;
  for (const t of tasks) {
    i++;
    const problems = [];
    const ev = t.eval;
    const isAns = ev.type === 'answer';
    const inp = (x) => (isAns ? { answer: x, url: '/', query } : { answer: '', url: x, query });
    const ok = await grade(t, inp(isAns ? t.reference_answer : t.reference_url));
    if (ok.pass !== true) problems.push(`reference fails: ${JSON.stringify(ok.checks.filter((c) => !c.pass)).slice(0, 300)}`);
    for (const c of ok.checks) if (c.drift) problems.push(`drift: ${JSON.stringify(c.reference)} vs ${JSON.stringify(c.sql_reference)}`);
    for (const d of isAns ? ['', 'I could not find it', perturb(t)] : ['/', '/search?query=nothing']) {
      const g = await grade(t, inp(d));
      if (g.pass !== false) problems.push(`decoy "${d}" passes`);
    }
    if (ev.type === 'directions') {
      const u = new URL(t.reference_url, 'http://x');
      const other = u.searchParams.get('engine') === 'fossgis_osrm_car' ? 'fossgis_osrm_foot' : 'fossgis_osrm_car';
      u.searchParams.set('engine', other);
      if ((await grade(t, inp(u.pathname + u.search))).pass !== false) problems.push('other mode passes');
    }
    if (A.ui) problems.push(...await ui(t));
    const s = per.get(t.template) || { n: 0, bad: 0 };
    s.n++;
    if (problems.length) { s.bad++; bad.push({ id: t.task_id, problems }); }
    per.set(t.template, s);
    if (i % 200 === 0) console.error(`${i}/${tasks.length}`);
  }
  for (const [k, s] of per) console.log(`${k.padEnd(40)} ${String(s.n).padStart(4)} ${s.bad ? 'BAD ' + s.bad : 'ok'}`);
  for (const b of bad.slice(0, 60)) console.log(b.id, b.problems.join(' | '));
  console.log(`${tasks.length} tasks, ${bad.length} with problems`);
  process.exit(bad.length ? 1 : 0);
}

const FACTS = new Set(['place-address', 'place-postcode', 'place-hours', 'place-phone', 'place-website', 'place-category', 'place-cuisine', 'place-coords', 'place-area', 'peak-elevation']);
const LEG = { 'drive-time': 'car', 'drive-distance': 'car', 'walk-time': 'foot', 'walk-distance': 'foot', 'bike-time': 'bike' };
const ENG = { car: 'fossgis_osrm_car', bike: 'fossgis_osrm_bike', foot: 'fossgis_osrm_foot' };
async function ui(t) {
  const name = t.template.replace(/^gen-map-/, '');
  const d = t.instantiation_dict;
  const out = [];
  for (const centre of [null, viewCentre(t.start_url)]) {
    const tag = centre ? 'view' : 'plain';
    if (FACTS.has(name) || name === 'open-place') {
      const s = await get(`/search?query=${encodeURIComponent(d.name)}`, centre);
      const href = firstResult(s.html);
      if (!href) { out.push(`${tag}: no search result`); continue; }
      if (name === 'open-place') {
        if ((await grade(t, { url: href, query })).pass !== true) out.push(`${tag}: first result ${href} fails`);
        continue;
      }
      const page = await get(href, centre);
      const g = await grade(t, { answer: text(page.html), query });
      if (g.pass !== true) out.push(`${tag}: page ${href} lacks the reference ${JSON.stringify(g.checks.filter((c) => !c.pass).map((c) => c.reference))}`);
    } else if (LEG[name]) {
      const r = await get(`/directions?engine=${ENG[LEG[name]]}&route_from=${encodeURIComponent(d.a)}&route_to=${encodeURIComponent(d.b)}`, centre);
      const m = /data-meters="(\d+)">([^<]*)<\/span>.*?data-seconds="(\d+)">([^<]*)</s.exec(r.html);
      if (!m) { out.push(`${tag}: no route`); continue; }
      const g = await grade(t, { answer: name.endsWith('distance') ? m[2] : m[4], query });
      if (g.pass !== true) out.push(`${tag}: UI shows ${m[2]} / ${m[4]}, reference ${t.reference_answer}`);
    } else if (name === 'directions-show' || name === 'directions-from-coords') {
      const from = name === 'directions-show' ? d.a : d.coords;
      const eng = t.eval.directions.engine;
      const r = await get(`/directions?engine=${ENG[eng]}&route_from=${encodeURIComponent(from)}&route_to=${encodeURIComponent(d.b)}`, centre);
      const g = await grade(t, { url: r.url, query });
      if (g.pass !== true) out.push(`${tag}: form -> ${r.url.slice(0, 120)} fails ${JSON.stringify(g.checks.map((c) => c.why))}`);
    } else if (name === 'search-category-near' || name === 'open-place-by-address') {
      if (name === 'search-category-near') {
        const s = await get(t.reference_url, centre);
        if (!/class="search_results_entry"/.test(s.html)) out.push(`${tag}: search lists nothing`);
      } else {
        const s = await get(`/search?query=${encodeURIComponent(d.addr + d.where)}`, centre);
        const hrefs = [...s.html.matchAll(/<a class="set_position" href="([^"]+)"/g)].map((m) => m[1]).slice(0, 3);
        if (!hrefs.includes(t.reference_url)) out.push(`${tag}: address search top 3 ${hrefs.join(' ')} lacks ${t.reference_url}`);
      }
    }
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(3); });
