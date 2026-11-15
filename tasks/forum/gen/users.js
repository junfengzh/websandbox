'use strict';
// User profiles: karma in the sidebar, submissions / comments tabs, counting by forum.
const L = require('./lib');
const { answer, answerTitleOk, titleRef, uid, AFTER } = require('./evals');

const subsBy = (userId) => L.all(`SELECT s.id, f.name AS forum FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.user_id = ? AND s.visibility = 'visible' ORDER BY s.id DESC`, userId);
const byForum = (subs) => { const m = new Map(); for (const s of subs) m.set(s.forum, (m.get(s.forum) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };

module.exports = [
  {
    name: 'compare-karma', kind: 'read', skills: ['compare', 'read-detail'], difficulty: 2,
    phrasings: [
      'Who has more {{kind}} karma, {{a}} or {{b}}? Answer with the username only.',
      'Compare the {{kind}} karma of users {{a}} and {{b}}. Which of them has the higher value? Reply with just the username.',
      'Between {{a}} and {{b}}, whose {{kind}} karma is larger? Give only the username.',
    ],
    *generate(r) {
      const ms = L.members();
      for (let i = 0; i < 400; i++) {
        const a = r.pick(ms); const b = r.pick(ms);
        if (a.id === b.id) continue;
        const kind = r() < 0.5 ? 'comment' : 'post';
        const col = kind === 'comment' ? 'comment_karma' : 'submission_karma';
        const va = a[col]; const vb = b[col];
        if (va === vb || Math.abs(va - vb) < Math.max(3, 0.05 * Math.max(Math.abs(va), Math.abs(vb)))) continue;
        const win = va > vb ? a : b;
        yield { slots: { a: a.username, b: b.username, kind }, login_user: L.loginFor(r, [a.username, b.username]),
          eval: answer(win.username, `SELECT u.username FROM user_stats st JOIN users u ON u.id = st.user_id WHERE u.id IN (${a.id}, ${b.id}) ORDER BY st.${col} DESC LIMIT 1`, { exact: true }),
          changes: [`${col}: ${a.username} ${va}, ${b.username} ${vb}; exact match (a must_include check would pass any answer naming both users)`] };
      }
    },
  },
  {
    name: 'user-forum-post-count', kind: 'read', skills: ['aggregate', 'navigate'], difficulty: 2,
    phrasings: [
      'How many posts has {{user}} submitted to /f/{{forum}}?',
      'Count the submissions {{user}} made in the {{forum}} forum.',
      'Look at {{user}}\'s profile. How many of their posts are in /f/{{forum}}?',
    ],
    *generate(r) {
      for (const u of r.shuffle(L.members().filter((m) => m.submissions >= 4 && m.submissions <= 25))) {
        const bf = byForum(subsBy(u.id));
        if (bf.length < 2) continue;
        const cand = bf.filter(([, n]) => n >= 2 && n <= 10);
        if (!cand.length) continue;
        const [forum, n] = r.pick(cand);
        yield { slots: { user: u.username, forum }, login_user: L.loginFor(r, [u.username]),
          eval: answer(String(n), `SELECT count(*) FROM submissions WHERE user_id = ${uid(u.username)} AND forum_id = ${L.fid(forum)} AND visibility = 'visible' AND created_at < '${AFTER}'`) };
      }
    },
  },
  {
    name: 'user-latest-comment-post', kind: 'read', skills: ['navigate', 'read-detail'], difficulty: 1,
    phrasings: [
      'What is the title of the post that {{user}} most recently commented on?',
      'Find the latest comment by {{user}}. Which submission was it on? Give the title.',
      'Check {{user}}\'s comments: on which post did they leave their newest comment?',
    ],
    *generate(r) {
      for (const u of r.shuffle(L.members())) {
        const cs = L.all(`SELECT c.id, c.created_at, s.title, s.visibility FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.user_id = ? AND c.visibility = 'visible' ORDER BY c.id DESC LIMIT 5`, u.id);
        if (cs.length < 2 || cs[0].visibility !== 'visible' || !answerTitleOk(cs[0].title)) continue;
        if (cs.slice(1).some((c) => c.created_at >= cs[0].created_at || c.title === cs[0].title)) continue; // id order = time order, distinct post
        yield { slots: { user: u.username }, login_user: L.loginFor(r, [u.username]),
          eval: answer(titleRef(cs[0].title), `SELECT s.title FROM comments c JOIN submissions s ON s.id = c.submission_id WHERE c.user_id = ${uid(u.username)} AND c.visibility = 'visible' AND c.created_at < '${AFTER}' ORDER BY c.id DESC LIMIT 1`) };
      }
    },
  },
  {
    name: 'user-top-forum', kind: 'read', skills: ['aggregate', 'navigate'], difficulty: 2,
    phrasings: [
      'In which forum has {{user}} submitted the most posts?',
      'Which forum does {{user}} post in most often? Count their submissions per forum.',
      'Go through {{user}}\'s submissions and tell me the forum they posted to the most.',
    ],
    *generate(r) {
      for (const u of r.shuffle(L.members().filter((m) => m.submissions >= 5 && m.submissions <= 25))) {
        const bf = byForum(subsBy(u.id));
        if (bf.length < 2 || bf[0][1] === bf[1][1]) continue;
        yield { slots: { user: u.username }, login_user: L.loginFor(r, [u.username]),
          eval: answer(bf[0][0], `SELECT f.name FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.user_id = ${uid(u.username)} AND s.visibility = 'visible' AND s.created_at < '${AFTER}' GROUP BY f.id ORDER BY count(*) DESC LIMIT 1`),
          changes: [`per forum: ${bf.map(([f, n]) => `${f} ${n}`).join(', ')}`] };
      }
    },
  },
];
