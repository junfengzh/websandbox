#!/usr/bin/env node
'use strict';
// Convert the 109 WebArena map-only tasks (test.raw.json, sites == ["map"]) to the map lite site.
//   node tasks/map/convert.js [--site http://127.0.0.1:7620] [--out tasks/map/webarena.jsonl]
// Needs a running map server (sites/map/server.js): every route time/distance is re-derived on
// OUR engines through the directions form (route_from/route_to -> geocoded top hit -> canonical
// URL), exactly what an agent sees in the UI, and recorded in the task's `changes`.
// Eval forms (kit/README.md "Grading", sites/map/grade.js): answer.must_include / fuzzy /
// numeric {value, unit, tol_*} (lists of specs), and the map checks directions / place / search
// on the final URL (WebArena program_html / url_match).
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const ROOT = path.resolve(__dirname, '..', '..');
const RAW = '$WEBARENA_TASKS';
const { values: A } = parseArgs({ options: { site: { type: 'string', default: 'http://127.0.0.1:7620' }, out: { type: 'string', default: path.join(__dirname, 'webarena.jsonl') } } });

// Default view = CMU, as on the WebArena map; explicit in the start URL so search ranking (which
// uses the map view centre, like OSM's viewbox) starts from the same place in every rollout.
const START = '__MAP__/#map=15/40.4443/-79.9436';

// ---------------------------------------------------------------- engine helpers
const cache = new Map();
async function leg(engine, from, to) {
  const k = [engine, from, to].join('|');
  if (cache.has(k)) return cache.get(k);
  const u = new URL('/directions', A.site);
  u.searchParams.set('engine', engine); u.searchParams.set('route_from', from); u.searchParams.set('route_to', to);
  const r = await fetch(u);
  const h = await r.text();
  const m = h.match(/data-meters="(\d+)">([^<]*)<\/span>.*?data-seconds="(\d+)">([^<]*)</s);
  if (!m) throw new Error(`no route: ${engine} ${from} -> ${to}`);
  const fin = new URL(r.url);
  const out = { engine, meters: +m[1], dist: m[2], secs: +m[3], time: m[4], from: fin.searchParams.get('from'), to: fin.searchParams.get('to'), route: fin.searchParams.get('route') };
  cache.set(k, out);
  return out;
}
const shown = (l) => Math.round(l.secs / 60); // minutes as the UI rounds them
const legNote = (l) => `${l.engine} ${l.from.split(',')[0]} -> ${l.to.split(',')[0]}: ${l.dist}, ${l.time}`;
// duration spec in minutes: short trips +-1 min, else 10 % (3 % for long trips; endpoints of a
// city/area vary by a few minutes)
function durSpec(min) {
  if (min <= 10) return { value: min, unit: 'min', tol_abs: 1 };
  if (min > 120) return { value: min, unit: 'min', tol_pct: 3, tol_abs: 5 };
  return { value: min, unit: 'min', tol_pct: 10, tol_abs: 1 };
}
const distSpec = (meters) => (meters < 1000 ? { value: meters, unit: 'm', tol_pct: 10, tol_abs: 30 } : { value: +(meters / 1000).toFixed(2), unit: 'km', tol_pct: 10 });
const fmtMin = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}min`);

// reference points (lat, lon) of places used by directions / search checks
const PT = {
  cmu: [40.4436977, -79.9434082], gates: [40.4438999, -79.9443914], indep: [39.9488951, -75.150009],
  pgh: [40.4406968, -80.0025666], nyc: [40.7127281, -74.0060152], portland: [43.6591, -70.2568],
  kamin: [40.4455861, -80.0179257], hunt: [40.441144, -79.9437501], carnegieHall: [40.7649124, -73.9798467],
  shady401: [40.4552249, -79.9211099], traderJoes: [40.459244, -79.9191455], target: [40.4608307, -79.9214662],
  tokyo: [40.457602, -79.9293305], wholeFoods: [40.462527, -79.9287132], marketDistrict: [40.4591365, -79.9204083],
  musicHall: [40.4433823, -79.9510867],
};
const CAT = { restaurant: [['amenity', 'restaurant']], parking: [['amenity', 'parking']], hotel: [['tourism', 'hotel']], bar: [['amenity', 'bar'], ['amenity', 'pub']] };

// ---------------------------------------------------------------- per-task conversion
// Each entry: async () => ({ intent?, eval, changes: [...], status?, drop_reason? })
const NOTE_PA = 'Address parts as our place page shows them (current OSM; the state "Pennsylvania" is part of PA addresses, WebArena\'s import lacked it).';
const S = {};

// --- 79: airports within a driving distance
const PIT_ADDR = ['Pittsburgh International Airport', 'Findlay Township', 'Allegheny County', '15108'];
S[7] = async () => {
  const l = await leg('car', 'Carnegie Mellon University', 'Pittsburgh International Airport');
  return { eval: { type: 'answer', answer: { must_include: PIT_ADDR } }, changes: [`exact_match of the full address -> must_include of its parts: our place page shows "${l.to}" (no street; postcode 15108 from the nearest address, WebArena 15231). ${NOTE_PA}`, `Lite route ${legNote(l)} (< 50 km); Allegheny County Airport is not international.`] };
};
S[8] = async () => ({ eval: { type: 'answer', answer: { fuzzy: ['There is no airport within 5 km of Carnegie Mellon University'] } }, changes: ['Kept fuzzy (LLM judge): nearest airport (Allegheny County Airport) is 16 km by car, PIT 33 km.'] });
S[9] = async () => {
  const l = await leg('car', 'Carnegie Art Museum', 'Pittsburgh International Airport');
  return { intent: 'Tell me the full address of all international airports that are within a driving distance of 35 km to Carnegie Art Museum', instantiation_dict: { radius: '35 km' }, eval: { type: 'answer', answer: { must_include: PIT_ADDR } }, changes: [`Radius 30 km -> 35 km: the lite car route is ${legNote(l)} (WebArena's OSRM was just under 30 km).`, 'Reference = the PIT address parts our place page shows. ' + NOTE_PA] };
};
S[10] = async () => {
  const a = await leg('car', 'Niagara Falls', 'Niagara Falls International Airport');
  const b = await leg('car', 'Niagara Falls', 'Buffalo Niagara International Airport');
  return { eval: { type: 'answer', answer: { must_include: ['Niagara Falls International Airport', '2035', 'Niagara Falls Boulevard', '14304', 'Buffalo-Niagara International Airport |OR| Buffalo Niagara International Airport', 'Cheektowaga', '14225'] } }, changes: [`Address parts as our place pages show them ("${a.to}", "${b.to}"; WebArena listed City of Niagara Falls/Town of Wheatfield and Holtz Drive).`, `Lite routes ${legNote(a)}; ${legNote(b)} (both < 60 km).`] };
};

// --- 73: compare walking and driving
for (const [id, from, to] of [[16, '5000 Fifth Avenue, Pittsburgh', 'UPMC family health center'], [17, 'AMC Waterfront', 'Carnegie Mellon University'], [18, 'AMC Waterfront', 'Univ of Pittsburgh'], [19, 'Carnegie Science Center', 'Carnegie Mellon University'], [20, 'Randyland', 'Carnegie Mellon University']]) {
  S[id] = async () => {
    const c = await leg('car', from, to); const f = await leg('foot', from, to);
    return { eval: { type: 'answer', answer: { numeric: [durSpec(shown(c)), durSpec(shown(f))] } }, changes: [`fuzzy -> numeric (both times must be in the answer, tolerance per kit numeric mode): lite ${legNote(c)}; ${legNote(f)} (WebArena OSRM: see original reference; our foot profile is 10-20 % faster).`] };
  };
}

// --- 78: hotel near PIT + supermarket
const DT = 'DoubleTree by Hilton Hotel Pittsburgh Airport';
S[32] = async () => {
  const l = await leg('foot', DT, 'Giant Eagle, 5990 University Boulevard');
  return { intent: 'I will arrive Pittsburgh Airport soon. Provide the name of a DoubleTree by Hilton hotel in the vicinity, if available. Then, tell me the the walking distance to the nearest supermarket own by a local company from the hotel.', instantiation_dict: { target1: 'DoubleTree by Hilton hotel' }, eval: { type: 'answer', answer: [{ must_include: [DT] }, { numeric: distSpec(l.meters) }] }, changes: ['"a Hilton hotel" -> "a DoubleTree by Hilton hotel": our data has several Hilton-family hotels near PIT (Hilton Garden Inn on University Blvd, Embassy Suites, DoubleTree), each with a different answer; WebArena\'s reference is the DoubleTree.', `Local-company supermarket = Giant Eagle (Pittsburgh-based), the nearest one to the hotel; lite ${legNote(l)} (WebArena 2.0km). Distance graded numerically.`] };
};
S[33] = async () => {
  const a = await leg('foot', DT, 'Pittsburgh Area Commissary'); const b = await leg('foot', DT, 'Walmart Supercenter, 7500 University Boulevard');
  const v = (a.meters + b.meters) / 2000;
  return { intent: 'I will arrive Pittsburgh Airport soon. Provide the name of a DoubleTree by Hilton hotel in the vicinity, if available. Then, tell me the the shortest walking distance to a supermarket from the hotel.', instantiation_dict: { target1: 'DoubleTree by Hilton hotel' }, eval: { type: 'answer', answer: [{ must_include: [DT] }, { numeric: { value: +v.toFixed(2), unit: 'km', tol_abs: +(Math.abs(a.meters - b.meters) / 2000 + 0.06).toFixed(2) } }] }, changes: ['"a Hilton hotel" -> "a DoubleTree by Hilton hotel" (several Hilton-family hotels near PIT in our data; WebArena\'s reference is the DoubleTree).', `Shortest walk to a supermarket: lite ${legNote(a)} (on the air base) and ${legNote(b)} (the nearest by straight line, what the "supermarket near" list shows first); both accepted (WebArena 1.4km).`] };
};
S[34] = async () => {
  const l = await leg('foot', 'Hyatt Regency Pittsburgh International Airport', 'Shop & Save, 600 Market Place Drive');
  return { eval: { type: 'answer', answer: [{ must_include: ['Hyatt Regency Pittsburgh International Airport'] }, { numeric: durSpec(shown(l)) }] }, changes: [`fuzzy "Time: 3h 30min" -> numeric: walking routes from the Hyatt (airport terminal) to the 20 nearest supermarkets were computed; the shortest is ${legNote(l)} (the straight-line nearest ones in Moon Township are 3h 52min+ because the airfield is in the way).`] };
};
S[35] = async () => {
  const a = await leg('car', 'Hyatt Regency Pittsburgh International Airport', 'Pittsburgh Area Commissary');
  const b = await leg('car', 'Hyatt Regency Pittsburgh International Airport', 'Shop & Save, 600 Market Place Drive');
  return { eval: { type: 'answer', answer: [{ must_include: ['Hyatt Regency Pittsburgh International Airport'] }, { numeric: { value: 14, unit: 'min', tol_abs: 1.5 } }] }, changes: [`fuzzy "Time: 15min" -> numeric 14 +- 1.5 min: shortest drives to a supermarket from the Hyatt: ${legNote(a)}, ${legNote(b)}, Walmart/ALDI Robinson 14 min, Giant Eagle/ALDI Moon Township 15 min.`] };
};

// --- 77: reachable in one hour by car (answer Yes)
for (const [id, to, from] of [[36, 'social security administration pittsburgh', 'Carnegie Mellon University'], [37, 'police station in pittsburgh', 'gates building at CMU'], [38, 'duquesne university', 'pittsburgh airport'], [39, 'walmart pittsburgh', '5600 fifth avenue'], [40, 'amc theatre pittsburgh', 'hobart street']]) {
  S[id] = async () => {
    const l = await leg('car', from, to);
    return { eval: { type: 'answer', answer: { must_include: ['Yes'] } }, changes: [`Unchanged reference "Yes": lite ${legNote(l)}.`] };
  };
}

// --- 68: walking time
for (const [id, from, to] of [[52, 'Carnegie Mellon University', 'starbucks on Craig Street'], [53, 'Univ of Pittsburgh', 'starbucks on Craig Street'], [54, 'Carnegie Mellon University', 'Univ of Pittsburgh'], [55, 'starbucks near CMU', 'Chatham university'], [56, 'Carnegie Museum of Art', 'Hunt Library']]) {
  S[id] = async () => {
    const l = await leg('foot', from, to);
    const extra = id === 56 ? ' Libraries at CMU: Hunt Library and Sorrells Library are both 11 min from the museum.' : id === 55 ? ' The Starbucks nearest CMU is 428 South Craig Street.' : '';
    return { eval: { type: 'answer', answer: { numeric: durSpec(shown(l)) } }, changes: [`fuzzy -> numeric: lite ${legNote(l)}.${extra}`] };
  };
}

// --- 69: closest restaurant/cafe
S[57] = async () => ({ eval: { type: 'answer', answer: { must_include: ['Beefsteak', 'Grano', 'Back Bar Grill', 'El Gallo de Oro', 'Nourish', 'Schatz Dining Room'] } }, changes: ['Restaurants inside the Cohon University Center (6-46 m from it, all closer than any other): Au Bon Pain is no longer in OSM.'] });
S[58] = async () => ({ eval: { type: 'answer', answer: { must_include: ['De Fer'] } }, changes: ['Reference "De Fer Coffee & Tea" shortened to "De Fer" (the "&" is often written "and"); it is in Hunt Library (14 m).'] });
S[59] = async () => ({ eval: { type: 'answer', answer: { must_include: ['The Exchange'] } }, changes: ['Unchanged: The Exchange (Tech Street) is the nearest restaurant to Hunt Library (157 m).'] });
S[60] = async () => ({ eval: { type: 'answer', answer: { must_include: ['The Exchange'] } }, changes: ['Unchanged: The Exchange is the nearest restaurant to Posner Hall (45 m).'] });
S[61] = async () => ({ eval: { type: 'answer', answer: { must_include: ['Hunan Express'] } }, changes: ['Reference "La Prima Espresso" (a cafe) -> "Hunan Express": the nearest amenity=restaurant to Sorrells Library in our data (79 m; the next is 288 m).'] });

// --- 70: zip codes
for (const [id, zip, note] of [[70, '15213', 'Unchanged.'], [71, '15217', 'Reference 15232 -> 15217: our place page shows postcode 15217 (Chatham University has no addr:postcode; the nearest address\'s postcode is used).'], [72, '06516', 'Unchanged (the OSM "Yale University" object is the West Campus in West Haven).'], [73, '10027', 'Unchanged.']]) {
  S[id] = async () => ({ eval: { type: 'answer', answer: { must_include: [zip] } }, changes: ['exact_match -> must_include (a whole-number match, so "The zip code is X" passes).', note] });
}

// --- 65: optimal order
S[74] = async () => {
  const a = await leg('car', 'Carnegie Mellon University', 'starbucks on craig street'); const b = await leg('car', 'starbucks on craig street', 'apple store shadyside');
  const c = await leg('car', 'Carnegie Mellon University', 'apple store shadyside'); const d = await leg('car', 'apple store shadyside', 'starbucks on craig street');
  return { eval: { type: 'answer', answer: { fuzzy: ['The order is Carnegie Mellon University, starbucks on craig street, apple store shadyside'] } }, changes: [`Same order as WebArena (its reference said "starbucks on forbes ave"; the place is the Starbucks on Craig Street): lite car CMU->Starbucks->Apple ${shown(a) + shown(b)} min vs CMU->Apple->Starbucks ${shown(c) + shown(d)} min (on foot also shorter).`] };
};
S[75] = async () => {
  const a = await leg('car', 'Massachusetts Institute of Technology', 'Harvard University'); const b = await leg('car', 'Harvard University', 'Boston Logan International Airport');
  const c = await leg('car', 'Massachusetts Institute of Technology', 'Boston Logan International Airport'); const d = await leg('car', 'Boston Logan International Airport', 'Harvard University');
  return { eval: { type: 'answer', answer: { fuzzy: ['The order is Massachusetts Institute of Technology, Harvard University, Boston Logan International Airport'] } }, changes: [`Unchanged: lite car MIT->Harvard->Logan ${shown(a) + shown(b)} min vs MIT->Logan->Harvard ${shown(c) + shown(d)} min.`] };
};
S[76] = async () => {
  const a = await leg('car', 'Princeton University', 'Yale University'); const b = await leg('car', 'Yale University', 'Harvard University');
  const c = await leg('car', 'Princeton University', 'Harvard University'); const d = await leg('car', 'Harvard University', 'Yale University');
  return { eval: { type: 'answer', answer: { fuzzy: ['The order is Princeton University, Yale University, Harvard University'] } }, changes: [`must_include of the whole sentence -> fuzzy (an order is not a substring test). Lite car P->Y->H ${fmtMin(shown(a) + shown(b))} vs P->H->Y ${fmtMin(shown(c) + shown(d))}.`] };
};

// --- 72: walk then drive
for (const [id, a, b, c] of [[80, 'Carnegie Mellon University', 'Starbucks on Craig Street', 'Pittsburgh International Airport'], [81, 'Univ of Pittsburgh', 'starbucks on Craig Street', 'Pittsburgh International Airport'], [82, 'Massachusetts Institute of Technology', 'Harvard University', 'Boston Logan International Airport'], [83, 'Carnegie Mellon University', 'apple store shadyside', 'starbucks on craig street']]) {
  S[id] = async () => {
    const w = await leg('foot', a, b); const d = await leg('car', b, c);
    const tot = shown(w) + shown(d);
    return { eval: { type: 'answer', answer: { numeric: { value: tot, unit: 'min', tol_pct: 10, tol_abs: 2 } } }, changes: [`fuzzy -> numeric: lite ${legNote(w)} + ${legNote(d)} = ${tot} min.`] };
  };
}

// --- 64: driving time from a hotel
for (const [id, from, to, note] of [[84, 'DoubleTree by Hilton New York Downtown', 'Keens Steakhouse', ''], [85, 'La Quinta Inn Pittsburgh Airport', 'Carnegie Mellon University', ''], [86, 'La Quinta Inn Pittsburgh Airport', 'University of Pittsburgh', ''], [87, 'red roof inn', 'Pittsburgh science museum', ' "red roof inn" = the top search hit near the CMU view (Red Roof Inn, Steubenville Pike, Robinson Township); "Pittsburgh science museum" = Kamin Science Center (the renamed Carnegie Science Center).'], [88, 'Homewood Suites Southpointe', 'PPG Paints Arena', '']]) {
  S[id] = async () => {
    const l = await leg('car', from, to);
    return { eval: { type: 'answer', answer: { numeric: durSpec(shown(l)) } }, changes: [`fuzzy -> numeric: lite ${legNote(l)}.${note}`] };
  };
}

// --- 67: bordering states (knowledge + map; unchanged)
for (const id of [89, 91, 92, 93]) S[id] = async () => null;
S[90] = async () => ({ eval: { type: 'answer', answer: { must_include: ['Ohio', 'Maryland', 'New York', 'New Jersey', 'Delaware', 'West Virginia'] } }, changes: ['Reference unchanged.'], status: 'dropped', drop_reason: 'Ohio, West Virginia, Maryland and Delaware are outside the map data (US Northeast extract: tiles, geocoder and routing end at the Pennsylvania border), so the map shows only New York and New Jersey as neighbours; the answer is not derivable from the site.' });

// --- 66: nearest X and walking distance
S[98] = async () => {
  const l = await leg('foot', 'University of Pittsburgh', 'Fuku Tea');
  return { intent: 'Where is the nearest Fuku Tea to University of Pittsburgh, and what is the walking distance to it?', instantiation_dict: { places: 'Fuku Tea' }, eval: { type: 'answer', answer: [{ must_include: ['Fuku Tea', '3800', 'Forbes Avenue', 'Central Oakland', 'Pittsburgh'] }, { numeric: distSpec(l.meters) }] }, changes: ['"tea cafe" -> "Fuku Tea": our data has several tea cafes 300-450 m from Pitt (TapiLab, Tsaocaa, Fuku Tea, ...), so "the nearest tea cafe" is not well defined; Fuku Tea is WebArena\'s reference.', `Fuku Tea is at 3800 Forbes Avenue in current OSM (WebArena 3716). Lite ${legNote(l)} (WebArena 653m); distance graded numerically.`] };
};
S[99] = async () => {
  const l = await leg('foot', '5700 Penn Ave', 'Five Guys, 5207 Liberty Avenue');
  return { eval: { type: 'answer', answer: [{ must_include: ['Five Guys', '5207', 'Liberty Avenue', 'Bloomfield', 'Pittsburgh'] }, { numeric: distSpec(l.meters) }] }, changes: [`Reference -> the Five Guys at 5207 Liberty Avenue (Bloomfield), the nearest to 5700 Penn Ave in current OSM (newer than WebArena's snapshot, whose answer was 117 South Bouquet Street, 4.0km). Lite ${legNote(l)}.`] };
};
S[100] = async () => {
  const l = await leg('foot', 'Carnegie Mellon', 'Starbucks, 428 South Craig Street');
  return { eval: { type: 'answer', answer: [{ must_include: ['Starbucks', '428', 'South Craig Street', 'Pittsburgh'] }, { numeric: distSpec(l.meters) }] }, changes: [`Address as our place page shows it: 428 South Craig Street, Panther Hollow, North Oakland (WebArena 417, Bellefield). Lite ${legNote(l)} (WebArena 557m).`] };
};
S[101] = async () => ({ eval: { type: 'answer', answer: { fuzzy: 'N/A' } }, changes: ['Kept fuzzy "N/A" (LLM judge): no In-N-Out in the map data (US Northeast).'] });

// --- 51: driving time between cities
for (const [id, a, b, note] of [[137, 'Philadelphia', 'Pittsburgh', 'Liberty Bell -> Philadelphia, Pirates -> Pittsburgh.'], [138, 'New York', 'Philadelphia', 'big apple -> New York (from "Big Apple"/Manhattan/Times Square 2h 3-5min).'], [139, 'Scranton', 'Bridgeport', 'Joe Biden\'s hometown -> Scranton.'], [140, 'Niagara Falls', 'New Haven', 'city of Yale -> New Haven (to the Yale University object in West Haven: 8h 52min).']]) {
  S[id] = async () => {
    const l = await leg('car', a, b);
    return { eval: { type: 'answer', answer: { numeric: durSpec(shown(l)) } }, changes: [`fuzzy -> numeric: lite ${legNote(l)}. ${note}`] };
  };
}
// --- 36: minimum travel time by car
for (const [id, from, to] of [[151, 'CMU', 'University of Pittsburgh'], [152, 'Schenley park', 'University of Pittsburgh'], [153, 'REI', 'CMU'], [154, 'gates building at CMU', 'Schenley park'], [155, 'Animal Rescue League of Pittsburgh', 'Schenley park']]) {
  S[id] = async () => {
    const l = await leg('car', from, to);
    const extra = id === 155 ? ' Animal Rescue League = Humane Animal Rescue of Pittsburgh (renamed; old name searchable).' : id === 154 ? ' CMU gates building = Gates and Hillman Centers.' : '';
    return { eval: { type: 'answer', answer: { numeric: durSpec(shown(l)) } }, changes: [`fuzzy -> numeric: lite ${legNote(l)}.${extra}`] };
  };
}
// --- 41: hotels within N minutes walking
S[218] = async () => ({ eval: { type: 'answer', answer: { fuzzy: 'N/A' } }, changes: ['Kept fuzzy "N/A": the nearest hotel to CMU (Mansions On Fifth) is a 10 min walk.'] });
S[219] = async () => ({ eval: { type: 'answer', answer: { fuzzy: 'N/A' } }, changes: ['Kept fuzzy "N/A": the nearest hotel to PIT (Pittsburgh Airport Inn & Suites) is a 17 min walk.'] });
S[220] = async () => {
  const a = await leg('foot', 'The Oaklander Hotel', 'Gardner Steel Conference Center'); const b = await leg('foot', 'Courtyard Pittsburgh University Center', 'Gardner Steel Conference Center');
  return { eval: { type: 'answer', answer: [{ must_include: ['Oaklander'] }, { numeric: distSpec(a.meters) }] }, changes: [`fuzzy -> must_include + numeric: only The Oaklander Hotel is within 5 min (lite ${legNote(a)}; next ${legNote(b)}). The Wyndham Pittsburgh University Center is not in current OSM.`] };
};
// --- 35: nearest X from CMU, times
S[221] = async () => {
  const w = await leg('foot', 'Carnegie Mellon University', 'post office near Carnegie Mellon University'); const d = await leg('car', 'Carnegie Mellon University', 'post office near Carnegie Mellon University'); const b = await leg('bike', 'Carnegie Mellon University', 'post office near Carnegie Mellon University');
  return { eval: { type: 'answer', answer: { numeric: [durSpec(shown(w)), durSpec(shown(d)), durSpec(shown(b))] } }, changes: [`fuzzy -> numeric (walk, drive, bike): the nearest post office in our data is ${w.to.split(',')[0]} (WebArena's was on campus, not in current OSM): lite ${legNote(w)}; ${legNote(d)}; ${legNote(b)}.`] };
};
for (const [id, to] of [[222, 'Cold Stone Creamery'], [223, "McDonald's"], [224, "Wendy's"]]) {
  S[id] = async () => {
    const l = await leg('car', 'Carnegie Mellon University', to);
    return { eval: { type: 'answer', answer: { numeric: durSpec(shown(l)) } }, changes: [`fuzzy -> numeric: nearest ${to} = ${l.to.split(',').slice(0, 3).join(',')}; lite ${legNote(l)}.`] };
  };
}
// --- 39: nearest pharmacy / gas station
S[236] = async () => {
  const a = await leg('foot', 'Carnegie Mellon University', "Schiller's Pharmacy"); const b = await leg('foot', 'Carnegie Mellon University', 'University Pharmacy');
  return { eval: { type: 'answer', answer: { must_include: ['Schiller |OR| University Pharmacy', 'Pittsburgh'] } }, changes: [`Accept Schiller's Pharmacy (811 S. Aiken Ave, the nearest by straight line, ${a.time} walk) or University Pharmacy (University Place, the nearest by walking, ${b.time}); both are within 20 min. Address parts reduced to the name + city.`] };
};
S[237] = async () => ({ eval: { type: 'answer', answer: { must_include: ['Sunoco', 'North Craig Street', 'North Oakland', 'Pittsburgh'] } }, changes: ['Unchanged: Sunoco, 195 North Craig Street, Bellefield, North Oakland (nearest fuel station, 2 min drive).'] });
// --- 46: coordinates
for (const [id, lat, lon, note] of [[248, 40.4424191, -79.9397388, ''], [249, 40.4607631, -79.9466666, ' (OSM name: West Penn Hospital Heliport; the task name is an alias)'], [250, 40.4509614, -79.9340518, ' (Apple Store, Walnut Street, Shadyside)'], [251, 40.4443029, -79.9488859, ' (bus stop "Forbes Ave opposite Craig St", south side of Forbes, the museum side; the Dithridge St stop on that side is within the tolerance too)'], [252, 40.457602, -79.9293305, '']]) {
  S[id] = async () => ({ eval: { type: 'answer', answer: { numeric: [{ value: +lat.toFixed(4), unit: 'deg', tol_abs: 0.0015 }, { value: +lon.toFixed(4), unit: 'deg', tol_abs: 0.0015 }] } }, changes: [`must_include of 3-decimal strings -> numeric unit deg +-0.0015 (a substring test fails on more precise answers like 40.4424): our place page shows ${lat.toFixed(6)}, ${lon.toFixed(6)}${note}.`] });
}
// --- 501: phone / operator / website / hours
S[253] = async () => ({ eval: { type: 'answer', answer: { fuzzy: 'N/A' } }, changes: ['Kept fuzzy "N/A": Carnegie Mellon Café has no phone tag.'] });
S[254] = async () => ({ eval: { type: 'answer', answer: { must_include: ['412', '578', '5000'] } }, changes: ['exact "4125785000" -> must_include of its groups: the place page (West Penn Hospital, alias Western Pennsylvania Hospital) shows "+1 412 578 5000".'] });
S[255] = async () => ({ eval: { type: 'answer', answer: { must_include: ['Allegheny County Airport Authority'] } }, changes: ['exact -> must_include (same value; the place page Operator field).'] });
S[256] = async () => ({ eval: { type: 'answer', answer: { must_include: ['carnegieart.org'] } }, changes: ['Reference http://web.cmoa.org/ -> carnegieart.org: current OSM website tag of Carnegie Museum of Art is https://carnegieart.org/.'] });
S[257] = async () => ({ eval: { type: 'answer', answer: { fuzzy: ['We-Su 10:00-17:00; Mo-Tu off'] } }, changes: ['Kept fuzzy; reference = the opening_hours our place page shows (WebArena "We-Su 10:00-17:00").'] });
// --- 47
S[287] = async () => { const l = await leg('car', 'Pittsburgh', 'Philadelphia'); return { eval: { type: 'answer', answer: { numeric: durSpec(shown(l)) } }, changes: [`fuzzy -> numeric: lite ${legNote(l)}.`] }; };
// --- 49: route SCS CMU -> Independence Hall (program_html -> directions check)
S[356] = async () => ({ eval: { type: 'directions', directions: { engine: 'car', from: { must_include: ['Gates and Hillman Centers', 'Pittsburgh'], near: PT.gates, radius_m: 300 }, to: { must_include: ['Independence Hall', 'Philadelphia'], near: PT.indep, radius_m: 300 } } }, changes: ['program_html (select.routing_engines selectedIndex 1, route_from/route_to values) -> directions check of the final URL: engine car, from/to = the From/To field values (display names) + route end points near the places. selectedIndex 1 = car on our page too.'] });
// --- 58: walking distance
for (const [id, a, b] of [[363, 'Carnegie Mellon University', 'Carnegie Music Hall'], [364, 'Carnegie Mellon University', 'UPMC Shadyside'], [365, 'Carnegie Music Hall', 'UPMC Shadyside'], [366, 'CVS Pharmacy, 4610 Centre Avenue', 'UPMC Shadyside'], [367, 'Carnegie Mellon University', 'CVS Pharmacy, 4610 Centre Avenue']]) {
  S[id] = async () => {
    const l = await leg('foot', a, b);
    const extra = id >= 366 ? ' The CVS closest to UPMC Shadyside and to CMU is CVS Pharmacy, 4610 Centre Avenue.' : '';
    return { eval: { type: 'answer', answer: { numeric: distSpec(l.meters) } }, changes: [`exact -> numeric distance: lite ${legNote(l)}.${extra}`] };
  };
}
// --- 52: description page (program_html sidebar text -> place check)
for (const [id, osm, inc, note] of [[369, ['W154257484'], ['Carnegie Music Hall'], ''], [370, ['R2279034', 'W25795401'], ['Carnegie Mellon University'], ' (the two amenity=university objects; buildings named after CMU do not count)'], [371, null, ['Piada Italian Street Food', 'Forbes Avenue'], ' (3600 Forbes Avenue, near Pitt)'], [372, ['W168456128'], ['Costco', 'Waterfront Drive West'], ' (Costco, 501 Waterfront Drive West; the bus stop "Waterfront Drive at Costco Driveway" would satisfy the text check alone)'], [373, ['N10114377662'], ['Whole Foods', 'East Liberty'], ' (Whole Foods Market, 5700 Penn Avenue)']]) {
  S[id] = async () => ({ eval: { type: 'place', place: { ...(osm ? { osm } : {}), must_include: inc } }, changes: [`program_html (#sidebar_content text) -> place check: the final URL is the place page of the object${note}; must_include on its name/address.`] });
}
// --- 59: url_match search -> search check
for (const [id, cat, near, ref, note] of [[377, 'restaurant', PT.hunt, '/search?query=restaurants%20near%20CMU%20Hunt%20Library', 'CMU ArtPark Lab is not in OSM (or our data): place -> CMU Hunt Library (intent adjusted).'], [378, 'parking', PT.cmu, '/search?query=parking%20near%20carnegie%20mellon%20university', ''], [379, 'hotel', PT.cmu, '/search?query=hotels%20near%20carnegie%20mellon%20university', ''], [380, 'bar', PT.musicHall, '/search?query=bars%20near%20Carnegie%20Music%20Hall', ''], [381, 'hotel', PT.musicHall, '/search?query=hotels%20near%20Carnegie%20Music%20Hall', '']]) {
  S[id] = async () => ({ ...(id === 377 ? { intent: 'Find the resturants around CMU Hunt Library', instantiation_dict: { space: 'resturants', location: 'CMU Hunt Library' } } : {}), eval: { type: 'search', search: { category: CAT[cat], near, radius_m: 600 }, url_reference: '__MAP__' + ref }, changes: [`url_match (exact query text) -> search check of the final URL: /search?query=<${cat} words> near|around <place>, any category wording (categories.json) and any name of the place (the most important object with those name words within 600 m). The WebArena URL ${ref} passes.${note ? ' ' + note : ''}`] });
}
S[382] = async () => ({ eval: { type: 'answer', answer: { fuzzy: 'N/A' } }, changes: ['Kept fuzzy "N/A": the nearest US Citizenship and Immigration Services in the data is in Johnston, Rhode Island.'] });
S[383] = async () => {
  const g = await leg('car', 'Hyatt Regency Pittsburgh International Airport', 'Giant Eagle, 5990 University Boulevard');
  const a = await leg('car', 'Hyatt Regency Pittsburgh International Airport', 'ALDI, 2830 Gracy Center Way');
  return { eval: { type: 'answer', answer: { must_include: ['Hyatt Regency Pittsburgh International Airport', 'Giant Eagle', 'ALDI'] } }, changes: [`Unchanged: lite ${legNote(g)}; ${legNote(a)} (others within 15 min: Shop & Save, Walmart and ALDI Robinson, Gordon Food Service, the air base commissary; extra names are not penalised).`] };
};
// --- 42: path between cities (directions check)
S[757] = async () => ({ eval: { type: 'directions', directions: { engine: 'car', from: { must_include: ['Pittsburgh'], near: PT.pgh, radius_m: 25000 }, to: { must_include: ['New York'], near: PT.nyc, radius_m: 40000 } } }, changes: ['program_html -> directions check: car (selectedIndex 1), From contains "Pittsburgh" and starts within 25 km of downtown, To contains "New York" and ends within 40 km of Manhattan (the Giants\' stadium is in New Jersey).'] });
S[758] = async () => ({ eval: { type: 'directions', directions: { engine: 'car', from: { must_include: ['New York'], near: PT.nyc, radius_m: 40000 }, to: { must_include: ['Portland', 'Maine'], near: PT.portland, radius_m: 15000 } } }, changes: ['program_html -> directions check: car, From "New York" (within 40 km), To "Portland ... Maine" (within 15 km of Portland, ME).'] });
// --- 54: directions with a mode
S[761] = async () => ({ eval: { type: 'directions', directions: { engine: 'foot', from: { must_include: ['Kamin Science Center |OR| Carnegie Science Center', 'Allegheny County', 'Pittsburgh'], near: PT.kamin, radius_m: 300 }, to: { must_include: ['Hunt Library', 'Pittsburgh'], near: PT.hunt, radius_m: 300 } } }, changes: ['program_html -> directions check: foot (selectedIndex 2). Carnegie Science Center is now Kamin Science Center (old name searchable; the From field shows the current name).'] });
S[762] = async () => ({ eval: { type: 'directions', directions: { engine: 'car', from: { must_include: ['Carnegie Hall', 'Manhattan', 'New York'], near: PT.carnegieHall, radius_m: 300 }, to: { must_include: ['Carnegie Mellon University', 'Pittsburgh'], near: PT.cmu, radius_m: 600 } } }, changes: ['program_html -> directions check: car. "Carnegie Music Hall in NYC" = Carnegie Hall; its OSM address is West 56th Street now (WebArena "West 57th Street"), so the street is not required.'] });
// --- 75: walkway to the closest store
for (const [id, to, pt, note] of [[763, "Trader Joe's, 6343, Penn Avenue, East Liberty", PT.traderJoes, ''], [764, 'Target, 6231, Penn Avenue, East Liberty', PT.target, ''], [765, 'Tokyo Japanese Food Store, 5855, Ellsworth Avenue, Shadyside', PT.tokyo, ''], [766, 'Whole Foods Market, 5700, Penn Avenue, East Liberty', PT.wholeFoods, ''], [767, 'Market District, Penn Avenue, Shadyside', PT.marketDistrict, 'Reference -> Market District (Penn Avenue, brand Giant Eagle, 250 m from 401 Shady Ave), the closest Giant Eagle store in current OSM (WebArena: Giant Eagle, 5550 Centre Avenue, ~1 km).']]) {
  S[id] = async () => ({ eval: { type: 'directions', directions: { engine: 'foot', from: { must_include: ['401, Shady Avenue, Shadyside'], near: PT.shady401, radius_m: 150 }, to: { must_include: [to], near: pt, radius_m: 200 } } }, changes: ['program_html -> directions check: foot (selectedIndex 2), From/To field values as before + end points near the places.'].concat(note ? [note] : []) });
}

// ---------------------------------------------------------------- main
(async () => {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8')).filter((t) => JSON.stringify(t.sites) === '["map"]');
  const out = [];
  for (const t of raw) {
    const fn = S[t.task_id];
    if (!fn) throw new Error(`no conversion for task ${t.task_id}`);
    const c = (await fn()) || {};
    let ev = c.eval;
    let changes = c.changes || [];
    if (!ev) { // unchanged answer check
      const ra = t.eval.reference_answers;
      ev = { type: 'answer', answer: ra.must_include ? { must_include: ra.must_include } : ra.exact_match ? { exact: ra.exact_match } : { fuzzy: ra.fuzzy_match } };
      changes = ['Unchanged reference (WebArena answer; the map shows the state outlines).'];
    }
    const rec = {
      task_id: t.task_id, site: 'map', intent: c.intent || t.intent, intent_template: t.intent_template, intent_template_id: t.intent_template_id,
      instantiation_dict: { ...t.instantiation_dict, ...(c.instantiation_dict || {}) }, start_url: START, require_login: false, login_user: null,
      eval: ev, changes: ['start_url __MAP__ -> __MAP__/#map=15/40.4443/-79.9436 (the default CMU view, explicit: search ranking uses the map view).', ...changes],
      status: c.status || 'verified', drop_reason: c.drop_reason || null,
    };
    if (c.intent) rec.original_intent = t.intent;
    out.push(rec);
  }
  fs.writeFileSync(A.out, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.error(`wrote ${out.length} tasks -> ${path.relative(ROOT, A.out)}`);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
