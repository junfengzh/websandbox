'use strict';
// Shared helpers of the code hosting site (gitlab.wa), used by repo/ and collab/ alike:
// users, namespaces, projects, access levels, markdown, time formatting, avatars, events.
// Everything runs on the current tenant connection (kit.sql), so call it inside handlers/jobs.
const kit = require('../../../kit');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const ACCESS = { NONE: 0, MINIMAL: 5, GUEST: 10, REPORTER: 20, DEVELOPER: 30, MAINTAINER: 40, OWNER: 50 };
const ACCESS_NAMES = { 0: 'No access', 5: 'Minimal Access', 10: 'Guest', 20: 'Reporter', 30: 'Developer', 40: 'Maintainer', 50: 'Owner' };

// ---------------------------------------------------------------- users / namespaces
const userById = (id) => (id == null ? null : kit.sql('SELECT * FROM users WHERE id = ?').get(id));
const userByUsername = (u) => kit.sql('SELECT * FROM users WHERE username = ?').get(String(u || ''));
const namespaceByPath = (p) => kit.sql('SELECT * FROM namespaces WHERE full_path = ?').get(String(p || ''));
const userNamespace = (userId) => kit.sql("SELECT * FROM namespaces WHERE kind = 'user' AND owner_id = ?").get(userId);

// Project row + namespace columns. ns_kind 'user' | 'group'; ns_owner_id for personal projects.
const PROJECT_SELECT = `SELECT p.*, n.kind AS ns_kind, n.name AS ns_name, n.full_path AS ns_path, n.owner_id AS ns_owner_id, n.parent_id AS ns_parent_id
  FROM projects p JOIN namespaces n ON n.id = p.namespace_id`;
const projectByPath = (fullPath) => kit.sql(`${PROJECT_SELECT} WHERE p.full_path = ?`).get(String(fullPath || ''));
const projectById = (id) => kit.sql(`${PROJECT_SELECT} WHERE p.id = ?`).get(id);

// Group ancestors of a namespace (itself first), for inherited membership.
function namespaceChain(nsId) {
  const out = [];
  let id = nsId;
  for (let i = 0; id != null && i < 20; i++) {
    const n = kit.sql('SELECT id, parent_id, kind FROM namespaces WHERE id = ?').get(id);
    if (!n) break;
    out.push(n);
    id = n.parent_id;
  }
  return out;
}

// Effective access level of `user` on `project` (GitLab rules: personal-namespace owner = Owner;
// project members; members of the group and its ancestors; admins act as Owner).
function accessLevel(user, project) {
  if (!user || !project) return 0;
  if (project.ns_kind === 'user' && project.ns_owner_id === user.id) return ACCESS.OWNER;
  let best = 0;
  const now = kit.nowSql().slice(0, 10);
  const m = kit.sql(`SELECT max(access_level) FROM members WHERE source_type = 'project' AND source_id = ? AND user_id = ?
    AND requested_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`).pluck().get(project.id, user.id, now);
  if (m) best = m;
  if (project.ns_kind === 'group') {
    for (const n of namespaceChain(project.namespace_id)) {
      const g = kit.sql(`SELECT max(access_level) FROM members WHERE source_type = 'namespace' AND source_id = ? AND user_id = ?
        AND requested_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`).pluck().get(n.id, user.id, now);
      if (g && g > best) best = g;
    }
  }
  if (user.is_admin && best < ACCESS.OWNER) best = ACCESS.OWNER;
  return best;
}

// Group access (for group pages): direct or inherited from ancestors.
function groupAccessLevel(user, ns) {
  if (!user || !ns) return 0;
  let best = 0;
  for (const n of namespaceChain(ns.id)) {
    const g = kit.sql(`SELECT max(access_level) FROM members WHERE source_type = 'namespace' AND source_id = ? AND user_id = ? AND requested_at IS NULL`).pluck().get(n.id, user.id);
    if (g && g > best) best = g;
  }
  if (user.is_admin && best < ACCESS.OWNER) best = ACCESS.OWNER;
  return best;
}

function canRead(user, project, access = accessLevel(user, project)) {
  if (!project) return false;
  if (project.visibility === 'public') return true;
  if (project.visibility === 'internal') return !!user;
  return access >= ACCESS.GUEST;
}

// SQL fragment: projects (alias p) the user may see. Use with visibleParams(user).
const visibleWhere = (alias = 'p') => `(${alias}.visibility = 'public' OR (? IS NOT NULL AND (${alias}.visibility = 'internal' OR ? = 1
  OR ${alias}.namespace_id IN (SELECT id FROM namespaces WHERE kind = 'user' AND owner_id = ?)
  OR ${alias}.id IN (SELECT source_id FROM members WHERE source_type = 'project' AND user_id = ?)
  OR ${alias}.namespace_id IN (SELECT source_id FROM members WHERE source_type = 'namespace' AND user_id = ?))))`;
const visibleParams = (user) => { const id = user ? user.id : null; return [id, user && user.is_admin ? 1 : 0, id, id, id]; };

// Load a project for a route (/:ns/:proj): 404 when missing or not visible (as GitLab),
// 403 when `min` access is required and missing. Returns the row + .access, .url.
function loadProject(req, ns, proj, { min = 0 } = {}) {
  const p = projectByPath(`${ns}/${proj}`);
  if (!p) throw kit.httpError(404, 'Project not found');
  const access = accessLevel(req.user, p);
  if (!canRead(req.user, p, access)) throw kit.httpError(404, 'Project not found');
  if (min && access < min) {
    if (!req.user) throw kit.httpError(401, 'Please sign in.');
    throw kit.httpError(403, 'You are not allowed to perform this action.');
  }
  p.access = access;
  p.url = '/' + p.full_path;
  return p;
}

const projectUrl = (p, suffix = '') => '/' + (p.full_path || p) + suffix;
// Encode a repository path for a URL, keeping the slashes.
const encPath = (s) => String(s || '').split('/').map(encodeURIComponent).join('/');

// ---------------------------------------------------------------- events / activity
// Insert an activity-feed row (events table). fields: project_id, author_id, action, target_type,
// target_id, target_title, push_* ...
function addEvent(fields) {
  const cols = Object.keys(fields);
  kit.db().prepare(`INSERT INTO events (${cols.join(', ')}, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?)`).run(...cols.map((c) => fields[c]), kit.nowSql());
}
// Activity feed rows with author / project / target iid joined in, for include('_event', {e}).
// where: SQL on events alias e (e.g. 'e.project_id = ?'); visibility filtered for `user`.
function loadEvents(where, params, { user = null, limit = 20, offset = 0 } = {}) {
  return kit.db().prepare(`SELECT e.*, u.username AS author_username, u.name AS author_name, u.avatar AS author_avatar,
      p.full_path AS project_path, p.name AS project_name, n.name AS ns_name,
      CASE e.target_type WHEN 'issue' THEN (SELECT iid FROM issues WHERE id = e.target_id)
        WHEN 'merge_request' THEN (SELECT iid FROM merge_requests WHERE id = e.target_id)
        WHEN 'milestone' THEN (SELECT iid FROM milestones WHERE id = e.target_id) END AS target_iid,
      CASE WHEN e.target_type = 'note' THEN (SELECT noteable_type || ':' || coalesce(
        CASE noteable_type WHEN 'issue' THEN (SELECT iid FROM issues WHERE id = noteable_id) WHEN 'merge_request' THEN (SELECT iid FROM merge_requests WHERE id = noteable_id) END, commit_sha, '')
        || ':' || substr(body, 1, 200) FROM notes WHERE id = e.target_id) END AS note_info
    FROM events e LEFT JOIN users u ON u.id = e.author_id LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN namespaces n ON n.id = p.namespace_id
    WHERE (${where}) AND (p.id IS NULL OR ${visibleWhere('p')})
    ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`).all(...params, ...visibleParams(user), limit, offset);
}
function touchProject(projectId) {
  kit.sql('UPDATE projects SET last_activity_at = ?, updated_at = ? WHERE id = ?').run(kit.nowSql(), kit.nowSql(), projectId);
}

// ---------------------------------------------------------------- time
const toDate = (s) => (s instanceof Date ? s : s ? new Date(String(s).replace(' ', 'T') + (/[zZ+]|-\d\d:?\d\d$/.test(String(s).slice(10)) ? '' : 'Z')) : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function absTime(s) {
  const d = toDate(s);
  if (!d || isNaN(d)) return '';
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'} UTC`;
}
function absDate(s) {
  const d = toDate(s);
  if (!d || isNaN(d)) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function relTime(s, now) {
  const d = toDate(s);
  if (!d || isNaN(d)) return '';
  const sec = Math.round(((now || kit.now()) - d) / 1000);
  const fut = sec < 0;
  const a = Math.abs(sec);
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let t;
  if (a < 60) t = 'just now';
  else if (a < 3600) t = unit(Math.floor(a / 60), 'minute');
  else if (a < 86400) t = unit(Math.floor(a / 3600), 'hour');
  else if (a < 86400 * 7) t = unit(Math.floor(a / 86400), 'day');
  else if (a < 86400 * 30) t = unit(Math.floor(a / 86400 / 7), 'week');
  else if (a < 86400 * 365) t = unit(Math.floor(a / 86400 / 30), 'month');
  else t = unit(Math.floor(a / 86400 / 365), 'year');
  if (t === 'just now') return t;
  return fut ? `in ${t}` : `${t} ago`;
}
// <time> element with relative text and absolute title.
const timeTag = (s, now) => (s ? `<time datetime="${kit.escapeHtml(String(s).replace(' ', 'T'))}Z" title="${kit.escapeHtml(absTime(s))}">${kit.escapeHtml(relTime(s, now))}</time>` : '');

// ---------------------------------------------------------------- avatars / links
const AVATAR_COLORS = ['#e7e4f2', '#e0f1f9', '#e1f4ed', '#fdf2d7', '#fbe5e1', '#f0e7d8', '#eef0f2'];
const AVATAR_INK = ['#4b3b8f', '#0b5c87', '#14634a', '#7a5600', '#9b2a16', '#6b4a12', '#3d434a'];
function avatarUrl(a) {
  if (!a) return null;
  if (/^(https?:)?\//.test(a)) return a;
  return '/media/' + String(a).replace(/^media\//, '');
}
function avatar(u, size = 32, cls = '') {
  if (!u) return '';
  const label = u.name || u.username || u.path || '?';
  const url = avatarUrl(u.avatar);
  if (url) return `<img class="avatar s${size} ${cls}" src="${kit.escapeHtml(url)}" width="${size}" height="${size}" alt="" loading="lazy">`;
  const i = Number(u.id || 0) % AVATAR_COLORS.length;
  const ch = (String(label).trim()[0] || '?').toUpperCase();
  return `<span class="avatar avatar-letter s${size} ${cls}" style="background:${AVATAR_COLORS[i]};color:${AVATAR_INK[i]}" aria-hidden="true">${kit.escapeHtml(ch)}</span>`;
}
const userLink = (u, { withAvatar = false, size = 24 } = {}) => (u ? `<a class="user-link" href="/${kit.escapeHtml(u.username)}" data-username="${kit.escapeHtml(u.username)}">${withAvatar ? avatar(u, size) + ' ' : ''}${kit.escapeHtml(u.name)}</a>` : '<span class="user-link">Ghost User</span>');

// ---------------------------------------------------------------- markdown (GitLab-flavoured, sanitised)
const SANITIZE = {
  allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'a', 'img', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'mark', 'kbd', 'small',
    'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'details', 'summary', 'div', 'span', 'input', 'picture', 'source', 'abbr', 'cite', 'q', 'samp', 'var', 'figure', 'figcaption', 'center'],
  allowedAttributes: {
    a: ['href', 'title', 'name', 'id', 'class', 'data-username', 'data-reference'], img: ['src', 'alt', 'title', 'width', 'height', 'align'],
    source: ['srcset', 'media', 'type'], input: ['type', 'checked', 'disabled'],
    '*': ['align', 'class', 'id', 'colspan', 'rowspan', 'start', 'lang', 'dir', 'aria-hidden'],
  },
  allowedClasses: { '*': [/^hljs/, /^language-/, 'task-list-item', 'task-list', 'gfm', /^gfm-/, 'user-link', 'anchor', 'contains-task-list'] },
  allowedSchemes: ['http', 'https', 'mailto', 'ftp'],
  allowedSchemesAppliedToAttributes: ['href', 'src', 'srcset'],
  allowProtocolRelative: true,
  exclusiveFilter: (f) => f.tag === 'input' && f.attribs.type !== 'checkbox',
  transformTags: {
    a: (tag, attribs) => (/^https?:\/\//.test(attribs.href || '') ? { tagName: 'a', attribs: { ...attribs, rel: 'nofollow noreferrer noopener', target: '_blank' } } : { tagName: 'a', attribs }),
    input: (tag, attribs) => ({ tagName: 'input', attribs: { ...attribs, disabled: '' } }),
  },
};
const slugify = (s) => String(s).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');

// md(text, ctx): ctx.project (project row; enables #123 / !12 references and repo-relative
// links), ctx.ref + ctx.dir (README: relative links -> /-/blob/<ref>/<dir>/x, images -> /-/raw/...).
function md(text, ctx = {}) {
  if (!text) return '';
  const src = String(text);
  if (src.length > 400000) return `<pre>${kit.escapeHtml(src.slice(0, 400000))}</pre>`;
  const p = ctx.project;
  const rewrite = (href, raw) => {
    if (!href || !p || !ctx.ref) return href;
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href;
    let target = href;
    let base = '';
    if (href.startsWith('/')) target = href.slice(1);
    else base = ctx.dir ? ctx.dir.replace(/\/$/, '') + '/' : '';
    const parts = [];
    for (const seg of (base + target).split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    const [pathPart, hash] = parts.join('/').split('#');
    return `/${p.full_path}/-/${raw ? 'raw' : 'blob'}/${encPath(ctx.ref)}/${pathPart}${hash ? '#' + hash : ''}`;
  };
  const renderer = new marked.Renderer();
  const headingIds = new Map();
  renderer.heading = function ({ tokens, depth }) {
    const inner = this.parser.parseInline(tokens);
    let id = slugify(inner) || 'section';
    const n = headingIds.get(id) || 0;
    headingIds.set(id, n + 1);
    if (n) id += '-' + n;
    return `<h${depth} id="user-content-${id}"><a class="anchor" href="#user-content-${id}" aria-hidden="true"></a>${inner}</h${depth}>\n`;
  };
  const textRefs = (html) => html
    .replace(/(^|[\s(])@([A-Za-z0-9_][A-Za-z0-9_.-]*[A-Za-z0-9_])/g, (m, pre, u) => `${pre}<a class="gfm gfm-project_member user-link" href="/${u}" data-username="${u}">@${u}</a>`)
    .replace(/(^|[\s(])([#!])(\d{1,7})\b/g, (m, pre, sig, n) => (p ? `${pre}<a class="gfm gfm-${sig === '#' ? 'issue' : 'merge_request'}" href="/${p.full_path}/-/${sig === '#' ? 'issues' : 'merge_requests'}/${n}" data-reference="${sig}${n}">${sig}${n}</a>` : m));
  renderer.text = function (tok) {
    const out = tok.tokens ? this.parser.parseInline(tok.tokens) : kit.escapeHtml(tok.text);
    return ctx.refs === false ? out : textRefs(out);
  };
  let html;
  try {
    html = marked.parse(src, {
      gfm: true, breaks: !!ctx.breaks, async: false, renderer,
      walkTokens: (t) => {
        if (t.type === 'link') t.href = rewrite(t.href, false);
        else if (t.type === 'image') t.href = rewrite(t.href, true);
      },
    });
  } catch (e) {
    return `<pre>${kit.escapeHtml(src)}</pre>`;
  }
  if (p && ctx.ref) {
    // raw HTML <img src="relative"> in READMEs
    html = html.replace(/(<img\b[^>]*?\ssrc=")([^"]+)(")/gi, (m, a, s, b) => a + rewrite(s, true) + b);
  }
  return sanitizeHtml(html, SANITIZE);
}

// ---------------------------------------------------------------- misc
const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many || one + 's'}`;
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
function fmtBytes(n) {
  n = Number(n || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1).replace(/\.0+$/, '')} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(2).replace(/\.?0+$/, '')} MiB`;
  return `${(n / 1024 ** 3).toFixed(2).replace(/\.?0+$/, '')} GiB`;
}
const setting = (key) => kit.sql('SELECT value FROM site_settings WHERE key = ?').pluck().get(key);

module.exports = {
  ACCESS, ACCESS_NAMES,
  userById, userByUsername, namespaceByPath, userNamespace, namespaceChain,
  PROJECT_SELECT, projectByPath, projectById, accessLevel, groupAccessLevel, canRead, visibleWhere, visibleParams, loadProject, projectUrl, encPath,
  addEvent, touchProject, loadEvents,
  toDate, absTime, absDate, relTime, timeTag,
  avatar, avatarUrl, userLink,
  md, slugify, plural, fmtNum, fmtBytes, setting,
};
