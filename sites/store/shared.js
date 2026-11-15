'use strict';
// Shared store helpers (storefront + back office): users and sessions, money and
// store-timezone date formatting, prices. Imported by server.js, storefront/ and admin/.
const kit = require('../../kit');

const ADMIN_COOKIE = 'wsb_admin_sid';
const TZ = 'America/New_York'; // store_config general/locale/timezone

// ---------------------------------------------------------------- users / sessions
// kit_sessions.user_id: customers by id (> 0), admin users by -id.
const sessionUserId = (u) => (u.kind === 'admin' ? -u.id : u.id);
const asCustomer = (u) => (u ? Object.assign(u, { kind: 'customer', role: 'customer', name: [u.firstname, u.lastname].filter(Boolean).join(' ') }) : null);
const asAdmin = (u) => (u ? Object.assign(u, { kind: 'admin', role: 'admin', name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.username }) : null);
const customerById = (db, id) => asCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
const adminById = (db, id) => asAdmin(db.prepare('SELECT * FROM admin_users WHERE id = ? AND is_active = 1').get(id));
const customerByEmail = (db, email) => asCustomer(db.prepare('SELECT * FROM customers WHERE email = ? COLLATE NOCASE').get(email));
const adminByName = (db, name) => asAdmin(db.prepare('SELECT * FROM admin_users WHERE username = ? COLLATE NOCASE AND is_active = 1').get(name));

// kind: 'customer' | 'admin' | null (either; customers by e-mail, admins by username)
function findUser(db, login, kind) {
  let s = String(login || '').trim();
  const m = /^(admin|customer):(.*)$/.exec(s);
  if (m) { kind = m[1]; s = m[2]; }
  if (kind === 'customer') return customerByEmail(db, s);
  if (kind === 'admin') return adminByName(db, s);
  return s.includes('@') ? customerByEmail(db, s) || adminByName(db, s) : adminByName(db, s) || customerByEmail(db, s);
}
function getUserBySessionId(db, id) {
  if (id == null) return null;
  const n = Number(id);
  return n < 0 ? adminById(db, -n) : customerById(db, n);
}
function isAdminSession(tenant, sid) {
  try {
    const r = tenant.db.prepare('SELECT user_id FROM kit_sessions WHERE id = ?').get(String(sid));
    return !!(r && r.user_id != null && Number(r.user_id) < 0);
  } catch { return false; }
}
// Rename the session cookie in an outgoing response (admin area -> wsb_admin_sid).
function renameSessionCookie(reply, from, to) {
  let h = reply.getHeader('set-cookie');
  if (!h) return;
  const re = new RegExp(`^${from}=`);
  h = [].concat(h).map((c) => String(c).replace(re, `${to}=`));
  reply.header('set-cookie', h);
}

// ---------------------------------------------------------------- formatting
const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v) => (v == null || v === '' ? '' : (Number(v) < 0 ? '-$' : '$') + nf.format(Math.abs(Number(v))));
const toDate = (s) => (s ? new Date(kit.parseTime(s)) : null);
const fmtCache = new Map();
const dtf = (o) => {
  const k = JSON.stringify(o);
  if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o }));
  return fmtCache.get(k);
};
// Store-time formats as Magento shows them.
const date = {
  short: (s) => (s ? dtf({ month: 'numeric', day: 'numeric', year: '2-digit' }).format(toDate(s)) : ''),      // 3/2/22
  medium: (s) => (s ? dtf({ month: 'short', day: 'numeric', year: 'numeric' }).format(toDate(s)) : ''),       // Mar 2, 2022
  long: (s) => (s ? dtf({ month: 'long', day: 'numeric', year: 'numeric' }).format(toDate(s)) : ''),          // March 2, 2022
  datetime: (s) => (s ? dtf({ month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(toDate(s)) : ''), // Mar 2, 2022, 6:01:12 AM
  iso: (s) => (s ? String(s).replace(' ', 'T') + 'Z' : ''),
};
// Magento names keep HTML entities (Quest Lumaflex&trade; Band): render as HTML, but escape
// anything that is not an entity.
const htmlName = (s) => String(s ?? '').replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', trade: '™', reg: '®', copy: '©', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', deg: '°', eacute: 'é', frac12: '½' };
const plainName = (s) => String(s ?? '').replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m));

// ---------------------------------------------------------------- prices
// Special price applies when set, lower than price, and today within [from, to] (store dates).
function finalPrice(p, today) {
  if (!p) return null;
  let price = p.price;
  if (p.special_price != null && (price == null || p.special_price < price)) {
    const from = p.special_from ? String(p.special_from).slice(0, 10) : null;
    const to = p.special_to ? String(p.special_to).slice(0, 10) : null;
    if ((!from || from <= today) && (!to || to >= today)) price = p.special_price;
  }
  return price;
}
// SQL expression for the effective (sortable) price of product alias `a` (today() = site clock).
const priceSql = (a = 'p') => `(CASE WHEN ${a}.special_price IS NOT NULL AND (${a}.price IS NULL OR ${a}.special_price < ${a}.price)
  AND (${a}.special_from IS NULL OR substr(${a}.special_from, 1, 10) <= today()) AND (${a}.special_to IS NULL OR substr(${a}.special_to, 1, 10) >= today())
  THEN ${a}.special_price ELSE ${a}.price END)`;
const orderStatusLabel = (db, status) => {
  const r = db.prepare('SELECT label FROM order_statuses WHERE status = ?').pluck().get(status);
  return r || (status ? status[0].toUpperCase() + status.slice(1) : '');
};

// per tenant, before its first BEGIN: listing index + change-tracking temp triggers
function onOpen(db, tenant) { require('./storefront/lib/pindex').attach(db, tenant); }

module.exports = {
  ADMIN_COOKIE, TZ,
  sessionUserId, findUser, getUserBySessionId, isAdminSession, renameSessionCookie,
  customerById, adminById, asCustomer, asAdmin,
  money, date, htmlName, plainName, finalPrice, priceSql, orderStatusLabel,
  locals: (req) => require('./storefront/lib/locals')(req),
  onOpen,
};
