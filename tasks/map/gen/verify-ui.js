#!/usr/bin/env node
'use strict';
// UI verification of the generated map templates (docs/GENERATOR.md "Validation"): for each
// template, instances are done through the site's UI in headless Chrome with
// tasks/tools/browse.js -- the steps a person takes (search box, result link, place facts,
// "What's nearby?", directions form, mode select, "Directions to here") -- the answer is read off
// the page (or the final URL taken), and graded with tasks/tools/grade.js --log; plus one negative
// check per template (a plausible wrong answer / end state, --expect-fail).
//   node tasks/tools/browse.js start --port 7641   (once; headless Chrome)
//   node tasks/map/gen/verify-ui.js --site http://127.0.0.1:7640 --port 7641 [--only t,t] [--pick 1,7] [--log tasks/map/verify-generated.jsonl] [--dry]
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { parseArgs } = require('util');

const ROOT = path.resolve(__dirname, '../../..');
const { values: A } = parseArgs({ options: {
  site: { type: 'string', default: 'http://127.0.0.1:7640' }, port: { type: 'string', default: '7641' }, only: { type: 'string' },
  pick: { type: 'string', default: '1,7' }, log: { type: 'string', default: path.join(ROOT, 'tasks/map/verify-generated.jsonl') },
  tasks: { type: 'string', default: path.join(ROOT, 'tasks/map/generated.jsonl') }, dry: { type: 'boolean' } } });

const b = (...args) => execFileSync('node', [path.join(ROOT, 'tasks/tools/browse.js'), ...args, '--port', A.port], { encoding: 'utf8', maxBuffer: 1 << 24 });
const goto = (u) => b('goto', u.replace(/^__MAP__/, A.site));
const url = () => b('url').trim();
const snap = () => b('snapshot', '--max', '40000');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** [N, text, href] of snapshot links */
const links = (s) => [...s.matchAll(/\[(\d+)\] link "([^"]*)" -> (\S+)/g)].map((m) => ({ n: m[1], text: m[2], href: m[3] }));
function clickLink(pred, what) {
  const l = links(snap()).find(pred);
  if (!l) throw new Error(`no link: ${what}`);
  b('click', l.n);
  return l;
}
const search = (text) => b('type', '@input\\[search\\]', text, '--enter');
const firstResult = () => clickLink((l) => /^\/(node|way|relation|place)\//.test(l.href) && !/^(©|About)/.test(l.text), 'first search result');
const facts = () => JSON.parse(JSON.parse(b('eval', "JSON.stringify(Object.fromEntries([...document.querySelectorAll('dl.place-facts dt')].map(d => [d.textContent.trim(), d.nextElementSibling.textContent.trim()])))").trim()));
const evalJ = (js) => JSON.parse(JSON.parse(b('eval', `JSON.stringify(${js})`).trim()));
const ENGINE_LABEL = { car: 'Car (OSRM)', bike: 'Bicycle (OSRM)', foot: 'Foot (OSRM)' };
/** fill the directions form and press Go; returns {time, dist, url} as shown */
function directions(from, to, mode) {
  if (!/\/directions/.test(url())) clickLink((l) => l.text === 'Directions', 'Directions menu');
  b('select', '@select "Mode"', ENGINE_LABEL[mode]);
  b('type', '@input\\[text\\] "From"', from);
  b('type', '@input\\[text\\] "To"', to);
  b('click', '@button "Go"');
  return summary();
}
const summary = () => evalJ("{time: (document.querySelector('.route-time') || {}).textContent || null, dist: (document.querySelector('.route-distance') || {}).textContent || null, first: (document.querySelector('.routing_step .step-text') || {}).textContent || null, url: location.pathname + location.search}");
/** "What's nearby?" from the current place page: [{name, dist (m), href}] */
function nearbyList(cat) {
  b('select', '@select "What', cat);
  b('submit', '@select "What');
  return evalJ("[...document.querySelectorAll('ol.query-results li')].map(li => ({name: li.querySelector('a').textContent, href: li.querySelector('a').getAttribute('href'), d: li.querySelector('.result-distance').textContent}))")
    .map((x) => ({ ...x, m: /km/.test(x.d) ? parseFloat(x.d) * 1000 : parseFloat(x.d) }));
}
const minutes = (t) => { const m = /(?:(\d+)h\s*)?(\d+)\s*min/.exec(t || ''); return m ? (+(m[1] || 0)) * 60 + +m[2] : null; };
const fmtMin = (n) => (n < 60 ? `${n} min` : `${Math.floor(n / 60)}h ${n % 60}min`);
const openPlace = (name) => { search(name); return firstResult(); };

// ---------------------------------------------------------------- procedures per template
// each: (task) -> {how, answer? , url?, neg: {answer? | url?, why}}
const DAYS = { Monday: 'Mo', Tuesday: 'Tu', Wednesday: 'We', Thursday: 'Th', Friday: 'Fr', Saturday: 'Sa', Sunday: 'Su' };
const F = require('./facts');
const fact = (key, toAnswer, neg) => (t) => {
  const d = t.instantiation_dict;
  goto(t.start_url);
  const l = openPlace(d.name);
  const f = facts();
  const v = f[key];
  if (v == null) throw new Error(`no ${key} on ${l.href}`);
  const answer = toAnswer(v, f, d);
  return { how: `search "${d.name}" -> first result ${l.href} -> ${key}: "${v}"`, answer, neg: neg(v, f, d) };
};
const P = {
  'place-address': fact('Address', (v) => { const s = v.split(', '); return `${s[1]} ${s[2]}`; }, (v) => ({ answer: v.split(', ')[2], why: 'street without the house number' })),
  'place-postcode': fact('Postcode', (v) => v, (v) => ({ answer: v.replace(/\d$/, (c) => String((+c + 3) % 10)), why: 'postcode with a wrong last digit' })),
  'place-hours': fact('Opening hours', (v, f, d) => { const h = F.parseHours(v)[DAYS[d.day]]; return `${h[0]} to ${h[1]}`; }, (v, f, d) => {
    const h = F.parseHours(v); const other = Object.entries(h).find(([k, x]) => k !== DAYS[d.day] && (x[0] !== h[DAYS[d.day]][0] || x[1] !== h[DAYS[d.day]][1]));
    return other ? { answer: `${other[1][0]} to ${other[1][1]}`, why: `hours of another day (${other[0]})` } : { answer: '08:15 to 15:45', why: 'made-up hours' };
  }),
  'place-phone': fact('Phone', (v) => v, (v) => ({ answer: v.replace(/\d(?=\D*$)/, (c) => String((+c + 1) % 10)), why: 'last digit wrong' })),
  'place-website': fact('Website', (v) => v, () => ({ answer: 'www.example.com', why: 'other site' })),
  'place-category': fact('Category', (v) => v.replace(/\s*\(.*\)$/, ''), () => ({ answer: 'It is an office building', why: 'wrong kind' })),
  'place-cuisine': fact('Cuisine', (v) => v, (v) => ({ answer: /italian/i.test(v) ? 'Mexican' : 'Italian', why: 'other cuisine' })),
  'place-coords': fact('Coordinates', (v) => v, (v) => { const [la, lo] = v.split(', ').map(Number); return { answer: `${(la + 0.01).toFixed(6)}, ${lo.toFixed(6)}`, why: 'latitude off by 0.01 deg (~1.1 km)' }; }),
  'place-area': fact('Address', (v) => v.split(', ').find((s) => / County$|^London Borough of |^Royal Borough of |^City of /.test(s) && s !== 'City of London' || s === 'City of London'),
    (v) => ({ answer: v.split(', ').find((s) => / County$/.test(s)) ? 'Somerset County' : 'Barnet', why: 'another county/borough' })),
  'peak-elevation': fact('Elevation', (v) => v, (v) => ({ answer: `${Math.round(parseFloat(v) * 1.2 + 10)} m`, why: 'elevation +20 %' })),

  'reverse-place': (t) => {
    goto(t.start_url); search(t.instantiation_dict.coords);
    const r = evalJ("[...document.querySelectorAll('.search_results_entry')].map(li => li.textContent.replace(/\\s+/g, ' ').trim())");
    const name = r[0].replace(/^\S+( \S+)? /, '').split(', ')[0];
    const first = evalJ("(document.querySelector('.search_results_entry a') || {}).textContent || ''").split(', ')[0];
    return { how: `search "${t.instantiation_dict.coords}" -> Where is this? first result "${r[0].slice(0, 100)}"`, answer: first || name, neg: { answer: (r[1] || 'Main Street').split(', ')[0].replace(/^\S+ (Road )?/, ''), why: 'the second result (street) instead of the place' } };
  },
  'reverse-street': (t) => {
    goto(t.start_url); search(t.instantiation_dict.coords);
    const r = evalJ("[...document.querySelectorAll('.search_results_entry')].map(li => ({type: li.querySelector('.result-type').textContent, name: li.textContent.replace(/\\s+/g, ' ').trim()}))");
    const st = r.find((x) => /Road|Street|Footway|Path|Pedestrian|Living Street|Service/.test(x.type) || / (Street|Avenue|Road|Lane|Place|Drive|Way|Boulevard|Crescent)\b/.test(x.name.split(', ')[0])) || r[1];
    const name = st.name.slice(st.type.length).trim().split(', ')[0];
    return { how: `search "${t.instantiation_dict.coords}" -> Where is this? street result "${st.name.slice(0, 100)}"`, answer: name, neg: { answer: 'High Street', why: 'another street' } };
  },
  'reverse-postcode': (t) => {
    goto(t.start_url); search(t.instantiation_dict.coords);
    clickLink((l) => l.text === 'Query features here', 'Query features');
    const enc = evalJ("[...document.querySelectorAll('ul.enclosing li')].map(li => li.textContent.replace(/\\s+/g, ' ').trim())");
    const pc = (enc.find((x) => /^Postcode /.test(x)) || '').replace(/^Postcode /, '');
    return { how: `search "${t.instantiation_dict.coords}" -> Where is this? -> Query features here -> enclosing "Postcode ${pc}"`, answer: pc, neg: { answer: pc.replace(/\d/, (c) => String((+c + 1) % 10)), why: 'one digit changed' } };
  },

  'nearest-category': (t) => {
    const d = t.instantiation_dict; goto(t.start_url); const l = openPlace(d.name);
    const v = require('./nearby').CATS.find((c) => c.one === d.cat).v;
    const list = nearbyList(v).filter((x) => x.name !== d.name);
    return { how: `search "${d.name}" -> ${l.href} -> What's nearby? ${v}: 1. ${list[0].name} ${list[0].d}, 2. ${list[1].name} ${list[1].d}`, answer: list[0].name, neg: { answer: list[1].name, why: 'the runner-up' } };
  },
  'nearest-category-distance': (t) => {
    const d = t.instantiation_dict; goto(t.start_url); const l = openPlace(d.name);
    const v = require('./nearby').CATS.find((c) => c.one === d.cat).v;
    const list = nearbyList(v).filter((x) => x.name !== d.name);
    return { how: `search "${d.name}" -> ${l.href} -> What's nearby? ${v}: 1. ${list[0].name} ${list[0].d}`, answer: `${list[0].name}, ${list[0].d.replace(/ \(.*/, '')}`, neg: { answer: `${list[0].name}, ${Math.round(list[0].m * 1.5 + 50)} m`, why: 'right name, distance +50 %' } };
  },
  'count-within-radius': (t) => {
    const d = t.instantiation_dict; goto(t.start_url); const l = openPlace(d.name);
    const v = require('./nearby').CATS.find((c) => c.many === d.cats).v;
    const R = /km/.test(d.radius) ? parseFloat(d.radius) * 1000 : parseFloat(d.radius);
    const list = nearbyList(v).filter((x) => x.name !== d.name);
    const n = list.filter((x) => x.m <= R).length;
    return { how: `search "${d.name}" -> ${l.href} -> What's nearby? ${v}: ${list.slice(0, n + 1).map((x) => `${x.name} ${x.d.replace(/ \(.*/, '')}`).join('; ')} -> ${n} within ${d.radius}`, answer: String(n), neg: { answer: String(n + 1), why: 'one too many' } };
  },
  'nearest-walk-time': (t) => {
    const d = t.instantiation_dict; goto(t.start_url); const l = openPlace(d.name);
    const v = require('./nearby').CATS.find((c) => c.one === d.cat).v;
    const list = nearbyList(v).filter((x) => x.name !== d.name);
    b('goto', A.site + list[0].href);
    clickLink((x) => x.text === 'Directions to here', 'Directions to here');
    const s = directions(d.name, evalJ("document.querySelector('[name=route_to]').value"), 'foot');
    return { how: `search "${d.name}" -> ${l.href} -> What's nearby? ${v}: ${list[0].name} -> its page -> Directions to here -> From "${d.name}", Foot -> ${s.dist}, ${s.time}`, answer: `${list[0].name}, ${s.time}`, neg: { answer: `${list[1].name}, ${s.time}`, why: 'the runner-up with the right time' } };
  },
};
const leg = (mode, kind) => (t) => {
  const d = t.instantiation_dict; goto(t.start_url);
  const s = directions(d.a, d.b, mode);
  const other = mode === 'car' ? 'foot' : 'car';
  return { how: `Directions -> ${mode}, From "${d.a}", To "${d.b}" -> Go -> ${s.dist}, ${s.time}`, url: s.url, answer: kind === 'time' ? s.time : s.dist,
    neg: { answer: kind === 'time' ? fmtMin(Math.round(minutes(s.time) * 1.5 + 3)) : `${(parseFloat(s.dist) * (/km/.test(s.dist) ? 1.5 : 0.0015)).toFixed(1)} km`, why: '+50 %' }, other };
};
Object.assign(P, {
  'drive-time': leg('car', 'time'), 'drive-distance': leg('car', 'dist'), 'walk-time': leg('foot', 'time'), 'walk-distance': leg('foot', 'dist'), 'bike-time': leg('bike', 'time'),
  'compare-modes': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    const mode = { 'by car': 'car', 'by bike': 'bike', 'on foot': 'foot' };
    const s1 = directions(d.a, d.b, mode[d.m1]);
    clickLink((l) => l.text === { 'by car': 'By car', 'by bike': 'By bicycle', 'on foot': 'On foot' }[d.m2], 'other mode link');
    const s2 = summary();
    return { how: `Directions ${mode[d.m1]} "${d.a}" -> "${d.b}": ${s1.time}; then the "${d.m2}" link: ${s2.time}`, url: s2.url, answer: `${d.m1}: ${s1.time}; ${d.m2}: ${s2.time}`, neg: { answer: `${d.m1}: ${s1.time}; ${d.m2}: ${fmtMin(Math.round(minutes(s2.time) * 1.6 + 4))}`, why: 'second time wrong' } };
  },
  'mode-difference': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    const m = { drive: 'car', cycle: 'bike', walk: 'foot' };
    const sf = directions(d.a, d.b, m[d.fast]);
    const ss = directions(d.a, d.b, m[d.slow]);
    const diff = minutes(ss.time) - minutes(sf.time);
    return { how: `Directions "${d.a}" -> "${d.b}": ${m[d.fast]} ${sf.time}, ${m[d.slow]} ${ss.time} -> difference ${diff} min`, url: ss.url, answer: `${diff} minutes`, neg: { answer: `${minutes(ss.time)} minutes`, why: 'the slow time instead of the difference' } };
  },
  'compare-destinations': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    const mode = { driving: 'car', cycling: 'bike', walking: 'foot' }[d.noun];
    const sb = directions(d.a, d.b, mode), sc = directions(d.a, d.c, mode);
    const [w, s, l] = minutes(sb.time) < minutes(sc.time) ? [d.b, sb, d.c] : [d.c, sc, d.b];
    return { how: `Directions ${mode} "${d.a}" -> "${d.b}" ${sb.time}; -> "${d.c}" ${sc.time}`, url: sc.url, answer: `${w}, ${s.time}`, neg: { answer: `${l}, ${(minutes(sb.time) < minutes(sc.time) ? sc : sb).time}`, why: 'the slower destination' } };
  },
  'closest-of-n': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    const names = d.list.split(/, | or /);
    const res = names.map((n) => ({ n, s: directions(d.a, n, 'foot') }));
    res.sort((x, y) => minutes(x.s.time) - minutes(y.s.time));
    return { how: `Directions foot from "${d.a}": ${res.map((x) => `${x.n} ${x.s.time}`).join('; ')}`, url: res[res.length - 1].s.url, answer: `${res[0].n}, ${res[0].s.time}`, neg: { answer: `${res[1].n}, ${res[1].s.time}`, why: 'the second-quickest' } };
  },
  'multi-leg-trip': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    const mode = { drive: 'car', cycle: 'bike', walk: 'foot' }[d.verb];
    const s1 = directions(d.a, d.b, mode), s2 = directions(d.b, d.c, mode);
    const tot = minutes(s1.time) + minutes(s2.time);
    return { how: `Directions ${mode} "${d.a}" -> "${d.b}" ${s1.time}; "${d.b}" -> "${d.c}" ${s2.time}; total ${tot} min`, url: s2.url, answer: fmtMin(tot), neg: { answer: s2.time, why: 'only the second leg' } };
  },
  'route-first-street': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    const mode = { driving: 'car', cycling: 'bike', walking: 'foot' }[d.noun];
    const s = directions(d.a, d.b, mode);
    const st = s.first.replace(/^Head \w+ on /, '');
    return { how: `Directions ${mode} "${d.a}" -> "${d.b}": first step "${s.first}"`, url: s.url, answer: st, neg: { answer: 'Broadway', why: 'another street' } };
  },

  'directions-show': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    const mode = { driving: 'car', cycling: 'bike', walking: 'foot' }[d.noun];
    const s = directions(d.a, d.b, mode);
    const u = new URL(s.url, 'http://x'); u.searchParams.set('engine', mode === 'car' ? 'fossgis_osrm_foot' : 'fossgis_osrm_car');
    return { how: `Directions -> ${mode}, From "${d.a}", To "${d.b}" -> Go -> ${s.dist}, ${s.time}`, url: s.url, neg: { url: u.pathname + u.search, why: 'same route, other mode' } };
  },
  'directions-to-nearest': (t) => {
    const d = t.instantiation_dict; goto(t.start_url); const l = openPlace(d.name);
    const v = require('./nearby').CATS.find((c) => c.one === d.cat).v;
    const list = nearbyList(v).filter((x) => x.name !== d.name);
    b('goto', A.site + list[0].href);
    clickLink((x) => x.text === 'Directions to here', 'Directions to here');
    const mode = { walking: 'foot', cycling: 'bike' }[d.noun];
    const s = directions(d.name, evalJ("document.querySelector('[name=route_to]').value"), mode);
    const s2 = directions(d.name, list[1].name, mode);
    return { how: `search "${d.name}" -> ${l.href} -> What's nearby? ${v}: ${list[0].name} -> Directions to here -> From "${d.name}", ${mode} -> ${s.dist}, ${s.time}`, url: s.url, neg: { url: s2.url, why: `route to the runner-up "${list[1].name}" (typed)` } };
  },
  'directions-from-coords': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    const s = directions(d.coords, d.b, 'car');
    const [la, lo] = d.coords.split(', ').map(Number);
    const s2 = directions(`${(la + 0.01).toFixed(5)}, ${lo}`, d.b, 'car');
    return { how: `Directions -> car, From "${d.coords}", To "${d.b}" -> Go -> ${s.dist}, ${s.time}`, url: s.url, neg: { url: s2.url, why: 'start 1.1 km off' } };
  },
  'search-category-near': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    search(`${d.cats} near ${d.name}`);
    const n = evalJ("document.querySelectorAll('.search_results_entry').length");
    const first = evalJ("(document.querySelector('.search_results_entry') || {}).textContent || ''").replace(/\s+/g, ' ').trim();
    return { how: `search "${d.cats} near ${d.name}" -> ${n} results, first "${first.slice(0, 90)}"`, url: url().replace(A.site, ''), neg: { url: `/search?query=${encodeURIComponent(`${d.cats} near Buckingham Palace`)}`, why: 'near another place' } };
  },
  'open-place': (t) => {
    const d = t.instantiation_dict; goto(t.start_url); const l = openPlace(d.name);
    return { how: `search "${d.name}" -> first result ${l.href}`, url: url().replace(A.site, ''), neg: { url: links(snap()).find((x) => /^\/(node|way)\//.test(x.href) && x.text !== d.name).href, why: 'a neighbour from the Nearby list' } };
  },
  'open-place-by-address': (t) => {
    const d = t.instantiation_dict; goto(t.start_url);
    search(d.addr + d.where);
    const rs = evalJ("[...document.querySelectorAll('.search_results_entry')].map(li => ({type: li.querySelector('.result-type').textContent.trim(), href: li.querySelector('a').getAttribute('href'), name: li.querySelector('a').textContent}))");
    const hit = rs.find((x) => x.type.toLowerCase() === d.kind) || rs[0];
    b('goto', A.site + hit.href);
    const nb = links(snap()).find((x) => /^\/(node|way)\//.test(x.href) && x.href !== hit.href);
    return { how: `search "${d.addr}${d.where}" -> results ${rs.slice(0, 3).map((x) => `${x.type}: ${x.name.split(', ')[0]}`).join('; ')} -> the ${d.kind} ${hit.href}`, url: hit.href, neg: { url: nb ? nb.href : '/node/1', why: 'a neighbour at the same address block' } };
  },
  'open-nearest-place': (t) => {
    const d = t.instantiation_dict; goto(t.start_url); const l = openPlace(d.name);
    const v = require('./nearby').CATS.find((c) => c.one === d.cat).v;
    const list = nearbyList(v).filter((x) => x.name !== d.name);
    b('goto', A.site + list[0].href);
    return { how: `search "${d.name}" -> ${l.href} -> What's nearby? ${v}: 1. ${list[0].name} ${list[0].d} -> ${list[0].href}`, url: list[0].href, neg: { url: list[1].href, why: `the runner-up ${list[1].name} ${list[1].d}` } };
  },
});

function gradeLog(t, r, negative) {
  const args = [path.join(ROOT, 'tasks/tools/grade.js'), '--site', A.site, '--tasks', A.tasks, '--id', t.task_id, '--grader', path.join(ROOT, 'sites/map/grade.js')];
  const x = negative ? r.neg : r;
  if (t.eval.type === 'answer') args.push('--answer', x.answer, '--url', x.url || r.url || url().replace(A.site, ''));
  else args.push('--url', x.url);
  args.push('--how', negative ? `NEGATIVE (${r.neg.why}): ${r.how}` : r.how, '--notes', negative ? r.neg.why : 'browse.js UI run (verify-ui.js)');
  if (!A.dry) args.push('--log', A.log);
  if (negative) args.push('--expect-fail');
  try { return { code: 0, out: execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; }
}

function main() {
  const tasks = fs.readFileSync(A.tasks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const by = new Map();
  for (const t of tasks) { if (!by.has(t.template)) by.set(t.template, []); by.get(t.template).push(t); }
  const only = A.only ? new Set(A.only.split(',')) : null;
  const picks = A.pick.split(',').map(Number);
  let fails = 0;
  for (const [tpl, ts] of by) {
    const name = tpl.replace(/^gen-map-/, '');
    if (only && !only.has(name)) continue;
    const proc = P[name];
    if (!proc) { console.log(`${name}: no procedure`); fails++; continue; }
    for (const [i, k] of picks.entries()) {
      const t = ts[Math.min(k, ts.length) - 1];
      let r;
      try { r = proc(t); } catch (e) { console.log(`${t.task_id} ERROR ${String(e.message).split('\n')[0]}`); fails++; continue; }
      const g = gradeLog(t, r, false);
      console.log(`${t.task_id} ${g.code === 0 ? 'PASS' : 'FAIL'}  ${r.how.slice(0, 200)}${t.eval.type === 'answer' ? `  answer="${r.answer}"` : `  url=${r.url.slice(0, 100)}`}`);
      if (g.code !== 0) { fails++; console.log('   ', g.out.slice(0, 600)); }
      if (i === 0) {
        const n = gradeLog(t, r, true);
        console.log(`${t.task_id} NEG ${n.code === 1 ? 'fails as expected' : 'PASSES (bad)'}  (${r.neg.why})`);
        if (n.code !== 1) { fails++; console.log('   ', n.out.slice(0, 400)); }
      }
    }
  }
  console.log(`done, ${fails} problems`);
  process.exit(fails ? 1 : 0);
}
main();
