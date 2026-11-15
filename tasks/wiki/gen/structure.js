'use strict';
// Article structure and wiki features: sections / table of contents, navigation end states
// (graded by the final URL, sections by its fragment), What links here, redirects, page info.
const L = require('./lib');
const F = require('./facts');

const T = [];
const BORING = /^(See also|References|External links|Notes|Further reading|Bibliography|Sources|Citations|Footnotes|Gallery|Works cited|Notes and references|Explanatory notes|Literature|Selected bibliography)$/i;
const secs = (m) => (m.sections ? JSON.parse(m.sections) : []);
// articles with a TOC (>= 4 headings, as the site renders one)
function* tocArticles(c, minIn = 100) {
  for (const [id, m] of c.meta) {
    if (m.inlinks < minIn || !F.usable(c, id)) continue;
    const s = secs(m);
    if (s.length >= 4) yield [id, m, s];
  }
}

T.push({
  id: 'gen-wiki-section-first-sub', skills: ['search', 'navigate', 'read-detail'], difficulty: 2, cap: 60,
  phrasings: [
    'In the wiki article {title}, what is the first subsection of the "{sec}" section?',
    'Open {title}. The section "{sec}" is divided into subsections; what is the heading of the first one?',
    'Look at the table of contents of {title}. Which subsection comes first under "{sec}"?',
  ],
  generate({ c }) {
    const out = [];
    for (const [, m, s] of tocArticles(c)) {
      const heads = s.map((x) => x[2]);
      for (let i = 0; i < s.length - 2; i++) {
        const [lv, , h] = s[i];
        if (lv !== 2 || BORING.test(h) || s[i + 1][0] !== 3) continue;
        if (heads.filter((x) => x === h).length !== 1) continue;
        // at least 2 subsections, so "first" is meaningful
        let n = 0; for (let j = i + 1; j < s.length && s[j][0] > 2; j++) if (s[j][0] === 3) n++;
        if (n < 2) continue;
        const sub = s[i + 1][2];
        if (sub.length > 70 || heads.filter((x) => x === sub).length !== 1) continue;
        out.push({ vars: { title: m.title, sec: h }, eval: { type: 'answer', answer: { must_include: [sub] } }, ref: sub });
        break;
      }
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-section-count-subs', skills: ['search', 'navigate', 'aggregate'], difficulty: 2, cap: 50,
  phrasings: [
    'How many subsections does the "{sec}" section of the article {title} have?',
    'In {title}, count the direct subsections listed under "{sec}" in the table of contents.',
  ],
  generate({ c }) {
    const out = [];
    for (const [, m, s] of tocArticles(c)) {
      const heads = s.map((x) => x[2]);
      const cand = [];
      for (let i = 0; i < s.length; i++) {
        const [lv, , h] = s[i];
        if (lv !== 2 || BORING.test(h) || heads.filter((x) => x === h).length !== 1) continue;
        let n = 0; let deeperFirst = false;
        for (let j = i + 1; j < s.length && s[j][0] > 2; j++) { if (s[j][0] === 3) n++; else if (n === 0) deeperFirst = true; }
        if (n >= 2 && n <= 12 && !deeperFirst) cand.push({ h, n });
      }
      if (!cand.length) continue;
      const x = cand[L.strHash(m.path) % cand.length];
      out.push({ vars: { title: m.title, sec: x.h }, eval: { type: 'answer', answer: { must_include: [L.countRef(x.n)] } }, ref: x.n });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-nav-section', skills: ['search', 'navigate'], difficulty: 1, cap: 60,
  phrasings: [
    'Open the "{sec}" section of the wiki article {title}.',
    'Go to the article {title} and jump to its "{sec}" section using the table of contents.',
    'Navigate to the section "{sec}" in {title}.',
  ],
  generate({ c }) {
    const out = [];
    for (const [, m, s] of tocArticles(c, 200)) {
      const heads = s.map((x) => x[2]);
      const cand = s.filter(([lv, a, h]) => lv <= 3 && !BORING.test(h) && heads.filter((x) => x === h).length === 1 && h.length <= 60 && a === h.replace(/ /g, '_') && !/["'&<>%?#]/.test(a));
      if (cand.length < 3) continue;
      const [, a, h] = cand[1 + (L.strHash(m.path) % (cand.length - 1))];
      out.push({ vars: { title: m.title, sec: h }, eval: { type: 'url', url: `__WIKIPEDIA__${L.wikiPath(m.path)}#${encodeURIComponent(a)}` }, ref: `${m.path}#${a}` });
    }
    return out;
  },
});

// ---- link graph
T.push({
  id: 'gen-wiki-whatlinkshere-count', skills: ['search', 'navigate', 'aggregate'], difficulty: 2, cap: 60,
  phrasings: [
    'How many articles on this wiki link to {title}?',
    'Use "What links here" for {title}. How many articles link to it?',
    'Count the pages on the wiki that link to the article {title} (articles only, not redirects).',
  ],
  generate({ c }) {
    const out = [];
    const st = c.db.prepare('SELECT count(*) FROM link WHERE dst = ?').pluck();
    for (const [id, m] of c.meta) {
      if (id % 7 !== 0 || !F.usable(c, id) || m.inlinks < 700) continue;
      const n = st.get(id);
      if (n < 3 || n > 45) continue;
      const sql = `SELECT count(*) FROM link WHERE dst = ${L.aid(m.path)}`;
      out.push({ vars: { title: m.title }, eval: { type: 'answer', answer: { must_include: [L.countRef(n)] }, answer_sql: sql }, ref: n });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-whatlinkshere-which', skills: ['search', 'navigate', 'compare'], difficulty: 2, cap: 55,
  phrasings: [
    'Which one of these articles links to {title}: {opts}?',
    'Of {opts}, exactly one has a link to the article {title}. Which one?',
    'Check "What links here" for {title}. Which of the following pages appears there: {opts}?',
  ],
  generate({ c, rand }) {
    const out = [];
    const linksTo = c.db.prepare('SELECT src FROM link WHERE dst = ?').pluck();
    const hasLink = c.db.prepare('SELECT 1 FROM link WHERE dst = ? AND src = ?').pluck();
    // outgoing links from the article HTML (link has no src index)
    const out1 = { all: (id) => [...new Set([...L.html(c.db, id).matchAll(/href="\/wiki\/([^"#?]+)/g)].map((m) => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }))].map((p) => c.byPath.get(p)).filter(Boolean).slice(0, 400) };
    for (const [id, m] of c.meta) {
      if (id % 11 !== 0 || !F.usable(c, id) || m.inlinks < 700) continue;
      const srcs = linksTo.all(id).filter((x) => F.usable(c, x));
      if (srcs.length < 3 || srcs.length > 200) continue;
      const yes = srcs[L.strHash(m.path) % srcs.length];
      // distractors: articles linked from the target (topically related) that do not link back
      const dis = out1.all(id).filter((x) => x !== yes && F.usable(c, x) && !hasLink.get(id, x));
      if (dis.length < 2) continue;
      const pick = rand.sample(dis, 2);
      const opts = rand.shuffle([yes, ...pick]).map((x) => c.meta.get(x).title);
      const ids = [yes, ...pick].map((x) => c.meta.get(x).path);
      const sql = `SELECT a.title FROM article a WHERE a.path IN (${ids.map(L.q).join(', ')}) AND a.id IN (SELECT src FROM link WHERE dst = ${L.aid(m.path)})`;
      out.push({ vars: { title: m.title, opts: opts.map((o) => `"${o}"`).join(', ') }, eval: { type: 'answer', answer: { must_include: [c.meta.get(yes).title] }, answer_sql: sql }, ref: c.meta.get(yes).title, opts });
    }
    return out;
  },
});

// ---- redirects / alternate names
function lev(a, b) {
  const m = a.length; const n = b.length; const d = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { let p = d[0]; d[0] = i; for (let j = 1; j <= n; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } }
  return d[n];
}
function goodRedirects(c) {
  const out = [];
  const st = c.db.prepare('SELECT path, title, target FROM redirect WHERE target = ?');
  for (const [id, m] of c.meta) {
    if (id % 3 !== 0 || !F.usable(c, id) || m.inlinks < 1500) continue;
    const tn = L.norm(m.title).replace(/[^a-z0-9 ]/g, '');
    for (const r of st.all(id)) {
      const rn = L.norm(r.title).replace(/[^a-z0-9 ]/g, '');
      if (/[()#:]/.test(r.title) || /\d{3,}/.test(r.title) || rn.length < 4 || r.title.length > 50) continue;
      if (rn === tn || tn.includes(rn) || rn.includes(tn)) continue;
      if (lev(rn, tn) < Math.max(4, 0.5 * Math.max(rn.length, tn.length))) continue; // not a misspelling
      if (!/^[A-Z]/.test(r.title) || r.title === r.title.toUpperCase()) continue;
      // the redirect name must not also be an article / other redirect's norm
      if (c.byNorm.has(L.norm(r.title))) continue;
      out.push({ r, m });
    }
  }
  return out;
}

T.push({
  id: 'gen-wiki-redirect-target', skills: ['search', 'navigate'], difficulty: 1, cap: 60,
  phrasings: [
    'On the wiki, "{name}" redirects to an article. What is that article\'s title?',
    'Search the wiki for "{name}". Which article do you end up on? Give its title.',
    '"{name}" is another name for something that has its own article on the wiki. What is the title of that article?',
  ],
  generate({ c }) {
    const seen = new Set();
    return goodRedirects(c).filter(({ m }) => (seen.has(m.id) ? false : seen.add(m.id))).map(({ r, m }) => ({
      vars: { name: r.title },
      eval: { type: 'answer', answer: { must_include: [m.title.replace(/ \([^()]+\)$/, '')] }, answer_sql: `SELECT a.title FROM redirect r JOIN article a ON a.id = r.target WHERE r.path = ${L.q(r.path)}` },
      ref: m.title,
    }));
  },
});

T.push({
  id: 'gen-wiki-redirect-nav', skills: ['search', 'navigate'], difficulty: 1, cap: 45,
  phrasings: [
    'Open the wiki article that "{name}" refers to.',
    'Go to the article you reach by searching for "{name}".',
  ],
  generate({ c }) {
    const seen = new Set();
    // a different redirect per article than gen-wiki-redirect-target uses (last one instead of first)
    const all = goodRedirects(c).reverse();
    return all.filter(({ m }) => (seen.has(m.id) ? false : seen.add(m.id))).map(({ r, m }) => ({
      vars: { name: r.title },
      eval: { type: 'url', url: `__WIKIPEDIA__${L.wikiPath(m.path)}` },
      ref: m.path,
    }));
  },
});

module.exports = T;
