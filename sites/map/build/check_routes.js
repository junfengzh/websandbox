#!/usr/bin/env node
'use strict';
// Route the WebArena task pairs between geocoded endpoints and compare with the answers of
// WebArena's OSRM-based map (test.raw.json). Prints a markdown table for docs/NOTES-map.md.
//   node build/check_routes.js
const { Geocoder } = require('../lib/geocode');
const { RouteEngine } = require('../lib/route-core');
const { formatDuration, formatDistance, DEFAULT_DIR } = require('../lib/route');

const CMU = [-79.9436, 40.4443];
const T = [
  [16, '5000 Fifth Avenue, Pittsburgh', 'UPMC Family Health Center', 'car', '2min'],
  [16, '5000 Fifth Avenue, Pittsburgh', 'UPMC Family Health Center', 'foot', '16min'],
  [17, 'AMC Waterfront', 'Carnegie Mellon University', 'car', '13min'],
  [17, 'AMC Waterfront', 'Carnegie Mellon University', 'foot', '1h 35min'],
  [18, 'AMC Waterfront', 'University of Pittsburgh', 'car', '15min'],
  [19, 'Carnegie Science Center', 'Carnegie Mellon University', 'car', '12min'],
  [19, 'Carnegie Science Center', 'Carnegie Mellon University', 'foot', '1h 44min'],
  [20, 'Randyland', 'Carnegie Mellon University', 'car', '13min'],
  [20, 'Randyland', 'Carnegie Mellon University', 'foot', '1h 45min'],
  [52, 'Carnegie Mellon University', 'Starbucks Craig Street', 'foot', '7 min'],
  [53, 'University of Pittsburgh', 'Starbucks Craig Street', 'foot', '18 min'],
  [54, 'Carnegie Mellon University', 'University of Pittsburgh', 'foot', '25 min'],
  [56, 'Carnegie Museum of Art', 'Hunt Library', 'foot', '11 min'],
  [84, 'DoubleTree by Hilton New York Downtown', 'Keens Steakhouse', 'car', '14 minutes'],
  [85, 'La Quinta Inn Pittsburgh Airport', 'Carnegie Mellon University', 'car', '30 minutes'],
  [86, 'La Quinta Inn Pittsburgh Airport', 'University of Pittsburgh', 'car', '29 minutes'],
  [88, 'Homewood Suites Southpointe', 'PPG Paints Arena', 'car', '34 minutes'],
  [97, 'Carnegie Mellon University', 'Massachusetts Institute of Technology', 'car', '914km'],
  [137, 'Philadelphia', 'Pittsburgh', 'car', '5h 47min'],
  [138, 'New York', 'Philadelphia', 'car', '1h 58min'],
  [139, 'Scranton', 'Bridgeport', 'car', '3h 20min'],
  [140, 'Niagara Falls, New York', 'New Haven', 'car', '8h 33min'],
  [151, 'Carnegie Mellon University', 'University of Pittsburgh', 'car', '4min'],
  [152, 'Schenley Park', 'University of Pittsburgh', 'car', '4min'],
  [153, 'REI Pittsburgh', 'Carnegie Mellon University', 'car', '7min'],
  [155, 'Animal Rescue League of Pittsburgh', 'Schenley Park', 'car', '9min'],
  [265, 'Boston', 'Acadia National Park', 'car', '457km'],
  [267, 'Bangor', 'Acadia National Park', 'car', '1h 23min'],
  [268, 'Vinalhaven', 'Acadia National Park', 'bike', '10h 33min'],
  [287, 'Pittsburgh', 'Philadelphia', 'car', '5h 47min'],
  [363, 'Carnegie Mellon University', 'Carnegie Music Hall', 'foot', '748m'],
  [364, 'Carnegie Mellon University', 'UPMC Shadyside', 'foot', '1.7km'],
  [365, 'Carnegie Music Hall', 'UPMC Shadyside', 'foot', '2.2km'],
];

const g = new Geocoder();
const eng = new RouteEngine(DEFAULT_DIR);
console.log('| Task | From -> To | Mode | WebArena | Lite | ms |');
console.log('|---|---|---|---|---|---|');
for (const [task, a, b, mode, want] of T) {
  const A = g.search(a, { center: CMU })[0], B = g.search(b, { center: CMU })[0];
  if (!A || !B) { console.log(`| ${task} | ${a} -> ${b} | ${mode} | ${want} | geocode miss | |`); continue; }
  const r = eng.route([A.lon, A.lat], [B.lon, B.lat], mode);
  const got = r.code === 'Ok' ? `${formatDuration(r.duration)}, ${formatDistance(r.distance)}` : r.code;
  console.log(`| ${task} | ${a} -> ${b} | ${mode} | ${want} | ${got} | ${r.ms ?? ''} |`);
}
