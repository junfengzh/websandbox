'use strict';
// "Nearest X to Y" / "how many X within R of Y": the place page's "What's nearby?" list (or the
// search "<category> near <place>"), both sorted by straight-line distance, plus walking times.
const L = require('./lib');

// [NEARBY value of the place page form, singular for intents, plural (search wording), US only]
const CATS = [
  ['restaurant', 'restaurant', 'restaurants'], ['cafe', 'cafe', 'cafes'], ['fast food', 'fast food restaurant', 'fast food restaurants'],
  ['bar', 'bar or pub', 'bars'], ['hotel', 'hotel', 'hotels'], ['supermarket', 'supermarket', 'supermarkets'], ['pharmacy', 'pharmacy', 'pharmacies'],
  ['bank', 'bank', 'banks'], ['post office', 'post office', 'post offices'], ['library', 'library', 'libraries'], ['museum', 'museum', 'museums'],
  ['park', 'park', 'parks'], ['cinema', 'cinema', 'cinemas'], ['school', 'school', 'schools'], ['police', 'police station', 'police stations'],
  ['hospital', 'hospital', 'hospitals'], ['theatre', 'theatre', 'theatres'], ['gas station', 'gas station', 'gas stations', true],
].map(([v, one, many, us]) => ({ v, one, many, us: !!us, classes: L.geo()._category(v) }));
const catsFor = (a) => CATS.filter((c) => !c.us || L.US.has(a.id));
const isCat = (p, c) => c.classes.some(([k, t]) => p.class === k && (!t || p.type === t));

/** the "What's nearby?" list of a place for a category (routes/pages.js /query) */
const nearbyList = (p, c) => L.geo().nearby(p.lat, p.lon, { category: c.v, limit: 20, radius: 1000, maxRadius: 20000 });

/**
 * The nearest place of a category to p by straight line, if it is a clear winner: named, nearer
 * than the runner-up by 40 % and 50 m, its name not shared by the next four, and the same first
 * result for the search "<category> near <p>" from the plain-load and the area view.
 */
function nearest(p, c, a, maxM = 1500, used = null) {
  const list = nearbyList(p, c).filter((x) => x.place_id !== p.id);
  if (list.length < 2) return null;
  const [w, s] = list;
  if (!w.name || !L.nameOk(w.name) || w.distance > maxM || s.distance < 1.4 * w.distance || s.distance - w.distance < 50) return null;
  if (list.slice(1, 5).some((x) => x.name === w.name)) return null;
  if (used && used.has(w.place_id)) return null; // one task per winner and template
  for (const q of [`${c.many} near ${p.name}`, `${c.v} near ${p.name}`]) {
    for (const ctr of [L.CMU, [a.lon, a.lat]]) {
      const h = L.topHit(q, ctr);
      if (!h || h.place_id !== w.place_id) return null;
    }
  }
  return { w, list };
}
const origin = (c) => (p) => !c || !isCat(p, c);

module.exports = [
  {
    name: 'nearest-category', kind: 'read', skills: ['search', 'navigate', 'compare'], difficulty: 2, max: 55,
    phrasings: [
      'What is the closest {{cat}} to {{name}}{{where}} (straight-line distance)? Tell me its name.',
      'I am at {{name}}{{where}}. Which {{cat}} is nearest as the crow flies?',
      'Using the map, find the {{cat}} nearest to {{name}}{{where}} and give me its name.',
    ],
    generate: (r) => L.loop(r, {
      max: 60, filter: () => true,
      make: (p, a, used) => {
        const c = r.pick(catsFor(a));
        if (isCat(p, c)) return null;
        const n = nearest(p, c, a, 1500, used);
        if (!n) return null;
        used.add(n.w.place_id);
        return { slots: { cat: c.one, name: p.name, where: L.where(p) }, start_url: L.startUrl(a), eval: { type: 'answer', answer: { must_include: [n.w.name] } }, answer: n.w.name,
          changes: [`nearest ${c.v}: ${n.w.name} ${Math.round(n.w.distance)} m; runner-up ${n.list[1].name || '(unnamed)'} ${Math.round(n.list[1].distance)} m`] };
      },
    }),
  },
  {
    name: 'nearest-category-distance', kind: 'read', skills: ['search', 'navigate', 'read-detail'], difficulty: 2, max: 50,
    phrasings: [
      'How far, in a straight line, is the nearest {{cat}} from {{name}}{{where}}, and what is it called?',
      'Find the {{cat}} closest to {{name}}{{where}}. What is its name and its straight-line distance from there?',
      'Name the nearest {{cat}} to {{name}}{{where}} and say how far away it is as the crow flies.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: (p, a, used) => {
        const c = r.pick(catsFor(a));
        if (isCat(p, c)) return null;
        const n = nearest(p, c, a, 2500, used);
        if (!n || n.w.distance < 60) return null;
        used.add(n.w.place_id);
        const sp = L.straightSpec(n.w.distance);
        return { slots: { cat: c.one, name: p.name, where: L.where(p) }, start_url: L.startUrl(a),
          eval: { type: 'answer', answer: [{ must_include: [n.w.name] }, { numeric: sp }] }, answer: `${n.w.name}, ${L.specText(sp)}`,
          changes: [`nearest ${c.v}: ${n.w.name} ${Math.round(n.w.distance)} m (the list shows ${L.fmtDist(n.w.distance)})`] };
      },
    }),
  },
  {
    name: 'count-within-radius', kind: 'read', skills: ['search', 'navigate', 'aggregate'], difficulty: 2, max: 50,
    phrasings: [
      'How many {{cats}} are there within {{radius}} (straight-line distance) of {{name}}{{where}}? Answer with the number.',
      'Count the {{cats}} the map lists within {{radius}} of {{name}}{{where}} as the crow flies.',
      'According to the map, how many {{cats}} lie within a {{radius}} radius of {{name}}{{where}}?',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: (p, a, used) => {
        const c = r.pick(catsFor(a));
        if (isCat(p, c)) return null;
        const R = r.pick([200, 300, 400, 500, 750, 1000]);
        const list = nearbyList(p, c).filter((x) => x.place_id !== p.id);
        const n = list.filter((x) => x.distance <= R).length;
        if (n < 2 || n > 12 || (list.length >= 20 && list[19].distance <= R)) return null;
        const margin = Math.max(25, 0.1 * R);
        if (list.some((x) => Math.abs(x.distance - R) < margin)) return null;
        const rad = R >= 1000 ? `${R / 1000} km` : `${R} m`;
        return { slots: { cats: c.many, radius: rad, name: p.name, where: L.where(p) }, start_url: L.startUrl(a), eval: { type: 'answer', answer: { must_include: [String(n)] } }, answer: String(n),
          changes: [`${c.v} within ${R} m: ${list.filter((x) => x.distance <= R).map((x) => `${x.name || '(unnamed)'} ${Math.round(x.distance)} m`).join('; ')}; next ${Math.round((list[n] || {}).distance || 0)} m`] };
      },
    }),
  },
  {
    name: 'nearest-walk-time', kind: 'read', skills: ['search', 'navigate', 'multi-step'], difficulty: 3, max: 50,
    phrasings: [
      'I am at {{name}}{{where}}. Which is the nearest {{cat}}, and how long does it take to walk there?',
      'Find the closest {{cat}} to {{name}}{{where}} and tell me its name and the walking time from {{name}}.',
      'How many minutes on foot is it from {{name}}{{where}} to the nearest {{cat}}? Also name the {{cat}}.',
    ],
    generate: (r) => L.loop(r, {
      max: 55, filter: () => true,
      make: async (p, a, used) => {
        const c = r.pick(catsFor(a).filter((x) => x.v !== 'park'));
        if (isCat(p, c)) return null;
        const n = nearest(p, c, a, 1500, used);
        if (!n || n.w.distance < 100) return null;
        const legs = [];
        for (const x of n.list.slice(0, 3)) legs.push(await L.route('foot', p, x));
        if (!legs[0] || legs.some((l) => !l)) return null;
        const best = legs[0].min;
        if (best > 40 || legs.slice(1).some((l) => l.min < Math.max(best + 2, best * 1.15))) return null;
        used.add(n.w.place_id);
        const sp = L.durSpec(best);
        return { slots: { cat: c.one, name: p.name, where: L.where(p) }, start_url: L.startUrl(a),
          eval: { type: 'answer', answer: [{ must_include: [n.w.name] }, { numeric: sp }] }, answer: `${n.w.name}, ${L.specText(sp)}`,
          changes: [`walks: ${n.list.slice(0, 3).map((x, i) => `${x.name || '(unnamed)'} ${legs[i].time} (${legs[i].dist})`).join('; ')}`] };
      },
    }),
  },
];
module.exports.CATS = CATS;
module.exports.nearest = nearest;
module.exports.catsFor = catsFor;
module.exports.isCat = isCat;
