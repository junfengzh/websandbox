'use strict';
// Comment votes (WebArena only votes on submissions). Graders check comment_votes rows, never
// net_score, and fail extra votes on other comments of the same thread.
const L = require('./lib');
const { state, uid, AFTER } = require('./evals');

const otherVotes = (me, sid, ids) => `(SELECT count(*) FROM comment_votes v JOIN comments c ON c.id = v.comment_id WHERE v.user_id = ${uid(me)} AND c.submission_id = ${sid}
  AND c.created_at < '${AFTER}' AND c.id NOT IN (${ids.join(', ')}))`;
const real = (c) => c.user_id !== L.DELETED_USER && L.cleanName(c.username);

module.exports = [
  {
    name: 'upvote-top-comment', kind: 'write', skills: ['read-detail', 'vote'], difficulty: 2,
    phrasings: [
      'Upvote the highest-scoring comment on the post "{{title}}" in /f/{{forum}}.',
      'Go to "{{title}}" in the {{forum}} forum and give the top comment an upvote.',
      'In the thread "{{title}}" (/f/{{forum}}), upvote the comment with the most points.',
    ],
    *generate(r) {
      for (const p of r.shuffle(L.posts().filter((x) => x.comment_count >= 4 && x.comment_count <= 60))) {
        const cs = L.commentsOf(p.id).sort((a, b) => b.net_score - a.net_score);
        if (cs.length < 3 || cs[0].net_score === cs[1].net_score || cs[0].parent_id != null) continue; // top-level: the first comment shown
        const me = L.loginFor(r, [cs[0].username, p.username]);
        const t = cs[0].id;
        yield { slots: { title: p.title, forum: p.forum }, login_user: me, start_url: '__REDDIT__/f/' + p.forum,
          eval: state(`SELECT (SELECT count(*) FROM comment_votes WHERE user_id = ${uid(me)} AND comment_id = ${t} AND upvote = 1) AS target, ${otherVotes(me, p.id, [t])} AS others`, [{ target: 1, others: 0 }]),
          changes: [`target comment ${t} (score ${cs[0].net_score}); no other votes in the thread`] };
      }
    },
  },
  {
    name: 'downvote-user-comments', kind: 'write', skills: ['multi-step', 'vote'], difficulty: 2,
    phrasings: [
      'Downvote every comment {{user}} wrote on the post "{{title}}" in /f/{{forum}}.',
      'On "{{title}}" in the {{forum}} forum, give a downvote to each of {{user}}\'s comments.',
      'I disagree with {{user}} in the thread "{{title}}" (/f/{{forum}}). Downvote all of their comments there.',
    ],
    *generate(r) {
      for (const p of r.shuffle(L.posts().filter((x) => x.comment_count >= 6 && x.comment_count <= 80))) {
        const cs = L.commentsOf(p.id);
        const by = new Map();
        for (const c of cs) if (real(c)) { if (!by.has(c.username)) by.set(c.username, []); by.get(c.username).push(c.id); }
        const cand = [...by.entries()].filter(([, ids]) => ids.length >= 2 && ids.length <= 4);
        if (!cand.length) continue;
        const [user, ids] = r.pick(cand);
        const me = L.loginFor(r, [user, p.username]);
        yield { slots: { title: p.title, forum: p.forum, user }, login_user: me, start_url: '__REDDIT__/f/' + p.forum,
          eval: state(`SELECT (SELECT count(*) FROM comment_votes WHERE user_id = ${uid(me)} AND comment_id IN (${ids.join(', ')}) AND upvote = 0) AS target, ${otherVotes(me, p.id, ids)} AS others`, [{ target: ids.length, others: 0 }]),
          changes: [`target comments ${ids.join(', ')}`] };
      }
    },
  },
];
