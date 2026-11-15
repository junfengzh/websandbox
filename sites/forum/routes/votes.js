'use strict';
// Votes: POST /sv/<id> (submission) and /cv/<id> (comment) with choice=1|-1|0.
// Form posts redirect back (no-JS fallback); /sv/<id>.json and /cv/<id>.json answer JSON.
const F = require('../lib/forum');

module.exports = async function (app, kit) {
  function vote(kind) {
    const [table, col, items] = kind === 'comment' ? ['comment_votes', 'comment_id', 'comments'] : ['submission_votes', 'submission_id', 'submissions'];
    return async (req, reply) => {
      const raw = String(req.params.id);
      const json = raw.endsWith('.json') || /application\/json/.test(req.headers.accept || '');
      const id = parseInt(raw, 10);
      if (!req.user) {
        if (json) { reply.code(401); return { error: 'Please log in to vote.' }; }
        return reply.redirect(`/login?next=${encodeURIComponent(F.backTo(req, '/'))}`);
      }
      const item = kit.sql(kind === 'comment'
        ? 'SELECT c.id, c.visibility, s.forum_id FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.id = ?'
        : 'SELECT id, visibility, forum_id FROM submissions WHERE id = ?').get(id || 0);
      if (!item) throw kit.httpError(404, 'Nothing to vote on.');
      if (item.visibility !== 'visible') throw kit.httpError(403, 'You cannot vote on deleted content.');
      if (F.activeBan(item.forum_id, req.user.id)) throw kit.httpError(403, 'You are banned from this forum.');
      const choice = parseInt((req.body || {}).choice, 10);
      if (![1, 0, -1].includes(choice)) throw kit.httpError(400, 'choice must be 1, 0 or -1.');
      const cur = kit.sql(`SELECT id, upvote FROM ${table} WHERE user_id = ? AND ${col} = ?`).get(req.user.id, id);
      if (choice === 0) { if (cur) kit.sql(`DELETE FROM ${table} WHERE id = ?`).run(cur.id); }
      else if (!cur) kit.sql(`INSERT INTO ${table} (user_id, ${col}, upvote, created_at) VALUES (?, ?, ?, ?)`).run(req.user.id, id, choice === 1 ? 1 : 0, kit.nowSql());
      else if ((cur.upvote ? 1 : -1) !== choice) kit.sql(`UPDATE ${table} SET upvote = ?, created_at = ? WHERE id = ?`).run(choice === 1 ? 1 : 0, kit.nowSql(), cur.id);
      const netScore = kit.sql(`SELECT net_score FROM ${items} WHERE id = ?`).pluck().get(id);
      if (json) return { netScore, choice };
      return reply.redirect(F.backTo(req, '/'));
    };
  }
  app.post('/sv/:id', vote('submission'));
  app.post('/cv/:id', vote('comment'));
};
