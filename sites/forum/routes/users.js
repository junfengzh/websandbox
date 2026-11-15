'use strict';
// User pages (overview, submissions, comments), biography, preferences, account, user list.
const F = require('../lib/forum');

const PER_PAGE = 25;

module.exports = async function (app, kit) {
  function profile(req, u) {
    // user_stats (build/site.sql) is kept exact by triggers
    const st = kit.sql('SELECT * FROM user_stats WHERE user_id = ?').get(u.id) || {};
    const karma = { post_karma: st.submission_karma || 0, comment_karma: st.comment_karma || 0, posts: st.submissions || 0, comments: st.comments || 0 };
    const moderates = kit.sql('SELECT f.name FROM moderators m JOIN forums f ON f.id = m.forum_id WHERE m.user_id = ? ORDER BY f.normalized_name').pluck().all(u.id);
    return { u, karma, moderates, me: !!req.user && req.user.id === u.id, admin: F.isAdmin(req.user) };
  }

  async function userPage(req, reply, tab) {
    const u = F.userByName(req.params.name);
    const pg = F.pageOf(req, PER_PAGE);
    let items = [];
    if (tab === 'submissions') {
      const ids = kit.sql("SELECT id FROM submissions WHERE user_id = ? AND visibility = 'visible' ORDER BY id DESC LIMIT ? OFFSET ?").pluck().all(u.id, PER_PAGE + 1, pg.offset);
      items = F.hydrate(ids).map((s) => ({ kind: 'submission', ...s }));
    } else if (tab === 'comments') {
      items = F.hydrateComments(kit.sql("SELECT id FROM comments WHERE user_id = ? AND visibility = 'visible' ORDER BY id DESC LIMIT ? OFFSET ?").pluck().all(u.id, PER_PAGE + 1, pg.offset))
        .map((c) => ({ kind: 'comment', ...c }));
    } else {
      // overview: newest submissions and comments interleaved by time
      const n = pg.offset + PER_PAGE + 1;
      const subs = F.hydrate(kit.sql("SELECT id FROM submissions WHERE user_id = ? AND visibility = 'visible' ORDER BY id DESC LIMIT ?").pluck().all(u.id, n)).map((s) => ({ kind: 'submission', ...s }));
      const coms = F.hydrateComments(kit.sql("SELECT id FROM comments WHERE user_id = ? AND visibility = 'visible' ORDER BY id DESC LIMIT ?").pluck().all(u.id, n)).map((c) => ({ kind: 'comment', ...c }));
      items = [...subs, ...coms].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id)).slice(pg.offset, pg.offset + PER_PAGE + 1);
    }
    const p = F.pager(req, items, PER_PAGE);
    const svotes = F.myVotes(req.user, 'submission', items.filter((x) => x.kind === 'submission').map((x) => x.id));
    const cvotes = F.myVotes(req.user, 'comment', items.filter((x) => x.kind === 'comment').map((x) => x.id));
    const label = { overview: 'Overview', submissions: 'Submissions', comments: 'Comments' }[tab];
    return reply.render('user', {
      title: tab === 'overview' ? u.username : `${u.username}: ${label}`, tab, items, p, svotes, cvotes, ...profile(req, u),
      crumbs: [['Users', '/users'], [u.username, `/user/${u.username}`], [label]],
    });
  }
  app.get('/user/:name', (req, reply) => userPage(req, reply, 'overview'));
  app.get('/user/:name/submissions', (req, reply) => userPage(req, reply, 'submissions'));
  app.get('/user/:name/comments', (req, reply) => userPage(req, reply, 'comments'));
  app.get('/u/:name', async (req, reply) => reply.redirect(`/user/${encodeURIComponent(req.params.name)}`));

  // the user themself (or an admin) may edit
  const editable = (req) => {
    const u = F.userByName(req.params.name);
    if (req.user.id !== u.id && !F.isAdmin(req.user)) throw kit.httpError(403, "You cannot change another user's settings.");
    return u;
  };

  app.get('/user/:name/edit_biography', { config: { login: true } }, async (req, reply) => {
    const u = editable(req);
    return reply.render('user_bio', { title: 'Edit biography', u, values: { biography: u.biography || '' }, errors: {}, crumbs: [[u.username, `/user/${u.username}`], ['Edit biography']] });
  });
  app.post('/user/:name/edit_biography', { config: { login: true } }, async (req, reply) => {
    const u = editable(req);
    const v = kit.validate(req.body, { biography: { maxLength: 300, label: 'Biography' } });
    if (!v.ok) return reply.render('user_bio', { title: 'Edit biography', u, values: v.values, errors: v.errors }, 422);
    kit.sql('UPDATE users SET biography = ? WHERE id = ?').run(v.values.biography || null, u.id);
    req.flash('success', 'Your biography was updated.');
    return reply.redirect(`/user/${u.username}`);
  });

  const PREFS = {
    front_page: { oneOf: ['subscribed', 'all', 'featured', 'moderated'], label: 'Front page' },
    front_page_sort_mode: { oneOf: F.SORT_NAMES, label: 'Front page sort' },
    timezone: { maxLength: 60, label: 'Time zone', check: (x) => { try { new Intl.DateTimeFormat('en-US', { timeZone: x }); return null; } catch { return 'Unknown time zone.'; } } },
    night_mode: { oneOf: ['auto', 'light', 'dark'], label: 'Theme' },
    show_thumbnails: { type: 'bool' },
    open_external_links_in_new_tab: { type: 'bool' },
    notify_on_reply: { type: 'bool' },
    notify_on_mentions: { type: 'bool' },
    allow_private_messages: { type: 'bool' },
  };
  const TZS = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney'];
  app.get('/user/:name/preferences', { config: { login: true } }, async (req, reply) => {
    const u = editable(req);
    return reply.render('user_prefs', { title: 'Preferences', u, values: u, errors: {}, TZS, crumbs: [[u.username, `/user/${u.username}`], ['Preferences']] });
  });
  app.post('/user/:name/preferences', { config: { login: true } }, async (req, reply) => {
    const u = editable(req);
    const v = kit.validate(req.body, PREFS);
    if (!v.ok) return reply.render('user_prefs', { title: 'Preferences', u, values: { ...u, ...v.values }, errors: v.errors, TZS }, 422);
    const x = v.values;
    kit.sql(`UPDATE users SET front_page = coalesce(?, front_page), front_page_sort_mode = coalesce(?, front_page_sort_mode), timezone = coalesce(?, timezone),
      night_mode = coalesce(?, night_mode), show_thumbnails = ?, open_external_links_in_new_tab = ?, notify_on_reply = ?, notify_on_mentions = ?, allow_private_messages = ? WHERE id = ?`)
      .run(x.front_page, x.front_page_sort_mode, x.timezone, x.night_mode, +x.show_thumbnails, +x.open_external_links_in_new_tab, +x.notify_on_reply, +x.notify_on_mentions, +x.allow_private_messages, u.id);
    req.flash('success', 'Your preferences were saved.');
    return reply.redirect(`/user/${u.username}/preferences`);
  });

  app.get('/user/:name/account', { config: { login: true } }, async (req, reply) => {
    const u = editable(req);
    return reply.render('user_account', { title: 'Account settings', u, values: { username: u.username, email: u.email || '' }, errors: {}, crumbs: [[u.username, `/user/${u.username}`], ['Account']] });
  });
  app.post('/user/:name/account', { config: { login: true } }, async (req, reply) => {
    const u = editable(req);
    const v = kit.validate(req.body, {
      username: { required: true, minLength: 3, maxLength: 25, pattern: /^[A-Za-z0-9_-]+$/, message: 'Username may only contain letters, numbers, underscores and hyphens.' },
      email: { type: 'email', maxLength: 200, label: 'Email address' },
      current_password: { label: 'Current password' },
      new_password: { minLength: 8, maxLength: 72, label: 'New password' },
      new_password_repeat: { label: 'Repeat new password' },
    });
    const x = v.values;
    if (!v.errors.username && x.username.toLowerCase() !== u.normalized_username && kit.sql('SELECT 1 FROM users WHERE normalized_username = lower(?)').get(x.username)) v.errors.username = 'That username is already taken.';
    if (x.new_password && x.new_password !== x.new_password_repeat) v.errors.new_password_repeat = 'The passwords do not match.';
    const changing = x.new_password || x.username !== u.username || (x.email || null) !== (u.email || null);
    if (changing && !F.isAdmin(req.user) && !(await kit.auth.verifyPassword(x.current_password || '', u.password_hash))) v.errors.current_password = 'Enter your current password to change account settings.';
    if (Object.keys(v.errors).length) return reply.render('user_account', { title: 'Account settings', u, values: { username: x.username, email: x.email }, errors: v.errors }, 422);
    kit.sql('UPDATE users SET username = ?, normalized_username = lower(?), email = ?, normalized_email = lower(?) WHERE id = ?').run(x.username, x.username, x.email, x.email, u.id);
    if (x.new_password) kit.sql('UPDATE users SET password_hash = ? WHERE id = ?').run(kit.auth.hashPassword(x.new_password), u.id);
    req.flash('success', 'Your account settings were saved.');
    return reply.redirect(`/user/${x.username}/account`);
  });

  // user list (Postmill /users): by join order, newest first
  app.get('/users', async (req, reply) => {
    const pg = F.pageOf(req, 50);
    if (pg.page > 200) throw kit.httpError(404, 'Page out of range.');
    const rows = kit.sql('SELECT id, username, created_at, last_seen_at FROM users ORDER BY id DESC LIMIT ? OFFSET ?').all(51, pg.offset);
    const p = F.pager(req, rows, 50);
    return reply.render('users', { title: 'Users', rows, p, crumbs: [['Users']] });
  });
};
