'use strict';
// The login user's own profile: biography derived from their posting history, preferences.
const L = require('./lib');
const { state, uid, lit } = require('./evals');

const PREFS = [
  { key: 'front_page', val: 'all', say: ['show all forums on my front page', 'make my front page list posts from all forums'] },
  { key: 'front_page', val: 'featured', say: ['make my front page show the featured forums', 'set my front page to featured forums'] },
  { key: 'front_page_sort_mode', val: 'new', say: ['sort my front page by new by default', 'make "New" my default sort'] },
  { key: 'front_page_sort_mode', val: 'top', say: ['sort my front page by top by default', 'make "Top" my default sort'] },
  { key: 'front_page_sort_mode', val: 'active', say: ['sort my front page by activity by default', 'make "Active" my default sort'] },
  { key: 'front_page_sort_mode', val: 'most_commented', say: ['sort my front page by most commented by default', 'make "Most commented" my default sort'] },
  { key: 'night_mode', val: 'dark', say: ['switch me to the dark theme', 'use the dark theme'] },
  { key: 'show_thumbnails', val: 0, say: ['turn off thumbnails in listings', 'stop showing thumbnails'] },
  { key: 'open_external_links_in_new_tab', val: 1, say: ['open external links in a new tab', 'make outside links open in a new tab'] },
  { key: 'notify_on_reply', val: 0, say: ['stop notifying me about replies', 'turn off reply notifications'] },
  { key: 'notify_on_mentions', val: 0, say: ['stop notifying me when I am mentioned', 'turn off mention notifications'] },
  { key: 'allow_private_messages', val: 0, say: ['stop allowing private messages', 'block private messages to me'] },
  { key: 'timezone', val: 'Europe/London', say: ['set my time zone to Europe/London'] },
  { key: 'timezone', val: 'America/Los_Angeles', say: ['set my time zone to America/Los_Angeles'] },
  { key: 'timezone', val: 'Asia/Tokyo', say: ['set my time zone to Asia/Tokyo'] },
  { key: 'timezone', val: 'UTC', say: ['set my time zone to UTC'] },
];
const LEADS = ['Most of my posts are in', 'I mostly post in', 'You can usually find me in', 'My favorite forum is'];
const COLS = ['front_page', 'front_page_sort_mode', 'night_mode', 'show_thumbnails', 'open_external_links_in_new_tab', 'notify_on_reply', 'notify_on_mentions', 'allow_private_messages', 'timezone'];

module.exports = [
  {
    name: 'bio-top-forum', kind: 'write', skills: ['aggregate', 'multi-step', 'form-edit'], difficulty: 3,
    phrasings: [
      'Set my biography to "{{lead}} <forum>", replacing <forum> with the name of the forum I have submitted the most posts to.',
      'Update my bio so it reads "{{lead}} <forum>", where <forum> is the forum I post in most.',
      'Check which forum I have posted the most submissions in, then change my biography to "{{lead}} <forum>" with that forum\'s name in place of <forum>.',
    ],
    *generate(r) {
      for (const u of r.shuffle(L.members().filter((m) => m.submissions >= 4 && m.submissions <= 25))) {
        const bf = L.all(`SELECT f.name, count(*) n FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.user_id = ? AND s.visibility = 'visible' GROUP BY f.id ORDER BY n DESC`, u.id);
        if (bf.length < 2 || bf[0].n === bf[1].n) continue;
        const top = bf[0].name.toLowerCase();
        const others = bf.slice(1).map((x) => x.name.toLowerCase());
        if (others.some((o) => o.includes(top) || top.includes(o))) continue; // substring-safe check
        const lead = r.pick(LEADS);
        yield { slots: { lead }, login_user: u.username,
          eval: state(`SELECT (${L.ci("coalesce(biography, '')", lead)} AND ${L.ci("coalesce(biography, '')", top)}${others.map((o) => ` AND NOT ${L.ci("coalesce(biography, '')", o)}`).join('')}) AS ok, biography FROM users WHERE id = ${uid(u.username)}`, 1),
          changes: [`answer forum: ${bf[0].name}; per forum ${bf.map((x) => `${x.name} ${x.n}`).join(', ')}; the bio must not name the user's other forums`] };
      }
    },
  },
  {
    name: 'preferences', kind: 'write', skills: ['form-edit'], difficulty: 1,
    phrasings: [
      'In my preferences, {{a}} and {{b}}.',
      'Please update my settings: {{a}}, and also {{b}}.',
      'Open my preferences and make two changes: {{a}}; {{b}}.',
    ],
    *generate(r) {
      const seen = new Set();
      for (let i = 0; i < 2000; i++) {
        const [x, y] = r.sample(PREFS, 2);
        if (x.key === y.key) continue;
        const sx = r.pick(x.say); const sy = r.pick(y.say);
        const k = sx + '|' + sy;
        if (seen.has(k)) continue; seen.add(k);
        const me = L.loginFor(r);
        const cur = L.get(`SELECT ${COLS.join(', ')} FROM users WHERE normalized_username = lower(?)`, me);
        if (cur[x.key] === x.val || cur[y.key] === y.val) continue;
        const want = { ...cur, [x.key]: x.val, [y.key]: y.val };
        yield { slots: { a: sx, b: sy }, login_user: me,
          eval: state(`SELECT ${COLS.join(', ')} FROM users WHERE id = ${uid(me)}`, [want]),
          changes: [`state: ${x.key}=${x.val}, ${y.key}=${y.val}; every other preference unchanged`] };
      }
    },
  },
];
