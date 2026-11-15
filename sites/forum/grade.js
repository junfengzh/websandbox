'use strict';
// Forum grader: the kit grader with forum URL canonicalisation, plus SQL helpers for task
// converters / state checks (ROUTES.md has the URL scheme, SCHEMA.md the tables).
//   grade(task, {answer, url, query, fuzzy}) -> {pass, score, checks}
//   grade.canonicalUrl(u)            '/f/DIY/118903/anything' -> '/f/diy/118903', '/f/books/hot' -> '/f/books', ...
//   grade.sql.*(...)                 SQL strings for answer_sql / state_sql
//   grade.latestSubmission(query, user, {forum}) / latestComment(query, user, {submissionId}) / vote(...)
const kit = require('../../kit');

const SORTS = ['hot', 'new', 'active', 'top', 'controversial', 'most_commented'];

// Canonical form of a forum URL, so equivalent pages compare equal:
// - host dropped, forum name and username lower-cased (Postmill lookups are case-insensitive);
// - submission/comment URLs lose the slug (/f/x/<id>/<slug>[/comment/<cid>] -> /f/x/<id>[/comment/<cid>]);
// - the default sort is dropped (/hot, /f/x/hot -> /, /f/x) and ?t=all, ?page=1 are dropped;
// - /u/<name> -> /user/<name>; /inbox -> /notifications; /wiki -> /wiki/index.
function canonicalUrl(u) {
  const s = String(u || '').trim().replace(/^__[A-Z_]+__/, 'http://x');
  let url;
  try { url = new URL(s, 'http://x'); } catch { return s; }
  let p = decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  let m;
  if ((m = /^\/f\/([^/]+)(\/.*)?$/.exec(p))) {
    const rest = m[2] || '';
    let mm;
    if ((mm = /^\/(\d+)(?:\/[^/]*)?(\/comment\/\d+)?(\/.*)?$/.exec(rest))) p = `/f/${m[1].toLowerCase()}/${mm[1]}${mm[2] || ''}${mm[3] || ''}`;
    else p = `/f/${m[1].toLowerCase()}${rest === '/hot' ? '' : rest}`;
  } else if ((m = /^\/(?:u|user)\/([^/]+)(\/.*)?$/.exec(p))) p = `/user/${m[1].toLowerCase()}${m[2] || ''}`;
  else if (p === '/hot') p = '/';
  else if (p === '/inbox') p = '/notifications';
  else if (p === '/wiki') p = '/wiki/index';
  const sp = new URLSearchParams(url.search);
  if (sp.get('t') === 'all') sp.delete('t');
  if (sp.get('page') === '1') sp.delete('page');
  const qs = sp.toString();
  return `http://x${p}${qs ? '?' + qs : ''}`;
}

const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const userId = (name) => `(SELECT id FROM users WHERE normalized_username = lower(${lit(name)}))`;
const forumId = (name) => `(SELECT id FROM forums WHERE normalized_name = lower(${lit(name)}))`;

const sql = {
  userId, forumId, lit,
  // newest submission (by id, like Postmill's "new") of a user, optionally in a forum
  latestSubmission: (user, { forum } = {}) => `SELECT s.id, f.name AS forum, s.title, s.url, s.body, s.media_type, s.image_id, s.visibility, s.created_at
    FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.user_id = ${userId(user)}${forum ? ` AND s.forum_id = ${forumId(forum)}` : ''} ORDER BY s.id DESC LIMIT 1`,
  // newest comment of a user, optionally on one submission / replying to one comment
  latestComment: (user, { submissionId, parentId } = {}) => `SELECT c.id, c.submission_id, c.parent_id, c.body, c.visibility, c.created_at
    FROM comments c WHERE c.user_id = ${userId(user)}${submissionId != null ? ` AND c.submission_id = ${+submissionId}` : ''}${parentId !== undefined ? (parentId === null ? ' AND c.parent_id IS NULL' : ` AND c.parent_id = ${+parentId}`) : ''} ORDER BY c.id DESC LIMIT 1`,
  // the user's vote: 1 up, -1 down, no row = none
  submissionVote: (user, id) => `SELECT CASE upvote WHEN 1 THEN 1 ELSE -1 END AS vote FROM submission_votes WHERE user_id = ${userId(user)} AND submission_id = ${+id}`,
  commentVote: (user, id) => `SELECT CASE upvote WHEN 1 THEN 1 ELSE -1 END AS vote FROM comment_votes WHERE user_id = ${userId(user)} AND comment_id = ${+id}`,
  subscribed: (user) => `SELECT f.name FROM forum_subscriptions fs JOIN forums f ON f.id = fs.forum_id WHERE fs.user_id = ${userId(user)} ORDER BY f.normalized_name`,
  forum: (name) => `SELECT f.*, (SELECT group_concat(t.name, ', ') FROM forums_tags ft JOIN forum_tags t ON t.id = ft.tag_id WHERE ft.forum_id = f.id) AS tags,
    (SELECT group_concat(u.username, ', ') FROM moderators m JOIN users u ON u.id = m.user_id WHERE m.forum_id = f.id) AS moderators FROM forums f WHERE f.normalized_name = lower(${lit(name)})`,
  bio: (user) => `SELECT biography FROM users WHERE normalized_username = lower(${lit(user)})`,
  // current forum ban (latest event wins)
  banned: (user, forum) => `SELECT banned FROM forum_bans WHERE forum_id = ${forumId(forum)} AND user_id = ${userId(user)} ORDER BY created_at DESC, id DESC LIMIT 1`,
  messagesBetween: (from, to) => `SELECT t.subject, m.body, m.created_at FROM messages m JOIN message_threads t ON t.id = m.thread_id
    WHERE m.sender_id = ${userId(from)} AND EXISTS (SELECT 1 FROM message_thread_participants p WHERE p.thread_id = m.thread_id AND p.user_id = ${userId(to)}) ORDER BY m.id`,
};

const first = async (query, q) => { const rows = await query(q); return rows.length ? rows[0] : null; };

// url_match 'prefix' (forum addition): the final URL's canonical path equals a reference path
// or lies below it (/f/space/134164/slug matches /f/space), query params as in 'subset'.
// This is WebArena's url_match for the reddit tasks: it tests `ref_base_path in pred_base_path`
// (substring), so ending on the new post / thread page under the forum passes.
const splitPath = (u) => { const i = u.indexOf('?'); return i < 0 ? [u, ''] : [u.slice(0, i), u.slice(i)]; };
async function grade(task, input = {}) {
  const ev = task.eval || task;
  if (!ev.url) return kit.grader.grade(task, input);
  const refs = [].concat(ev.url).map(canonicalUrl);
  const canon = { ...ev, url: refs };
  let url = input.url ? canonicalUrl(input.url) : input.url;
  if (ev.url_match === 'prefix') {
    canon.url_match = 'subset';
    if (url) {
      const [up, uq] = splitPath(url);
      const hit = refs.map((r) => splitPath(r)[0]).find((rp) => up.toLowerCase() === rp.toLowerCase() || up.toLowerCase().startsWith(rp.toLowerCase() + '/'));
      if (hit) url = hit + uq;
    }
  }
  const t = task.eval ? { ...task, eval: canon } : canon;
  const r = await kit.grader.grade(t, { ...input, url });
  for (const c of r.checks) if (c.type === 'url') c.got = input.url;
  return r;
}

module.exports = grade;
module.exports.grade = grade;
module.exports.canonicalUrl = canonicalUrl;
module.exports.sql = sql;
module.exports.SORTS = SORTS;
module.exports.latestSubmission = (query, user, o) => first(query, sql.latestSubmission(user, o));
module.exports.latestComment = (query, user, o) => first(query, sql.latestComment(user, o));
module.exports.vote = async (query, user, { submission, comment }) => {
  const r = await first(query, submission != null ? sql.submissionVote(user, submission) : sql.commentVote(user, comment));
  return r ? (Array.isArray(r) ? r[0] : r.vote) : 0;
};
