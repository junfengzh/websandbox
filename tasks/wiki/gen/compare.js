'use strict';
// Compare one infobox attribute across 2-3 named articles (unique winner with a clear margin),
// and follow-a-link chains (article -> infobox link -> fact on the linked article).
const L = require('./lib');
const F = require('./facts');
const I = require('./infobox');

const ans = (s) => ({ type: 'answer', answer: { must_include: [s] } });
const T = [];

// group candidates into sets of k with a unique winner (margin >= rel) from a deterministic shuffle
function groups(rand, items, k, better, margin, maxGroups) {
  const xs = rand.shuffle(items);
  const out = [];
  for (let i = 0; i + k <= xs.length && out.length < maxGroups; i += k) {
    const g = xs.slice(i, i + k);
    const s = g.slice().sort((a, b) => better(a, b));
    if (!margin(s[0], s[1])) continue;
    const ns = g.map((x) => L.norm(x.title));
    if (ns.some((a, ia) => ns.some((b, ib) => ia !== ib && b.includes(a)))) continue; // no title inside another
    out.push({ g, win: s[0] });
  }
  return out;
}
const list = (ts) => (ts.length === 2 ? `${ts[0]} and ${ts[1]}` : `${ts.slice(0, -1).join(', ')} and ${ts[ts.length - 1]}`);

T.push({
  id: 'gen-wiki-compare-population', skills: ['search', 'read-detail', 'compare'], difficulty: 2, cap: 55,
  phrasings: [
    'Which has the largest population according to the wiki: {list}?',
    'Compare the populations of {list}. Which one is the most populous?',
    'Among {list}, which has the most inhabitants (infobox population)?',
  ],
  generate({ c, rand }) {
    const items = [];
    for (const [, rec, m] of I.ents(c, 200)) {
      if (!I.isSettlement(rec)) continue;
      const pr = F.rows(rec, /./, /^Population/);
      if (!pr.length || !/^(Total|City|Town|Municipality)$/.test(pr[0].k)) continue;
      const v = F.count(pr[0], { min: 1000 });
      if (v) items.push({ path: m.path, title: m.title, v: v.v });
    }
    return groups(rand, items, 3, (a, b) => b.v - a.v, (a, b) => a.v > b.v * 1.1, 400).map(({ g, win }) => ({
      vars: { list: list(g.map((x) => x.title)) }, eval: ans(win.title), evidence: g.map((x) => x.path), ref: g.map((x) => `${x.title}=${x.v}`).join('; '),
    }));
  },
});

T.push({
  id: 'gen-wiki-compare-birth', skills: ['search', 'read-detail', 'compare'], difficulty: 2, cap: 55,
  phrasings: [
    'Who was born first: {list}?',
    'Of {list}, who is the oldest (earliest date of birth)?',
    'Which of these people was born earliest: {list}?',
  ],
  generate({ c, rand }) {
    const items = [];
    for (const [, rec, m] of I.ents(c, 300)) {
      if (!I.isPerson(rec)) continue;
      const b = F.bornDied(F.one(rec, /^Born$/));
      if (b && +b.iso.slice(0, 4) >= 1500) items.push({ path: m.path, title: m.title, v: b.iso });
    }
    const k = (x) => +x.v.slice(0, 4);
    return groups(rand, items, 3, (a, b) => (a.v < b.v ? -1 : 1), (a, b) => k(b) - k(a) >= 2, 400).map(({ g, win }) => ({
      vars: { list: list(g.map((x) => x.title)) }, eval: ans(win.title), evidence: g.map((x) => x.path), ref: g.map((x) => `${x.title}=${x.v}`).join('; '),
    }));
  },
});

T.push({
  id: 'gen-wiki-compare-capacity', skills: ['search', 'read-detail', 'compare'], difficulty: 2, cap: 45,
  phrasings: [
    'Which venue has the larger capacity: {list}?',
    'Compare the seating capacities of {list}. Which holds the most people?',
  ],
  generate({ c, rand }) {
    const items = [];
    for (const [, rec, m] of I.ents(c, 50)) {
      if (!F.rows(rec, /^(Opened|Broke ground|Built)$/).length) continue;
      const v = F.count(F.one(rec, /^Capacity$/), { min: 500, max: 300000 });
      if (v) items.push({ path: m.path, title: m.title, v: v.v });
    }
    const out = [];
    for (const k of [2, 3]) {
      out.push(...groups(rand, items, k, (a, b) => b.v - a.v, (a, b) => a.v > b.v * 1.05, 200).map(({ g, win }) => ({
        vars: { list: list(g.map((x) => x.title)) }, eval: ans(win.title), evidence: g.map((x) => x.path), ref: g.map((x) => `${x.title}=${x.v}`).join('; '),
      })));
    }
    return out;
  },
});

// ---- chains: article --(infobox link)--> article --> fact
function chain(c, kRe, filter) {
  const out = [];
  for (const [, rec, m] of I.ents(c, 20)) {
    if (filter && !filter(rec)) continue;
    const r = F.one(rec, kRe);
    const name = F.singleName(r);
    const to = name && F.singleLink(c, r);
    if (!to || !F.usable(c, to) || !c.all.get(to)) continue;
    out.push({ m, name, to, rec2: c.all.get(to), m2: c.meta.get(to) });
  }
  return out;
}

T.push({
  id: 'gen-wiki-chain-director-birthplace', skills: ['search', 'navigate', 'multi-step', 'read-detail'], difficulty: 3, cap: 55,
  phrasings: [
    'Where was the director of the film {title} born? Name the city or town.',
    'Find who directed {title}, then tell me that person\'s birthplace (city).',
    'The director of {title} was born in which city?',
  ],
  generate({ c }) {
    const out = [];
    for (const x of chain(c, /^Directed by$/, I.isFilm)) {
      if (!I.isPerson(x.rec2)) continue;
      const b = F.bornDied(F.one(x.rec2, /^Born$/));
      const cty = b && F.city(b.place);
      if (!cty || b.place.split(',').length < 2) continue;
      out.push({ vars: { title: x.m.title }, eval: ans(cty), ref: `${x.m2.title}: ${b.place}`, evidence: [x.m2.path], born: { id: x.m2.id, place: b.place, name: x.m2.title } });
    }
    return out;
  },
  finish: I.textBirthplaceAlt,
});

T.push({
  id: 'gen-wiki-chain-team-venue-capacity', skills: ['search', 'navigate', 'multi-step', 'read-detail'], difficulty: 3, cap: 50,
  phrasings: [
    'What is the capacity of the home venue of {title}?',
    'Find where {title} play their home games, then report that venue\'s seating capacity.',
    'How many spectators does the home stadium or arena of {title} hold?',
  ],
  generate({ c }) {
    const out = [];
    for (const x of chain(c, /^(Arena|Stadium|Ground|Home ground|Home stadium|Arena\/Stadium|Ballpark)$/, (rec) => F.rows(rec, /^(League|Conference|Division)$/).length > 0)) {
      const v = F.count(F.one(x.rec2, /^Capacity$/), { min: 500, max: 300000 });
      if (!v) continue;
      // club infoboxes may repeat the capacity: it must agree with the venue's
      const own = F.rows(x.m && c.all.get(x.m.id), /^Capacity$/);
      if (own.length && !own.every((r) => { const w = F.count(r, { min: 1 }); return w && w.v === v.v; })) continue;
      out.push({ vars: { title: x.m.title }, eval: ans(v.shown), ref: `${x.m2.title}: ${v.shown}`, evidence: [x.m2.path] });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-chain-almamater-founded', skills: ['search', 'navigate', 'multi-step', 'read-detail'], difficulty: 3, cap: 45,
  phrasings: [
    'When was the alma mater of {title} established? Give the year.',
    '{title} studied at a university or school listed as their alma mater. In what year was it founded?',
  ],
  generate({ c }) {
    const out = [];
    for (const x of chain(c, /^Alma mater$/, I.isPerson)) {
      const rs = F.rows(x.rec2, /^(Established|Founded)$/);
      const y = rs.length === 1 && F.year(rs[0]);
      if (!y) continue;
      out.push({ vars: { title: x.m.title }, eval: ans(y), ref: `${x.m2.title}: ${rs[0].text}`, evidence: [x.m2.path] });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-chain-county-seat', skills: ['search', 'navigate', 'multi-step', 'read-detail'], difficulty: 3, cap: 45,
  phrasings: [
    'What is the county seat of the county that {title} is in?',
    '{title} lies in a county. Which city or town is that county\'s seat?',
  ],
  generate({ c }) {
    const out = [];
    for (const x of chain(c, /^County$/, I.isSettlement)) {
      const r = F.one(x.rec2, /^Seat$/);
      const v = F.singleName(r);
      if (!v || L.norm(v) === L.norm(x.m.title.split(',')[0]) || L.norm(x.m2.title).startsWith(L.norm(v))) continue; // not the town itself, nor the county's own name (Washington County -> Washington)
      out.push({ vars: { title: x.m.title }, eval: ans(v), ref: `${x.m2.title}: seat ${v}`, evidence: [x.m2.path] });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-nav-infobox-link', skills: ['search', 'navigate'], difficulty: 2, cap: 55,
  phrasings: [
    'Open the wiki article about the director of {title}.',
    'Go to the article on the person who directed {title}.',
    'Starting from {title}, navigate to the article of its director.',
  ],
  generate({ c }) {
    const out = [];
    for (const x of chain(c, /^Directed by$/, I.isFilm)) {
      out.push({ vars: { title: x.m.title }, eval: { type: 'url', url: `__WIKIPEDIA__${L.wikiPath(x.m2.path)}` }, ref: x.m2.path });
    }
    return out;
  },
});

module.exports = T;
