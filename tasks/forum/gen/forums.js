'use strict';
// Forum directory: categories (/forums/by_category, /tag/<name>), counts, subscriptions.
const L = require('./lib');
const { answer, state, uid, lit, AFTER } = require('./evals');

module.exports = [
  {
    name: 'category-largest-forum', kind: 'read', skills: ['aggregate', 'compare'], difficulty: 2,
    phrasings: [
      'Among the forums in the "{{category}}" category, which one has the {{most}} submissions?',
      'Look at the "{{category}}" category of forums. Which forum there has the {{most}} posts?',
      'Which forum in the {{category}} category has the {{most}} submissions?',
    ],
    *generate(r) {
      for (const t of r.shuffle(L.tags())) {
        if (t.forums.length < 2) continue;
        for (const most of r.shuffle(['most', 'fewest'])) {
          const xs = [...t.forums].sort((a, b) => (most === 'most' ? b.n - a.n : a.n - b.n));
          if (xs[0].n === xs[1].n) continue;
          const dir = most === 'most' ? 'DESC' : 'ASC';
          yield { slots: { category: t.name, most }, login_user: L.loginFor(r),
            eval: answer(xs[0].name, `SELECT f.name FROM forums f JOIN forums_tags ft ON ft.forum_id = f.id JOIN forum_tags t ON t.id = ft.tag_id WHERE t.name = ${lit(t.name)}
              ORDER BY (SELECT count(*) FROM submissions s WHERE s.forum_id = f.id AND s.visibility = 'visible' AND s.created_at < '${AFTER}') ${dir} LIMIT 1`),
            changes: [`counts: ${xs.map((f) => `${f.name} ${f.n}`).join(', ')}`] };
        }
      }
    },
  },
  {
    name: 'subscribe-category', kind: 'write', skills: ['multi-step', 'navigate'], difficulty: 2,
    phrasings: [
      'Subscribe to every forum in the "{{category}}" category{{except}}.',
      'I want to follow the {{category}} category: subscribe me to all of its forums{{except}}.',
      'Find the forums listed under "{{category}}" and subscribe to each of them{{except}}.',
    ],
    *generate(r) {
      const out = [];
      for (const t of L.tags()) {
        if (t.forums.length < 2 || t.forums.length > 12) continue;
        out.push({ t, skip: null });
        for (const f of t.forums) if (t.forums.length >= 3) out.push({ t, skip: f });
      }
      for (const { t, skip } of r.shuffle(out)) {
        const want = t.forums.filter((f) => f !== skip).map((f) => f.name.toLowerCase()).sort();
        const me = L.loginFor(r);
        yield { slots: { category: t.name, except: skip ? ` except /f/${skip.name}` : '', skip: skip ? skip.name : null }, login_user: me,
          eval: state(`SELECT f.normalized_name FROM forum_subscriptions fs JOIN forums f ON f.id = fs.forum_id WHERE fs.user_id = ${uid(me)} ORDER BY 1`, want.map((n) => [n])),
          changes: ['state: the user\'s subscriptions are exactly the category\'s forums (the user starts with none)'] };
      }
    },
  },
];
