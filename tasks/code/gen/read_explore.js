'use strict';
// Read templates: explore / project lists / user profiles.
const { q, uid } = require('./lib');

// SQL: projects visible to a signed-in user (as repo/lib/lists.js listProjects + code.visibleWhere), not archived
const VIS = (u) => `p.archived = 0 AND (p.visibility IN ('public','internal') OR p.namespace_id IN (SELECT id FROM namespaces WHERE kind = 'user' AND owner_id = ${uid(u)}) OR p.id IN (SELECT source_id FROM members WHERE source_type = 'project' AND user_id = ${uid(u)} AND requested_at IS NULL))`;
const like = (kw) => { const l = q('%' + kw + '%'); return `(p.name LIKE ${l} OR p.path LIKE ${l} OR p.full_path LIKE ${l} OR p.description LIKE ${l})`; };

const starsFilter = {
  id: 'gen-code-explore-stars-filter', kind: 'read', skills: ['search', 'filter-sort', 'compare'], difficulty: 2, cap: 60,
  phrasings: [
    'Among the projects whose name or description contains "{kw}", which one has the {rank} stars? Give the project name.',
    'Filter the project list by "{kw}". Which of the matching projects has the {rank} stars?',
    'Which project matching "{kw}" is the one with the {rank} stars on this GitLab?',
  ],
  generate({ db }) {
    const U = 'byteblaze';
    const projs = db.prepare(`SELECT p.* FROM projects p WHERE ${VIS(U)}`).all();
    const words = new Set();
    for (const p of projs) for (const w of `${p.name} ${p.description || ''}`.toLowerCase().match(/[a-z]{4,}/g) || []) words.add(w);
    const out = [];
    for (const kw of [...words].sort()) {
      if (['with', 'that', 'this', 'from', 'your', 'have', 'into', 'more', 'than', 'what', 'were', 'will', 'which', 'they', 'when'].includes(kw)) continue;
      const m = projs.filter((p) => [p.name, p.path, p.full_path, p.description || ''].some((s) => s.toLowerCase().includes(kw)));
      if (m.length < 3 || m.length > 40) continue;
      const s = m.map((p) => p.star_count).sort((a, b) => b - a);
      for (const [rank, k] of [['most', 0], ['second most', 1]]) {
        if (!(s[k] > 0) || s[k] === s[k + 1] || (k > 0 && s[k] === s[k - 1])) continue;
        const top = m.find((p) => p.star_count === s[k]);
        // the name must be distinctive (not the keyword itself)
        if (top.name.toLowerCase() === kw) continue;
        out.push({
          vars: { kw, rank }, start: '/explore/projects',
          eval: { type: 'answer', answer: { must_include: [top.name] },
            answer_sql: `SELECT p.name FROM projects p WHERE ${VIS(U)} AND ${like(kw)} ORDER BY p.star_count DESC, p.id LIMIT 1 OFFSET ${k}` },
          difficulty: k ? 3 : 2,
        });
      }
    }
    return out;
  },
};

const starsThreshold = {
  id: 'gen-code-explore-stars-count', kind: 'read', skills: ['filter-sort', 'aggregate'], difficulty: 2, cap: 45,
  phrasings: [
    'How many projects on this GitLab have {cmp} {n} stars?',
    'Count the projects that have {cmp} {n} stars.',
    'Looking at all projects, how many of them have {cmp} {n} stars?',
  ],
  generate({ db }) {
    const U = 'byteblaze';
    const projs = db.prepare(`SELECT p.star_count FROM projects p WHERE ${VIS(U)}`).all();
    const out = [];
    for (let n = 2; n <= 52; n++) {
      for (const [cmp, op] of [['more than', '>'], ['at least', '>=']]) {
        const cnt = projs.filter((p) => (op === '>' ? p.star_count > n : p.star_count >= n)).length;
        if (cnt < 1 || cnt > 120) continue;
        out.push({ vars: { cmp, n: String(n) }, start: '/explore/projects',
          eval: { type: 'answer', answer: { must_include: [String(cnt)] }, answer_sql: `SELECT count(*) FROM projects p WHERE ${VIS(U)} AND p.star_count ${op} ${n}` } });
      }
    }
    return out;
  },
};

const userProjects = {
  id: 'gen-code-user-projects-extreme', kind: 'read', skills: ['navigate', 'filter-sort', 'compare'], difficulty: 2, cap: 30,
  phrasings: [
    'Which of {who}\'s personal projects {what}? Give the project name.',
    'Look at the projects owned by {who}. Which one {what}?',
    'Among {who}\'s own repositories, which one {what}?',
  ],
  generate({ db }) {
    const U = 'byteblaze';
    const users = db.prepare(`SELECT u.username, u.name, n.id ns FROM users u JOIN namespaces n ON n.owner_id = u.id AND n.kind = 'user'
      WHERE u.state = 'active' AND (SELECT count(*) FROM projects p WHERE p.namespace_id = n.id AND ${VIS(U)}) >= 3 ORDER BY u.username`).all();
    const variants = [
      ['was updated most recently', 'p.last_activity_at DESC'], ['was updated least recently', 'p.last_activity_at ASC'],
      ['was created most recently', 'p.created_at DESC'], ['was created first', 'p.created_at ASC'],
      ['has the most stars', 'p.star_count DESC'], ['has the most commits on its default branch', 'p.commit_count DESC'],
    ];
    const out = [];
    for (const u of users) {
      for (const [what, order] of variants) {
        const sql = `SELECT p.name, ${order.split(' ')[0]} AS k FROM projects p WHERE p.namespace_id = (SELECT id FROM namespaces WHERE kind = 'user' AND path = ${q(u.username)}) AND ${VIS(U)} ORDER BY ${order}, p.id`;
        const rows = db.prepare(sql).all();
        if (rows.length < 3 || rows[0].k === rows[1].k || !rows[0].k) continue;
        const who = u.username === U ? 'my' : `${u.name} (@${u.username})`;
        out.push({ vars: { who, what },
          start: '/' + u.username,
          eval: { type: 'answer', answer: { must_include: [rows[0].name] }, answer_sql: sql.replace('SELECT p.name, ', 'SELECT p.name, ') + ' LIMIT 1' } });
      }
    }
    // "my" reads badly with "'s": rewrite those intents in index via vars
    for (const o of out) if (o.vars.who === 'my') { o.phrasing = 'Which of my personal projects {what}? Give the project name.'; }
    return out;
  },
};

const userProfile = {
  id: 'gen-code-user-profile-field', kind: 'read', skills: ['search', 'read-detail'], difficulty: 1, cap: 50,
  phrasings: [
    'What {field} does the user {name} list on their profile?',
    'Find {name}\'s user profile. What is their {field}?',
    'According to the GitLab profile of {name}, what is their {field}?',
  ],
  generate({ db }) {
    const out = [];
    const fields = [['location', 'location'], ['organization', 'organization'], ['job title', 'job_title']];
    const users = db.prepare(`SELECT * FROM users WHERE state = 'active' AND user_type IS NULL AND private_profile = 0 AND
      ((location IS NOT NULL AND location != '') OR (organization IS NOT NULL AND organization != '') OR (job_title IS NOT NULL AND job_title != '')) ORDER BY id`).all();
    const nameCount = new Map();
    for (const r of db.prepare('SELECT lower(name) n, count(*) c FROM users GROUP BY 1').all()) nameCount.set(r.n, r.c);
    for (const u of users) {
      if (nameCount.get(u.name.toLowerCase()) > 1 || !/^[\p{L}][\p{L} .'-]+$/u.test(u.name)) continue;
      for (const [field, col] of fields) {
        const v = (u[col] || '').trim();
        if (v.length < 3 || v.length > 60) continue;
        const name = u.name.toLowerCase() === u.username.toLowerCase() ? `@${u.username}` : `${u.name} (@${u.username})`;
        out.push({ vars: { field, name }, start: '/explore/users',
          eval: { type: 'answer', answer: { must_include: [v] }, answer_sql: `SELECT trim(${col}) FROM users WHERE username = ${q(u.username)}` } });
      }
    }
    return out;
  },
};

module.exports = [starsFilter, userProjects, userProfile];
