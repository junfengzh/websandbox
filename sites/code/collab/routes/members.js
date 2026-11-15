'use strict';
// Members of projects (/:ns/:proj/-/project_members) and groups (/groups/:group/-/group_members):
// list (direct + inherited, search, sort, invited, access requests), invite by username or
// email with role and expiry, change role / expiry, remove, leave, request access, approve/deny.
// Rules (GitLab): Maintainer+ manage members; only Owners grant/change/remove Owner; a group
// keeps at least one Owner; an e-mail that belongs to a user adds that user, else a pending invite.
module.exports = function members(app, ctx) {
  const { kit, U, A, I, P, view, back } = ctx;
  const LEVELS = [[10, 'Guest'], [20, 'Reporter'], [30, 'Developer'], [40, 'Maintainer'], [50, 'Owner']];
  const SORTS = { access_level_asc: 'access_level ASC, u.username COLLATE NOCASE', access_level_desc: 'access_level DESC, u.username COLLATE NOCASE', name_asc: 'u.name COLLATE NOCASE ASC', name_desc: 'u.name COLLATE NOCASE DESC',
    last_joined: 'm.created_at DESC', oldest_joined: 'm.created_at ASC', last_activity_on_desc: 'u.last_activity_on DESC', last_activity_on_asc: 'u.last_activity_on ASC', recent_sign_in: 'u.last_sign_in_at DESC', oldest_sign_in: 'u.last_sign_in_at ASC' };
  const SORT_LABELS = [['name_asc', 'Name, ascending'], ['name_desc', 'Name, descending'], ['access_level_desc', 'Max role'], ['access_level_asc', 'Min role'], ['last_joined', 'Last joined'], ['oldest_joined', 'Oldest joined'], ['recent_sign_in', 'Recent sign in'], ['last_activity_on_desc', 'Last activity']];

  const scopeOf = (s) => (s.project
    ? { type: 'project', id: s.project.id, base: `${s.project.base}/-/project_members`, access: s.project.access, name: s.project.name, kind: 'project', target: s.project, nsChain: I.groupChain(s.project.namespace_id), personalOwner: s.project.ns_kind === 'user' ? s.project.ns_owner_id : null }
    : { type: 'namespace', id: s.group.id, base: `${s.group.base}/-/group_members`, access: s.group.access, name: s.group.name, kind: 'group', target: s.group, nsChain: I.groupChain(s.group.parent_id), personalOwner: null });

  function memberRows(sc, req) {
    const q = U.str(req.query.search);
    const sort = SORTS[U.str(req.query.sort)] ? U.str(req.query.sort) : 'access_level_desc';
    const like = q ? `%${q.replace(/[\\%_]/g, (x) => '\\' + x)}%` : null;
    const where = like ? " AND (u.username LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')" : '';
    const lp = like ? [like, like, like] : [];
    const direct = kit.sql(`SELECT m.*, m.access_level AS access_level, u.username, u.name, u.avatar, u.state AS user_state, u.last_activity_on, u.last_sign_in_at, cb.username AS created_by_username
      FROM members m JOIN users u ON u.id = m.user_id LEFT JOIN users cb ON cb.id = m.created_by_id
      WHERE m.source_type = ? AND m.source_id = ? AND m.requested_at IS NULL${where} ORDER BY ${SORTS[sort]}`).all(sc.type, sc.id, ...lp);
    const seen = new Map(direct.map((m) => [m.user_id, m]));
    const inherited = [];
    for (const gid of sc.nsChain) {
      const g = kit.sql('SELECT full_path, name FROM namespaces WHERE id = ?').get(gid);
      for (const m of kit.sql(`SELECT m.*, u.username, u.name, u.avatar, u.state AS user_state, u.last_activity_on, u.last_sign_in_at FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.source_type = 'namespace' AND m.source_id = ? AND m.requested_at IS NULL${where} ORDER BY ${SORTS[sort]}`).all(gid, ...lp)) {
        const d = seen.get(m.user_id);
        if (d && d.access_level >= m.access_level) continue;
        m.inherited_from = g; inherited.push(m); seen.set(m.user_id, m);
      }
    }
    // personal project owner without a members row
    if (sc.personalOwner && !direct.some((m) => m.user_id === sc.personalOwner)) {
      const u = kit.sql('SELECT id AS user_id, username, name, avatar, state AS user_state, last_activity_on, last_sign_in_at FROM users WHERE id = ?').get(sc.personalOwner);
      if (u && (!like || [u.username, u.name].some((x) => x.toLowerCase().includes(q.toLowerCase())))) inherited.unshift({ ...u, id: null, access_level: 50, owner_namespace: true, created_at: null });
    }
    const all = [...direct, ...inherited.filter((m) => !direct.some((d) => d.user_id === m.user_id))];
    const invited = kit.sql(`SELECT m.*, cb.username AS created_by_username FROM members m LEFT JOIN users cb ON cb.id = m.created_by_id WHERE m.source_type = ? AND m.source_id = ? AND m.user_id IS NULL AND m.invite_email IS NOT NULL ORDER BY m.created_at DESC`).all(sc.type, sc.id);
    const requests = kit.sql(`SELECT m.*, u.username, u.name, u.avatar FROM members m JOIN users u ON u.id = m.user_id WHERE m.source_type = ? AND m.source_id = ? AND m.requested_at IS NOT NULL ORDER BY m.requested_at DESC`).all(sc.type, sc.id);
    return { all, direct, invited, requests, sort, q };
  }

  function render(req, reply, s, extra = {}, status) {
    const sc = scopeOf(s);
    const r = memberRows(sc, req);
    const tab = ['invited', 'access_requests'].includes(U.str(req.query.tab)) ? U.str(req.query.tab) : 'members';
    const me = req.user;
    const myRow = me ? r.direct.find((m) => m.user_id === me.id) : null;
    return view(reply, 'members', {
      title: 'Members', project: s.project, group: s.group, nav: s.project ? 'members' : 'group.members', sc, r, tab, levels: LEVELS, sortOptions: SORT_LABELS,
      canManage: sc.access >= A.MAINTAINER && !(s.project && s.project.archived), isOwner: sc.access >= A.OWNER, myRow,
      canRequest: me && sc.access < A.GUEST && !r.requests.some((m) => m.user_id === me.id) && sc.target.request_access_enabled !== 0,
      crumbs: [[s.project ? 'Project members' : 'Group members']], values: extra.values || {}, errors: extra.errors || [], ...extra,
    }, status);
  }
  const routes = (prefix, load, base) => {
    app.get(`${prefix}`, async (req, reply) => render(req, reply, load(req)));
    app.post(`${prefix}`, { config: { login: true } }, async (req, reply) => invite(req, reply, load(req)));
    app.post(`${prefix}/:id/update`, { config: { login: true } }, async (req, reply) => update(req, reply, load(req)));
    app.post(`${prefix}/:id/delete`, { config: { login: true } }, async (req, reply) => remove(req, reply, load(req)));
    app.post(`${prefix}/leave`, { config: { login: true } }, async (req, reply) => leave(req, reply, load(req)));
    app.post(`${prefix}/request_access`, { config: { login: true } }, async (req, reply) => requestAccess(req, reply, load(req)));
    app.post(`${prefix}/:id/approve_access_request`, { config: { login: true } }, async (req, reply) => approve(req, reply, load(req)));
    app.post(`${prefix}/:id/resend_invite`, { config: { login: true } }, async (req, reply) => { const s = load(req); const sc = scopeOf(s); need(sc); req.flash('success', 'The invitation was successfully resent.'); return reply.redirect(`${sc.base}?tab=invited`); });
    void base;
  };
  routes(P('project_members'), (req) => ({ project: A.loadProject(req) }));
  routes('/groups/:group/-/group_members', (req) => ({ group: A.loadGroup(req, req.params.group) }));

  const need = (sc) => { if (sc.access < A.MAINTAINER) throw kit.httpError(403, 'You need at least the Maintainer role to manage members.'); if (sc.target.archived) throw kit.httpError(403, 'This project is archived.'); };

  function addOrUpdate(sc, user, invitee, level, expires) {
    const ex = invitee.id ? kit.sql('SELECT * FROM members WHERE source_type = ? AND source_id = ? AND user_id = ?').get(sc.type, sc.id, invitee.id) : null;
    const now = kit.nowSql();
    if (ex) {
      kit.sql('UPDATE members SET access_level = ?, expires_at = ?, requested_at = NULL, updated_at = ? WHERE id = ?').run(level, expires || null, now, ex.id);
      return 'updated';
    }
    if (invitee.id) {
      kit.sql('INSERT INTO members (source_type, source_id, user_id, access_level, created_by_id, invite_accepted_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(sc.type, sc.id, invitee.id, level, user.id, now, expires || null, now, now);
      if (sc.type === 'project') kit.sql("INSERT INTO events (project_id, author_id, action, created_at) VALUES (?, ?, 'joined', ?)").run(sc.id, invitee.id, now);
      else kit.sql("INSERT INTO events (group_id, author_id, action, created_at) VALUES (?, ?, 'joined', ?)").run(sc.id, invitee.id, now);
      return 'added';
    }
    const dup = kit.sql('SELECT id FROM members WHERE source_type = ? AND source_id = ? AND user_id IS NULL AND invite_email = ? COLLATE NOCASE').get(sc.type, sc.id, invitee.email);
    if (dup) { kit.sql('UPDATE members SET access_level = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(level, expires || null, now, dup.id); return 'updated'; }
    kit.sql('INSERT INTO members (source_type, source_id, user_id, access_level, created_by_id, invite_email, expires_at, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)')
      .run(sc.type, sc.id, level, user.id, invitee.email, expires || null, now, now);
    return 'invited';
  }
  ctx.addMember = (s, user, invitee, level, expires) => addOrUpdate(scopeOf(s), user, invitee, level, expires);

  async function invite(req, reply, s) {
    const sc = scopeOf(s); need(sc);
    const b = req.body || {};
    const raw = [...U.arr(b['user_ids[]'] ?? b.user_ids), ...U.str(b.invitees || b.usernames || b.user_id || b.email).split(/[,;\n]+/)].map((x) => String(x).trim()).filter(Boolean);
    const level = U.int(b.access_level, 10);
    const expires = U.str(b.expires_at);
    const errors = [];
    if (!raw.length) errors.push('Select at least one user or enter an email address to invite.');
    if (!LEVELS.some(([l]) => l === level)) errors.push('Choose a valid role.');
    if (level === 50 && sc.access < A.OWNER) errors.push('Only Owners can grant the Owner role.');
    const exp = U.parseDate(expires);
    if (exp === undefined) errors.push('Access expiration date is invalid (use YYYY-MM-DD).');
    else if (exp && exp <= kit.nowSql().slice(0, 10)) errors.push('Access expiration date must be in the future.');
    const invitees = [];
    // Entries are comma-separated; an entry may be a username, an e-mail, or a user's full name
    // ("Jakub Klinkovský", as GitLab's invite picker finds by name); otherwise space-separated usernames.
    const byName = (n) => { const r = kit.sql("SELECT * FROM users WHERE name = ? COLLATE NOCASE AND state = 'active' LIMIT 2").all(n); return r.length === 1 ? r[0] : null; };
    const findUser = (v) => kit.sql("SELECT * FROM users WHERE (username = ? OR email = ? COLLATE NOCASE OR public_email = ? COLLATE NOCASE) AND state = 'active'").get(v, v, v);
    const entries = [];
    for (const x of raw) {
      const v = x.replace(/^@/, '');
      if (/\s/.test(v) && !findUser(v)) { const u = byName(v); if (u) entries.push('@' + u.username); else entries.push(...v.split(/\s+/)); } else entries.push(x);
    }
    for (const x of entries) {
      const s2 = x.replace(/^@/, '');
      const byId = /^\d+$/.test(s2) ? kit.sql("SELECT * FROM users WHERE id = ? AND state = 'active'").get(+s2) : null;
      const u = byId || kit.sql("SELECT * FROM users WHERE (username = ? OR email = ? COLLATE NOCASE OR public_email = ? COLLATE NOCASE) AND state = 'active'").get(s2, s2, s2);
      if (u) { if (u.user_type) errors.push(`${u.username} is a bot and cannot be invited.`); else invitees.push({ id: u.id, username: u.username }); }
      else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s2)) invitees.push({ email: s2.toLowerCase() });
      else errors.push(`User not found: ${s2}`);
    }
    if (errors.length) { req.flash('error', errors.join(' ')); return render(req, reply, s, { values: { invitees: raw.join(', '), access_level: level, expires_at: expires }, errors }, 422); }
    const res = { added: [], updated: [], invited: [] };
    for (const inv of invitees) {
      if (inv.id && sc.personalOwner === inv.id) { res.updated.push(inv.username); continue; }
      const ex = inv.id ? kit.sql('SELECT access_level FROM members WHERE source_type = ? AND source_id = ? AND user_id = ?').get(sc.type, sc.id, inv.id) : null;
      if (ex && ex.access_level === 50 && sc.access < A.OWNER) { errors.push(`${inv.username} is an Owner; only Owners can change it.`); continue; }
      res[addOrUpdate(sc, req.user, inv, level, exp)].push(inv.username || inv.email);
    }
    const parts = [];
    if (res.added.length) parts.push(`Added ${res.added.map((x) => '@' + x).join(', ')} as ${U.ACCESS[level]}.`);
    if (res.updated.length) parts.push(`Updated ${res.updated.map((x) => '@' + x).join(', ')} to ${U.ACCESS[level]}.`);
    if (res.invited.length) parts.push(`Invitation sent to ${res.invited.join(', ')}.`);
    if (parts.length) req.flash('success', parts.join(' ') || 'Members were successfully added.');
    if (errors.length) req.flash('error', errors.join(' '));
    return reply.redirect(res.invited.length && !res.added.length ? `${sc.base}?tab=invited` : sc.base);
  }

  const loadMember = (sc, id) => {
    const m = kit.sql('SELECT * FROM members WHERE id = ? AND source_type = ? AND source_id = ?').get(U.int(id), sc.type, sc.id);
    if (!m) throw kit.httpError(404, 'Member not found');
    return m;
  };
  const ownerCount = (sc) => kit.sql("SELECT count(*) FROM members WHERE source_type = ? AND source_id = ? AND access_level = 50 AND user_id IS NOT NULL AND requested_at IS NULL").pluck().get(sc.type, sc.id);

  async function update(req, reply, s) {
    const sc = scopeOf(s); need(sc);
    const m = loadMember(sc, req.params.id);
    if (m.user_id && m.user_id === sc.personalOwner) throw kit.httpError(403, "The owner of a personal project's namespace cannot be changed.");
    const b = req.body || {};
    const level = b.access_level != null ? U.int(b.access_level) : m.access_level;
    if (!LEVELS.some(([l]) => l === level)) throw kit.httpError(422, 'Invalid role.');
    if ((level === 50 || m.access_level === 50) && sc.access < A.OWNER) throw kit.httpError(403, 'Only Owners can change the Owner role.');
    if (sc.type === 'namespace' && m.access_level === 50 && level !== 50 && ownerCount(sc) <= 1) { req.flash('error', 'A group must have at least one owner.'); return reply.redirect(sc.base); }
    let expires = m.expires_at;
    if (b.expires_at != null) {
      const e = U.parseDate(b.expires_at);
      if (e === undefined) { req.flash('error', 'Expiration date is invalid (use YYYY-MM-DD).'); return reply.redirect(sc.base); }
      if (e && e <= kit.nowSql().slice(0, 10)) { req.flash('error', 'Expiration date must be in the future.'); return reply.redirect(sc.base); }
      expires = e;
    }
    kit.sql('UPDATE members SET access_level = ?, expires_at = ?, updated_at = ? WHERE id = ?').run(level, expires || null, kit.nowSql(), m.id);
    const who = m.user_id ? kit.sql('SELECT username FROM users WHERE id = ?').pluck().get(m.user_id) : m.invite_email;
    req.flash('success', `Role of ${m.user_id ? '@' : ''}${who} updated to ${U.ACCESS[level]}${expires ? `, access expires ${U.dateFmt(expires)}` : ''}.`);
    return reply.redirect(back(req, sc.base));
  }
  function deleteMember(sc, m, unassign) {
    kit.sql('DELETE FROM members WHERE id = ?').run(m.id);
    if (m.user_id) {
      const now = kit.nowSql();
      if (sc.type === 'project') kit.sql("INSERT INTO events (project_id, author_id, action, created_at) VALUES (?, ?, 'left', ?)").run(sc.id, m.user_id, now);
      if (unassign && sc.type === 'project') {
        kit.sql("DELETE FROM issue_assignees WHERE user_id = ? AND issue_id IN (SELECT id FROM issues WHERE project_id = ? AND state = 'opened')").run(m.user_id, sc.id);
        kit.sql("DELETE FROM mr_assignees WHERE user_id = ? AND merge_request_id IN (SELECT id FROM merge_requests WHERE project_id = ? AND state = 'opened')").run(m.user_id, sc.id);
      }
    }
  }
  async function remove(req, reply, s) {
    const sc = scopeOf(s);
    const m = loadMember(sc, req.params.id);
    if (m.user_id && m.user_id === sc.personalOwner) throw kit.httpError(403, "The owner of a personal project's namespace cannot be removed.");
    const self = req.user && m.user_id === req.user.id;
    if (!self) need(sc);
    if (m.access_level === 50 && sc.access < A.OWNER) throw kit.httpError(403, 'Only Owners can remove an Owner.');
    if (sc.type === 'namespace' && m.access_level === 50 && m.user_id && ownerCount(sc) <= 1) { req.flash('error', 'A group must have at least one owner. Promote someone else first.'); return reply.redirect(sc.base); }
    deleteMember(sc, m, U.bool(req.body && req.body.unassign_issuables));
    const who = m.user_id ? '@' + kit.sql('SELECT username FROM users WHERE id = ?').pluck().get(m.user_id) : m.invite_email;
    req.flash('success', m.requested_at ? `Access request of ${who} was denied.` : m.user_id ? `${who} was removed from the ${sc.kind} ${sc.name}.` : `The invitation for ${who} was revoked.`);
    if (self) return reply.redirect('/dashboard/projects');
    return reply.redirect(back(req, m.user_id ? sc.base : `${sc.base}?tab=invited`));
  }
  async function leave(req, reply, s) {
    const sc = scopeOf(s);
    const m = kit.sql('SELECT * FROM members WHERE source_type = ? AND source_id = ? AND user_id = ?').get(sc.type, sc.id, req.user.id);
    if (!m) throw kit.httpError(404, 'You are not a direct member.');
    if (sc.type === 'namespace' && m.access_level === 50 && ownerCount(sc) <= 1) { req.flash('error', 'You cannot leave this group: you are its last owner.'); return reply.redirect(sc.base); }
    deleteMember(sc, m, false);
    req.flash('success', `You left the "${sc.name}" ${sc.kind}.`);
    return reply.redirect('/dashboard/projects');
  }
  async function requestAccess(req, reply, s) {
    const sc = scopeOf(s);
    if (sc.access >= A.GUEST) { req.flash('info', 'You already have access.'); return reply.redirect(sc.target.url || sc.base); }
    if (!kit.sql('SELECT 1 FROM members WHERE source_type = ? AND source_id = ? AND user_id = ?').get(sc.type, sc.id, req.user.id)) {
      const now = kit.nowSql();
      kit.sql('INSERT INTO members (source_type, source_id, user_id, access_level, requested_at, created_at, updated_at) VALUES (?, ?, ?, 30, ?, ?, ?)').run(sc.type, sc.id, req.user.id, now, now, now);
    }
    req.flash('success', 'Your request for access has been queued for review.');
    return reply.redirect(sc.base);
  }
  async function approve(req, reply, s) {
    const sc = scopeOf(s); need(sc);
    const m = loadMember(sc, req.params.id);
    if (!m.requested_at) throw kit.httpError(422, 'This is not an access request.');
    const level = U.int(req.body && req.body.access_level, m.access_level);
    kit.sql('UPDATE members SET requested_at = NULL, access_level = ?, invite_accepted_at = ?, created_by_id = ?, updated_at = ? WHERE id = ?').run(level, kit.nowSql(), req.user.id, kit.nowSql(), m.id);
    req.flash('success', 'Access request approved.');
    return reply.redirect(sc.base);
  }
};
