'use strict';
// Search: submissions, comments, forums (FTS5 via kit.search), users by name.
// GET /search?q=&type=submissions|comments|forums|users&sort=relevance|new|top&f=<forum>&t=<window>&page=
const F = require('../lib/forum');

const PER_PAGE = 25;
// bm25 ranks every match: fine for a few thousand, too slow for common words over
// 2.5M comments. Above the cap, results are newest-first (FTS rowid order).
const RANK_CAP = { submissions: 3000, comments: 1500 };
const SCAN = 3000; // random row reads: keep the bounded scan small (cold-cache cost)

module.exports = async function (app, kit) {
  app.get('/search', async (req, reply) => {
    const db = kit.db();
    const q = String(req.query.q || '').trim().slice(0, 300);
    const type = ['submissions', 'comments', 'forums', 'users'].includes(req.query.type) ? req.query.type : 'submissions';
    const sort = ['relevance', 'new', 'top'].includes(req.query.sort) ? req.query.sort : 'relevance';
    const t = F.WINDOWS[req.query.t] ? req.query.t : 'all';
    const forum = req.query.f ? F.forumByName(req.query.f, { required: false }) : null;
    const pg = F.pageOf(req, PER_PAGE);
    const data = { title: q ? `Search: ${q}` : 'Search', q, type, sort, t, forum, rows: [], p: null, capped: false, suggestion: null, crumbs: [['Search']] };
    if (!q) return reply.render('search', data);
    const since = F.windowStart(t);

    if (type === 'forums') {
      const s = kit.search.prepare(db, 'forums_fts', q, { weights: { name: 10, title: 5, description: 2, sidebar: 1 }, prefix: 'all' });
      const rows = s.match ? kit.sql(`SELECT f.id, f.name, f.title, f.description, ${s.snippet('description', 20)} AS snip FROM forums_fts JOIN forums f ON f.id = forums_fts.rowid
        WHERE forums_fts MATCH ? ORDER BY ${s.rank}, f.id LIMIT ? OFFSET ?`).all(s.match, PER_PAGE + 1, pg.offset) : [];
      const get = F.forumCounts(null);
      for (const r of rows) Object.assign(r, get(r.id));
      data.rows = rows;
      data.p = F.pager(req, rows, PER_PAGE);
      if (!rows.length && pg.page === 1) data.suggestion = kit.search.didYouMean(db, 'forums_fts', q);
      return reply.render('search', data);
    }
    if (type === 'users') {
      const like = `%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
      const exact = kit.sql('SELECT id, username, created_at FROM users WHERE normalized_username = lower(?)').all(q);
      // prefix match uses the unique index; substring match is bounded
      const rows = kit.sql("SELECT id, username, created_at FROM users WHERE normalized_username >= ? AND normalized_username < ? ORDER BY normalized_username LIMIT ? OFFSET ?")
        .all(q.toLowerCase(), q.toLowerCase() + '￿', PER_PAGE + 1, pg.offset);
      const seen = new Set(exact.map((r) => r.id));
      data.rows = [...exact, ...rows.filter((r) => !seen.has(r.id))];
      if (data.rows.length < PER_PAGE && pg.page === 1) {
        for (const r of kit.sql("SELECT id, username, created_at FROM users WHERE normalized_username LIKE ? ESCAPE '\\' LIMIT 50").all(like)) if (!data.rows.some((x) => x.id === r.id)) data.rows.push(r);
      }
      data.p = F.pager(req, data.rows, PER_PAGE);
      return reply.render('search', data);
    }

    const table = type === 'comments' ? 'comments_fts' : 'submissions_fts';
    // Prefix matching ("word*") merges the doclists of every term with that prefix: seconds for
    // short prefixes over 2.5M comments. Comments match whole words (like Postmill's tsvector
    // search); post searches complete the last word when it has 4+ letters.
    const last = (q.match(/[\p{L}\p{N}]+/gu) || []).pop() || '';
    const prefix = type === 'comments' || last.length < 4 || /"\s*$/.test(q) ? 'none' : 'last';
    const s = kit.search.prepare(db, table, q, type === 'comments' ? { prefix } : { weights: { title: 10, body: 2, url: 1 }, prefix });
    if (!s.match) return reply.render('search', data);
    const cond = []; const params = [];
    if (type === 'comments') {
      cond.push("c.visibility = 'visible'");
      if (forum) { cond.push('s.forum_id = ?'); params.push(forum.id); }
      if (since) { cond.push('c.created_at >= ?'); params.push(since); }
    } else {
      cond.push("s.visibility = 'visible'");
      if (forum) { cond.push('s.forum_id = ?'); params.push(forum.id); }
      if (since) { cond.push('s.created_at >= ?'); params.push(since); }
    }
    const alias = type === 'comments' ? 'c' : 's';
    const join = type === 'comments'
      ? 'CROSS JOIN comments c ON c.id = m.rid CROSS JOIN submissions s ON s.id = c.submission_id'
      : 'CROSS JOIN submissions s ON s.id = m.rid';
    const cap = RANK_CAP[type];
    // Small match sets are filtered and ranked in full. Big ones (common words): only the
    // newest SCAN matches are filtered/sorted, newest first (or by score for sort=top).
    const big = kit.countCapped(db, `FROM ${table} WHERE ${table} MATCH ?`, [s.match], cap) > cap;
    const inner = big ? `SELECT rowid AS rid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid DESC LIMIT ${SCAN}`
      : `SELECT rowid AS rid, ${s.rank} AS score FROM ${table} WHERE ${table} MATCH ?`;
    const fromWhere = `FROM (${inner}) m ${join} WHERE ${cond.join(' AND ')}`;
    const n = kit.countCapped(db, fromWhere, [s.match, ...params], cap);
    data.total = Math.min(n, cap);
    data.countLabel = n > cap ? `More than ${cap.toLocaleString('en-US')} results` : `${n.toLocaleString('en-US')} result${n === 1 ? '' : 's'}`;
    data.big = big;
    const order = sort === 'top' ? `${alias}.net_score DESC, ${alias}.id DESC` : sort === 'new' || big ? 'm.rid DESC' : `m.score, ${alias}.id DESC`;
    const rows = kit.sql(`SELECT ${alias}.id ${fromWhere} ORDER BY ${order} LIMIT ? OFFSET ?`).pluck().all(s.match, ...params, PER_PAGE + 1, pg.offset);
    if (!rows.length) {
      data.rows = [];
    } else if (type === 'comments') {
      // ids inlined (integers from the DB): with bound IN params FTS5 scans every match
      const snips = new Map(db.prepare(`SELECT rowid, ${s.snippet('body', 30)} AS snip FROM comments_fts WHERE comments_fts MATCH ? AND rowid IN (${rows.map(Number).join(',')})`).all(s.match).map((r) => [r.rowid, r.snip]));
      data.rows = F.hydrateComments(rows).map((r) => ({ ...r, snip: snips.get(r.id) }));
    } else {
      const snips = new Map(db.prepare(`SELECT rowid, ${s.snippet('body', 30)} AS snip, ${s.highlight('title')} AS htitle FROM submissions_fts WHERE submissions_fts MATCH ? AND rowid IN (${rows.map(Number).join(',')})`).all(s.match).map((r) => [r.rowid, r]));
      data.rows = F.hydrate(rows).map((r) => ({ ...r, snip: snips.get(r.id) && snips.get(r.id).snip, htitle: snips.get(r.id) && snips.get(r.id).htitle }));
      data.votes = F.myVotes(req.user, 'submission', rows);
    }
    data.p = F.pager(req, data.rows, PER_PAGE);
    if (!data.rows.length && pg.page === 1) data.suggestion = kit.search.didYouMean(db, 'forums_fts', q);
    return reply.render('search', data);
  });
};
