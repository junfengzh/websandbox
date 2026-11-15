'use strict';
// Moderation. Nobody moderates a forum in the source data; the site admin (KrokmaniakPL) is a
// moderator of every forum (ROUTES.md), so these tasks log in as the admin.
const L = require('./lib');
const { state, uid, fid, lit, AFTER } = require('./evals');

const ORDER = { 'highest-scoring': 'net_score DESC, id DESC', 'lowest-scoring': 'net_score ASC, id ASC', 'most commented': 'comment_count DESC, id DESC', newest: 'id DESC' };
const KEY = { 'highest-scoring': 'net_score', 'lowest-scoring': 'net_score', 'most commented': 'comment_count', newest: 'id' };
const pickPost = (f, which) => {
  const [a, b] = L.all(`SELECT s.id, s.title, s.net_score, s.comment_count, s.user_id, u.username FROM submissions s JOIN users u ON u.id = s.user_id
    WHERE s.forum_id = ? AND s.visibility = 'visible' ORDER BY ${ORDER[which].replace(/(\w+) (ASC|DESC)/g, 's.$1 $2')} LIMIT 2`, f.id);
  if (!a || (b && a[KEY[which]] === b[KEY[which]])) return null;
  return a;
};
const realAuthor = (p) => p.user_id !== L.DELETED_USER && L.cleanName(p.username) && p.username !== L.ADMIN;

const flagTemplate = (name, col, verb, choices, phrasings) => ({
  name, kind: 'write', skills: ['moderation', 'filter-sort'], difficulty: 2, phrasings,
  *generate(r) {
    for (const f of r.shuffle(L.forums()).filter((x) => x.n >= 10)) {
      for (const which of r.sample(choices, 2)) {
        const p = pickPost(f, which);
        if (!p) continue;
        yield { slots: { which, forum: f.name }, login_user: L.ADMIN,
          eval: state(`SELECT (SELECT ${col} FROM submissions WHERE id = ${p.id}) AS target, (SELECT count(*) FROM submissions WHERE forum_id = ${fid(f.name)} AND ${col} = 1) AS total`, [{ target: 1, total: 1 }]),
          changes: [`target: submission ${p.id}; no other post in the forum may be ${verb}`] };
      }
    }
  },
});

module.exports = [
  flagTemplate('mod-lock-post', 'locked', 'locked', ['most commented', 'highest-scoring', 'lowest-scoring'], [
    'As a moderator, lock the {{which}} post in /f/{{forum}} so nobody can comment on it any more.',
    'Lock the {{which}} submission in the {{forum}} forum.',
    'The {{which}} thread in /f/{{forum}} needs to be closed to new comments. Lock it.',
  ]),
  flagTemplate('mod-pin-post', 'sticky', 'pinned', ['newest', 'highest-scoring', 'most commented'], [
    'Pin the {{which}} post in /f/{{forum}} to the top of the forum.',
    'As a moderator of the {{forum}} forum, make its {{which}} submission sticky.',
    'Find the {{which}} post on /f/{{forum}} and pin it.',
  ]),
  {
    name: 'mod-remove-lowest-comment', kind: 'write', skills: ['moderation', 'read-detail'], difficulty: 2,
    phrasings: [
      'As a moderator, remove the lowest-scoring comment on the post "{{title}}" in /f/{{forum}}.',
      'On "{{title}}" in the {{forum}} forum, take down the comment with the fewest points (moderator removal).',
      'Moderate the thread "{{title}}" (/f/{{forum}}): remove its most downvoted comment.',
    ],
    *generate(r) {
      for (const p of r.shuffle(L.posts().filter((x) => x.comment_count >= 4 && x.comment_count <= 50))) {
        const cs = L.commentsOf(p.id).sort((a, b) => a.net_score - b.net_score);
        if (cs.length < 3 || cs[0].net_score === cs[1].net_score) continue;
        yield { slots: { title: p.title, forum: p.forum }, login_user: L.ADMIN, start_url: '__REDDIT__/f/' + p.forum,
          eval: state(`SELECT (SELECT visibility FROM comments WHERE id = ${cs[0].id}) AS target, (SELECT count(*) FROM comments WHERE submission_id = ${p.id} AND visibility <> 'visible') AS removed`, [{ target: 'trashed', removed: 1 }]),
          changes: [`target: comment ${cs[0].id} (score ${cs[0].net_score}); moderator removal = visibility trashed`] };
      }
    },
  },
  {
    name: 'mod-ban-author', kind: 'write', skills: ['moderation', 'filter-sort', 'multi-step'], difficulty: 3,
    phrasings: [
      'Ban the author of the {{which}} post in /f/{{forum}} from that forum, with the reason "{{reason}}".',
      'Whoever submitted the {{which}} post in the {{forum}} forum should be banned from it. Use "{{reason}}" as the reason.',
      'As a moderator of /f/{{forum}}, find who posted its {{which}} submission and ban them there (reason: "{{reason}}").',
    ],
    *generate(r) {
      for (const f of r.shuffle(L.forums()).filter((x) => x.n >= 10)) {
        for (const which of r.sample(['lowest-scoring', 'newest', 'most commented'], 2)) {
          const p = pickPost(f, which);
          if (!p || !realAuthor(p)) continue;
          const reason = r.pick(L.PHRASES.reasons);
          yield { slots: { which, forum: f.name, reason }, login_user: L.ADMIN,
            eval: state(`SELECT (SELECT banned FROM forum_bans WHERE forum_id = ${fid(f.name)} AND user_id = ${uid(p.username)} ORDER BY created_at DESC, id DESC LIMIT 1) AS banned,
              (SELECT count(*) FROM forum_bans WHERE forum_id = ${fid(f.name)} AND user_id = ${uid(p.username)} AND banned = 1 AND ${L.ci('reason', reason)}) >= 1 AS reason_ok,
              (SELECT count(DISTINCT user_id) FROM forum_bans WHERE banned = 1) AS banned_users`, [{ banned: 1, reason_ok: 1, banned_users: 1 }]),
            changes: [`target: ${p.username} (submission ${p.id}); nobody else may be banned`] };
        }
      }
    },
  },
  {
    name: 'mod-add-moderator', kind: 'write', skills: ['moderation', 'filter-sort', 'multi-step'], difficulty: 2,
    phrasings: [
      'Make the user who submitted the {{which}} post in /f/{{forum}} a moderator of /f/{{forum}}.',
      'Add the author of the {{which}} submission in the {{forum}} forum as one of its moderators.',
      'Find who posted the {{which}} post on /f/{{forum}} and give them moderator rights in that forum.',
    ],
    *generate(r) {
      for (const f of r.shuffle(L.forums()).filter((x) => x.n >= 10)) {
        for (const which of r.sample(['highest-scoring', 'most commented', 'newest'], 2)) {
          const p = pickPost(f, which);
          if (!p || !realAuthor(p)) continue;
          yield { slots: { which, forum: f.name }, login_user: L.ADMIN,
            eval: state(`SELECT u.normalized_username FROM moderators m JOIN users u ON u.id = m.user_id WHERE m.forum_id = ${fid(f.name)}`, [[p.username.toLowerCase()]]),
            changes: [`target: ${p.username} (submission ${p.id}); the forum's moderator list must be exactly that user`] };
        }
      }
    },
  },
  {
    name: 'mod-forum-category', kind: 'write', skills: ['moderation', 'form-edit'], difficulty: 2,
    phrasings: [
      'Add /f/{{forum}} to the "{{category}}" category as well, keeping the category it already has.',
      'Edit the {{forum}} forum so it is listed under "{{category}}" in addition to its current category.',
      'As a moderator, give /f/{{forum}} the extra category "{{category}}" (do not remove the existing one).',
    ],
    *generate(r) {
      const cats = L.tags().map((t) => t.name);
      for (const f of r.shuffle(L.forums())) {
        const cat = r.pick(cats.filter((c) => c !== f.tag));
        yield { slots: { forum: f.name, category: cat }, login_user: L.ADMIN,
          eval: state(`SELECT t.normalized_name FROM forums_tags ft JOIN forum_tags t ON t.id = ft.tag_id WHERE ft.forum_id = ${fid(f.name)}`, [[f.tag.toLowerCase()], [cat.toLowerCase()]]),
          changes: [`current category ${f.tag}; state: exactly {${f.tag}, ${cat}}`] };
      }
    },
  },
];
