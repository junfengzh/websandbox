#!/usr/bin/env node
'use strict';
// Geocode every WebArena task place (test/task_places.json) and print a markdown table
// (query -> top hit) for docs/NOTES-map.md. Exit code 1 if any expected hit is missing.
//   node build/check_places.js [geocode.db]
const path = require('path');
const { Geocoder } = require('../lib/geocode');
const spec = require('../test/task_places.json');

const g = new Geocoder(process.argv[2]);
let bad = 0;
const rows = [];
for (const p of spec.places) {
  const t = Date.now();
  const r = g.search(p.q, { center: spec.center, limit: 5 });
  const ms = Date.now() - t;
  const top = r[0];
  const ok = !!top && (top.display_name || '').toLowerCase().includes(p.expect.toLowerCase());
  const any = r.findIndex((x) => (x.display_name || '').toLowerCase().includes(p.expect.toLowerCase()));
  if (!ok) bad++;
  rows.push(`| ${p.q} | ${top ? `${top.display_name.replace(/\|/g, '/')} (${top.class}/${top.type})` : '-'} | ${ok ? 'ok' : any > 0 ? `#${any + 1}` : 'MISS'} | ${ms} | ${p.tasks.join(' ')} |`);
}
console.log('| Query | Top hit (display_name, class/type) | OK | ms | Tasks |');
console.log('|---|---|---|---|---|');
for (const r of rows) console.log(r);
console.log(`\n${spec.places.length - bad}/${spec.places.length} top hits as expected`);
process.exitCode = bad ? 1 : 0;
void path;
