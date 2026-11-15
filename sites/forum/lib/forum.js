'use strict';
// Forum helpers shared by the routes: markdown, slugs, time formatting, loaders,
// permissions, submission listings, notifications.
const kit = require('../../../kit');

// ---------------------------------------------------------------- text
// Escape HTML but keep valid character entities (Postmill renders bodies with
// CommonMark, which decodes entities: the Reddit-imported `&gt;` shows as ">").
const escKeepEntities = (s) => String(s ?? '')
  .replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeHref = (u) => {
  const x = String(u).trim().replace(/&amp;/g, '&');
  if (/^(https?:|mailto:)/i.test(x) || (/^\//.test(x) && !/^\/\//.test(x)) || /^#/.test(x)) return x.replace(/"/g, '%22');
  return null;
};

function inline(s) {
  // s: raw text of one block. Code spans and links become placeholders so later
  // passes (autolinks, emphasis) don't touch them.
  const ph = [];
  const hold = (html) => `\u0001${ph.push(html) - 1}\u0001`;
  let t = escKeepEntities(s);
  t = t.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => hold(`<code>${code.trim()}</code>`));
  t = t.replace(/!?\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\s*\)/g, (m, text, url) => {
    const h = safeHref(url);
    return h ? hold(`<a href="${h}" rel="nofollow ugc">${emph(text) || h}</a>`) : m;
  });
  t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,:;"')\]!?])/g, (m, pre, url) => pre + hold(`<a href="${url}" rel="nofollow ugc">${url}</a>`));
  t = t.replace(/(^|[\s(])\/?([uf])\/([A-Za-z0-9_-]{2,40})\b/g, (m, pre, k, name) => pre + hold(`<a href="/${k === 'u' ? 'user' : 'f'}/${name}">/${k}/${name}</a>`));
  t = emph(t);
  t = t.replace(/ {2,}\n/g, '<br>\n').replace(/\\\n/g, '<br>\n');
  return t.replace(/\u0001(\d+)\u0001/g, (_, i) => ph[+i]);
}
function emph(t) {
  return t
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

// Small, safe CommonMark subset: paragraphs, headings, quotes, lists, code, rules.
function markdown(src) {
  if (src == null || src === '') return '';
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join('\n'))}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (/^\s*$/.test(l)) { flush(); i++; continue; }
    if ((m = /^\s{0,3}(```|~~~)/.exec(l))) {
      flush();
      const fence = m[1]; const buf = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${kit.escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (!para.length && /^( {4}|\t)/.test(l)) {
      const buf = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (/^\s*$/.test(lines[i]) && i + 1 < lines.length && /^( {4}|\t)/.test(lines[i + 1])))) buf.push(lines[i++].replace(/^( {4}|\t)/, ''));
      out.push(`<pre><code>${kit.escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { flush(); const n = Math.min(m[1].length + 2, 6); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s{0,3}>/.test(l)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
      out.push(`<blockquote>${markdown(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if ((m = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+/.exec(l))) {
      flush();
      const ordered = /\d/.test(m[1]);
      const items = [];
      while (i < lines.length) {
        const mm = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i]);
        if (mm && /\d/.test(mm[1]) === ordered) { items.push([mm[2]]); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
        break;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x.join('\n'))}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    para.push(l);
    i++;
  }
  flush();
  return out.join('\n');
}

// Postmill Slugger::slugify: lower-case, split on non-word chars, '-'-joined, <= 60 chars (whole words).
function slugify(title, max = 60) {
  const words = String(title || '').toLowerCase().split(/[^\p{L}\p{N}_\p{M}]+/u).filter(Boolean);
  let slug = ''; let n = 0;
  for (const w of words) {
    const add = n > 0 ? `-${w}` : w;
    n += add.replace(/\p{M}/gu, '').length;
    if (n > max) break;
    slug += add;
  }
  return slug || '-';
}

// Plain-text excerpt of a markdown body (listing previews, notifications).
const excerpt = (s, n = 200) => {
  const t = String(s || '').replace(/[#>*_`~\[\]]+/g, '').replace(/\(https?:\/\/[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t;
};

// ---------------------------------------------------------------- time
const TZ_DEFAULT = 'America/New_York';
const fmtCache = new Map();
function dtf(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch { f = dtf(TZ_DEFAULT); }
    fmtCache.set(tz, f);
  }
  return f;
}
const toDate = (s) => new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
// "March 31, 2023 at 6:24 PM EDT" in the viewer's timezone
const absTime = (s, tz) => (s ? dtf(tz || TZ_DEFAULT).format(toDate(s)).replace(/, (\d+:)/, ' at $1') : '');
function relTime(s, now) {
  if (!s) return '';
  const d = (now.getTime() - toDate(s).getTime()) / 1000;
  const a = Math.abs(d);
  const unit = a < 60 ? [Math.round(a), 'second'] : a < 3600 ? [Math.floor(a / 60), 'minute'] : a < 86400 ? [Math.floor(a / 3600), 'hour']
    : a < 86400 * 30 ? [Math.floor(a / 86400), 'day'] : a < 86400 * 365 ? [Math.floor(a / (86400 * 30)), 'month'] : [Math.floor(a / (86400 * 365)), 'year'];
  const txt = `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'}`;
  return d >= 0 ? `${txt} ago` : `in ${txt}`;
}

// ---------------------------------------------------------------- loaders
function forumByName(name, { required = true } = {}) {
  const f = kit.sql('SELECT * FROM forums WHERE normalized_name = lower(?)').get(String(name));
  if (!f && required) throw kit.httpError(404, `The forum "${name}" does not exist.`);
  return f;
}
function userByName(name, { required = true } = {}) {
  const u = kit.sql('SELECT * FROM users WHERE normalized_username = lower(?)').get(String(name));
  if (!u && required) throw kit.httpError(404, `The user "${name}" does not exist.`);
  return u;
}
const SUB_COLS = `s.id, s.forum_id, s.user_id, s.title, s.slug, s.url, s.body, s.media_type, s.image_id, s.created_at, s.edited_at,
  s.last_active_at, s.sticky, s.locked, s.moderated, s.visibility, s.net_score, s.comment_count, s.ranking,
  u.username, f.name AS forum_name, i.file_name AS image_file, i.path AS image_path, i.thumb_path AS image_thumb, i.media_width AS image_w, i.media_height AS image_h`;
const SUB_JOINS = 'JOIN users u ON u.id = s.user_id JOIN forums f ON f.id = s.forum_id LEFT JOIN images i ON i.id = s.image_id';
function submissionById(id, forum) {
  const s = kit.sql(`SELECT ${SUB_COLS} FROM submissions s ${SUB_JOINS} WHERE s.id = ?`).get(+id || 0);
  if (!s || (forum && s.forum_id !== forum.id)) throw kit.httpError(404, 'That submission does not exist.');
  return s;
}
const subUrl = (s) => `/f/${s.forum_name}/${s.id}/${s.slug}`;
const commentUrl = (s, cid) => `/f/${s.forum_name}/${s.id}/${s.slug}/comment/${cid}`;
const mediaUrl = (p) => (!p ? null : p.startsWith('/') ? p : `/media/${p}`);
const imageHref = (file) => (file ? `/submission_images/${file}` : null);

// ---------------------------------------------------------------- permissions
const isAdmin = (user) => !!user && user.role === 'admin';
function isModerator(user, forumId) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  return !!kit.sql('SELECT 1 FROM moderators WHERE forum_id = ? AND user_id = ?').get(forumId, user.id);
}
// Current forum ban (latest ban/unban event, not expired), or null.
function activeBan(forumId, userId) {
  const b = kit.sql('SELECT * FROM forum_bans WHERE forum_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(forumId, userId);
  if (!b || !b.banned) return null;
  if (b.expires_at && b.expires_at <= kit.nowSql()) return null;
  return b;
}
function siteBan(userId) {
  const b = kit.sql('SELECT * FROM user_bans WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(userId);
  if (!b || !b.banned) return null;
  if (b.expires_at && b.expires_at <= kit.nowSql()) return null;
  return b;
}
function assertCanPost(user, forum) {
  if (siteBan(user.id)) throw kit.httpError(403, 'Your account is banned from posting on this site.');
  const b = activeBan(forum.id, user.id);
  if (b) throw kit.httpError(403, `You are banned from /f/${forum.name}${b.expires_at ? ` until ${b.expires_at}` : ''}. Reason: ${b.reason}`);
}

// ---------------------------------------------------------------- listings
// Postmill SubmissionPage::SORT_MAP; column per sort and the index prefix it uses.
const SORTS = {
  hot: { label: 'Hot', col: 's.ranking', dir: 'DESC' },
  new: { label: 'New', col: 's.id', dir: 'DESC', idOnly: true },
  active: { label: 'Active', col: 's.last_active_at', dir: 'DESC' },
  top: { label: 'Top', col: 's.net_score', dir: 'DESC', window: true },
  controversial: { label: 'Controversial', col: 's.net_score', dir: 'ASC', window: true },
  most_commented: { label: 'Most commented', col: 's.comment_count', dir: 'DESC', window: true },
};
const WINDOWS = { day: ['Past 24 hours', 1], week: ['Past week', 7], month: ['Past month', 30], year: ['Past year', 365], all: ['All time', 0] };
const SORT_NAMES = Object.keys(SORTS);
const orderBy = (sort) => {
  const s = SORTS[sort];
  return s.idOnly ? `s.id ${s.dir}` : `${s.col} ${s.dir}, s.id ${s.dir}`;
};
function windowStart(t) {
  const w = WINDOWS[t];
  if (!w || !w[1]) return null;
  return kit.sqlTime(kit.now().getTime() - w[1] * 86400 * 1000);
}

// listSubmissions({forumIds: null | [ids], sort, t, offset, limit, userId, excludeSticky})
// -> rows (limit + 1 fetched so the caller knows if there is a next page).
// Multi-forum lists (subscribed front page) union per-forum index scans, each
// limited to offset+limit rows, so cost doesn't depend on the forums' sizes.
function listSubmissions({ forumIds = null, sort = 'hot', t = 'all', offset = 0, limit = 25, excludeSticky = false }) {
  if (!SORTS[sort]) sort = 'hot';
  const since = SORTS[sort].window || sort === 'hot' || sort === 'new' || sort === 'active' ? windowStart(t) : null;
  const n = offset + limit + 1;
  const db = kit.db();
  const conds = ["s.visibility = 'visible'"];
  const params = [];
  if (excludeSticky) conds.push('s.sticky = 0');
  let ids;
  const ob = orderBy(sort);
  // A short time window: read the window's rows through the created_at index and sort
  // them (the sort indexes would scan everything before finding none).
  const narrow = (fid) => since && kit.countCapped(db, `FROM submissions s INDEXED BY ${fid == null ? 'submissions_created' : 'submissions_forum_created'} WHERE ${fid == null ? '' : 's.forum_id = ? AND '}s.created_at >= ?`, fid == null ? [since] : [fid, since], 3000) <= 3000;
  const one = (fid) => {
    const c = [...conds]; const p = [...params];
    if (fid != null) { c.push('s.forum_id = ?'); p.push(fid); }
    if (since) { c.push('s.created_at >= ?'); p.push(since); }
    const ix = since && narrow(fid) ? `INDEXED BY ${fid == null ? 'submissions_created' : 'submissions_forum_created'}` : '';
    return { sql: `SELECT s.id, ${SORTS[sort].col} AS k FROM submissions s ${ix} WHERE ${c.join(' AND ')} ORDER BY ${ob} LIMIT ${n}`, p };
  };
  if (forumIds == null) {
    const q = one(null);
    ids = kit.sql(q.sql.replace(`LIMIT ${n}`, `LIMIT ${limit + 1} OFFSET ${offset}`)).all(...q.p).map((r) => r.id);
  } else {
    if (!forumIds.length) return [];
    const parts = forumIds.map(one);
    const sql = `SELECT id FROM (${parts.map((x) => `SELECT * FROM (${x.sql})`).join(' UNION ALL ')}) s ORDER BY ${ob.replace(/s\.(ranking|last_active_at|net_score|comment_count)/, 'k')} LIMIT ${limit + 1} OFFSET ${offset}`;
    ids = kit.sql(sql).all(...parts.flatMap((x) => x.p)).map((r) => r.id);
  }
  return hydrate(ids);
}
function hydrate(ids) {
  if (!ids.length) return [];
  const rows = kit.sql(`SELECT ${SUB_COLS} FROM submissions s ${SUB_JOINS} WHERE s.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter(Boolean);
}
// Comments with their submission/forum context (user pages, search, recent), in `ids` order.
function hydrateComments(ids) {
  if (!ids.length) return [];
  const rows = kit.sql(`SELECT c.id, c.body, c.created_at, c.edited_at, c.net_score, c.submission_id, c.parent_id, c.user_id, c.visibility,
      u.username, s.title, s.slug, s.visibility AS submission_visibility, f.name AS forum_name
    FROM comments c JOIN submissions s ON s.id = c.submission_id JOIN users u ON u.id = c.user_id JOIN forums f ON f.id = s.forum_id
    WHERE c.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter(Boolean);
}
function stickies(forumId) {
  const ids = kit.sql("SELECT id FROM submissions s WHERE forum_id = ? AND sticky = 1 AND visibility = 'visible' ORDER BY id DESC LIMIT 10").pluck().all(forumId);
  return hydrate(ids);
}

// Vote state of the current user for listed items: Map id -> 1 | -1.
function myVotes(user, kind, ids) {
  const m = new Map();
  if (!user || !ids.length) return m;
  const [table, col] = kind === 'comment' ? ['comment_votes', 'comment_id'] : ['submission_votes', 'submission_id'];
  for (let k = 0; k < ids.length; k += 500) {
    const chunk = ids.slice(k, k + 500);
    for (const r of kit.sql(`SELECT ${col} AS id, upvote FROM ${table} WHERE user_id = ? AND ${col} IN (${chunk.map(() => '?').join(',')})`).all(user.id, ...chunk)) m.set(r.id, r.upvote ? 1 : -1);
  }
  return m;
}

// Simple page/next paging without a count (Postmill pages with "next" links too).
function pager(req, rows, perPage) {
  const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 10000));
  const hasNext = rows.length > perPage;
  if (hasNext) rows.length = perPage;
  return {
    page, perPage, offset: (page - 1) * perPage, hasNext,
    prev: page > 1 ? kit.urlWith(req, { page: page === 2 ? null : page - 1 }) : null,
    next: hasNext ? kit.urlWith(req, { page: page + 1 }) : null,
  };
}
const pageOf = (req, perPage) => { const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, 10000)); return { page, offset: (page - 1) * perPage, limit: perPage }; };

// Submission count of a forum (visible): covering index count minus the hidden rows.
function forumCounts(forumIds) {
  const all = new Map(); const hidden = new Map(); const subs = new Map();
  const one = forumIds && forumIds.length === 1;
  const w = forumIds ? `WHERE forum_id IN (${forumIds.map(() => '?').join(',')})` : '';
  const p = forumIds || [];
  for (const r of kit.sql(`SELECT forum_id, count(*) n FROM submissions ${w} GROUP BY forum_id`).all(...p)) all.set(r.forum_id, r.n);
  for (const r of kit.sql(`SELECT forum_id, count(*) n FROM submissions WHERE visibility <> 'visible' ${forumIds ? `AND forum_id IN (${p.map(() => '?').join(',')})` : ''} GROUP BY forum_id`).all(...p)) hidden.set(r.forum_id, r.n);
  for (const r of kit.sql(`SELECT forum_id, count(*) n FROM forum_subscriptions ${w} GROUP BY forum_id`).all(...p)) subs.set(r.forum_id, r.n);
  const get = (id) => ({ submissions: (all.get(id) || 0) - (hidden.get(id) || 0), subscribers: subs.get(id) || 0 });
  return one ? get(forumIds[0]) : get;
}

function subscribedIds(user) {
  if (!user) return [];
  return kit.sql('SELECT forum_id FROM forum_subscriptions WHERE user_id = ? ORDER BY forum_id').pluck().all(user.id);
}
const isSubscribed = (user, forumId) => !!user && !!kit.sql('SELECT 1 FROM forum_subscriptions WHERE user_id = ? AND forum_id = ?').get(user.id, forumId);

function forumSidebar(user, forum) {
  return {
    type: 'forum', forum, counts: forumCounts([forum.id]),
    mods: kit.sql('SELECT u.username FROM moderators m JOIN users u ON u.id = m.user_id WHERE m.forum_id = ? ORDER BY m.id').pluck().all(forum.id),
    tags: kit.sql('SELECT t.name FROM forums_tags ft JOIN forum_tags t ON t.id = ft.tag_id WHERE ft.forum_id = ? ORDER BY t.name').pluck().all(forum.id),
    subscribed: isSubscribed(user, forum.id),
    canModerate: isModerator(user, forum.id),
    ban: user ? activeBan(forum.id, user.id) : null,
  };
}

// ---------------------------------------------------------------- notifications
function notify(userId, type, { submissionId = null, commentId = null, messageId = null } = {}) {
  kit.sql('INSERT INTO notifications (user_id, notification_type, submission_id, comment_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, type, submissionId, commentId, messageId, kit.nowSql());
}
// @name and /u/name mentions in a body -> notifications (once per user, not self).
function notifyMentions(body, author, type, ids, skip = new Set()) {
  const names = new Set();
  for (const m of String(body || '').matchAll(/(?:^|[^\w/])(?:@|\/u\/)([A-Za-z0-9_-]{3,40})/g)) names.add(m[1].toLowerCase());
  for (const n of names) {
    const u = kit.sql('SELECT id, notify_on_mentions FROM users WHERE normalized_username = ?').get(n);
    if (!u || u.id === author.id || skip.has(u.id) || !u.notify_on_mentions) continue;
    notify(u.id, type, ids);
    skip.add(u.id);
  }
}

function modLog(forumId, user, entry) {
  kit.sql(`INSERT INTO forum_log_entries (forum_id, user_id, author_id, submission_id, comment_id, ban_id, was_admin, action_type, title, locked, reason, created_at)
    VALUES (@forum_id, @user_id, @author_id, @submission_id, @comment_id, @ban_id, @was_admin, @action_type, @title, @locked, @reason, @created_at)`).run({
    forum_id: forumId, user_id: user.id, author_id: null, submission_id: null, comment_id: null, ban_id: null, title: null, locked: null, reason: null,
    was_admin: isAdmin(user) && !kit.sql('SELECT 1 FROM moderators WHERE forum_id = ? AND user_id = ?').get(forumId, user.id) ? 1 : 0,
    created_at: kit.nowSql(), ...entry,
  });
}

// redirect target from a form's `next` field or the Referer (same-site paths only)
function backTo(req, fallback = '/') {
  const n = (req.body && req.body.next) || '';
  if (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//')) return n;
  const r = req.headers.referer;
  if (r) { try { const u = new URL(r); if (u.host === req.headers.host) return u.pathname + u.search + u.hash; } catch {} }
  return fallback;
}

module.exports = {
  markdown, inline, slugify, excerpt, escKeepEntities, absTime, relTime, toDate, TZ_DEFAULT,
  forumByName, userByName, submissionById, SUB_COLS, SUB_JOINS, subUrl, commentUrl, mediaUrl, imageHref,
  isAdmin, isModerator, activeBan, siteBan, assertCanPost,
  SORTS, SORT_NAMES, WINDOWS, listSubmissions, hydrate, hydrateComments, stickies, myVotes, pager, pageOf, forumCounts, subscribedIds, isSubscribed, forumSidebar,
  notify, notifyMentions, modLog, backTo, windowStart,
};
