'use strict';
// Comment threads on a submission page: read scores, structure (top-level vs replies), authors.
const L = require('./lib');
const { answer, AFTER } = require('./evals');

const threadPosts = (r, lo = 5, hi = 60) => r.shuffle(L.posts().filter((p) => p.comment_count >= lo && p.comment_count <= hi));
const live = (sid) => `FROM comments c JOIN users u ON u.id = c.user_id WHERE c.submission_id = ${sid} AND c.visibility = 'visible' AND c.created_at < '${AFTER}'`;
const real = (c) => c.user_id !== L.DELETED_USER && L.cleanName(c.username);

module.exports = [
  {
    name: 'top-comment-author', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2,
    phrasings: [
      'On the post "{{title}}" in /f/{{forum}}, who wrote the highest-scoring comment?',
      'Open "{{title}}" in the {{forum}} forum. Which user wrote the comment with the most points?',
      'Who is the author of the best-scoring comment on the submission "{{title}}" (/f/{{forum}})?',
    ],
    *generate(r) {
      for (const p of threadPosts(r)) {
        const cs = L.commentsOf(p.id).sort((a, b) => b.net_score - a.net_score);
        if (cs.length < 3 || cs[0].net_score === cs[1].net_score || !real(cs[0])) continue;
        yield { slots: { title: p.title, forum: p.forum }, login_user: L.loginFor(r), start_url: '__REDDIT__/f/' + p.forum,
          eval: answer(cs[0].username, `SELECT u.username ${live(p.id)} ORDER BY c.net_score DESC LIMIT 1`), changes: [`reference: comment ${cs[0].id}`] };
      }
    },
  },
  {
    name: 'top-level-count', kind: 'read', skills: ['aggregate', 'read-detail'], difficulty: 2,
    phrasings: [
      'How many top-level comments (direct replies to the post, not replies to other comments) does "{{title}}" in /f/{{forum}} have?',
      'Count the comments posted directly on the submission "{{title}}" in the {{forum}} forum, leaving out replies to comments. How many are there?',
      'On "{{title}}" (/f/{{forum}}), how many comments are replies to the post itself rather than to another comment?',
    ],
    *generate(r) {
      for (const p of threadPosts(r, 4, 40)) {
        const cs = L.all(`SELECT id, parent_id, visibility FROM comments WHERE submission_id = ?`, p.id);
        if (cs.some((c) => c.visibility !== 'visible')) continue;
        const top = cs.filter((c) => c.parent_id == null).length;
        if (top < 2 || top > 15 || top === cs.length) continue;
        yield { slots: { title: p.title, forum: p.forum }, login_user: L.loginFor(r), start_url: '__REDDIT__/f/' + p.forum,
          eval: answer(String(top), `SELECT count(*) ${live(p.id)} AND c.parent_id IS NULL`), changes: [`submission ${p.id}: ${cs.length} comments, ${top} top-level`] };
      }
    },
  },
  {
    name: 'parent-comment-author', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 2,
    phrasings: [
      'On the post "{{title}}" in /f/{{forum}}, {{user}} replied to someone else\'s comment. Whose comment was it?',
      '{{user}} left a reply in the thread "{{title}}" ({{forum}} forum). Which user wrote the comment they were replying to?',
      'In "{{title}}" on /f/{{forum}}, who wrote the comment that {{user}} answered?',
    ],
    *generate(r) {
      for (const p of threadPosts(r, 5, 60)) {
        const cs = L.commentsOf(p.id);
        const by = new Map(cs.map((c) => [c.id, c]));
        const counts = new Map();
        for (const c of cs) counts.set(c.user_id, (counts.get(c.user_id) || 0) + 1);
        const cand = r.shuffle(cs.filter((c) => c.parent_id && counts.get(c.user_id) === 1 && real(c) && c.user_id !== p.user_id));
        for (const c of cand) {
          const par = by.get(c.parent_id);
          if (!par || !real(par) || par.user_id === c.user_id) continue;
          yield { slots: { title: p.title, forum: p.forum, user: c.username }, login_user: L.loginFor(r, [c.username, par.username]), start_url: '__REDDIT__/f/' + p.forum,
            eval: answer(par.username, `SELECT u.username FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = (SELECT parent_id FROM comments WHERE id = ${c.id})`),
            changes: [`reference: comment ${c.id} replies to ${par.id}`] };
          break;
        }
      }
    },
  },
  {
    name: 'thread-user-comment-count', kind: 'read', skills: ['aggregate', 'navigate'], difficulty: 2,
    phrasings: [
      'How many comments did {{user}} write on the post "{{title}}" in /f/{{forum}}?',
      'In the thread "{{title}}" ({{forum}} forum), count the comments by {{user}}.',
      'Open "{{title}}" on /f/{{forum}}. How many times did {{user}} comment there?',
    ],
    *generate(r) {
      for (const p of threadPosts(r, 8, 80)) {
        const cs = L.commentsOf(p.id);
        const counts = new Map();
        for (const c of cs) if (real(c)) counts.set(c.username, (counts.get(c.username) || 0) + 1);
        const cand = [...counts.entries()].filter(([, n]) => n >= 2 && n <= 7);
        if (!cand.length) continue;
        const [user, n] = r.pick(cand);
        yield { slots: { title: p.title, forum: p.forum, user }, login_user: L.loginFor(r, [user]), start_url: '__REDDIT__/f/' + p.forum,
          eval: answer(String(n), `SELECT count(*) ${live(p.id)} AND c.user_id = ${L.uid(user)}`) };
      }
    },
  },
];
