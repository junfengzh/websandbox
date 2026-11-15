'use strict';
// Creating and editing submissions: text and link posts in a named forum, cross-posting a link,
// renaming one's own post, creating a forum with a first post.
const L = require('./lib');
const { state, uid, lit, myNewPost, eqci } = require('./evals');

const TITLES = ['Looking for recommendations', 'What is everyone working on this week?', 'Weekly discussion thread', 'First time posting here',
  'Any advice for a beginner?', 'What would you change about this community?', 'Unpopular opinion thread', 'Share your favorite resources',
  'Is anyone else seeing this?', 'Quick poll for the regulars', 'Lessons learned after one year', 'What got you started?',
  'Hidden gems nobody talks about', 'Help me settle a debate', 'Best thing you discovered this month'];
const BODIES = ['Curious to hear what everyone thinks.', 'Please share your experiences in the comments.', 'I will summarize the answers in a week.',
  'Be kind, I am new here.', 'Links and sources welcome.', 'Thanks in advance for any help!', 'Long time lurker, first post.',
  'Let us keep it civil and on topic.'];
const LINKS = ['https://en.wikipedia.org/wiki/Open_source', 'https://www.gutenberg.org/ebooks/1342', 'https://archive.org/details/texts',
  'https://github.com/torvalds/linux', 'https://www.nasa.gov/missions', 'https://www.openstreetmap.org/about', 'https://www.python.org/about/',
  'https://www.nps.gov/yell/index.htm', 'https://www.bbc.co.uk/news/science_and_environment', 'https://www.who.int/news-room',
  'https://developer.mozilla.org/en-US/docs/Web/HTTP', 'https://www.metmuseum.org/art/collection', 'https://www.imdb.com/chart/top/',
  'https://www.rottentomatoes.com/browse/movies_in_theaters', 'https://www.weather.gov/', 'https://www.khanacademy.org/math'];
const LINK_TITLES = ['Found this useful, sharing here', 'Worth a read', 'Great resource for everyone', 'Bookmark this one',
  'Saw this today and thought of you all', 'Interesting link for the weekend'];
const RENAME = ['(Update)', '- Solved', '(Resolved)', '- edited', '(answered)'];
const WORDS1 = ['Urban', 'Retro', 'Night', 'Budget', 'Indie', 'Pocket', 'Weekend', 'Quiet', 'Rainy', 'Tiny', 'Daily', 'Slow'];
const WORDS2 = ['Gardening', 'Cycling', 'Baking', 'Chess', 'Astronomy', 'Hiking', 'Synths', 'Origami', 'Birding', 'Puzzles', 'Podcasts', 'Coffee'];

const newPostSql = (me, { forums, title, body, url }) => `SELECT (fname IN (${forums.map((f) => `lower(${lit(f)})`).join(', ')})${title != null ? ` AND ${eqci('title', title)}` : ''}${body != null ? ` AND ${L.ci("coalesce(body, '')", body)}` : ''}${url !== undefined ? (url ? ` AND rtrim(coalesce(url, ''), '/') = ${lit(url.replace(/\/$/, ''))}` : " AND coalesce(url, '') = ''") : ''}) AS ok, fname, title, url, body FROM (${myNewPost(me)})`;

module.exports = [
  {
    name: 'create-text-post', kind: 'write', skills: ['create', 'form-edit'], difficulty: 1,
    phrasings: [
      'Create a text post in /f/{{forum}} titled "{{title}}" with the body "{{body}}".',
      'Post to the {{forum}} forum: title "{{title}}", text "{{body}}".',
      'Start a new discussion in /f/{{forum}}. Use "{{title}}" as the title and write "{{body}}" in the body.',
    ],
    *generate(r) {
      const seen = new Set();
      for (let i = 0; i < 300; i++) {
        const f = r.pick(L.forums()); const title = r.pick(TITLES); const body = r.pick(BODIES);
        if (seen.has(f.name + title)) continue; seen.add(f.name + title);
        const me = L.loginFor(r);
        yield { slots: { forum: f.name, title, body }, login_user: me,
          eval: state(newPostSql(me, { forums: [f.name], title, body, url: null }), 1),
          changes: ['state: the user\'s newest new submission is a text post (no URL) in the forum with this title and body'] };
      }
    },
  },
  {
    name: 'create-link-post', kind: 'write', skills: ['create', 'form-edit'], difficulty: 1,
    phrasings: [
      'Share the link {{url}} in /f/{{forum}} with the title "{{title}}".',
      'Submit a link post to the {{forum}} forum: URL {{url}}, title "{{title}}".',
      'Post {{url}} as a link in /f/{{forum}} and call it "{{title}}".',
    ],
    *generate(r) {
      const seen = new Set();
      for (let i = 0; i < 300; i++) {
        const f = r.pick(L.forums()); const url = r.pick(LINKS); const title = r.pick(LINK_TITLES);
        if (seen.has(f.name + url)) continue; seen.add(f.name + url);
        const me = L.loginFor(r);
        yield { slots: { forum: f.name, url, title }, login_user: me,
          eval: state(newPostSql(me, { forums: [f.name], title, url }), 1),
          changes: ['state: the user\'s newest new submission links the URL (trailing slash ignored) in the forum with this title'] };
      }
    },
  },
  {
    name: 'crosspost-top-link', kind: 'write', skills: ['filter-sort', 'multi-step', 'create'], difficulty: 3,
    phrasings: [
      'Take the link from the highest-scoring link post in /f/{{src}} and share it in /f/{{dst}} with the same title.',
      'Cross-post the top-scoring link submission of the {{src}} forum to the {{dst}} forum, keeping its URL and title.',
      'Find the best-scoring post in /f/{{src}} that links to an external website and re-post that link to /f/{{dst}} under the same title.',
    ],
    *generate(r) {
      const tops = [];
      for (const f of L.forums()) {
        const [a, b] = L.all(`SELECT id, title, url, net_score FROM submissions WHERE forum_id = ? AND visibility = 'visible' AND media_type = 'url' AND url LIKE 'http%' ORDER BY net_score DESC, id DESC LIMIT 2`, f.id);
        if (!a || !b || a.net_score === b.net_score || !L.cleanText(a.title, 10, 100) || a.url.length >= 200 || /[\s"'<>&]/.test(a.url)) continue;
        // findable: within the first two pages of /f/<forum>/top
        const above = L.get(`SELECT count(*) n FROM submissions WHERE forum_id = ? AND visibility = 'visible' AND (net_score > ? OR (net_score = ? AND id > ?))`, f.id, a.net_score, a.net_score, a.id).n;
        if (above < 50) tops.push({ f, p: a });
      }
      const seen = new Set();
      for (let i = 0; i < 400; i++) {
        const s = r.pick(tops); const d = r.pick(L.forums());
        if (d.id === s.f.id || seen.has(s.f.name + d.name)) continue; seen.add(s.f.name + d.name);
        const me = L.loginFor(r);
        yield { slots: { src: s.f.name, dst: d.name }, login_user: me,
          eval: state(newPostSql(me, { forums: [d.name], title: s.p.title, url: s.p.url }), 1),
          changes: [`source: submission ${s.p.id} (${s.p.url})`] };
      }
    },
  },
  {
    name: 'edit-own-post-title', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 2,
    phrasings: [
      'Change the title of my post "{{old}}" to "{{new}}".',
      'Rename my submission "{{old}}" so its title reads "{{new}}".',
      'Edit my post titled "{{old}}" and set the title to "{{new}}".',
    ],
    *generate(r) {
      const n = new Map(L.members().map((m) => [m.id, m]));
      for (const p of r.shuffle(L.posts().filter((x) => n.has(x.user_id) && L.cleanText(x.title, 15, 80)))) {
        const neu = `${p.title} ${r.pick(RENAME)}`;
        yield { slots: { old: p.title, new: neu }, login_user: p.username,
          eval: state(`SELECT (${eqci('title', neu)} AND visibility = 'visible' AND user_id = ${uid(p.username)}) AS ok, title FROM submissions WHERE id = ${p.id}`, 1),
          changes: [`target: own submission ${p.id} in /f/${p.forum}`] };
      }
    },
  },
  {
    name: 'create-forum-with-post', kind: 'write', skills: ['create', 'multi-step', 'form-edit'], difficulty: 3,
    phrasings: [
      'Create a forum named {{name}} (title "{{ftitle}}", category "{{category}}") and then post a text submission in it titled "{{title}}".',
      'Start a new forum called {{name}} with the title "{{ftitle}}" in the {{category}} category, then make its first post: "{{title}}".',
      'Set up the forum {{name}} (title: "{{ftitle}}", category: {{category}}) and submit a text post titled "{{title}}" there.',
    ],
    *generate(r) {
      const taken = new Set(L.forums().map((f) => f.name.toLowerCase()));
      const cats = L.tags().map((t) => t.name);
      const seen = new Set();
      for (let i = 0; i < 400; i++) {
        const w1 = r.pick(WORDS1); const w2 = r.pick(WORDS2);
        const name = r() < 0.5 ? `${w1}${w2}` : `${w1.toLowerCase()}_${w2.toLowerCase()}`;
        if (taken.has(name.toLowerCase()) || seen.has(name.toLowerCase())) continue; seen.add(name.toLowerCase());
        const ftitle = `${w1} ${w2}`; const category = r.pick(cats); const title = r.pick(TITLES);
        const me = L.loginFor(r);
        yield { slots: { name, ftitle, category, title }, login_user: me,
          eval: state(`SELECT (f.id IS NOT NULL AND ${eqci('f.title', ftitle)}
            AND EXISTS (SELECT 1 FROM forums_tags ft JOIN forum_tags t ON t.id = ft.tag_id WHERE ft.forum_id = f.id AND t.normalized_name = lower(${lit(category)}))
            AND EXISTS (SELECT 1 FROM submissions s WHERE s.forum_id = f.id AND s.user_id = ${uid(me)} AND s.visibility = 'visible' AND ${eqci('s.title', title)})) AS ok
            FROM (SELECT 1) LEFT JOIN forums f ON f.normalized_name = lower(${lit(name)})`, 1),
          changes: ['state: forum row (title, category) and a post by the user in it with the title'] };
      }
    },
  },
];
