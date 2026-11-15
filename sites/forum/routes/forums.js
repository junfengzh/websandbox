'use strict';
// Forum list / categories, create & edit forum, subscribe, moderators, bans, moderation log.
const F = require('../lib/forum');

module.exports = async function (app, kit) {
  const LIST_SORTS = { name: 'Name', title: 'Title', submissions: 'Submissions', subscribers: 'Subscribers', created: 'Newest' };
  function forumRows(req) {
    const get = F.forumCounts(null);
    const subs = new Set(F.subscribedIds(req.user));
    const tags = new Map();
    for (const r of kit.sql('SELECT ft.forum_id, t.name FROM forums_tags ft JOIN forum_tags t ON t.id = ft.tag_id ORDER BY t.name').all()) {
      if (!tags.has(r.forum_id)) tags.set(r.forum_id, []);
      tags.get(r.forum_id).push(r.name);
    }
    return kit.sql('SELECT id, name, title, description, created_at, featured FROM forums').all()
      .map((f) => ({ ...f, ...get(f.id), subscribed: subs.has(f.id), tags: tags.get(f.id) || [] }));
  }
  const sorters = {
    name: (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    title: (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.id - b.id,
    submissions: (a, b) => b.submissions - a.submissions || a.id - b.id,
    subscribers: (a, b) => b.subscribers - a.subscribers || b.submissions - a.submissions || a.id - b.id,
    created: (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id),
  };
  async function list(req, reply) {
    const sort = req.params.sortBy || req.query.sort || 'name';
    if (!LIST_SORTS[sort]) throw kit.httpError(404, `Unknown sort "${sort}".`);
    const rows = forumRows(req).sort(sorters[sort]);
    const pg = F.pageOf(req, 50);
    const page = rows.slice(pg.offset, pg.offset + 51);
    const p = F.pager(req, page, 50);
    return reply.render('forums', { title: 'Forums', rows: page, total: rows.length, p, sort, LIST_SORTS, crumbs: [['Forums']] });
  }
  app.get('/forums', list);
  app.get('/forums/:sortBy', list);
  app.get('/forums/all', async (req, reply) => {
    const rows = forumRows(req).sort(sorters.name);
    return reply.render('forums_all', { title: 'All forums', rows, crumbs: [['Forums', '/forums'], ['All forums']] });
  });
  app.get('/forums/by_category', async (req, reply) => {
    const rows = forumRows(req).sort(sorters.name);
    const cats = kit.sql('SELECT id, name, description FROM forum_tags ORDER BY normalized_name').all();
    const groups = cats.map((c) => ({ ...c, forums: rows.filter((f) => f.tags.includes(c.name)) }));
    const untagged = rows.filter((f) => !f.tags.length);
    return reply.render('forums_categories', { title: 'Forums by category', groups, untagged, crumbs: [['Forums', '/forums'], ['By category']] });
  });
  app.get('/tag/:name', async (req, reply) => {
    const tag = kit.sql('SELECT * FROM forum_tags WHERE normalized_name = lower(?)').get(String(req.params.name));
    if (!tag) throw kit.httpError(404, `No category named "${req.params.name}".`);
    const rows = forumRows(req).filter((f) => f.tags.includes(tag.name)).sort(sorters.name);
    return reply.render('forums_all', { title: `Category: ${tag.name}`, tag, rows, crumbs: [['Forums', '/forums'], ['By category', '/forums/by_category'], [tag.name]] });
  });

  // ---- subscribe
  for (const [path, on] of [['subscribe', true], ['unsubscribe', false]]) {
    app.post(`/f/:forum/${path}`, { config: { login: true } }, async (req, reply) => {
      const f = F.forumByName(req.params.forum);
      if (on) kit.sql('INSERT OR IGNORE INTO forum_subscriptions (user_id, forum_id, subscribed_at) VALUES (?, ?, ?)').run(req.user.id, f.id, kit.nowSql());
      else kit.sql('DELETE FROM forum_subscriptions WHERE user_id = ? AND forum_id = ?').run(req.user.id, f.id);
      const json = /application\/json/.test(req.headers.accept || '');
      if (json) return { subscribed: on, subscribers: F.forumCounts([f.id]).subscribers };
      req.flash('success', on ? `You are now subscribed to /f/${f.name}.` : `You unsubscribed from /f/${f.name}.`);
      return reply.redirect(F.backTo(req, `/f/${f.name}`));
    });
  }

  // ---- create / edit
  const tagList = (s) => [...new Set(String(s || '').split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 10);
  const FORUM_RULES = {
    title: { required: true, maxLength: 100 },
    description: { required: true, maxLength: 1500 },
    sidebar: { maxLength: 10000 },
    tags: { maxLength: 300, label: 'Categories', check: (x) => (tagList(x).some((t) => !/^[\w &'-]{2,40}$/.test(t)) ? 'Categories: 2-40 letters, digits, spaces, & \' or -, separated by commas.' : null) },
  };
  function setTags(forumId, tags) {
    kit.sql('DELETE FROM forums_tags WHERE forum_id = ?').run(forumId);
    for (const t of tags) {
      let id = kit.sql('SELECT id FROM forum_tags WHERE normalized_name = lower(?)').pluck().get(t);
      if (!id) id = Number(kit.sql('INSERT INTO forum_tags (name, normalized_name) VALUES (?, lower(?))').run(t, t).lastInsertRowid);
      kit.sql('INSERT OR IGNORE INTO forums_tags (forum_id, tag_id) VALUES (?, ?)').run(forumId, id);
    }
  }
  const forumTags = (id) => kit.sql('SELECT t.name FROM forums_tags ft JOIN forum_tags t ON t.id = ft.tag_id WHERE ft.forum_id = ? ORDER BY t.name').pluck().all(id).join(', ');
  const allTags = () => kit.sql('SELECT name FROM forum_tags ORDER BY normalized_name').pluck().all();

  app.get('/create_forum', { config: { login: true } }, async (req, reply) =>
    reply.render('forum_form', { title: 'Create forum', forum: null, values: {}, errors: {}, allTags: allTags(), crumbs: [['Forums', '/forums'], ['Create forum']] }));
  app.post('/create_forum', { config: { login: true } }, async (req, reply) => {
    const v = kit.validate(req.body, {
      name: { required: true, minLength: 3, maxLength: 25, pattern: /^\w+$/, message: 'Name may only contain letters, numbers and underscores (3-25 characters).' },
      ...FORUM_RULES,
    });
    if (!v.errors.name && F.forumByName(v.values.name, { required: false })) v.errors.name = 'A forum with that name already exists.';
    if (!v.ok || v.errors.name) return reply.render('forum_form', { title: 'Create forum', forum: null, values: v.values, errors: v.errors, allTags: allTags() }, 422);
    const now = kit.nowSql();
    const x = v.values;
    const id = Number(kit.sql('INSERT INTO forums (name, normalized_name, title, description, sidebar, created_at) VALUES (?, lower(?), ?, ?, ?, ?)')
      .run(x.name, x.name, x.title, x.description, x.sidebar || '', now).lastInsertRowid);
    kit.sql('INSERT INTO moderators (forum_id, user_id, created_at) VALUES (?, ?, ?)').run(id, req.user.id, now);
    kit.sql('INSERT OR IGNORE INTO forum_subscriptions (user_id, forum_id, subscribed_at) VALUES (?, ?, ?)').run(req.user.id, id, now);
    setTags(id, tagList(x.tags));
    req.flash('success', `The forum /f/${x.name} was created. You are its moderator.`);
    return reply.redirect(`/f/${x.name}`);
  });

  const modForum = (req) => {
    const f = F.forumByName(req.params.forum);
    if (!F.isModerator(req.user, f.id)) throw kit.httpError(403, 'Only moderators of this forum can do that.');
    return f;
  };
  app.get('/f/:forum/edit', { config: { login: true } }, async (req, reply) => {
    const f = modForum(req);
    return reply.render('forum_form', { title: `Edit /f/${f.name}`, forum: f, values: { ...f, tags: forumTags(f.id) }, errors: {}, allTags: allTags(), crumbs: [[`/f/${f.name}`, `/f/${f.name}`], ['Edit forum']] });
  });
  app.post('/f/:forum/edit', { config: { login: true } }, async (req, reply) => {
    const f = modForum(req);
    const v = kit.validate(req.body, { ...FORUM_RULES, featured: { type: 'bool' }, moderation_log_public: { type: 'bool' } });
    if (!v.ok) return reply.render('forum_form', { title: `Edit /f/${f.name}`, forum: f, values: { ...v.values, name: f.name }, errors: v.errors, allTags: allTags() }, 422);
    const x = v.values;
    kit.sql('UPDATE forums SET title = ?, description = ?, sidebar = ?, moderation_log_public = ? WHERE id = ?').run(x.title, x.description, x.sidebar || '', x.moderation_log_public ? 1 : 0, f.id);
    if (F.isAdmin(req.user)) kit.sql('UPDATE forums SET featured = ? WHERE id = ?').run(x.featured ? 1 : 0, f.id);
    setTags(f.id, tagList(x.tags));
    req.flash('success', 'The forum was updated.');
    return reply.redirect(`/f/${f.name}`);
  });

  // ---- moderators
  app.get('/f/:forum/moderators', async (req, reply) => {
    const f = F.forumByName(req.params.forum);
    const rows = kit.sql('SELECT m.id, m.created_at, u.username FROM moderators m JOIN users u ON u.id = m.user_id WHERE m.forum_id = ? ORDER BY m.id').all(f.id);
    return reply.render('forum_moderators', { title: `Moderators of /f/${f.name}`, forum: f, rows, canModerate: F.isModerator(req.user, f.id), errors: {}, values: {}, crumbs: [[`/f/${f.name}`, `/f/${f.name}`], ['Moderators']] });
  });
  app.post('/f/:forum/moderators', { config: { login: true } }, async (req, reply) => {
    const f = modForum(req);
    const u = F.userByName(String(req.body.username || '').trim(), { required: false });
    if (!u) { req.flash('error', `No user named "${req.body.username || ''}".`); return reply.redirect(`/f/${f.name}/moderators`); }
    kit.sql('INSERT OR IGNORE INTO moderators (forum_id, user_id, created_at) VALUES (?, ?, ?)').run(f.id, u.id, kit.nowSql());
    req.flash('success', `${u.username} is now a moderator of /f/${f.name}.`);
    return reply.redirect(`/f/${f.name}/moderators`);
  });
  app.post('/f/:forum/moderators/:username/remove', { config: { login: true } }, async (req, reply) => {
    const f = modForum(req);
    const u = F.userByName(req.params.username);
    kit.sql('DELETE FROM moderators WHERE forum_id = ? AND user_id = ?').run(f.id, u.id);
    req.flash('success', `${u.username} is no longer a moderator of /f/${f.name}.`);
    return reply.redirect(`/f/${f.name}/moderators`);
  });

  // ---- bans
  app.get('/f/:forum/bans', { config: { login: true } }, async (req, reply) => {
    const f = modForum(req);
    if (req.query.username) return reply.redirect(`/f/${f.name}/ban/${encodeURIComponent(String(req.query.username).trim())}`);
    // current state = latest event per user
    const rows = kit.sql(`SELECT b.*, u.username, m.username AS banned_by FROM forum_bans b JOIN users u ON u.id = b.user_id JOIN users m ON m.id = b.banned_by_id
      WHERE b.forum_id = ? AND b.id = (SELECT id FROM forum_bans x WHERE x.forum_id = b.forum_id AND x.user_id = b.user_id ORDER BY created_at DESC, id DESC LIMIT 1)
        AND b.banned = 1 AND (b.expires_at IS NULL OR b.expires_at > ?) ORDER BY b.created_at DESC`).all(f.id, kit.nowSql());
    return reply.render('forum_bans', { title: `Bans in /f/${f.name}`, forum: f, rows, crumbs: [[`/f/${f.name}`, `/f/${f.name}`], ['Bans']] });
  });
  app.get('/f/:forum/ban/:username', { config: { login: true } }, async (req, reply) => {
    const f = modForum(req);
    const u = F.userByName(req.params.username);
    return reply.render('forum_ban', { title: `Ban ${u.username} from /f/${f.name}`, forum: f, u, values: {}, errors: {}, current: F.activeBan(f.id, u.id), crumbs: [[`/f/${f.name}`, `/f/${f.name}`], ['Bans', `/f/${f.name}/bans`], [u.username]] });
  });
  app.post('/f/:forum/ban/:username', { config: { login: true } }, async (req, reply) => {
    const f = modForum(req);
    const u = F.userByName(req.params.username);
    const v = kit.validate(req.body, { reason: { required: true, maxLength: 300 }, expires: { type: 'date', label: 'Expiry date' } });
    if (!v.ok) return reply.render('forum_ban', { title: `Ban ${u.username} from /f/${f.name}`, forum: f, u, values: v.values, errors: v.errors, current: F.activeBan(f.id, u.id) }, 422);
    const now = kit.nowSql();
    const banId = Number(kit.sql('INSERT INTO forum_bans (forum_id, user_id, banned_by_id, reason, banned, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(f.id, u.id, req.user.id, v.values.reason, now, v.values.expires ? `${v.values.expires} 00:00:00` : null).lastInsertRowid);
    F.modLog(f.id, req.user, { action_type: 'ban', author_id: u.id, ban_id: banId, reason: v.values.reason });
    req.flash('success', `${u.username} was banned from /f/${f.name}.`);
    return reply.redirect(`/f/${f.name}/bans`);
  });
  app.post('/f/:forum/unban/:username', { config: { login: true } }, async (req, reply) => {
    const f = modForum(req);
    const u = F.userByName(req.params.username);
    const reason = String(req.body.reason || '').trim() || 'Unbanned';
    const banId = Number(kit.sql('INSERT INTO forum_bans (forum_id, user_id, banned_by_id, reason, banned, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(f.id, u.id, req.user.id, reason, kit.nowSql()).lastInsertRowid);
    F.modLog(f.id, req.user, { action_type: 'ban', author_id: u.id, ban_id: banId, reason });
    req.flash('success', `${u.username} was unbanned from /f/${f.name}.`);
    return reply.redirect(`/f/${f.name}/bans`);
  });

  // ---- moderation log
  async function log(req, reply, f) {
    if (f && !f.moderation_log_public && !F.isModerator(req.user, f.id)) throw kit.httpError(403, 'The moderation log of this forum is private.');
    const pg = F.pageOf(req, 50);
    const rows = kit.sql(`SELECT l.*, m.username AS moderator, a.username AS author, fo.name AS forum_name, s.slug, b.banned, b.expires_at
      FROM forum_log_entries l JOIN users m ON m.id = l.user_id LEFT JOIN users a ON a.id = l.author_id JOIN forums fo ON fo.id = l.forum_id
      LEFT JOIN submissions s ON s.id = l.submission_id LEFT JOIN forum_bans b ON b.id = l.ban_id
      WHERE ${f ? 'l.forum_id = ?' : 'fo.moderation_log_public = 1'} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`).all(...(f ? [f.id] : []), 51, pg.offset);
    const p = F.pager(req, rows, 50);
    return reply.render('modlog', { title: f ? `Moderation log of /f/${f.name}` : 'Moderation log', forum: f, rows, p,
      crumbs: f ? [[`/f/${f.name}`, `/f/${f.name}`], ['Moderation log']] : [['Moderation log']] });
  }
  app.get('/f/:forum/moderation_log', (req, reply) => log(req, reply, F.forumByName(req.params.forum)));
  app.get('/moderation_log', (req, reply) => log(req, reply, null));
};
