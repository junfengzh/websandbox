'use strict';
// Travel questions answered on the directions page (From/To fields or "Directions from/to here",
// mode select): time/distance by car, bike, foot, mode comparisons, choosing between
// destinations, multi-leg trips, the first street of a route.
const L = require('./lib');

const MODE = { car: { by: 'by car', verb: 'drive', noun: 'driving' }, bike: { by: 'by bike', verb: 'cycle', noun: 'cycling' }, foot: { by: 'on foot', verb: 'walk', noun: 'walking' } };

/**
 * Up to k partners of A in the same area at a straight-line distance in [lo, hi] m, each
 * unambiguous from A's location (and A from theirs) -- the map view after picking A.
 */
function partners(r, a, A, lo, hi, k = 1, used = new Set(), extra = () => true) {
  const out = [];
  const cands = r.shuffle(L.areaPois(a).filter((p) => p.id !== A.id && !used.has(p.id) && extra(p)
    && (() => { const d = L.hav(A.lat, A.lon, p.lat, p.lon); return d >= lo && d <= hi; })()));
  for (const p of cands.slice(0, 60)) {
    if (out.length >= k) break;
    if (p.name === A.name || out.some((x) => x.name === p.name || x.name.includes(p.name) || p.name.includes(x.name)) || A.name.includes(p.name) || p.name.includes(A.name)) continue;
    if (!L.unambiguous(p, [[A.lon, A.lat], ...out.map((x) => [x.lon, x.lat])])) continue;
    if (!L.unambiguous(A, [[p.lon, p.lat]])) return out;
    out.push(p);
  }
  return out;
}
const nm = (p) => p.name;
const routeOk = (l) => l && !l.ferry && l.meters > 0;

/** a simple A -> B question for one mode */
function single(name, mode, metric, { lo, hi, phrasings, difficulty = 1, max = 50 }) {
  return {
    name, kind: 'read', skills: ['search', 'navigate', 'read-detail'], difficulty, max, phrasings,
    generate: (r) => L.loop(r, {
      max: max + 5, filter: () => true,
      make: async (A, a, used) => {
        const [B] = partners(r, a, A, lo, hi, 1, used);
        if (!B) return null;
        const l = await L.route(mode, A, B);
        if (!routeOk(l)) return null;
        if (mode === 'foot' && l.min > 120) return null;
        if (mode === 'bike' && l.min > 150) return null;
        used.add(B.id);
        const sp = metric === 'time' ? L.durSpec(l.min) : L.distSpec(l.meters);
        return { slots: { a: nm(A), b: nm(B), where: L.where(A) }, start_url: L.startUrl(a), eval: { type: 'answer', answer: { numeric: sp } }, answer: L.specText(sp),
          changes: [`${mode} ${A.name} -> ${B.name}: ${l.dist}, ${l.time}`] };
      },
    }),
  };
}

module.exports = [
  single('drive-time', 'car', 'time', { lo: 2000, hi: 25000, phrasings: [
    'How long does it take to drive from {{a}}{{where}} to {{b}}?',
    'What is the driving time from {{a}}{{where}} to {{b}} according to the map\'s directions?',
    'I need to get from {{a}}{{where}} to {{b}} by car. How long will the drive take?',
  ] }),
  single('drive-distance', 'car', 'distance', { lo: 2000, hi: 30000, phrasings: [
    'What is the driving distance from {{a}}{{where}} to {{b}}?',
    'How far is it by car from {{a}}{{where}} to {{b}}, following the map\'s route?',
    'Using car directions, how many kilometres is the trip from {{a}}{{where}} to {{b}}?',
  ] }),
  single('walk-time', 'foot', 'time', { lo: 600, hi: 6000, phrasings: [
    'How long does it take to walk from {{a}}{{where}} to {{b}}?',
    'What is the walking time from {{a}}{{where}} to {{b}}?',
    'If I go on foot from {{a}}{{where}} to {{b}}, how many minutes will it take?',
  ] }),
  single('walk-distance', 'foot', 'distance', { lo: 400, hi: 4000, phrasings: [
    'What is the walking distance from {{a}}{{where}} to {{b}}?',
    'How far is the walk from {{a}}{{where}} to {{b}}, according to the walking directions?',
    'Get walking directions from {{a}}{{where}} to {{b}}. How long is the route?',
  ] }),
  single('bike-time', 'bike', 'time', { lo: 1500, hi: 15000, phrasings: [
    'How long does it take to cycle from {{a}}{{where}} to {{b}}?',
    'What is the cycling time from {{a}}{{where}} to {{b}} according to the bicycle directions?',
    'I want to ride my bike from {{a}}{{where}} to {{b}}. How long will it take?',
  ] }),
  {
    name: 'compare-modes', kind: 'read', skills: ['navigate', 'read-detail', 'compare'], difficulty: 2, max: 50,
    phrasings: [
      'How long does the trip from {{a}}{{where}} to {{b}} take {{m1}}, and how long {{m2}}? Give both times.',
      'Compare travelling from {{a}}{{where}} to {{b}} {{m1}} and {{m2}}: what is the travel time for each?',
      'Tell me the travel time from {{a}}{{where}} to {{b}} both {{m1}} and {{m2}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (A, a, used) => {
        const [m1, m2] = r.pick([['car', 'foot'], ['bike', 'foot'], ['car', 'bike']]);
        const [B] = partners(r, a, A, 1000, 6000, 1, used);
        if (!B) return null;
        const l1 = await L.route(m1, A, B), l2 = await L.route(m2, A, B);
        if (!routeOk(l1) || !routeOk(l2) || l2.min > 120) return null;
        if (Math.abs(l1.min - l2.min) < Math.max(4, 0.25 * Math.max(l1.min, l2.min))) return null; // distinct values
        used.add(B.id);
        const s1 = L.durSpec(l1.min), s2 = L.durSpec(l2.min);
        return { slots: { a: nm(A), b: nm(B), where: L.where(A), m1: MODE[m1].by, m2: MODE[m2].by }, start_url: L.startUrl(a),
          eval: { type: 'answer', answer: { numeric: [s1, s2] } }, answer: `${MODE[m1].by} ${L.specText(s1)}, ${MODE[m2].by} ${L.specText(s2)}`,
          changes: [`${m1}: ${l1.dist}, ${l1.time}; ${m2}: ${l2.dist}, ${l2.time}`] };
      },
    }),
  },
  {
    name: 'mode-difference', kind: 'read', skills: ['navigate', 'read-detail', 'compare', 'aggregate'], difficulty: 3, max: 50,
    phrasings: [
      'How many minutes longer does it take to {{slow}} than to {{fast}} from {{a}}{{where}} to {{b}}?',
      'Going from {{a}}{{where}} to {{b}}, how much time would I save if I {{fast}} instead of {{slow}}?',
      'What is the difference in travel time between {{slowing}} and {{fasting}} from {{a}}{{where}} to {{b}}?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (A, a, used) => {
        const [fast, slow] = r.pick([['car', 'foot'], ['bike', 'foot'], ['car', 'bike']]);
        const [B] = partners(r, a, A, 1200, fast === 'car' && slow === 'bike' ? 12000 : 5000, 1, used);
        if (!B) return null;
        const lf = await L.route(fast, A, B), ls = await L.route(slow, A, B);
        if (!routeOk(lf) || !routeOk(ls) || ls.min > 120) return null;
        const diff = ls.min - lf.min;
        if (diff < 5) return null;
        used.add(B.id);
        const sp = { value: diff, unit: 'min', tol_pct: 10, tol_abs: 2 };
        return { slots: { a: nm(A), b: nm(B), where: L.where(A), fast: MODE[fast].verb, slow: MODE[slow].verb, fasting: MODE[fast].noun, slowing: MODE[slow].noun }, start_url: L.startUrl(a),
          eval: { type: 'answer', answer: { numeric: sp } }, answer: L.specText(sp), changes: [`${fast}: ${lf.time} (${lf.dist}); ${slow}: ${ls.time} (${ls.dist}); difference ${diff} min (+-2)`] };
      },
    }),
  },
  {
    name: 'compare-destinations', kind: 'read', skills: ['navigate', 'compare', 'multi-step'], difficulty: 2, max: 50,
    phrasings: [
      'From {{a}}{{where}}, which is the quicker {{noun}} trip: to {{b}} or to {{c}}? Also tell me how long that trip takes.',
      'I am at {{a}}{{where}} and can either go to {{b}} or to {{c}} ({{by}}). Which one can I reach faster, and in how many minutes?',
      'Which is closer in {{noun}} time from {{a}}{{where}}: {{b}} or {{c}}? Give the name and the travel time.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (A, a, used) => {
        const mode = r.pick(['car', 'car', 'foot', 'bike']);
        const [lo, hi] = mode === 'car' ? [2000, 20000] : mode === 'bike' ? [1500, 10000] : [500, 4000];
        const [B, C] = partners(r, a, A, lo, hi, 2, used);
        if (!B || !C) return null;
        const lb = await L.route(mode, A, B), lc = await L.route(mode, A, C);
        if (!routeOk(lb) || !routeOk(lc)) return null;
        const [w, wl, ll] = lb.min < lc.min ? [B, lb, lc] : [C, lc, lb];
        if (ll.min < Math.max(wl.min + 3, wl.min * 1.25) || wl.min > 120) return null;
        used.add(B.id); used.add(C.id);
        const sp = L.durSpec(wl.min);
        return { slots: { a: nm(A), b: nm(B), c: nm(C), where: L.where(A), noun: MODE[mode].noun, by: MODE[mode].by }, start_url: L.startUrl(a),
          eval: { type: 'answer', answer: [{ must_include: [w.name] }, { numeric: sp }] }, answer: `${w.name}, ${L.specText(sp)}`,
          changes: [`${mode}: ${B.name} ${lb.time} (${lb.dist}); ${C.name} ${lc.time} (${lc.dist})`] };
      },
    }),
  },
  {
    name: 'closest-of-n', kind: 'read', skills: ['navigate', 'compare', 'multi-step'], difficulty: 3, max: 50,
    phrasings: [
      'Which of these places is the shortest walk from {{a}}{{where}}: {{list}}? Tell me its name and the walking time.',
      'Starting at {{a}}{{where}}, I can walk to {{list}}. Which one takes the least time on foot, and how long is that walk?',
      'Of {{list}}, which is quickest to reach on foot from {{a}}{{where}}? Include the walking time.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (A, a, used) => {
        const k = r.pick([3, 3, 4]);
        const ps = partners(r, a, A, 400, 3000, k, used);
        if (ps.length < k) return null;
        const legs = [];
        for (const p of ps) legs.push(await L.route('foot', A, p));
        if (legs.some((l) => !routeOk(l))) return null;
        const order = legs.map((l, i) => i).sort((i, j) => legs[i].min - legs[j].min);
        const w = order[0], s = order[1];
        if (legs[s].min < Math.max(legs[w].min + 3, legs[w].min * 1.2)) return null;
        for (const p of ps) used.add(p.id);
        const names = ps.map(nm);
        const list = names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
        const sp = L.durSpec(legs[w].min);
        return { slots: { a: nm(A), list, where: L.where(A) }, start_url: L.startUrl(a),
          eval: { type: 'answer', answer: [{ must_include: [ps[w].name] }, { numeric: sp }] }, answer: `${ps[w].name}, ${L.specText(sp)}`,
          changes: [`foot: ${ps.map((p, i) => `${p.name} ${legs[i].time} (${legs[i].dist})`).join('; ')}`] };
      },
    }),
  },
  {
    name: 'multi-leg-trip', kind: 'read', skills: ['navigate', 'aggregate', 'multi-step'], difficulty: 3, max: 50,
    phrasings: [
      'I plan to {{verb}} from {{a}}{{where}} to {{b}}, and then from {{b}} on to {{c}}. What is the total travel time of both legs?',
      'Trip plan ({{by}}): {{a}}{{where}} -> {{b}} -> {{c}}. How long will the whole trip take, adding up both legs?',
      'How long in total does it take to {{verb}} from {{a}}{{where}} to {{b}} and then continue to {{c}}?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (A, a, used) => {
        const mode = r.pick(['car', 'car', 'bike', 'foot']);
        const [lo, hi] = mode === 'car' ? [2000, 12000] : mode === 'bike' ? [1500, 7000] : [500, 2500];
        const [B] = partners(r, a, A, lo, hi, 1, used);
        if (!B) return null;
        const [C] = partners(r, a, B, lo, hi, 1, new Set([...used, A.id, B.id]), (p) => p.name !== A.name && !A.name.includes(p.name) && !p.name.includes(A.name));
        if (!C || !L.unambiguous(C, [[A.lon, A.lat]])) return null;
        const l1 = await L.route(mode, A, B), l2 = await L.route(mode, B, C);
        if (!routeOk(l1) || !routeOk(l2) || l1.min + l2.min > 150 || l1.min < 3 || l2.min < 3) return null;
        used.add(B.id); used.add(C.id);
        const tot = l1.min + l2.min;
        const sp = { value: tot, unit: 'min', tol_pct: 10, tol_abs: 2 };
        return { slots: { a: nm(A), b: nm(B), c: nm(C), where: L.where(A), verb: MODE[mode].verb, by: MODE[mode].by }, start_url: L.startUrl(a),
          eval: { type: 'answer', answer: { numeric: sp } }, answer: L.specText(sp),
          changes: [`${mode}: ${A.name} -> ${B.name} ${l1.time} (${l1.dist}); ${B.name} -> ${C.name} ${l2.time} (${l2.dist}); total ${tot} min (+-2 or 10 %)`] };
      },
    }),
  },
  {
    name: 'route-first-street', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2, max: 50,
    phrasings: [
      'If I {{verb}} from {{a}}{{where}} to {{b}} following the map\'s directions, on which street does the route start?',
      'Get {{noun}} directions from {{a}}{{where}} to {{b}}. What is the first street named in the turn-by-turn directions?',
      'On the {{noun}} route from {{a}}{{where}} to {{b}}, which street do I set off on?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (A, a, used) => {
        const mode = r.pick(['car', 'foot', 'bike']);
        const [B] = partners(r, a, A, 800, mode === 'car' ? 15000 : 5000, 1, used);
        if (!B) return null;
        const l = await L.route(mode, A, B);
        if (!routeOk(l) || !l.steps || l.steps.length < 3) return null;
        const s0 = l.steps[0];
        if (!s0.name || !L.nameOk(s0.name) || s0.distance < 40 || s0.name === (l.steps[1] || {}).name) return null;
        used.add(B.id);
        return { slots: { a: nm(A), b: nm(B), where: L.where(A), verb: MODE[mode].verb, noun: MODE[mode].noun }, start_url: L.startUrl(a),
          eval: { type: 'answer', answer: { must_include: [L.streetAlts(s0.name)] } }, answer: s0.name,
          changes: [`${mode} ${A.name} -> ${B.name}: ${l.dist}, ${l.time}; first step "${s0.instruction}" ${Math.round(s0.distance)} m`] };
      },
    }),
  },
];
module.exports.partners = partners;
module.exports.MODE = MODE;
