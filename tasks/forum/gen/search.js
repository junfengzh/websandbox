'use strict';
// Search: posts by title, comments by a quoted phrase, and filtered/sorted search within a forum.
const L = require('./lib');
const { answer, answerTitleOk, titleRef, lit, fid, AFTER } = require('./evals');
const search = require('../../../kit/lib/search');

const STOP = new Set('about after again their there these those which would could should other where while being every still never always really people thing things think since first years today little great right'.split(' '));

module.exports = [
  {
    name: 'search-post-forum-author', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1,
    phrasings: [
      'Find the post titled "{{title}}". Who submitted it, and in which forum?',
      'Someone posted "{{title}}". Tell me the username of the submitter and the forum it was posted in.',
      'Search for the submission "{{title}}" and report its author and forum.',
    ],
    *generate(r) {
      for (const p of r.sample(L.posts(), 400)) {
        yield { slots: { title: p.title }, login_user: L.loginFor(r, [p.username]),
          // two rows (the grader reads the first column of each row)
          eval: answer([p.username, p.forum], `SELECT u.username FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.id = ${p.id} UNION ALL SELECT f.name FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.id = ${p.id}`),
          changes: [`reference: submission ${p.id}`, 'regrade 2026-11-15: answer_sql returns the username and the forum as two rows (it returned one row with two columns, so the drift check saw only the username)'] };
      }
    },
  },
  {
    name: 'search-comment-phrase', kind: 'read', skills: ['search', 'navigate'], difficulty: 2,
    phrasings: [
      'Somebody left a comment saying "{{phrase}}". On which post was that comment made? Give the post title.',
      'Find the comment "{{phrase}}" and tell me the title of the submission it belongs to.',
      'There is a comment that reads "{{phrase}}". What post is it under?',
    ],
    *generate(r) {
      const max = L.get('SELECT max(id) m FROM comments').m;
      const cnt = L.open().prepare('SELECT count(*) n FROM (SELECT rowid FROM comments_fts WHERE comments_fts MATCH ? LIMIT 3)');
      for (let tries = 0; tries < 60000; tries++) {
        const c = L.get(`SELECT c.id, c.body, c.submission_id, s.title, s.visibility sv FROM comments c JOIN submissions s ON s.id = c.submission_id
          WHERE c.id >= ? AND c.visibility = 'visible' ORDER BY c.id LIMIT 1`, 1 + r.int(max));
        if (!c || c.sv !== 'visible' || !L.cleanText(c.body, 30, 90) || c.body.split(' ').length < 6 || !answerTitleOk(c.title)) continue;
        const m = search.match(`"${c.body}"`, { prefix: 'none' });
        if (!m || cnt.get(m).n !== 1) continue;
        yield { slots: { phrase: c.body }, login_user: L.loginFor(r),
          eval: answer(titleRef(c.title), `SELECT s.title FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.id = ${c.id}`),
          changes: [`reference: comment ${c.id} on submission ${c.submission_id}`] };
      }
    },
  },
  {
    name: 'search-top-in-forum', kind: 'read', skills: ['search', 'filter-sort'], difficulty: 2,
    phrasings: [
      'Search /f/{{forum}} for posts about "{{word}}". Which matching post has the highest score? Give its title.',
      'Among the {{forum}} forum\'s search results for "{{word}}", what is the title of the top-scoring post?',
      'Look up "{{word}}" in the {{forum}} forum and tell me the title of the best-scoring result.',
    ],
    *generate(r) {
      const fts = L.open().prepare(`SELECT s.id, s.title, s.net_score, s.forum_id FROM submissions_fts JOIN submissions s ON s.id = submissions_fts.rowid
        WHERE submissions_fts MATCH ? AND s.visibility = 'visible'`);
      const seen = new Set();
      for (const f of r.shuffle(L.forums()).filter((x) => x.n >= 50)) {
        const titles = L.all(`SELECT title FROM submissions WHERE forum_id = ? AND visibility = 'visible'`, f.id).map((x) => x.title);
        let made = 0;
        for (const t of r.sample(titles, 60)) {
          if (made >= 2) break;
          const words = (t.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length >= 5 && w.length <= 10 && !STOP.has(w));
          if (!words.length) continue;
          const w = r.pick(words);
          if (seen.has(f.name + w)) continue;
          seen.add(f.name + w);
          const m = search.match(w, { prefix: 'last' });
          const hits = fts.all(m);
          if (hits.length > 2500) continue;
          const inF = hits.filter((h) => h.forum_id === f.id).sort((a, b) => b.net_score - a.net_score || b.id - a.id);
          if (inF.length < 3 || inF.length > 40 || inF[0].net_score === inF[1].net_score || !answerTitleOk(inF[0].title)) continue;
          made++;
          yield { slots: { forum: f.name, word: w }, login_user: L.loginFor(r),
            eval: answer(titleRef(inF[0].title), `SELECT s.title FROM submissions_fts JOIN submissions s ON s.id = submissions_fts.rowid WHERE submissions_fts MATCH ${lit(m)} AND s.forum_id = ${fid(f.name)} AND s.visibility = 'visible' AND s.created_at < '${AFTER}' ORDER BY s.net_score DESC, s.id DESC LIMIT 1`),
            changes: [`search semantics: FTS ${m} (the site prefix-matches a last word of 4+ letters); ${inF.length} matches in the forum`] };
        }
      }
    },
  },
];
