'use strict';
// Private messages (threads between two users) and notifications.
const F = require('../lib/forum');

module.exports = async function (app, kit) {
  app.get('/messages', { config: { login: true } }, async (req, reply) => {
    const pg = F.pageOf(req, 25);
    const rows = kit.sql(`SELECT t.id, t.subject, t.created_at,
        (SELECT max(m.id) FROM messages m WHERE m.thread_id = t.id) AS last_id,
        (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS n,
        (SELECT group_concat(u.username, ', ') FROM message_thread_participants p JOIN users u ON u.id = p.user_id WHERE p.thread_id = t.id AND p.user_id <> ?) AS others,
        (SELECT count(*) FROM notifications n JOIN messages m ON m.id = n.message_id WHERE n.user_id = ? AND n.read_at IS NULL AND m.thread_id = t.id) AS unread
      FROM message_threads t JOIN message_thread_participants me ON me.thread_id = t.id AND me.user_id = ?
      ORDER BY last_id DESC LIMIT ? OFFSET ?`).all(req.user.id, req.user.id, req.user.id, 26, pg.offset);
    for (const r of rows) {
      const m = kit.sql('SELECT m.body, m.created_at, u.username FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(r.last_id);
      Object.assign(r, { last_body: m && m.body, last_at: m && m.created_at, last_from: m && m.username });
    }
    const p = F.pager(req, rows, 25);
    return reply.render('messages', { title: 'Messages', rows, p, crumbs: [['Messages']] });
  });

  const loadThread = (req) => {
    const t = kit.sql('SELECT * FROM message_threads WHERE id = ?').get(+req.params.id || 0);
    if (!t || !kit.sql('SELECT 1 FROM message_thread_participants WHERE thread_id = ? AND user_id = ?').get(t.id, req.user.id)) throw kit.httpError(404, 'That message thread does not exist.');
    return t;
  };
  app.get('/messages/thread/:id', { config: { login: true } }, async (req, reply) => {
    const t = loadThread(req);
    const msgs = kit.sql('SELECT m.*, u.username FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.thread_id = ? ORDER BY m.id').all(t.id);
    const others = kit.sql('SELECT u.username, u.allow_private_messages FROM message_thread_participants p JOIN users u ON u.id = p.user_id WHERE p.thread_id = ? AND p.user_id <> ?').all(t.id, req.user.id);
    kit.sql('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(kit.nowSql(), req.user.id, t.id);
    return reply.render('message_thread', { title: t.subject || 'Conversation', t, msgs, others, values: {}, errors: {}, crumbs: [['Messages', '/messages'], [t.subject || 'Conversation']] });
  });
  function addMessage(threadId, sender, body) {
    const now = kit.nowSql();
    const id = Number(kit.sql('INSERT INTO messages (thread_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)').run(threadId, sender.id, body, now).lastInsertRowid);
    for (const uid of kit.sql('SELECT user_id FROM message_thread_participants WHERE thread_id = ? AND user_id <> ?').pluck().all(threadId, sender.id)) F.notify(uid, 'message', { messageId: id });
    return id;
  }
  app.post('/messages/thread/:id/reply', { config: { login: true } }, async (req, reply) => {
    const t = loadThread(req);
    const body = String(req.body.message || '').trim();
    if (!body || body.length > 10000) { req.flash('error', body ? 'The message must be at most 10000 characters.' : 'The message cannot be empty.'); return reply.redirect(`/messages/thread/${t.id}`); }
    const id = addMessage(t.id, req.user, body);
    req.flash('success', 'Your reply was sent.');
    return reply.redirect(`/messages/thread/${t.id}#message-${id}`);
  });

  const RULES = { subject: { required: true, maxLength: 200 }, message: { required: true, maxLength: 10000 } };
  app.get('/user/:name/compose_message', { config: { login: true } }, async (req, reply) => {
    const to = F.userByName(req.params.name);
    return reply.render('compose', { title: `Message ${to.username}`, to, values: {}, errors: {}, crumbs: [[to.username, `/user/${to.username}`], ['Send message']] });
  });
  app.post('/user/:name/compose_message', { config: { login: true } }, async (req, reply) => {
    const to = F.userByName(req.params.name);
    const v = kit.validate(req.body, RULES);
    if (to.id === req.user.id) v.errors.message = 'You cannot send a message to yourself.';
    else if (!to.allow_private_messages && !F.isAdmin(req.user)) v.errors.message = `${to.username} does not accept private messages.`;
    if (Object.keys(v.errors).length) return reply.render('compose', { title: `Message ${to.username}`, to, values: v.values, errors: v.errors }, 422);
    const now = kit.nowSql();
    const tid = Number(kit.sql('INSERT INTO message_threads (subject, created_at) VALUES (?, ?)').run(v.values.subject, now).lastInsertRowid);
    kit.sql('INSERT INTO message_thread_participants (thread_id, user_id) VALUES (?, ?), (?, ?)').run(tid, req.user.id, tid, to.id);
    addMessage(tid, req.user, v.values.message);
    req.flash('success', `Your message to ${to.username} was sent.`);
    return reply.redirect(`/messages/thread/${tid}`);
  });

  // ---- notifications
  app.get('/notifications', { config: { login: true } }, async (req, reply) => {
    const pg = F.pageOf(req, 25);
    const rows = kit.sql(`SELECT n.*, s.title, s.slug, f.name AS forum_name, c.body AS comment_body, cu.username AS comment_user,
        m.body AS message_body, m.thread_id, mu.username AS message_user, su.username AS submission_user
      FROM notifications n
      LEFT JOIN submissions s ON s.id = n.submission_id LEFT JOIN forums f ON f.id = s.forum_id LEFT JOIN users su ON su.id = s.user_id
      LEFT JOIN comments c ON c.id = n.comment_id LEFT JOIN users cu ON cu.id = c.user_id
      LEFT JOIN messages m ON m.id = n.message_id LEFT JOIN users mu ON mu.id = m.sender_id
      WHERE n.user_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`).all(req.user.id, 26, pg.offset);
    const p = F.pager(req, rows, 25);
    return reply.render('notifications', { title: 'Notifications', rows, p, crumbs: [['Notifications']] });
  });
  app.get('/inbox', async (req, reply) => reply.redirect('/notifications'));
  app.post('/notifications/clear', { config: { login: true } }, async (req, reply) => {
    const r = kit.sql('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(kit.nowSql(), req.user.id);
    req.flash('success', r.changes ? `Marked ${r.changes} notification${r.changes === 1 ? '' : 's'} as read.` : 'No unread notifications.');
    return reply.redirect('/notifications');
  });
  app.post('/notifications/:id/read', { config: { login: true } }, async (req, reply) => {
    const n = kit.sql('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(+req.params.id || 0, req.user.id);
    if (!n) throw kit.httpError(404, 'No such notification.');
    kit.sql('UPDATE notifications SET read_at = coalesce(read_at, ?) WHERE id = ?').run(kit.nowSql(), n.id);
    return reply.redirect(F.backTo(req, '/notifications'));
  });
};
