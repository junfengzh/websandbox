'use strict';
// Cookie sessions stored in the tenant DB (temp.kit_sessions), so they reset
// with the rollout. Writes are immediate (write-through) and happen inside the
// request's savepoint.
const crypto = require('node:crypto');
const { httpError } = require('./context');

const COOKIE = 'wsb_sid';
const rid = (n = 18) => crypto.randomBytes(n).toString('base64url');
const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' };

class Session {
  constructor(tenant, row) {
    this.tenant = tenant;
    this.row = row; // may be null until first write
    this.data = row ? JSON.parse(row.data) : {};
  }
  get id() { return this.row && this.row.id; }
  get userId() { return this.row ? this.row.user_id : null; }
  get(k) { return this.data[k]; }
  set(k, v) {
    if (v === undefined) delete this.data[k]; else this.data[k] = v;
    this.save();
  }
  save() { this.tenant.sql('UPDATE kit_sessions SET data = ? WHERE id = ?').run(JSON.stringify(this.data), this.ensure().id); }
  ensure() {
    if (!this.row) this.row = createSession(this.tenant, null, this.data);
    if (this.reply && !this.cookieSet) { this.reply.setCookie(COOKIE, this.row.id, cookieOpts); this.cookieSet = true; }
    return this.row;
  }
}

function createSession(tenant, userId, data = {}) {
  const row = { id: rid(), user_id: userId ?? null, data: JSON.stringify(data), csrf: rid(), created_at: tenant.nowSql() };
  tenant.sql('INSERT INTO kit_sessions (id, user_id, data, csrf, created_at) VALUES (@id, @user_id, @data, @csrf, @created_at)').run(row);
  return row;
}

// Called inside tenant.run() before the handler.
async function loadSession(site, req, reply) {
  const t = req.tenant;
  const sid = req.cookies && req.cookies[COOKIE];
  const row = sid ? t.st.sess.get(sid) : null;
  const s = new Session(t, row || null);
  s.reply = reply;
  req.session = s;
  req.user = null;
  if (row && row.user_id != null && site.cfg.auth) {
    req.user = (await site.cfg.auth.getUser(t.db, row.user_id)) || null;
  }
}

function roleOf(site, user) {
  if (!user) return null;
  return site.cfg.auth && site.cfg.auth.roleOf ? site.cfg.auth.roleOf(user) : user.role;
}

// Decorates req with session helpers (bound per request).
function decorate(site, req, reply) {
  req.csrfToken = () => req.session.ensure().csrf;
  req.flash = (type, msg) => {
    if (msg === undefined) [type, msg] = ['info', type];
    const f = req.session.get('_flash') || [];
    f.push({ type, msg });
    req.session.set('_flash', f.slice(-10)); // unread flashes don't pile up (e.g. scripted POSTs)
  };
  req.takeFlashes = () => {
    const f = req.session.get('_flash');
    if (!f) return [];
    req.session.set('_flash', undefined);
    return f;
  };
  req.hasRole = (...roles) => {
    const r = roleOf(site, req.user);
    return r != null && roles.flat().includes(r);
  };
  req.login = async (user) => {
    const t = req.tenant;
    const keep = req.session.data;
    delete keep._flash;
    if (req.session.row) t.sql('DELETE FROM kit_sessions WHERE id = ?').run(req.session.row.id);
    const id = site.cfg.auth && site.cfg.auth.idOf ? site.cfg.auth.idOf(user) : user.id;
    const row = createSession(t, id, keep);
    req.session = new Session(t, row);
    req.session.reply = reply;
    req.session.ensure();
    req.user = user;
  };
  req.logout = () => {
    if (req.session.row) req.tenant.sql('DELETE FROM kit_sessions WHERE id = ?').run(req.session.row.id);
    reply.clearCookie(COOKIE, { path: '/' });
    req.session = new Session(req.tenant, null);
    req.session.reply = reply;
    req.user = null;
  };
  // Verify a login/password against the site's users; returns the user or null.
  req.authenticate = (login, password) => authenticate(site, req.tenant.db, login, password);
}

async function authenticate(site, db, login, password) {
  const a = site.cfg.auth;
  if (!a || !login) return null;
  const user = await a.findUser(db, String(login).trim());
  if (!user) return null;
  const { verifyPassword } = require('./auth');
  const ok = a.verify ? await a.verify(password, user) : await verifyPassword(password, user.password_hash);
  return ok ? user : null;
}

function checkCsrf(req) {
  const sent = (req.body && req.body._csrf) || req.headers['x-csrf-token'];
  const want = req.session.row && req.session.row.csrf;
  if (!want || !sent || sent !== want) throw httpError(403, 'Invalid or missing CSRF token. Reload the page and try again.');
}

module.exports = { COOKIE, cookieOpts, Session, createSession, loadSession, decorate, checkCsrf, roleOf, authenticate };
