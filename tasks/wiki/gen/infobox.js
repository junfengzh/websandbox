'use strict';
// Single infobox facts: read one value from an article's infobox (search -> article -> infobox).
const L = require('./lib');
const F = require('./facts');

// iterate usable articles with an infobox
function* ents(c, minIn = 0) {
  for (const [id, rec] of c.all) if (rec.ib && F.usable(c, id) && c.meta.get(id).inlinks >= minIn) yield [id, rec, c.meta.get(id)];
}
const isPerson = (rec) => F.rows(rec, /^Born$/).length === 1 && !/settlement|country/.test(rec.ib.cls);
const isSettlement = (rec) => /ib-settlement|ib-uk-place|ib-pol-div/.test(rec.ib.cls);
const ans = (s) => ({ type: 'answer', answer: { must_include: [s] } });
const ansSql = (s, sql) => ({ type: 'answer', answer: { must_include: [s] }, answer_sql: sql });

const T = [];
// birthplace templates: also accept the place the article text gives when it differs from the
// infobox city (F.textBirthplace), as a ` |OR| ` alternative; only for the chosen instances
function textBirthplaceAlt(inst) {
  const born = inst.born;
  delete inst.born;
  const x = born && F.textBirthplace(L.openDb(), born.id, born.place, born.name);
  if (!x) return;
  const r = inst.eval.answer.must_include[0];
  inst.eval = { ...inst.eval, answer: { ...inst.eval.answer, must_include: [`${r} |OR| ${x}`] } };
  inst.changes = [`regrade 2026-11-15 (RL scan analysis): the article text gives the birthplace as ${x} (infobox: ${born.place}); both accepted`];
}
// first row of an Area / Population block that is not the total
const NOT_TOTAL = /^(Land|Water|Urban|Metro|Rural|CSA|MSA|Rank|Density|Elevation|Highest elevation|Lowest elevation|Demonym|Estimate|Ethnicity|Religion|Language)/i;

T.push({
  id: 'gen-wiki-person-birth-date', skills: ['search', 'read-detail'], difficulty: 1, cap: 70,
  phrasings: [
    'When was {title} born? Give the full date.',
    'Look up {title} on the wiki. What is their date of birth (day, month and year)?',
    'On what date was {title} born?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 50)) {
      if (!isPerson(rec)) continue;
      const b = F.bornDied(F.one(rec, /^Born$/));
      if (!b) continue;
      const alts = L.dateAlts(b.iso);
      if (!alts || +b.iso.slice(0, 4) < 1000) continue;
      out.push({ vars: { title: m.title }, eval: ans(alts), ref: L.fmtDate(b.iso) });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-person-birthplace', skills: ['search', 'read-detail'], difficulty: 1, cap: 70,
  phrasings: [
    'In which city or town was {title} born?',
    'Where was {title} born? Name the city.',
    'Find the article about {title}. What is their place of birth (city or town)?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 50)) {
      if (!isPerson(rec)) continue;
      const b = F.bornDied(F.one(rec, /^Born$/));
      const cty = b && F.city(b.place);
      if (!cty || b.place.split(',').length < 2) continue;
      out.push({ vars: { title: m.title }, eval: ans(cty), ref: b.place, born: { id: m.id, place: b.place, name: m.title } });
    }
    return out;
  },
  finish: textBirthplaceAlt,
});

T.push({
  id: 'gen-wiki-person-death-age', skills: ['search', 'read-detail'], difficulty: 1, cap: 55,
  phrasings: [
    'How old was {title} when they died?',
    'At what age did {title} die?',
    'According to the wiki, what age was {title} at the time of death?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 50)) {
      if (!isPerson(rec)) continue;
      const d = F.bornDied(F.one(rec, /^Died$/));
      const b = F.bornDied(F.one(rec, /^Born$/));
      if (!d || !b || d.age == null) continue;
      // age consistent with the two dates
      const [by, bm, bd] = b.iso.split('-').map(Number); const [dy, dm, dd] = d.iso.split('-').map(Number);
      const age = dy - by - (dm < bm || (dm === bm && dd < bd) ? 1 : 0);
      if (age !== d.age || age < 1) continue;
      out.push({ vars: { title: m.title }, eval: ans(String(age)), ref: age });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-person-alma-mater', skills: ['search', 'read-detail'], difficulty: 1, cap: 55,
  phrasings: [
    'Which school or university is listed as the alma mater of {title}?',
    'Where did {title} study? Give the alma mater shown in their infobox.',
    'What is the alma mater of {title}?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 50)) {
      if (!isPerson(rec)) continue;
      const r = F.one(rec, /^Alma mater$/);
      const v = F.singleName(r);
      if (!v || !F.singleLink(c, r)) continue;
      out.push({ vars: { title: m.title }, eval: ans(v), ref: v });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-settlement-population', skills: ['search', 'read-detail'], difficulty: 1, cap: 70,
  changes: 'regrade 2026-11-15 (strict numbers): answer.strict_numbers false -- the infobox figure comes with its census year ("47,743 (2010)"), which the intent does not name, so the reference answer itself would fail the count check; large population figures are not guessable by listing numbers.',
  phrasings: [
    'What is the total population of {title} given in its infobox?',
    'According to the wiki, how many people live in {title} (the population figure in the infobox)?',
    'Look up {title}. What population figure does its infobox report?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      if (!isSettlement(rec)) continue;
      const pr = F.rows(rec, /./, /^Population/);
      if (!pr.length) continue;
      const head = pr[0].h;
      // the first row of the population block is the total (Total / City / Town / Village / Commune ...)
      const first = pr[0];
      if (NOT_TOTAL.test(first.k)) continue;
      if (pr.filter((r) => r.k === first.k).length !== 1) continue;
      const v = F.count(first, { min: 100 });
      if (!v) continue;
      const yr = (/\((?:[A-Za-z.]+ )?(\d{4})\)/.exec(head) || [])[1];
      out.push({ vars: { title: m.title }, eval: { type: 'answer', answer: { must_include: [v.shown], strict_numbers: false } }, ref: v.shown + (yr ? ` (${yr})` : '') });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-settlement-area', skills: ['search', 'read-detail'], difficulty: 2, cap: 55,
  phrasings: [
    'What is the total area of {title} in square kilometres?',
    'How large is {title}? Give its total area in km².',
    'Using the wiki, find the area of {title} in square kilometres.',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      if (!isSettlement(rec)) continue;
      const ar = F.rows(rec, /./, /^Area/);
      if (!ar.length || NOT_TOTAL.test(ar[0].k)) continue;
      const v = F.areaKm2(ar[0]);
      if (!v || v.v < 0.5) continue;
      // numeric: unit 'km' reads "151.12 km2" / "151.12 km²" (km quantity) or a bare number
      out.push({ vars: { title: m.title }, eval: { type: 'answer', answer: { numeric: { value: v.v, unit: 'km', tol_pct: 1.5 } } }, ref: v.shown });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-elevation', skills: ['search', 'read-detail'], difficulty: 1, cap: 60,
  phrasings: [
    'What is the elevation of {title}?',
    'How high above sea level is {title}, according to its infobox?',
    'Find {title} on the wiki and report its elevation (metres or feet).',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      const r = F.one(rec, /^Elevation$/);
      const v = F.lengthM(r);
      if (!v || v.m < 5) continue;
      out.push({ vars: { title: m.title }, eval: { type: 'answer', answer: { numeric: { value: +v.m.toFixed(1), unit: 'm', tol_pct: 2, tol_abs: 2 } } }, ref: v.shown });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-geo-length', skills: ['search', 'read-detail'], difficulty: 1, cap: 45,
  phrasings: [
    'How long is the {title}, according to the wiki?',
    'What length does the wiki give for {title}?',
    'Find the infobox of {title}. What is its length?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      if (!F.rows(rec, /^(Mouth|Source|Basin size|Spans|Crosses|Termini|Major junctions)$/).length) continue;
      const v = F.lengthM(F.one(rec, /^(Length|Total length)$/), /km|mi/);
      if (!v || v.m < 500) continue;
      const title = /^(River|Lake|Mount)\b/.test(m.title) || !/\b(River|Bridge|Canal|Tunnel|Highway|Road|Railway)\b/.test(m.title) ? m.title : m.title;
      out.push({ vars: { title }, eval: { type: 'answer', answer: { numeric: { value: +(v.m / 1000).toFixed(2), unit: 'km', tol_pct: 2 } } }, ref: v.shown });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-settlement-mayor', skills: ['search', 'read-detail'], difficulty: 1, cap: 55,
  phrasings: [
    'Who is the mayor of {title} according to the wiki?',
    'Find the article on {title}. Who is listed as its mayor?',
    'Name the mayor of {title} shown in the infobox.',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      if (!isSettlement(rec)) continue;
      const r = F.one(rec, /^Mayor( \(\d{4}[–-]\d{4}\))?$/);
      const raw = r && r.lines.length === 1 ? r.lines[0].replace(/\s*\([^()]{1,25}\)$/, '') : null;
      const v = raw && F.singleName({ ...r, lines: [raw] });
      if (!v || v.split(' ').length < 2) continue;
      out.push({ vars: { title: m.title }, eval: ans(v), ref: r.lines[0] });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-commune-department', skills: ['search', 'read-detail'], difficulty: 1, cap: 55,
  phrasings: [
    'The French commune {title}: which department is it in?',
    'In which French department is {title} located?',
    'Look up the commune {title}. Name its department and region.',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 0)) {
      if (!F.rows(rec, /^INSEE\/Postal code$/).length) continue;
      const d = F.singleName(F.one(rec, /^Department$/));
      const rg = F.singleName(F.one(rec, /^Region$/), { allowDigits: false });
      if (!d || !rg) continue;
      out.push({ vars: { title: m.title }, eval: { type: 'answer', answer: { must_include: [d] } }, ref: `${d} (${rg})`, region: rg });
    }
    return out;
  },
  finish(inst, phrIdx) { if (phrIdx === 2) inst.eval = { type: 'answer', answer: { must_include: [inst.eval.answer.must_include[0], inst.region] } }; },
});

T.push({
  id: 'gen-wiki-org-headquarters', skills: ['search', 'read-detail'], difficulty: 1, cap: 60,
  phrasings: [
    'In which city is {title} headquartered?',
    'Where are the headquarters of {title}? Name the city.',
    'According to the wiki, what city is the headquarters of {title} in?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      const r = F.one(rec, /^Headquarters$/);
      if (!r || r.lines.length !== 1 || /\d/.test(r.text)) continue;
      const parts = r.lines[0].split(',').map((s) => s.trim());
      if (parts.length < 2 || parts.length > 4) continue;
      const cty = F.city(r.lines[0]);
      if (!cty || /\b(Street|Avenue|Road|Tower|Building|Center|Centre|Plaza|Park|House|Station|Base|Camp)\b/.test(cty)) continue;
      // the city part links to a settlement article of that name
      const cid = r.links.length ? c.resolve(r.links[0]) : null;
      const crec = cid && c.all.get(cid);
      if (!crec || !crec.ib || !isSettlement(crec) || !L.norm(c.meta.get(cid).title).startsWith(L.norm(cty))) continue;
      out.push({ vars: { title: m.title }, eval: ans(cty), ref: r.lines[0] });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-org-founded-year', skills: ['search', 'read-detail'], difficulty: 1, cap: 65,
  phrasings: [
    'In what year was {title} founded?',
    'When was {title} established? Give the year.',
    'What founding year does the wiki give for {title}?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      if (isSettlement(rec) || isPerson(rec)) continue;
      const rs = F.rows(rec, /^(Founded|Established|Formation|Formed|Founded in)$/);
      if (rs.length !== 1) continue;
      const y = F.year(rs[0]);
      if (!y) continue;
      out.push({ vars: { title: m.title }, eval: ans(y), ref: rs[0].text });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-team-coach', skills: ['search', 'read-detail'], difficulty: 1, cap: 55,
  phrasings: [
    'Who is the head coach of {title}?',
    'According to the wiki, who coaches {title}?',
    'Find {title} on the wiki. Who is listed as head coach or manager?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      if (!F.rows(rec, /^(League|Conference|Division)$/).length) continue;
      const r = F.one(rec, /^(Head coach|Manager)$/);
      const v = F.singleName(r);
      if (!v || v.split(' ').length < 2) continue;
      out.push({ vars: { title: m.title }, eval: ans(v), ref: v });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-venue-capacity', skills: ['search', 'read-detail'], difficulty: 1, cap: 60,
  phrasings: [
    'What is the seating capacity of {title}?',
    'How many spectators can {title} hold, according to its infobox?',
    'Look up {title}. What capacity does the wiki give?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 30)) {
      if (!F.rows(rec, /^(Opened|Broke ground|Built)$/).length) continue;
      const v = F.count(F.one(rec, /^Capacity$/), { min: 500, max: 300000 });
      if (!v) continue;
      out.push({ vars: { title: m.title }, eval: ans(v.shown), ref: v.shown });
    }
    return out;
  },
});

const isFilm = (rec) => F.rows(rec, /^Directed by$/).length === 1 && F.rows(rec, /^Running time$/).length === 1 && !F.rows(rec, /^(No\. of episodes|No\. of seasons)$/).length;
T.push({
  id: 'gen-wiki-film-director', skills: ['search', 'read-detail'], difficulty: 1, cap: 60,
  phrasings: [
    'Who directed the film {title}?',
    'Find the wiki article on {title}. Who is its director?',
    'Name the director of {title}.',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 20)) {
      if (!isFilm(rec)) continue;
      const v = F.singleName(F.one(rec, /^Directed by$/));
      if (!v) continue;
      out.push({ vars: { title: m.title }, eval: ans(v), ref: v });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-film-runtime', skills: ['search', 'read-detail'], difficulty: 1, cap: 55,
  phrasings: [
    'What is the running time of {title}?',
    'How long is the film {title}, according to the wiki?',
    'Look up {title}. How many minutes does it run?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, rec, m] of ents(c, 20)) {
      if (!isFilm(rec)) continue;
      const v = F.minutes(F.one(rec, /^Running time$/));
      if (!v || v < 40) continue;
      out.push({ vars: { title: m.title }, eval: { type: 'answer', answer: { numeric: { value: v, unit: 'min', tol_abs: 1 } } }, ref: `${v} minutes` });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-country-capital', skills: ['search', 'read-detail'], difficulty: 1, cap: 40,
  phrasings: [
    'What is the capital of {title}?',
    'According to the wiki, which city is the capital of {title}?',
  ],
  generate({ c }) {
    const out = [];
    for (const [id, rec, m] of ents(c, 30)) {
      if (!/ib-country|ib-pol-div|ib-settlement/.test(rec.ib.cls) && !F.rows(rec, /^(Official languages|Demonym\(s\))$/).length) continue;
      const r = F.rows(rec, /^Capital( and largest city)?$/)[0];
      if (!r || F.rows(rec, /^Capital/).length !== 1) continue;
      const line = r.lines[0] || '';
      const v = F.singleName({ ...r, lines: [line.replace(/\s*\d.*$/, '').trim()] });
      if (!v || r.links.length < 1 || c.resolve(r.links[0]) === id) continue;
      out.push({ vars: { title: m.title }, eval: ans(v), ref: r.text });
    }
    return out;
  },
});

module.exports = T;
module.exports.textBirthplaceAlt = textBirthplaceAlt;
module.exports.ents = ents;
module.exports.isPerson = isPerson;
module.exports.isSettlement = isSettlement;
module.exports.isFilm = isFilm;
