'use strict';
// Writing comments: replies to a specific comment, comments that quote a post, editing and
// deleting the login user's own comments.
const L = require('./lib');
const { state, uid, lit, AFTER, myNewComments } = require('./evals');

const postIds = () => { if (!postIds.s) postIds.s = new Map(L.posts().map((p) => [p.id, p])); return postIds.s; };
// a member's comments on posts with clean unique titles where they commented exactly once
function* ownComments(r, bodyOk = () => true) {
  for (const u of r.shuffle(L.members())) {
    const cs = L.all(`SELECT id, submission_id, body, parent_id FROM comments WHERE user_id = ? AND visibility = 'visible' ORDER BY id`, u.id);
    const per = new Map();
    for (const c of cs) per.set(c.submission_id, (per.get(c.submission_id) || 0) + 1);
    const ok = r.shuffle(cs.filter((c) => per.get(c.submission_id) === 1 && postIds().has(c.submission_id) && bodyOk(c.body)));
    if (ok.length) yield { u, c: ok[0], p: postIds().get(ok[0].submission_id), total: cs.length };
  }
}

module.exports = [
  {
    name: 'reply-user-latest-comment', kind: 'write', skills: ['navigate', 'create'], difficulty: 2,
    phrasings: [
      'Find the most recent comment by {{user}} and reply to it with "{{text}}".',
      'Reply "{{text}}" to {{user}}\'s latest comment.',
      'Go to {{user}}\'s profile, open their newest comment, and post the reply "{{text}}".',
    ],
    *generate(r) {
      for (const u of r.shuffle(L.members())) {
        const c = L.get(`SELECT c.id, c.submission_id, s.visibility sv, s.locked FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.user_id = ? AND c.visibility = 'visible' ORDER BY c.id DESC LIMIT 1`, u.id);
        if (!c || c.sv !== 'visible' || c.locked) continue;
        const text = r.pick(L.PHRASES.comment);
        const me = L.loginFor(r, [u.username]);
        yield { slots: { user: u.username, text }, login_user: me,
          eval: state(`SELECT count(*) FROM (${myNewComments(me)}) WHERE parent_id = ${c.id} AND ${L.ci('body', text)}`, { min: 1 }),
          changes: [`target: comment ${c.id} on submission ${c.submission_id}`] };
      }
    },
  },
  {
    name: 'reply-quoting-title', kind: 'write', skills: ['filter-sort', 'multi-step', 'create'], difficulty: 2,
    phrasings: [
      'Find the {{which}} post in /f/{{forum}} and leave a comment on it that quotes its title.',
      'Comment on the {{which}} submission in the {{forum}} forum. The comment must contain the post\'s title word for word.',
      'Go to the {{which}} post of /f/{{forum}} and write a comment that repeats its exact title.',
    ],
    *generate(r) {
      const ORDER = { 'highest-scoring': 'net_score DESC, id DESC', 'most commented': 'comment_count DESC, id DESC', newest: 'id DESC' };
      for (const f of r.shuffle(L.forums()).filter((x) => x.n >= 10)) {
        for (const which of r.sample(Object.keys(ORDER), 2)) {
          const [a, b] = L.all(`SELECT id, title, net_score, comment_count, locked FROM submissions WHERE forum_id = ? AND visibility = 'visible' ORDER BY ${ORDER[which]} LIMIT 2`, f.id);
          if (!a || a.locked || !L.cleanText(a.title, 12, 90)) continue;
          const key = which === 'highest-scoring' ? 'net_score' : which === 'most commented' ? 'comment_count' : 'id';
          if (b && a[key] === b[key]) continue;
          const me = L.loginFor(r);
          yield { slots: { which, forum: f.name }, login_user: me,
            eval: state(`SELECT count(*) FROM (${myNewComments(me)}) WHERE submission_id = ${a.id} AND ${L.ci('body', a.title)}`, { min: 1 }),
            changes: [`target: submission ${a.id} "${a.title}"`] };
        }
      }
    },
  },
  {
    name: 'edit-own-comment', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 2,
    phrasings: [
      'Edit my comment on the post "{{title}}" and add "{{text}}" at the end, keeping the original text.',
      'Append the line "{{text}}" to the comment I left on "{{title}}" (keep what I wrote).',
      'Update my comment in the thread "{{title}}": keep it as is but add "{{text}}" after it.',
    ],
    *generate(r) {
      for (const { u, c, p } of ownComments(r, (b) => L.cleanText(b, 20, 300))) {
        const text = r.pick(L.PHRASES.edits);
        const head = c.body.slice(0, 40);
        yield { slots: { title: p.title, text }, login_user: u.username,
          eval: state(`SELECT (${L.ci('body', text)} AND ${L.ci('body', head)} AND visibility = 'visible') AS ok FROM comments WHERE id = ${c.id}`, 1),
          changes: [`target: own comment ${c.id} on submission ${p.id} (/f/${p.forum}); original text must stay`] };
      }
    },
  },
  {
    name: 'delete-own-comment', kind: 'write', skills: ['navigate'], difficulty: 2,
    phrasings: [
      'Delete the comment I wrote on the post "{{title}}".',
      'Remove my comment from the thread "{{title}}" in /f/{{forum}}.',
      'I regret my comment on "{{title}}". Please delete it.',
    ],
    *generate(r) {
      for (const { u, c, p, total } of ownComments(r)) {
        yield { slots: { title: p.title, forum: p.forum }, login_user: u.username,
          eval: state(`SELECT (SELECT visibility FROM comments WHERE id = ${c.id}) AS target,
            (SELECT count(*) FROM comments WHERE user_id = ${uid(u.username)} AND visibility <> 'visible' AND created_at < '${AFTER}') AS deleted`, [{ target: 'soft_deleted', deleted: 1 }]),
          changes: [`target: own comment ${c.id} on submission ${p.id}; none of the user's other ${total - 1} comments may be deleted`] };
      }
    },
  },
];
