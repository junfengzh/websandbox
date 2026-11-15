'use strict';
// Shared helpers for the forum task generator (docs/GENERATOR.md): DB access, seeded RNG,
// SQL literal helpers, entity pools and text filters. Templates live in the family modules
// next to this file; index.js runs them.
const path = require('path');
const Database = require(path.join(__dirname, '../../../kit/node_modules/better-sqlite3'));

const DATA = process.env.WSB_FORUM_DATA || '$WSB_DATA_ROOT/forum';
// Rows created by the agent are newer than the data (newest source row 2023-06-12; site clock 2023-07-11).
const AFTER = '2023-06-13';
const DELETED_USER = 10000; // '[deleted]'
const ADMIN = 'KrokmaniakPL'; // the only site admin = moderator of every forum

let db;
const open = () => db || (db = new Database(path.join(DATA, 'base.db'), { readonly: true, fileMustExist: true }));
const all = (sql, ...p) => open().prepare(sql).all(...p);
const get = (sql, ...p) => open().prepare(sql).get(...p);

// mulberry32
function rng(seed) {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (n) => Math.floor(r() * n);
  r.pick = (xs) => xs[r.int(xs.length)];
  r.shuffle = (xs) => { const a2 = [...xs]; for (let i = a2.length - 1; i > 0; i--) { const j = r.int(i + 1); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; };
  r.sample = (xs, k) => r.shuffle(xs).slice(0, k);
  return r;
}
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

// SQL literals / sub-selects (same forms as sites/forum/grade.js)
const lit = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const uid = (name) => `(SELECT id FROM users WHERE normalized_username = lower(${lit(name)}))`;
const fid = (name) => `(SELECT id FROM forums WHERE normalized_name = lower(${lit(name)}))`;
const ci = (col, needle) => `instr(lower(${col}), lower(${lit(needle)})) > 0`; // case-insensitive contains
const eqci = (col, v) => `lower(trim(${col})) = lower(${lit(v)})`;

// Text that survives being quoted in an intent, typed into a form or search box, and shown by the
// site unchanged: plain ASCII, no quotes, no HTML entities or markdown specials.
const CLEAN = /^[A-Za-z0-9 ,.:;!?()'\/-]+$/;
const cleanText = (s, min = 15, max = 100) => typeof s === 'string' && s.length >= min && s.length <= max && CLEAN.test(s) && !/\s{2}/.test(s) && s === s.trim() && /[A-Za-z]{3}/.test(s);
const cleanName = (s) => /^[A-Za-z0-9_-]{3,30}$/.test(s);

const subUrl = (forum, id) => `__REDDIT__/f/${forum}/${id}`;

// ---------------------------------------------------------------- pools (cached)
const cache = {};
const once = (k, f) => (k in cache ? cache[k] : (cache[k] = f()));

const forums = () => once('forums', () => all(`SELECT f.id, f.name, (SELECT count(*) FROM submissions s WHERE s.forum_id = f.id AND s.visibility = 'visible') AS n,
  (SELECT t.name FROM forums_tags ft JOIN forum_tags t ON t.id = ft.tag_id WHERE ft.forum_id = f.id) AS tag FROM forums f ORDER BY f.normalized_name`));
const tags = () => once('tags', () => {
  const m = new Map();
  for (const f of forums()) { if (!m.has(f.tag)) m.set(f.tag, []); m.get(f.tag).push(f); }
  return [...m.entries()].map(([name, fs]) => ({ name, forums: fs })).sort((a, b) => (a.name < b.name ? -1 : 1));
});

const titleCounts = () => once('titleCounts', () => {
  const m = new Map();
  for (const r of all('SELECT lower(title) t, count(*) n FROM submissions GROUP BY lower(title)')) m.set(r.t, r.n);
  return m;
});
const uniqueTitle = (t) => titleCounts().get(String(t).toLowerCase()) === 1;

// Posts with clean, site-wide unique titles by a real (not [deleted]) user.
const posts = () => once('posts', () => all(`SELECT s.id, s.title, s.url, s.media_type, s.net_score, s.comment_count, s.user_id, u.username, f.name AS forum
  FROM submissions s JOIN users u ON u.id = s.user_id JOIN forums f ON f.id = s.forum_id
  WHERE s.visibility = 'visible' AND s.user_id <> ${DELETED_USER} ORDER BY s.id`).filter((p) => cleanText(p.title, 20, 90) && cleanName(p.username) && uniqueTitle(p.title)));

// Users who can log in and look like regular members (some posts and comments).
const members = () => once('members', () => all(`SELECT u.id, u.username, st.submissions, st.comments, st.submission_karma, st.comment_karma
  FROM user_stats st JOIN users u ON u.id = st.user_id WHERE st.submissions BETWEEN 2 AND 40 AND st.comments BETWEEN 2 AND 60 AND u.id NOT IN (${DELETED_USER}, 9)
  AND u.role = 'user' ORDER BY u.id`).filter((u) => cleanName(u.username)));
const loginFor = (r, exclude = []) => {
  const ms = members();
  for (;;) { const u = ms[r.int(ms.length)]; if (!exclude.includes(u.username)) return u.username; }
};

const commentsOf = (sid) => all(`SELECT c.id, c.parent_id, c.user_id, u.username, c.net_score, c.body, c.created_at FROM comments c JOIN users u ON u.id = c.user_id
  WHERE c.submission_id = ? AND c.visibility = 'visible' ORDER BY c.id`, sid);

const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd']; const v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

// Phrase material for write tasks (comments, titles, messages)
const PHRASES = {
  comment: ['Thanks for sharing this!', 'This is really helpful, bookmarking it.', 'Great point, I had not thought about it that way.',
    'Could you share a source for this?', 'I had the same experience last year.', 'Interesting, following this thread.',
    'This deserves more attention.', 'Totally agree with you here.', 'Can you elaborate on that a bit?', 'Well said.',
    'I learned something new today.', 'Following up on this later.', 'Nice find!', 'Respectfully, I disagree.',
    'This made my day.', 'Same here, glad I am not the only one.'],
  subjects: ['Quick question', 'About your post', 'Collaboration idea', 'Thanks!', 'Hello from the forum', 'A follow-up', 'Your recent submission'],
  messages: ['Hi, I really enjoyed your post. Do you have any more like it?', 'Hello! Would you be open to answering a few questions about your post?',
    'Thanks for the great content, keep it up.', 'Hi there, could you share where you found that?', 'Your post was the best thing I read this week, thank you.',
    'Hey, I would love to hear more about this topic from you.'],
  edits: ['EDIT: Thanks everyone for the replies!', 'EDIT: Fixed a typo.', 'Update: this has been resolved.', 'EDIT: Added more details below.',
    'Update: still looking for advice.', 'EDIT: Wow, this blew up. Thank you all!'],
  reasons: ['Spam', 'Repeated rule violations', 'Off-topic content', 'Harassment of other users', 'Low effort posting'],
};

module.exports = {
  open, all, get, rng, hash, lit, uid, fid, ci, eqci, cleanText, cleanName, subUrl, forums, tags, posts, members, loginFor, commentsOf,
  uniqueTitle, ordinal, domainOf, PHRASES, AFTER, DELETED_USER, ADMIN,
};
