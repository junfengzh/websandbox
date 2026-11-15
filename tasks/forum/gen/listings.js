'use strict';
// Forum listings and sorts: read the right post off /f/<forum>/<sort> (or page through /new).
const L = require('./lib');
const { answer, answerTitleOk, titleRef, lit, fid, AFTER } = require('./evals');

const base = (forum) => `FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.forum_id = ${fid(forum)} AND s.visibility = 'visible' AND s.created_at < '${AFTER}'`;
const postsIn = (forumId) => L.all(`SELECT s.id, s.title, s.url, s.media_type, s.net_score, s.comment_count, s.last_active_at, s.created_at, s.user_id, u.username
  FROM submissions s JOIN users u ON u.id = s.user_id WHERE s.forum_id = ? AND s.visibility = 'visible' ORDER BY s.id DESC`, forumId);
// top-1 by key, rejecting ties on the key
const uniqueTop = (rows, key, dir = -1) => {
  const xs = [...rows].sort((a, b) => dir * (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
  if (!xs.length || (xs.length > 1 && xs[0][key] === xs[1][key])) return null;
  return xs[0];
};
const realUser = (p) => p.user_id !== L.DELETED_USER && L.cleanName(p.username);

function* eachForum(r, min = 5) {
  for (const f of r.shuffle(L.forums())) if (f.n >= min) yield f;
}

module.exports = [
  {
    name: 'top-post-author', kind: 'read', skills: ['filter-sort', 'read-detail'], difficulty: 1,
    phrasings: [
      'Who submitted the highest-scoring post of all time in /f/{{forum}}? Give the username.',
      'In the {{forum}} forum, which user posted the submission with the most points ever?',
      'Find the top post of all time on /f/{{forum}} and tell me who submitted it.',
    ],
    *generate(r) {
      for (const f of eachForum(r)) {
        const top = uniqueTop(postsIn(f.id), 'net_score');
        if (!top || !realUser(top)) continue;
        yield { slots: { forum: f.name }, login_user: L.loginFor(r),
          eval: answer(top.username, `SELECT u.username ${base(f.name)} ORDER BY s.net_score DESC, s.id DESC LIMIT 1`) };
      }
    },
  },
  {
    name: 'most-commented-title', kind: 'read', skills: ['filter-sort'], difficulty: 1,
    phrasings: [
      'What is the title of the most commented post in /f/{{forum}}?',
      'Which submission in the {{forum}} forum has the most comments? Tell me its title.',
      'Look at /f/{{forum}} and find the post that drew the most comments. What is it called?',
    ],
    *generate(r) {
      for (const f of eachForum(r)) {
        const top = uniqueTop(postsIn(f.id), 'comment_count');
        if (!top || !answerTitleOk(top.title)) continue;
        yield { slots: { forum: f.name }, login_user: L.loginFor(r),
          eval: answer(titleRef(top.title), `SELECT s.title ${base(f.name)} ORDER BY s.comment_count DESC, s.id DESC LIMIT 1`) };
      }
    },
  },
  {
    name: 'nth-top-score', kind: 'read', skills: ['filter-sort', 'read-detail'], difficulty: 2,
    phrasings: [
      'Sort /f/{{forum}} by top (all time). What score does the {{nth}} post have?',
      'How many points does the {{nth}} highest-scoring submission in the {{forum}} forum have?',
      'In /f/{{forum}}, what is the score of the post ranked {{nth}} by points?',
    ],
    *generate(r) {
      for (const f of [...eachForum(r, 20), ...eachForum(r, 20)]) {
        const n = 2 + r.int(14);
        const xs = postsIn(f.id).map((p) => p.net_score).sort((a, b) => b - a);
        // neighbours must differ so an off-by-one answer fails
        if (xs.length < n + 1 || xs[n - 1] === xs[n - 2] || xs[n - 1] === xs[n]) continue;
        yield { slots: { forum: f.name, nth: L.ordinal(n), n }, login_user: L.loginFor(r),
          eval: answer(String(xs[n - 1]), `SELECT s.net_score ${base(f.name)} ORDER BY s.net_score DESC, s.id DESC LIMIT 1 OFFSET ${n - 1}`) };
      }
    },
  },
  {
    name: 'newest-post-comments', kind: 'read', skills: ['filter-sort', 'read-detail'], difficulty: 1,
    phrasings: [
      'How many comments does the newest post in /f/{{forum}} have?',
      'Open the most recently submitted post in the {{forum}} forum. How many comments are on it?',
      'Tell me the comment count of the latest submission on /f/{{forum}}.',
    ],
    *generate(r) {
      for (const f of eachForum(r)) {
        const p = postsIn(f.id)[0];
        if (!p || p.comment_count < 1) continue;
        yield { slots: { forum: f.name }, login_user: L.loginFor(r),
          eval: answer(String(p.comment_count), `SELECT count(*) FROM comments c WHERE c.submission_id = (SELECT s.id ${base(f.name)} ORDER BY s.id DESC LIMIT 1) AND c.created_at < '${AFTER}'`) };
      }
    },
  },
  {
    name: 'most-active-title', kind: 'read', skills: ['filter-sort'], difficulty: 2,
    phrasings: [
      'Which post in /f/{{forum}} had the most recent activity (newest comment)? Give its title.',
      'Sort the {{forum}} forum by activity. What is the title of the most active post?',
      'In /f/{{forum}}, find the thread that was active most recently and tell me its title.',
    ],
    *generate(r) {
      for (const f of eachForum(r)) {
        const top = uniqueTop(postsIn(f.id), 'last_active_at');
        if (!top || !answerTitleOk(top.title)) continue;
        yield { slots: { forum: f.name }, login_user: L.loginFor(r),
          eval: answer(titleRef(top.title), `SELECT s.title ${base(f.name)} ORDER BY s.last_active_at DESC, s.id DESC LIMIT 1`) };
      }
    },
  },
  {
    name: 'top-link-domain', kind: 'read', skills: ['filter-sort', 'read-detail'], difficulty: 2,
    phrasings: [
      'The highest-scoring link post in /f/{{forum}} points to which website? Give the domain name.',
      'Among the posts in the {{forum}} forum that link to an external site, which domain does the top-scoring one link to?',
      'Find the best-scoring submission in /f/{{forum}} that is a link (not a text or image post). What website is it from?',
    ],
    *generate(r) {
      for (const f of eachForum(r, 10)) {
        const links = postsIn(f.id).filter((p) => p.media_type === 'url' && p.url && /^https?:\/\//.test(p.url));
        const top = uniqueTop(links, 'net_score');
        if (!top) continue;
        // findable: within the first two pages of /f/<forum>/top
        if (postsIn(f.id).filter((p) => p.net_score > top.net_score || (p.net_score === top.net_score && p.id > top.id)).length >= 50) continue;
        const d = L.domainOf(top.url);
        if (!d || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) continue;
        yield { slots: { forum: f.name }, login_user: L.loginFor(r),
          eval: answer(d, `SELECT s.url ${base(f.name)} AND s.media_type = 'url' AND s.url LIKE 'http%' ORDER BY s.net_score DESC, s.id DESC LIMIT 1`) };
      }
    },
  },
  {
    name: 'nth-newest-title', kind: 'read', skills: ['filter-sort', 'navigate'], difficulty: 2,
    phrasings: [
      'Sorting /f/{{forum}} by new, what is the title of the {{nth}} post?',
      'What is the {{nth}} newest submission in the {{forum}} forum? Give its title.',
      'Go through the newest posts of /f/{{forum}} and tell me the title of the {{nth}} one.',
    ],
    *generate(r) {
      for (const f of [...eachForum(r, 80), ...eachForum(r, 80)]) {
        const n = 26 + r.int(45);
        const p = postsIn(f.id)[n - 1];
        if (!p || !answerTitleOk(p.title)) continue;
        yield { slots: { forum: f.name, nth: L.ordinal(n), n }, login_user: L.loginFor(r),
          eval: answer(titleRef(p.title), `SELECT s.title ${base(f.name)} ORDER BY s.id DESC LIMIT 1 OFFSET ${n - 1}`) };
      }
    },
  },
];
