'use strict';
// Write templates: project administration (members, labels, milestones, settings), stars, profile.
const { q, pid, uid, ROLE } = require('./lib');
const { actor, userLabel } = require('./write_issues');

const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => `${months[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
const randDate = (rand, y0 = 2023) => `${y0 + rand.int(2)}-${String(6 + rand.int(7)).padStart(2, '0')}-${String(1 + rand.int(28)).padStart(2, '0')}`;
const projects = (db) => db.prepare(`SELECT p.* FROM projects p WHERE p.archived = 0 AND p.visibility IN ('public','private') AND p.default_branch IS NOT NULL ORDER BY p.id`).all();
// active humans with a distinctive name, as invite targets
const people = (db) => db.prepare(`SELECT username, name FROM users u WHERE state = 'active' AND user_type IS NULL AND length(name) >= 5 AND name LIKE '% %'
  AND (SELECT count(*) FROM users u2 WHERE lower(u2.name) = lower(u.name)) = 1 AND username NOT IN ('root', 'byteblaze') ORDER BY id`).all();

const memberManage = {
  id: 'gen-code-member-manage', kind: 'write', skills: ['form-edit', 'navigate'], difficulty: 2, cap: 70,
  phrasings: [
    'In the {repo} project, {action}.',
    'Manage the members of {repo}: {action}.',
    'Update {repo}\'s membership: {action}.',
  ],
  generate({ db, rand }) {
    const out = [];
    const pool = people(db);
    for (const p of projects(db)) {
      const login = actor(db, p, 40);
      if (!login) continue;
      const M = (u) => `SELECT access_level, expires_at FROM members WHERE source_type = 'project' AND source_id = ${pid(p.full_path)} AND user_id = ${uid(u)} AND requested_at IS NULL`;
      // existing direct members (not the namespace owner): change role / remove
      const mem = db.prepare(`SELECT u.username, u.name, m.access_level FROM members m JOIN users u ON u.id = m.user_id JOIN namespaces n ON n.id = ?
        WHERE m.source_type = 'project' AND m.source_id = ? AND m.requested_at IS NULL AND u.username != ? AND NOT (n.kind = 'user' AND n.owner_id = u.id) AND m.access_level < 50`).all(p.namespace_id, p.id, login);
      for (const m of mem) {
        const to = rand.pick([10, 20, 30, 40].filter((x) => x !== m.access_level));
        out.push({ vars: { repo: p.full_path, action: `change the role of ${userLabel(m)} from ${ROLE[m.access_level]} to ${ROLE[to]}` }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT access_level FROM members WHERE source_type = 'project' AND source_id = ${pid(p.full_path)} AND user_id = ${uid(m.username)} AND requested_at IS NULL`, state_expect: to } });
        out.push({ vars: { repo: p.full_path, action: `remove ${userLabel(m)} from the project members` }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT count(*) FROM members WHERE source_type = 'project' AND source_id = ${pid(p.full_path)} AND user_id = ${uid(m.username)}`, state_expect: 0 } });
      }
      // add a new member with a role and an expiration date
      const existing = new Set(db.prepare(`SELECT u.username FROM members m JOIN users u ON u.id = m.user_id WHERE m.source_type = 'project' AND m.source_id = ?`).pluck().all(p.id));
      const u = rand.pick(pool.filter((x) => !existing.has(x.username)));
      const role = rand.pick([10, 20, 30, 40]); const exp = randDate(rand);
      out.push({ vars: { repo: p.full_path, action: `add ${userLabel(u)} as a ${ROLE[role]} whose access expires on ${longDate(exp)}` }, login, start: '/' + p.full_path,
        eval: { type: 'state', state_sql: `SELECT (access_level = ${role} AND substr(expires_at, 1, 10) = '${exp}') AS ok FROM members WHERE source_type = 'project' AND source_id = ${pid(p.full_path)} AND user_id = ${uid(u.username)} AND requested_at IS NULL`, state_expect: 1 } });
    }
    return out;
  },
};

const LABEL_NAMES = ['needs-triage', 'good first issue', 'blocked', 'regression', 'performance', 'security', 'documentation needed', 'ux', 'breaking change', 'awaiting feedback', 'wontfix-candidate', 'ci', 'refactor', 'priority: high', 'priority: low'];
const COLORS = ['#d9534f', '#5cb85c', '#428bca', '#f0ad4e', '#8e44ad', '#34495e', '#1abc9c', '#e67e22', '#ff69b4', '#009966'];
const LABEL_DESC = ['Needs a decision from the maintainers', 'Waiting for more information', 'Affects the build pipeline', 'Worth doing in the next release', 'Tracked for the changelog'];
const createLabel = {
  id: 'gen-code-create-label', kind: 'write', skills: ['create', 'form-edit'], difficulty: 2, cap: 70,
  phrasings: [
    'Create a label "{title}" in {repo} with the color {color} and the description "{desc}".',
    'Add a new project label to {repo}: name "{title}", color {color}, description "{desc}".',
    'In the {repo} project, set up a label called "{title}" (color {color}) described as "{desc}".',
  ],
  generate({ db, rand }) {
    const out = [];
    for (const p of projects(db)) {
      const login = actor(db, p, 20);
      if (!login) continue;
      const have = new Set(db.prepare('SELECT lower(title) FROM labels WHERE project_id = ?').pluck().all(p.id));
      const title = rand.pick(LABEL_NAMES.filter((l) => !have.has(l)));
      if (!title) continue;
      const color = rand.pick(COLORS); const desc = rand.pick(LABEL_DESC);
      out.push({ vars: { repo: p.full_path, title, color, desc }, login, start: '/' + p.full_path,
        eval: { type: 'state', state_sql: `SELECT (lower(color) = ${q(color)} AND trim(coalesce(description, '')) = ${q(desc)}) AS ok FROM labels WHERE project_id = ${pid(p.full_path)} AND title = ${q(title)}`, state_expect: 1 } });
    }
    return out;
  },
};

const milestoneEdit = {
  id: 'gen-code-milestone-edit', kind: 'write', skills: ['form-edit', 'navigate'], difficulty: 2, cap: 60,
  phrasings: [
    'In {repo}, {action}.',
    'Go to the milestones of {repo} and {action}.',
  ],
  generate({ db, rand }) {
    const out = [];
    const rows = db.prepare(`SELECT p.*, m.title mtitle, m.state mstate, m.due_date mdue, m.start_date mstart FROM milestones m JOIN projects p ON p.id = m.project_id
      WHERE p.archived = 0 AND p.visibility IN ('public','private') AND (SELECT count(*) FROM milestones m2 WHERE m2.project_id = m.project_id AND m2.title = m.title) = 1 ORDER BY m.id`).all();
    for (const r of rows) {
      const login = actor(db, r, 20);
      if (!login) continue;
      const M = `FROM milestones WHERE project_id = ${pid(r.full_path)} AND title = ${q(r.mtitle)}`;
      const v = rand.int(3);
      if (v === 0) {
        out.push({ vars: { repo: r.full_path, action: r.mstate === 'active' ? `close the milestone "${r.mtitle}"` : `reopen the closed milestone "${r.mtitle}"` }, login, start: '/' + r.full_path,
          eval: { type: 'state', state_sql: `SELECT state ${M}`, state_expect: r.mstate === 'active' ? 'closed' : 'active' } });
      } else {
        const due = randDate(rand, 2024);
        if (r.mstart && r.mstart > due) continue;
        out.push({ vars: { repo: r.full_path, action: `change the due date of the milestone "${r.mtitle}" to ${longDate(due)}` }, login, start: '/' + r.full_path,
          eval: { type: 'state', state_sql: `SELECT due_date ${M}`, state_expect: due } });
      }
    }
    return out;
  },
};

const starUserProjects = {
  id: 'gen-code-star-user-projects', kind: 'write', skills: ['navigate', 'multi-step'], difficulty: 2, cap: 40,
  phrasings: [
    'Star every public project owned by {user}.',
    'I like {user}\'s work: star all of their personal projects.',
    'Go through {user}\'s profile and star each of their projects.',
  ],
  generate({ db }) {
    const out = [];
    const users = db.prepare(`SELECT u.username, u.name, n.id ns, (SELECT count(*) FROM projects p WHERE p.namespace_id = n.id AND p.visibility = 'public' AND p.archived = 0) np
      FROM users u JOIN namespaces n ON n.owner_id = u.id AND n.kind = 'user' WHERE u.state = 'active' AND u.username NOT IN ('byteblaze') ORDER BY u.id`).all();
    for (const u of users) {
      if (u.np < 2 || u.np > 8) continue;
      if (db.prepare(`SELECT count(*) FROM projects WHERE namespace_id = ? AND (visibility != 'public' OR archived = 1)`).pluck().get(u.ns)) continue;
      for (const login of ['byteblaze', 'yjlou', 'Roshanjossey', 'abisubramanya27']) {
        if (login === u.username) continue;
        const starred = db.prepare(`SELECT count(*) FROM stars s JOIN projects p ON p.id = s.project_id WHERE p.namespace_id = ? AND p.visibility = 'public' AND s.user_id = (SELECT id FROM users WHERE username = ?)`).pluck().get(u.ns, login);
        if (starred > 0) continue;
        out.push({ vars: { user: userLabel(u) }, login, start: '/' + u.username,
          eval: { type: 'state', state_sql: `SELECT count(*) FROM stars s JOIN projects p ON p.id = s.project_id WHERE s.user_id = ${uid(login)} AND p.archived = 0 AND p.visibility = 'public' AND p.namespace_id = (SELECT id FROM namespaces WHERE kind = 'user' AND path = ${q(u.username)})`, state_expect: u.np } });
      }
    }
    return out;
  },
};

const TOPICS = ['javascript', 'python', 'accessibility', 'cli', 'education', 'machine-learning', 'web', 'tooling', 'documentation', 'android', 'game', 'security'];
const DESCS = ['Maintained mirror for the sandbox', 'Experimental fork, not for production use', 'Archived notes and examples', 'Personal playground project', 'Course material and assignments', 'Utilities shared across my projects'];
const projectSettings = {
  id: 'gen-code-project-settings', kind: 'write', skills: ['form-edit', 'navigate'], difficulty: 2, cap: 80,
  phrasings: [
    'In the settings of {repo}, {action}.',
    'Update the {repo} project settings: {action}.',
    'Edit the general settings of {repo}: {action}.',
  ],
  generate({ db, rand }) {
    const out = [];
    for (const p of projects(db)) {
      const login = actor(db, p, 40);
      if (!login) continue;
      const P = pid(p.full_path);
      const v = rand.int(4);
      if (v === 0) {
        const d = rand.pick(DESCS);
        out.push({ vars: { repo: p.full_path, action: `set the project description to "${d}"` }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT trim(description) FROM projects WHERE id = ${P}`, state_expect: d } });
      } else if (v === 1) {
        const ts = rand.sample(TOPICS, 2).sort();
        out.push({ vars: { repo: p.full_path, action: `add the topics "${ts[0]}" and "${ts[1]}"` }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT count(*) FROM project_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.project_id = ${P} AND lower(t.name) IN (${ts.map(q).join(', ')})`, state_expect: 2 } });
      } else if (v === 2) {
        const to = p.visibility === 'public' ? 'private' : 'public';
        out.push({ vars: { repo: p.full_path, action: `change the project visibility to ${to}` }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT visibility FROM projects WHERE id = ${P}`, state_expect: to } });
      } else {
        const feats = [['wiki_enabled', 'the wiki'], ['issues_enabled', 'issues'], ['forking_enabled', 'forking']].filter(([c]) => p[c] === 1);
        if (!feats.length) continue;
        const [col, label] = rand.pick(feats);
        const others = ['issues_enabled', 'merge_requests_enabled', 'wiki_enabled', 'forking_enabled'].filter((c) => c !== col);
        out.push({ vars: { repo: p.full_path, action: `turn off ${label} (leave the other features as they are)` }, login, start: '/' + p.full_path,
          eval: { type: 'state', state_sql: `SELECT ${col}, ${others.join(', ')} FROM projects WHERE id = ${P}`, state_expect: [[0, ...others.map((c) => p[c])]] } });
      }
    }
    return out;
  },
};

const JOBS = ['Software Engineer', 'Frontend Developer', 'Data Scientist', 'Site Reliability Engineer', 'Technical Writer', 'Open Source Maintainer', 'Research Assistant'];
const ORGS = ['Carnegie Mellon University', 'Acme Corp', 'Open Source Collective', 'Initech', 'Globex', 'Umbrella Labs'];
const PLACES = ['Pittsburgh, PA', 'Berlin, Germany', 'Bangalore, India', 'Toronto, Canada', 'Lisbon, Portugal', 'Seoul, South Korea', 'Austin, TX'];
const PRONOUNS = ['she/her', 'he/him', 'they/them'];
const profileEdit = {
  id: 'gen-code-profile-edit', kind: 'write', skills: ['form-edit'], difficulty: 2, cap: 60,
  phrasings: [
    'Update my GitLab profile: {changes}.',
    'Edit your user profile so that {changes2}.',
    'On my profile settings, {changes}.',
  ],
  generate({ db, rand }) {
    const out = [];
    const logins = db.prepare(`SELECT username FROM users u WHERE state = 'active' AND user_type IS NULL AND (username IN ('byteblaze', 'yjlou', 'Roshanjossey', 'abisubramanya27', 'lahwaacz', 'koush', 'aklsh', 'convexegg', 'murale127')
      OR id IN (SELECT DISTINCT owner_id FROM namespaces n JOIN projects p ON p.namespace_id = n.id WHERE n.kind = 'user' AND p.visibility = 'public')) ORDER BY id`).pluck().all();
    for (const login of logins) {
      const u = db.prepare('SELECT * FROM users WHERE username = ?').get(login);
      const fields = rand.sample([['job_title', 'job title', JOBS], ['organization', 'organization', ORGS], ['location', 'location', PLACES], ['pronouns', 'pronouns', PRONOUNS]], 2);
      const set = fields.map(([col, label, vals]) => [col, label, rand.pick(vals.filter((x) => x !== u[col]))]);
      const changes = set.map(([, l, v]) => `set the ${l} to "${v}"`).join(' and ');
      const changes2 = set.map(([, l, v]) => `the ${l} ${l === 'pronouns' ? 'are' : 'is'} "${v}"`).join(' and ');
      out.push({ vars: { changes, changes2 }, login, start: '/-/profile',
        eval: { type: 'state', state_sql: `SELECT ${set.map(([c]) => `trim(${c})`).join(', ')} FROM users WHERE username = ${q(login)}`, state_expect: [set.map(([, , v]) => v)] } });
    }
    return out;
  },
};

module.exports = [memberManage, createLabel, milestoneEdit, starUserProjects, projectSettings, profileEdit];
