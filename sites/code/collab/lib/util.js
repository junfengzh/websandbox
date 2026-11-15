'use strict';
// Small helpers shared by the collaboration routes (issues, MRs, labels, milestones, members,
// groups, new project, settings, wiki).
const ACCESS = { 5: 'Minimal Access', 10: 'Guest', 20: 'Reporter', 30: 'Developer', 40: 'Maintainer', 50: 'Owner' };
const ROLE_BY_NAME = { minimal: 5, 'minimal access': 5, guest: 10, reporter: 20, developer: 30, maintainer: 40, owner: 50 };

const str = (x) => (x == null ? '' : Array.isArray(x) ? String(x[x.length - 1] ?? '') : String(x)).trim();
const arr = (x) => (x == null || x === '' ? [] : Array.isArray(x) ? x.map(String).filter((s) => s !== '') : [String(x)]);
const int = (x, d = null) => { const n = parseInt(str(x), 10); return Number.isFinite(n) ? n : d; };
const bool = (x) => { const s = str(x).toLowerCase(); return s === '1' || s === 'true' || s === 'on' || s === 'yes'; };

// GitLab-style query params: label_name[]=a&label_name[]=b (also label_name=a,b)
function qlist(q, name) {
  const v = q[`${name}[]`] ?? q[name];
  return arr(v).flatMap((s) => (q[`${name}[]`] != null ? [s] : s.split(','))).map((s) => s.trim()).filter(Boolean);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const toDate = (s) => (s instanceof Date ? s : s ? new Date(String(s).replace(' ', 'T') + (String(s).length <= 10 ? 'T00:00:00Z' : 'Z')) : null);
// "Jan 16, 2023"
function dateFmt(s) {
  const d = toDate(s); if (!d || isNaN(d)) return '';
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
const dateLong = (s) => { const d = toDate(s); return d && !isNaN(d) ? `${MONTHS_LONG[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}` : ''; };
// "Jan 16, 2023 2:05pm UTC"
function dateTime(s) {
  const d = toDate(s); if (!d || isNaN(d)) return '';
  let h = d.getUTCHours(); const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12;
  return `${dateFmt(d)} ${h}:${String(d.getUTCMinutes()).padStart(2, '0')}${ap} UTC`;
}
// "3 days ago" relative to the site clock
function ago(s, now) {
  const d = toDate(s); if (!d || isNaN(d)) return '';
  const n = now instanceof Date ? now : toDate(now);
  let sec = Math.round((n - d) / 1000);
  const fut = sec < 0; sec = Math.abs(sec);
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, k] of units) {
    if (sec >= k) { const v = Math.floor(sec / k); const t = `${v} ${u}${v === 1 ? '' : 's'}`; return fut ? `in ${t}` : `${t} ago`; }
  }
  return fut ? 'in a few seconds' : 'just now';
}
const isoDate = (s) => (s ? String(s).slice(0, 10) : '');
// accepts YYYY-MM-DD, M/D/YYYY, MM/DD/YYYY -> 'YYYY-MM-DD' | null | undefined(invalid)
function parseDate(s) {
  s = str(s); if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) [y, mo, d] = [+m[3], +m[1], +m[2]];
  else return undefined;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// GitLab-like path slug from a name: "My Project" -> "my-project"
function slugify(name) {
  return str(name).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').replace(/-{2,}/g, '-').slice(0, 255);
}
const PATH_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const RESERVED = new Set(['-', 'admin', 'api', 'assets', 'dashboard', 'explore', 'groups', 'help', 'login', 'logout', 'projects', 'public', 'search', 'snippets', 'users', 'uploads', 'static', 'media', 'new', 'profile', '_kit', '__rl', 'u']);
function validPath(p) {
  if (!p) return 'Path can\'t be blank.';
  if (!PATH_RE.test(p) || /\.(git|atom)$/.test(p) || p.endsWith('.')) return 'Path can contain only letters, digits, \'_\', \'-\' and \'.\'. Cannot start with \'-\', end in \'.git\' or end in \'.atom\'.';
  if (RESERVED.has(p.toLowerCase())) return 'Path is reserved.';
  return null;
}

// label text colour for a background like GitLab (#fff on dark, #333 on light)
function labelText(bg) {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg || ''); if (!m) return '#fff';
  const n = parseInt(m[1], 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#1f1e24' : '#fff';
}
const LABEL_COLORS = ['#009966', '#8fbc8f', '#3cb371', '#00b140', '#013220', '#6699cc', '#0000ff', '#e6e6fa', '#9400d3', '#330066', '#808080', '#36454f', '#f7e7ce', '#c21e56', '#cc338b', '#dc143c', '#ff0000', '#cd5b45', '#eee600', '#ed9121', '#c39953'];

function initials(name) { const s = str(name); return (s[0] || '?').toUpperCase(); }
function avatarColor(id) { const c = ['#e1dbf1', '#d4e0f0', '#c3e6cd', '#f5d9a8', '#f6d5d5', '#d1e7e7', '#ebe1d1']; return c[(Number(id) || 0) % c.length]; }

function pct(a, b) { return b ? Math.round((a * 100) / b) : 0; }
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const num = (n) => Number(n || 0).toLocaleString('en-US');

// small inline SVG icons (headless browsers often lack emoji fonts)
const ICON_PATHS = {
  comment: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.4"/>',
  clock: '<circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.8V8l2.2 1.6" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  eyeoff: '<path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 13 13 3" stroke="currentColor" stroke-width="1.4"/>',
  check: '<path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  thumbsup: '<path d="M5 7.5V13H2.5V7.5zM5 7.5l2.5-5c1 0 1.8.8 1.6 1.8L8.7 6.5h3.6c.9 0 1.5.8 1.3 1.6l-1 4c-.2.6-.7.9-1.3.9H5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  thumbsdown: '<path d="M5 8.5V3H2.5v5.5zM5 8.5l2.5 5c1 0 1.8-.8 1.6-1.8L8.7 9.5h3.6c.9 0 1.5-.8 1.3-1.6l-1-4C12.4 3.3 11.9 3 11.3 3H5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  branch: '<circle cx="5" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="5.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 5.1v5.8M11 7.1c0 2.5-6 1.5-6 3.8" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  star: '<path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" fill="currentColor"/>',
  staroff: '<path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" fill="none" stroke="currentColor" stroke-width="1.2"/>',
};
const icon = (name, size = 14) => `<svg class="gl-icon" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICON_PATHS[name] || ''}</svg>`;

module.exports = {
  icon, ACCESS, ROLE_BY_NAME, str, arr, int, bool, qlist, dateFmt, dateLong, dateTime, ago, isoDate, parseDate, toDate,
  slugify, validPath, PATH_RE, RESERVED, labelText, LABEL_COLORS, initials, avatarColor, pct, plural, num, MONTHS,
};
