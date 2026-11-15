'use strict';
// User settings: /-/profile (edit profile + status + avatar), password, access tokens (feed token).
const fs = require('node:fs');
const code = require('../../lib/code');

module.exports = async function (app, kit) {
  const FIELDS = ['name', 'pronouns', 'public_email', 'website_url', 'location', 'job_title', 'organization', 'bio', 'twitter', 'linkedin', 'skype'];
  const render = (req, reply, extra = {}, status = 200) => {
    const st = kit.sql('SELECT * FROM user_statuses WHERE user_id = ?').get(req.user.id) || {};
    return reply.render('repo/profile_edit', { title: 'Edit Profile', crumbs: [['User Settings', '/-/profile'], ['Edit Profile']], sidebar: 'repo/_sidebar_settings', nav: 'profile',
      values: { ...req.user }, st, errors: {}, ...extra }, status);
  };
  app.get('/-/profile', { config: { login: true } }, async (req, reply) => render(req, reply));
  app.get('/profile', { config: { login: true } }, async (req, reply) => reply.redirect('/-/profile'));
  app.post('/-/profile', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    const values = {};
    for (const f of FIELDS) values[f] = b[f] == null ? req.user[f] : String(b[f]).trim();
    const v = kit.validate(values, {
      name: { required: true, maxLength: 255, label: 'Full name' },
      website_url: { check: (x) => (x && !/^(https?:\/\/)?[^\s/$.?#].[^\s]*$/i.test(x) ? 'Website url is not a valid URL' : null) },
      bio: { maxLength: 255, label: 'Bio' }, pronouns: { maxLength: 50 }, location: { maxLength: 255 }, job_title: { maxLength: 200 }, organization: { maxLength: 255 },
      public_email: { check: (x) => (x && ![req.user.email, req.user.commit_email].includes(x) ? 'Public email must be one of your verified emails' : null) },
    });
    if (!v.ok) return render(req, reply, { values: { ...req.user, ...values }, errors: v.errors }, 422);
    const sets = FIELDS.map((f) => `${f} = ?`).join(', ');
    kit.db().prepare(`UPDATE users SET ${sets}, private_profile = ?, updated_at = ? WHERE id = ?`).run(...FIELDS.map((f) => (values[f] === '' && f !== 'name' ? null : values[f])), b.private_profile === '1' || b.private_profile === 'on' ? 1 : 0, kit.nowSql(), req.user.id);
    // avatar upload (multipart) or removal
    const av = b.avatar && typeof b.avatar === 'object' ? b.avatar : null;
    if (av && av.url) {
      if (!/^image\//.test(av.mimetype || '') || av.size > 200 * 1024 * 1024) return render(req, reply, { errors: { avatar: 'Avatar must be an image file' } }, 422);
      kit.sql('UPDATE users SET avatar = ? WHERE id = ?').run(av.url, req.user.id);
    } else if (b.remove_avatar === '1') kit.sql('UPDATE users SET avatar = NULL WHERE id = ?').run(req.user.id);
    // status fields may be submitted with the profile form
    if (b.status_message != null || b.status_busy != null) saveStatus(req.user.id, b);
    req.flash('success', 'Profile was successfully updated');
    return reply.redirect('/-/profile');
  });
  const saveStatus = (uid, b) => {
    const msg = String(b.status_message || '').trim().slice(0, 100);
    const busy = b.status_busy === '1' || b.status_busy === 'on' || b.availability === 'busy';
    const emoji = String(b.status_emoji || '').trim() || 'speech_balloon';
    const clear = { '30m': 1800, '3h': 10800, '8h': 28800, '1d': 86400, '3d': 259200, '7d': 604800, '30d': 2592000 }[b.clear_status_after];
    if (!msg && !busy) { kit.sql('DELETE FROM user_statuses WHERE user_id = ?').run(uid); return; }
    const until = clear ? new Date(kit.now().getTime() + clear * 1000).toISOString().slice(0, 19).replace('T', ' ') : null;
    kit.sql(`INSERT INTO user_statuses (user_id, emoji, message, availability, clear_status_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET emoji = excluded.emoji, message = excluded.message, availability = excluded.availability, clear_status_at = excluded.clear_status_at`)
      .run(uid, emoji, msg || null, busy ? 'busy' : 'not_set', until);
  };
  app.post('/-/profile/status', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    if (b.clear === '1') kit.sql('DELETE FROM user_statuses WHERE user_id = ?').run(req.user.id);
    else saveStatus(req.user.id, b);
    req.flash('success', b.clear === '1' ? 'Status cleared' : 'Status updated');
    const next = b.next;
    return reply.redirect(typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/-/profile');
  });

  // password
  app.get('/-/profile/password/edit', { config: { login: true } }, async (req, reply) => reply.render('repo/profile_password', { title: 'Password', crumbs: [['User Settings', '/-/profile'], ['Password']], sidebar: 'repo/_sidebar_settings', nav: 'password', errors: {} }));
  app.post('/-/profile/password', { config: { login: true } }, async (req, reply) => {
    const b = req.body || {};
    const errors = {};
    const ok = req.user.password_hash && (await kit.auth.verifyPassword(String(b.current_password || ''), req.user.password_hash));
    if (!ok) errors.current_password = 'You must provide a valid current password';
    const pw = String(b.new_password || '');
    if (pw.length < 8) errors.new_password = 'Password is too short (minimum is 8 characters)';
    else if (pw !== String(b.password_confirmation || '')) errors.password_confirmation = "Password confirmation doesn't match Password";
    if (Object.keys(errors).length) return reply.render('repo/profile_password', { title: 'Password', crumbs: [['User Settings', '/-/profile'], ['Password']], sidebar: 'repo/_sidebar_settings', nav: 'password', errors }, 422);
    kit.sql('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(kit.auth.hashPassword(pw), kit.nowSql(), req.user.id);
    req.flash('success', 'Password was successfully updated.');
    return reply.redirect('/-/profile/password/edit');
  });

  // access tokens page: GitLab 15.7 shows the feed token here
  app.get('/-/profile/personal_access_tokens', { config: { login: true } }, async (req, reply) => reply.render('repo/profile_tokens', { title: 'Access Tokens', crumbs: [['User Settings', '/-/profile'], ['Access Tokens']], sidebar: 'repo/_sidebar_settings', nav: 'tokens' }));
  app.get('/-/profile/account', { config: { login: true } }, async (req, reply) => reply.render('repo/profile_account', { title: 'Account', crumbs: [['User Settings', '/-/profile'], ['Account']], sidebar: 'repo/_sidebar_settings', nav: 'account' }));
  void fs; void code;
};
