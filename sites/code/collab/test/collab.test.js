'use strict';
// Collaboration-side tests on the real code data (node --test sites/code/collab/test/).
// Needs $WSB_DATA_ROOT/code (or CODE_DATA). Runs ../../server.js (repo side +
// this plugin); COLLAB_HARNESS=1 runs the dev harness (plugin + minimal sign-in) instead. byteblaze's password comes from
// CODE_PASSWORD or WebArena's env_config.py (never printed); without it the form-login test is
// skipped and the rest use POST /__rl/login. Every write is checked with SQL via /__rl/query.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = process.env.CODE_DATA || '$WSB_DATA_ROOT/code';
const SITE = process.env.COLLAB_HARNESS ? path.join(__dirname, '../dev/harness.js') : path.join(__dirname, '../../server.js');
function password() {
  if (process.env.CODE_PASSWORD) return process.env.CODE_PASSWORD;
  const f = path.join(__dirname, '../../../../../3rd-party/webarena/browser_env/env_config.py');
  const m = fs.existsSync(f) && /"gitlab":\s*\{\s*"username":\s*"byteblaze",\s*"password":\s*"([^"]+)"/.exec(fs.readFileSync(f, 'utf8'));
  return m ? m[1] : null;
}

class Client {
  constructor(base) { this.base = base; this.jar = new Map(); }
  async req(method, p, { form, json, headers = {} } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(this.base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = kv.slice(i + 1);
      if (!v || /expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k); else this.jar.set(k, v);
    }
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
  }
  get(p) { return this.req('GET', p); }
  async csrf(p) { const r = await this.get(p); return (/name="csrf-token" content="([^"]+)"/.exec(r.text) || [])[1]; }
  async post(p, form, from) {
    const pairs = Array.isArray(form) ? form : Object.entries(form);
    return this.req('POST', p, { form: [...pairs, ['_csrf', await this.csrf(from || '/byteblaze/dotfiles/-/issues')]] });
  }
}

let srv, base, c, anon;
const q = async (sql, params = []) => {
  const r = await fetch(base + '/__rl/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.rows.map((row) => Object.fromEntries(j.columns.map((k, i) => [k, Array.isArray(row) ? row[i] : row[k]])));
};
const one = async (sql, params) => { const r = await q(sql, params); return r[0] ? Object.values(r[0])[0] : undefined; };

test.before(async () => {
  const site = require(SITE);
  srv = await site.start({ tenants: 1, port: 0, data: DATA, bind: 'ports', uploads: fs.mkdtempSync(path.join((process.env.WSB_TMP || require('os').tmpdir()), 'collab-up-')), jobTickMs: 50 });
  base = srv.url(0);
  await fetch(base + '/__rl/clock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frozen: true }) });
  c = new Client(base); anon = new Client(base);
  const r = await fetch(base + '/__rl/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'byteblaze' }) });
  const { cookie } = await r.json();
  c.jar.set(cookie.name, cookie.value);
});
test.after(async () => { if (srv) await srv.close(); });

test('form login as byteblaze', { skip: !password() && 'no password available' }, async () => {
  const x = new Client(base);
  const tok = await x.csrf('/users/sign_in');
  const r = await x.req('POST', '/users/sign_in', { form: { login: 'byteblaze', password: password(), 'user[login]': 'byteblaze', 'user[password]': password(), _csrf: tok } });
  assert.equal(r.status, 302);
  const page = await x.get('/dashboard/todos');
  assert.equal(page.status, 200);
});

test('issue list filters and sorting (GitLab URL scheme)', async () => {
  let r = await anon.get('/a11yproject/a11yproject.com/-/issues/?label_name%5B%5D=help%20wanted&state=all');
  assert.equal(r.status, 200);
  const n = await one(`SELECT count(*) FROM issues i JOIN label_links ll ON ll.target_type = 'issue' AND ll.target_id = i.id JOIN labels l ON l.id = ll.label_id
    WHERE i.project_id = (SELECT id FROM projects WHERE full_path = 'a11yproject/a11yproject.com') AND l.title = 'help wanted'`);
  assert.match(r.text, new RegExp(`Showing 1-\\d+ of ${n} issues`));
  r = await anon.get('/root/metaseq/-/issues/?search=OPT&label_name%5B%5D=question');
  assert.equal(r.status, 200);
  r = await anon.get('/a11yproject/a11yproject.com/-/issues/?sort=created_asc&state=opened');
  const first = await one(`SELECT title FROM issues WHERE project_id = (SELECT id FROM projects WHERE full_path = 'a11yproject/a11yproject.com') AND state = 'opened' ORDER BY created_at ASC LIMIT 1`);
  assert.ok(r.text.indexOf(first.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')) > 0, 'oldest open issue listed first');
  r = await c.get('/dashboard/issues?scope=all&state=opened&assignee_username=byteblaze');
  assert.equal(r.status, 200);
  r = await c.get('/dashboard/merge_requests?reviewer_username=byteblaze');
  assert.equal(r.status, 200);
  const rv = await one("SELECT count(*) FROM mr_reviewers r JOIN merge_requests m ON m.id = r.merge_request_id WHERE r.user_id = (SELECT id FROM users WHERE username = 'byteblaze') AND m.state = 'opened'");
  assert.match(r.text, new RegExp(`Open <span class="issuable-count">${rv}<`));
});

test('create an issue with label, assignee and due date; comment; close; reopen', async () => {
  const P = '/a11yproject/a11yproject.com';
  const label = await one(`SELECT id FROM labels WHERE project_id = (SELECT id FROM projects WHERE full_path = 'a11yproject/a11yproject.com') AND title = 'bug'`);
  const rosh = await one("SELECT id FROM users WHERE username = 'Roshanjossey'");
  const open0 = await one(`SELECT open_issues_count FROM projects WHERE full_path = 'a11yproject/a11yproject.com'`);
  let r = await c.post(`${P}/-/issues`, [['title', '401 bad gateway'], ['description', 'Seen on **prod**'], ['label_ids[]', String(label)], ['assignee_ids_usernames', 'Roshanjossey'], ['due_date', '2030-12-31']], `${P}/-/issues/new`);
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const iss = (await q(`SELECT * FROM issues WHERE title = '401 bad gateway' AND project_id = (SELECT id FROM projects WHERE full_path = 'a11yproject/a11yproject.com')`))[0];
  assert.ok(iss);
  assert.equal(r.location, `${P}/-/issues/${iss.iid}`);
  assert.equal(iss.due_date, '2030-12-31');
  assert.equal(await one('SELECT count(*) FROM label_links WHERE target_type = ? AND target_id = ? AND label_id = ?', ['issue', iss.id, label]), 1);
  assert.equal(await one('SELECT user_id FROM issue_assignees WHERE issue_id = ?', [iss.id]), rosh);
  assert.equal(await one(`SELECT open_issues_count FROM projects WHERE full_path = 'a11yproject/a11yproject.com'`), open0 + 1);
  r = await c.get(`${P}/-/issues/${iss.iid}`);
  assert.match(r.text, /data-qa-selector="title_content">401 bad gateway</);
  assert.match(r.text, /Dec 31, 2030/);
  // comment
  r = await c.post(`${P}/-/issues/${iss.iid}/notes`, { note: 'Thanks, working on it' }, `${P}/-/issues/${iss.iid}`);
  assert.equal(r.status, 302);
  assert.equal(await one("SELECT count(*) FROM notes WHERE noteable_type = 'issue' AND noteable_id = ? AND system = 0 AND body = 'Thanks, working on it'", [iss.id]), 1);
  assert.equal(await one('SELECT user_notes_count FROM issues WHERE id = ?', [iss.id]), 1);
  // close / reopen
  r = await c.post(`${P}/-/issues/${iss.iid}/close`, {}, `${P}/-/issues/${iss.iid}`);
  assert.equal(r.status, 302);
  assert.equal(await one('SELECT state FROM issues WHERE id = ?', [iss.id]), 'closed');
  assert.equal(await one(`SELECT open_issues_count FROM projects WHERE full_path = 'a11yproject/a11yproject.com'`), open0);
  assert.equal(await one("SELECT count(*) FROM resource_events WHERE target_type = 'issue' AND target_id = ? AND kind = 'state' AND state = 'closed'", [iss.id]), 1);
  r = await c.post(`${P}/-/issues/${iss.iid}/reopen`, {}, `${P}/-/issues/${iss.iid}`);
  assert.equal(await one('SELECT state FROM issues WHERE id = ?', [iss.id]), 'opened');
  // sidebar: due date, assignees (+ self), milestone, confidential
  await c.post(`${P}/-/issues/${iss.iid}/due_date`, { due_date: '2033-07-18' }, `${P}/-/issues/${iss.iid}`);
  assert.equal(await one('SELECT due_date FROM issues WHERE id = ?', [iss.id]), '2033-07-18');
  await c.post(`${P}/-/issues/${iss.iid}/assignees`, { assign_self: '1' }, `${P}/-/issues/${iss.iid}`);
  assert.deepEqual((await q('SELECT u.username FROM issue_assignees a JOIN users u ON u.id = a.user_id WHERE a.issue_id = ? ORDER BY 1', [iss.id])).map((x) => x.username).sort(), ['Roshanjossey', 'byteblaze'].sort());
  await c.post(`${P}/-/issues/${iss.iid}/confidential`, { confidential: '1' }, `${P}/-/issues/${iss.iid}`);
  assert.equal(await one('SELECT confidential FROM issues WHERE id = ?', [iss.id]), 1);
  r = await anon.get(`${P}/-/issues/${iss.iid}`);
  assert.equal(r.status, 404, 'confidential issue hidden from anonymous users');
  // "Comment & close"
  r = await c.post(`${P}/-/issues/${iss.iid}/notes`, { note: 'done', close: '1' }, `${P}/-/issues/${iss.iid}`);
  assert.equal(await one('SELECT state FROM issues WHERE id = ?', [iss.id]), 'closed');
});

test('labels: create, edit, prioritize, delete', async () => {
  const P = '/byteblaze/dotfiles';
  let r = await c.post(`${P}/-/labels`, { title: 'needs-review', color: '#ff0000', description: 'Please review' }, `${P}/-/labels/new`);
  assert.equal(r.status, 302);
  const id = await one(`SELECT id FROM labels WHERE title = 'needs-review' AND project_id = (SELECT id FROM projects WHERE full_path = 'byteblaze/dotfiles')`);
  assert.ok(id);
  r = await c.post(`${P}/-/labels`, { title: 'needs-review', color: '#ff0000' }, `${P}/-/labels/new`);
  assert.equal(r.status, 422, 'duplicate title rejected');
  await c.post(`${P}/-/labels/${id}/edit`, { title: 'needs review', color: '#00ff00', description: '' }, `${P}/-/labels`);
  assert.equal(await one('SELECT title || color FROM labels WHERE id = ?', [id]), 'needs review#00ff00');
  await c.post(`${P}/-/labels/${id}/toggle_priority`, {}, `${P}/-/labels`);
  assert.equal(await one('SELECT count(*) FROM label_priorities WHERE label_id = ?', [id]), 1);
  await c.post(`${P}/-/labels/${id}/delete`, {}, `${P}/-/labels`);
  assert.equal(await one('SELECT count(*) FROM labels WHERE id = ?', [id]), 0);
});

test('milestones: create with dates, show, close', async () => {
  const P = '/byteblaze/dotfiles';
  let r = await c.post(`${P}/-/milestones`, { title: 'product launch', start_date: '2023-01-16', due_date: '2023-01-30', description: '' }, `${P}/-/milestones/new`);
  assert.equal(r.status, 302);
  const m = (await q(`SELECT * FROM milestones WHERE title = 'product launch' AND project_id = (SELECT id FROM projects WHERE full_path = 'byteblaze/dotfiles')`))[0];
  assert.equal(m.start_date, '2023-01-16'); assert.equal(m.due_date, '2023-01-30');
  r = await c.get(r.location);
  assert.match(r.text, /class="block start_date"><span class="title">Start date<\/span><span class="value">Jan 16, 2023/);
  r = await c.post(`${P}/-/milestones`, { title: 'bad dates', start_date: '2023-02-16', due_date: '2023-01-01' }, `${P}/-/milestones/new`);
  assert.equal(r.status, 422);
  await c.post(`${P}/-/milestones/${m.iid}/close`, {}, `${P}/-/milestones`);
  assert.equal(await one('SELECT state FROM milestones WHERE id = ?', [m.id]), 'closed');
});

test('project members: invite by username with role and expiry, change role, remove', async () => {
  const P = '/byteblaze/dotfiles';
  const pid = await one("SELECT id FROM projects WHERE full_path = 'byteblaze/dotfiles'");
  let r = await c.post(`${P}/-/project_members`, { invitees: 'abisubramanya27, vinta', access_level: '10', expires_at: '2030-01-01' }, `${P}/-/project_members`);
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const rows = await q("SELECT u.username, m.access_level, m.expires_at, m.id FROM members m JOIN users u ON u.id = m.user_id WHERE m.source_type = 'project' AND m.source_id = ? ORDER BY u.username", [pid]);
  const abi = rows.find((x) => x.username === 'abisubramanya27');
  assert.equal(abi.access_level, 10); assert.equal(abi.expires_at, '2030-01-01');
  assert.ok(rows.find((x) => x.username === 'vinta'));
  r = await c.get(`${P}/-/project_members`);
  assert.match(r.text, /@abisubramanya27/);
  await c.post(`${P}/-/project_members/${abi.id}/update`, { access_level: '30' }, `${P}/-/project_members`);
  assert.equal(await one('SELECT access_level FROM members WHERE id = ?', [abi.id]), 30);
  r = await c.post(`${P}/-/project_members`, { invitees: 'nobody-here-xyz', access_level: '30' }, `${P}/-/project_members`);
  assert.equal(r.status, 422);
  r = await c.post(`${P}/-/project_members`, { invitees: 'someone@example.org', access_level: '20' }, `${P}/-/project_members`);
  assert.equal(await one("SELECT access_level FROM members WHERE source_type = 'project' AND source_id = ? AND invite_email = 'someone@example.org' AND user_id IS NULL", [pid]), 20);
  await c.post(`${P}/-/project_members/${abi.id}/delete`, {}, `${P}/-/project_members`);
  assert.equal(await one('SELECT count(*) FROM members WHERE id = ?', [abi.id]), 0);
});

test('groups: create with members, page, add member, group milestone', async () => {
  let r = await c.post('/groups', { name: 'n-lab', path: '', visibility: 'private', description: 'lab', invitees: 'patou, egpast', invite_access_level: '30' }, '/groups/new');
  assert.equal(r.status, 302, r.text.slice(0, 400));
  assert.equal(r.location, '/n-lab');
  const gid = await one("SELECT id FROM namespaces WHERE full_path = 'n-lab' AND kind = 'group'");
  assert.ok(gid);
  const mem = await q("SELECT u.username, m.access_level FROM members m JOIN users u ON u.id = m.user_id WHERE m.source_type = 'namespace' AND m.source_id = ? ORDER BY 1", [gid]);
  assert.deepEqual(mem.map((x) => `${x.username}:${x.access_level}`).sort(), ['byteblaze:50', 'egpast:30', 'patou:30'].sort());
  r = await c.get('/groups/n-lab');
  assert.equal(r.status, 200);
  r = await c.get('/dashboard/groups');
  assert.match(r.text, /href="\/n-lab"/);
  r = await c.post('/groups/n-lab/-/group_members', { invitees: 'westurner', access_level: '30' }, '/groups/n-lab/-/group_members');
  assert.equal(r.status, 302);
  r = await c.get('/groups/n-lab/-/group_members');
  assert.match(r.text, /@westurner/);
  r = await c.post('/groups', { name: 'n-lab', path: 'n-lab' }, '/groups/new');
  assert.equal(r.status, 422, 'taken path rejected');
  r = await c.post('/groups/n-lab/-/milestones', { title: 'Q1', due_date: '2023-03-31' }, '/groups/n-lab/-/milestones/new');
  assert.equal(r.status, 302);
  assert.equal(await one("SELECT count(*) FROM milestones WHERE group_id = ? AND title = 'Q1'", [gid]), 1);
});

test('merge request: create from a branch, review, approve, merge', async () => {
  // find a byteblaze branch that is ahead of its default branch and has no open MR
  const cands = await q(`SELECT p.full_path, p.id, p.default_branch, r.name FROM projects p JOIN refs r ON r.project_id = p.id AND r.kind = 'branch'
    WHERE p.namespace_id = (SELECT id FROM namespaces WHERE path = 'byteblaze') AND p.objects_policy = 'full' AND r.name != p.default_branch ORDER BY p.id, r.name`);
  let pick = null;
  for (const x of cands) {
    if (await one("SELECT count(*) FROM merge_requests WHERE project_id = ? AND source_branch = ? AND state = 'opened'", [x.id, x.name])) continue;
    const r = await c.get(`/${x.full_path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(x.name)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(x.default_branch)}`);
    if (r.status === 200 && /id="new_merge_request"/.test(r.text)) { pick = x; break; }
  }
  assert.ok(pick, 'a mergeable branch exists');
  const P = `/${pick.full_path}`;
  const oldHead = await one("SELECT sha FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?", [pick.id, pick.default_branch]);
  const commitCount0 = await one('SELECT commit_count FROM projects WHERE id = ?', [pick.id]);
  let r = await c.post(`${P}/-/merge_requests`, [['source_project_id', String(pick.id)], ['target_project_id', String(pick.id)], ['source_branch', pick.name], ['target_branch', pick.default_branch],
    ['title', 'Test merge'], ['description', 'Merging'], ['reviewer_ids_usernames', 'byteblaze'], ['force_remove_source_branch', '1']], `${P}/-/merge_requests/new`);
  assert.equal(r.status, 302, r.text.slice(0, 400));
  const mr = (await q("SELECT * FROM merge_requests WHERE project_id = ? AND title = 'Test merge'", [pick.id]))[0];
  assert.ok(mr && mr.state === 'opened' && mr.commits_count > 0 && mr.files_count >= 0);
  assert.equal(await one('SELECT count(*) FROM mr_reviewers WHERE merge_request_id = ?', [mr.id]), 1);
  assert.ok(await one('SELECT count(*) FROM mr_commits WHERE merge_request_id = ?', [mr.id]) > 0);
  for (const tab of ['', '/commits', '/diffs']) assert.equal((await c.get(`${P}/-/merge_requests/${mr.iid}${tab}`)).status, 200);
  // comment + approve
  await c.post(`${P}/-/merge_requests/${mr.iid}/notes`, { note: 'lgtm' }, `${P}/-/merge_requests/${mr.iid}`);
  assert.equal(await one("SELECT count(*) FROM notes WHERE noteable_type = 'merge_request' AND noteable_id = ? AND body = 'lgtm'", [mr.id]), 1);
  await c.post(`${P}/-/merge_requests/${mr.iid}/approve`, {}, `${P}/-/merge_requests/${mr.iid}`);
  assert.equal(await one('SELECT count(*) FROM mr_approvals WHERE merge_request_id = ?', [mr.id]), 1);
  // merge
  r = await c.post(`${P}/-/merge_requests/${mr.iid}/merge`, { should_remove_source_branch: '1' }, `${P}/-/merge_requests/${mr.iid}`);
  assert.equal(r.status, 302);
  const after = (await q('SELECT * FROM merge_requests WHERE id = ?', [mr.id]))[0];
  assert.equal(after.state, 'merged', 'merged');
  const head = await one("SELECT sha FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?", [pick.id, pick.default_branch]);
  assert.equal(head, after.merge_commit_sha);
  const mc = (await q('SELECT * FROM commits WHERE sha = ?', [head]))[0];
  assert.equal(mc.parents.split(' ')[0], oldHead);
  assert.equal(mc.parents.split(' ').length, 2);
  assert.match(mc.message, /See merge request/);
  assert.equal(await one('SELECT count(*) FROM project_commits WHERE project_id = ? AND commit_id = ?', [pick.id, mc.id]), 1);
  assert.equal(await one('SELECT commit_id FROM branch_commits WHERE project_id = ? AND branch = ? AND pos = 0', [pick.id, pick.default_branch]), mc.id);
  assert.ok(await one('SELECT commit_count FROM projects WHERE id = ?', [pick.id]) > commitCount0);
  assert.equal(await one("SELECT count(*) FROM refs WHERE project_id = ? AND kind = 'branch' AND name = ?", [pick.id, pick.name]), 0, 'source branch deleted');
  // the merge commit's tree is readable (has_tree) and the job recomputes contributors
  assert.equal(mc.has_tree, 1);
  await fetch(base + '/__rl/jobs/run', { method: 'POST' });
  assert.ok(await one('SELECT count(*) FROM contributors WHERE project_id = ? AND branch = ?', [pick.id, pick.default_branch]) > 0);
});

test('web commit on a new branch -> MR -> merge carries temp.repo_files to the target', { skip: !!process.env.COLLAB_HARNESS && 'needs the repo side' }, async () => {
  const P = '/byteblaze/cloud-to-butt';
  const p = (await q("SELECT id, default_branch FROM projects WHERE full_path = 'byteblaze/cloud-to-butt'"))[0];
  let r = await c.post(`${P}/-/create/${p.default_branch}/`, { file_name: 'NOTES.md', content: 'hello from a branch\n', commit_message: 'Add notes', branch_name: 'add-notes' }, `${P}/-/new/${p.default_branch}/`);
  assert.equal(r.status, 302, r.text.slice(0, 300));
  assert.equal(await one("SELECT content FROM repo_files WHERE project_id = ? AND branch = 'add-notes' AND path = 'NOTES.md'", [p.id]), 'hello from a branch\n');
  r = await c.post(`${P}/-/merge_requests`, { source_branch: 'add-notes', target_branch: p.default_branch, title: 'Add notes' }, `${P}/-/merge_requests/new`);
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const mr = (await q("SELECT * FROM merge_requests WHERE project_id = ? AND title = 'Add notes'", [p.id]))[0];
  assert.equal(mr.files_count, 1);
  r = await c.get(`${P}/-/merge_requests/${mr.iid}/diffs`);
  assert.match(r.text, /hello from a branch/);
  r = await c.post(`${P}/-/merge_requests/${mr.iid}/merge`, { should_remove_source_branch: '1' }, `${P}/-/merge_requests/${mr.iid}`);
  assert.equal(await one('SELECT state FROM merge_requests WHERE id = ?', [mr.id]), 'merged');
  assert.equal(await one('SELECT content FROM repo_files WHERE project_id = ? AND branch = ? AND path = ?', [p.id, p.default_branch, 'NOTES.md']), 'hello from a branch\n');
  assert.equal(await one("SELECT count(*) FROM refs WHERE project_id = ? AND kind = 'branch' AND name = 'add-notes'", [p.id]), 0);
  r = await c.get(`${P}/-/raw/${p.default_branch}/NOTES.md`);
  assert.equal(r.text, 'hello from a branch\n');
});

test('wiki and project settings', async () => {
  const P = '/byteblaze/dotfiles';
  let r = await c.post(`${P}/-/wikis`, { title: 'Setup guide', content: '# Setup\nRun `make`.', format: 'markdown' }, `${P}/-/wikis/new`);
  assert.equal(r.status, 302);
  assert.equal(r.location, `${P}/-/wikis/Setup-guide`);
  r = await c.get(r.location);
  assert.match(r.text, /Run <code>make<\/code>/);
  await c.post(`${P}/-/wikis/Setup-guide/edit`, { title: 'Setup-guide', content: 'v2', format: 'markdown' }, `${P}/-/wikis/Setup-guide/edit`);
  assert.equal(await one("SELECT content FROM wiki_pages WHERE slug = 'Setup-guide' AND project_id = (SELECT id FROM projects WHERE full_path = 'byteblaze/dotfiles')"), 'v2');
  r = await c.post(`${P}/edit`, { name: 'dotfiles', description: 'My dotfiles', visibility: 'private', topics: 'zsh, vim' }, `${P}/edit`);
  assert.equal(r.status, 302, r.text.slice(0, 300));
  const p = (await q("SELECT * FROM projects WHERE full_path = 'byteblaze/dotfiles'"))[0];
  assert.equal(p.visibility, 'private'); assert.equal(p.description, 'My dotfiles');
  assert.deepEqual((await q('SELECT t.name FROM project_topics pt JOIN topics t ON t.id = pt.topic_id WHERE pt.project_id = ? ORDER BY 1', [p.id])).map((x) => x.name), ['vim', 'zsh']);
  assert.equal((await anon.get(`${P}/-/issues`)).status, 404, 'private project hidden from anonymous users');
  await c.post(`${P}/archive`, {}, `${P}/edit`);
  assert.equal(await one('SELECT archived FROM projects WHERE id = ?', [p.id]), 1);
  await c.post(`${P}/unarchive`, {}, `${P}/edit`);
  r = await c.post(`${P}/rename`, { path: 'dotfiles2' }, `${P}/edit`);
  assert.equal(await one('SELECT full_path FROM projects WHERE id = ?', [p.id]), 'byteblaze/dotfiles2');
  r = await c.post('/byteblaze/dotfiles2/remove', { confirm_name: 'wrong' }, '/byteblaze/dotfiles2/edit');
  assert.equal(await one('SELECT count(*) FROM projects WHERE id = ?', [p.id]), 1);
  r = await c.post('/byteblaze/dotfiles2/remove', { confirm_name: 'byteblaze/dotfiles2' }, '/byteblaze/dotfiles2/edit');
  assert.equal(await one('SELECT count(*) FROM projects WHERE id = ?', [p.id]), 0);
});

test('reset restores the base state', async () => {
  assert.ok(await one("SELECT count(*) FROM namespaces WHERE full_path = 'n-lab'"));
  const r = await fetch(base + '/__rl/reset', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(await one("SELECT count(*) FROM namespaces WHERE full_path = 'n-lab'"), 0);
  assert.equal(await one("SELECT count(*) FROM issues WHERE title = '401 bad gateway'"), 0);
  assert.equal(await one("SELECT count(*) FROM projects WHERE full_path = 'byteblaze/dotfiles'"), 1);
  assert.equal(await one("SELECT count(*) FROM merge_requests WHERE title = 'Test merge'"), 0);
});
