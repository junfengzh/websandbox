'use strict';
// Repository side of the code hosting site against the real base.db:
//   node --test sites/code/test/repo.test.js     (env CODE_DATA, default $WSB_DATA_ROOT/code)
// Overlay DB mode: tenants share base.db and never commit, so this can run beside a dev server.
// Logins use POST /__rl/login (no passwords in the repo); the sign-in form is tested with a
// freshly registered user.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Client, rl, q } = require('../../../kit/test/helpers');

const DATA = process.env.CODE_DATA || '$WSB_DATA_ROOT/code';
const TMP = (process.env.WSB_TMP || require('os').tmpdir());
const HAVE = fs.existsSync(path.join(DATA, 'base.db'));
const P = 'byteblaze/gimmiethat.space';

let s, A, B, uploads;
test.before(async () => {
  if (!HAVE) return;
  uploads = fs.mkdtempSync(path.join(fs.existsSync(TMP) ? TMP : os.tmpdir(), 'wsb-code-up-'));
  const site = require('../server.js');
  s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads, jobTickMs: 50 });
  A = s.url(0); B = s.url(1);
});
test.after(async () => { if (s) await s.close(); if (uploads) fs.rmSync(uploads, { recursive: true, force: true }); });
test.beforeEach(async () => { if (HAVE) await rl(A, '/reset?all=1', {}); });
const T = (name, fn) => test(name, { skip: !HAVE && 'no base.db' }, fn);

const one = async (base, sql) => { const r = await q(base, sql); return r.length ? Object.values(r[0])[0] : null; };
async function as(user, base = A) {
  const c = new Client(base);
  const r = await rl(base, '/login', { user });
  c.jar.set(r.cookie.name, r.cookie.value);
  return c;
}
const csrfOf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];
async function postForm(c, page, action, form) {
  const _csrf = csrfOf((await c.get(page)).text);
  return c.post(action, { form: { _csrf, ...form } });
}
const gitSha = (type, body) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body])).digest('hex');

T('public pages render (anonymous)', async () => {
  const c = new Client(A);
  for (const p of ['/explore/projects', '/explore/projects?sort=stars_desc', '/explore/projects/starred', '/explore/projects/trending', '/explore/groups', '/explore/users',
    '/users/sign_in', '/users/sign_up', '/byteblaze', '/users/byteblaze/starred', '/users/byteblaze/following', '/users/byteblaze/followers', '/users/byteblaze/activity',
    '/a11yproject/a11yproject.com', '/a11yproject/a11yproject.com/-/tree/main', '/a11yproject/a11yproject.com/-/commits/main', '/a11yproject/a11yproject.com/-/branches',
    '/a11yproject/a11yproject.com/-/tags', '/a11yproject/a11yproject.com/-/graphs/main', '/vinta/awesome-python/-/graphs/master', '/primer/design/-/forks', '/primer/design/-/starrers',
    '/primer/design/activity', '/primer/design/-/compare', '/primer/design/-/network/main', '/search?search=python', '/search?search=bug&scope=issues', '/gcc-mirror/gcc', '/gcc-mirror/gcc/-/commits/master?page=5']) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<main id="content-body"/, p);
  }
  assert.equal((await c.get('/')).status, 302);
  assert.equal((await c.get('/nosuchuser')).status, 404);
  assert.equal((await c.get('/primer/nosuchproject')).status, 404);
  assert.equal((await c.get(`/${P}`)).status, 404, 'private project hidden from anonymous');
  assert.equal((await c.get('/dashboard/projects')).location, '/users/sign_in?next=%2Fdashboard%2Fprojects');
});

T('explore sorts by stars like GitLab', async () => {
  const c = new Client(A);
  const html = (await c.get('/explore/projects?sort=stars_desc')).text;
  const first = /class="project-title"><a href="\/([^"]+)"/.exec(html)[1];
  const want = await one(A, "SELECT full_path FROM projects WHERE visibility = 'public' AND archived = 0 ORDER BY star_count DESC, id LIMIT 1");
  assert.equal(first, want);
});

T('register, sign out, sign in with the form', async () => {
  const c = new Client(A);
  let r = await postForm(c, '/users/sign_up', '/users/sign_up', { first_name: 'Test', last_name: 'User', username: 'tuser1', email: 'tuser1@example.com', password: 'longpassword1' });
  assert.equal(r.status, 302);
  assert.equal(await one(A, "SELECT count(*) FROM namespaces WHERE path = 'tuser1' AND kind = 'user'"), 1);
  r = await postForm(c, '/dashboard/projects', '/users/sign_out', {});
  assert.equal(r.status, 302);
  r = await postForm(c, '/users/sign_in', '/users/sign_in', { login: 'tuser1', password: 'wrong-password' });
  assert.match(r.text, /Invalid login or password/);
  r = await postForm(c, '/users/sign_in', '/users/sign_in', { login: 'tuser1@example.com', password: 'longpassword1', next: '/explore' });
  assert.equal(r.location, '/explore');
  assert.match((await c.get('/dashboard/projects')).text, /Your projects/);
});

T('file browser: tree, blob, raw, blame, find file, refs with slashes', async () => {
  const c = await as('byteblaze');
  let r = await c.get(`/${P}/-/tree/main`);
  assert.match(r.text, /index\.html/);
  r = await c.get(`/${P}/-/blob/main/index.html`);
  assert.match(r.text, /hljs-tag/);
  r = await c.get(`/${P}/-/raw/main/index.html`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.match(r.text, /^<!DOCTYPE html>/i);
  assert.equal((await c.get(`/${P}/-/blame/main/index.html`)).status, 200);
  assert.match((await c.get(`/${P}/-/find_file/main?q=pkg`)).text, /package\.json/);
  r = await c.get('/amwhalen/archive-my-tweets/-/tree/github/fork/chtitux/addRssFeed');
  assert.equal(r.status, 200);
  assert.equal((await c.get(`/${P}/-/blob/main/nope.txt`)).status, 404);
  // a recent-policy repo: old commits show the "history truncated" message
  const old = await one(A, "SELECT c.sha FROM branch_commits b JOIN commits c ON c.id = b.commit_id JOIN projects p ON p.id = b.project_id WHERE p.full_path = 'keycloak/keycloak' AND b.branch = 'main' AND c.has_tree = 0 LIMIT 1");
  r = await c.get(`/keycloak/keycloak/-/tree/${old}`);
  assert.match(r.text, /History truncated/);
  r = await c.get(`/keycloak/keycloak/-/commit/${old}`);
  assert.match(r.text, /History truncated/);
});

T('stored trees round-trip through the tree serializer (real git ids)', async () => {
  const rows = await q(A, "SELECT sha, enc, hex(data) AS d FROM git_objects WHERE type = 'tree' AND omitted = 0 AND rowid % 997 = 0 LIMIT 40");
  const git = require('../repo/lib/git');
  for (const r of rows) {
    let buf = Buffer.from(r.d, 'hex');
    if (r.enc === 1) buf = zlib.inflateSync(buf);
    assert.equal(gitSha('tree', buf), r.sha);
    assert.equal(gitSha('tree', git.serializeTree(git.parseTree(buf))), r.sha);
  }
});

T('web editor: edit commits a real blob/tree/commit, history + contributors update, reset restores', async () => {
  const c = await as('byteblaze');
  const pid = await one(A, `SELECT id FROM projects WHERE full_path = '${P}'`);
  const head0 = await one(A, `SELECT sha FROM refs WHERE project_id = ${pid} AND kind = 'branch' AND name = 'main'`);
  const n0 = await one(A, `SELECT commit_count FROM projects WHERE id = ${pid}`);
  const content = '<!doctype html>\n<title>edited</title>\n';
  const r = await postForm(c, `/${P}/-/edit/main/index.html`, `/${P}/-/update/main/index.html`, { file_path: 'index.html', content, commit_message: 'Edit index via web editor', branch_name: 'main' });
  assert.equal(r.status, 302);
  assert.equal(r.location, `/${P}/-/blob/main/index.html`);
  const head = await q(A, `SELECT c.* FROM refs r JOIN commits c ON c.sha = r.sha WHERE r.project_id = ${pid} AND r.kind = 'branch' AND r.name = 'main'`);
  const cm = head[0];
  assert.notEqual(cm.sha, head0);
  assert.equal(cm.parents, head0);
  assert.equal(cm.title, 'Edit index via web editor');
  assert.equal(cm.author_name, 'Byte Blaze');
  assert.equal(cm.has_tree, 1);
  assert.equal(await one(A, `SELECT count(*) FROM git_objects WHERE sha = '${gitSha('blob', Buffer.from(content))}'`), 1);
  assert.equal(await one(A, `SELECT count(*) FROM project_commits WHERE project_id = ${pid} AND commit_id = ${cm.id}`), 1);
  assert.equal(await one(A, `SELECT commit_id FROM branch_commits WHERE project_id = ${pid} AND branch = 'main' ORDER BY pos LIMIT 1`), cm.id);
  assert.equal(await one(A, `SELECT commit_count FROM projects WHERE id = ${pid}`), n0 + 1);
  assert.equal(await one(A, `SELECT p.path FROM commit_files f JOIN paths p ON p.id = f.path_id WHERE f.commit_id = ${cm.id}`), 'index.html');
  assert.equal(await one(A, `SELECT count(*) FROM events WHERE project_id = ${pid} AND action = 'pushed' AND push_commit_to = '${cm.sha}'`), 1);
  // graders read web-edited files from temp.repo_files
  assert.equal(await one(A, `SELECT content FROM repo_files WHERE project_id = ${pid} AND branch = 'main' AND path = 'index.html'`), content);
  // pages show it
  assert.match((await c.get(`/${P}/-/raw/main/index.html`)).text, /<title>edited<\/title>/);
  assert.match((await c.get(`/${P}/-/commits/main`)).text, /Edit index via web editor/);
  const diff = (await c.get(`/${P}/-/commit/${cm.sha}`)).text;
  assert.match(diff, /class="add"/);
  // contributors job (runs on the tenant's clock tick)
  await rl(A, '/jobs/run', {});
  const email = await one(A, "SELECT lower(email) FROM users WHERE username = 'byteblaze'");
  assert.ok((await one(A, `SELECT commits FROM contributors WHERE project_id = ${pid} AND branch = 'main' AND author_email = '${email}'`)) >= 1);
  // tenant B never saw it; reset restores A
  assert.equal(await one(B, `SELECT sha FROM refs WHERE project_id = ${pid} AND kind = 'branch' AND name = 'main'`), head0);
  await rl(A, '/reset', {});
  assert.equal(await one(A, `SELECT sha FROM refs WHERE project_id = ${pid} AND kind = 'branch' AND name = 'main'`), head0);
  assert.equal(await one(A, `SELECT count(*) FROM commits WHERE sha = '${cm.sha}'`), 0);
  assert.equal(await one(A, 'SELECT count(*) FROM repo_files'), 0);
});

T('web editor: new file on a new branch (+ MR redirect), delete file, validation', async () => {
  const c = await as('byteblaze');
  const pid = await one(A, `SELECT id FROM projects WHERE full_path = '${P}'`);
  let r = await postForm(c, `/${P}/-/new/main/`, `/${P}/-/create/main/docs`, { file_name: 'guide/intro.md', content: '# Intro\n', commit_message: 'Add intro', branch_name: 'docs-1', create_merge_request: '1' });
  assert.equal(r.status, 302);
  assert.match(r.location, /\/-\/merge_requests\/new\?merge_request%5Bsource_branch%5D=docs-1/);
  assert.equal(await one(A, `SELECT count(*) FROM refs WHERE project_id = ${pid} AND kind = 'branch' AND name = 'docs-1'`), 1);
  r = await c.get(`/${P}/-/blob/docs-1/docs/guide/intro.md`);
  assert.equal(r.status, 200);
  assert.match(r.text, /<h1[^>]*>.*Intro<\/h1>/);
  assert.match((await c.get(`/${P}/-/commits/docs-1`)).text, /Add intro/);
  r = await postForm(c, `/${P}/-/blob/main/AUTHORS`, `/${P}/-/delete/main/AUTHORS`, { commit_message: 'Remove AUTHORS', branch_name: 'main' });
  assert.equal(r.status, 302);
  assert.equal((await c.get(`/${P}/-/blob/main/AUTHORS`)).status, 404);
  assert.equal(await one(A, `SELECT content IS NULL FROM repo_files WHERE project_id = ${pid} AND branch = 'main' AND path = 'AUTHORS'`), 1);
  assert.equal(await one(A, `SELECT content FROM repo_files WHERE project_id = ${pid} AND branch = 'docs-1' AND path = 'docs/guide/intro.md'`), '# Intro\n');
  r = await postForm(c, `/${P}/-/new/main/`, `/${P}/-/create/main`, { file_name: 'index.html', content: 'x', commit_message: 'dup', branch_name: 'main' });
  assert.equal(r.status, 422);
  assert.match(r.text, /already exists/);
  r = await postForm(c, `/${P}/-/new/main/`, `/${P}/-/create/main`, { file_name: 'x.txt', content: 'x', commit_message: '', branch_name: 'main' });
  assert.equal(r.status, 422);
  // CSRF is required
  r = await c.post(`/${P}/-/create/main`, { form: { file_name: 'y.txt', content: 'y', commit_message: 'y', branch_name: 'main' } });
  assert.equal(r.status, 403);
});

T('permissions: a non-member cannot commit; private project hidden', async () => {
  const c = await as('vinta');
  assert.equal((await c.get(`/${P}`)).status, 404);
  const pub = await as('vinta');
  const r = await postForm(pub, '/primer/design/-/blob/main/README.md', '/primer/design/-/update/main/README.md', { file_path: 'README.md', content: 'x', commit_message: 'x', branch_name: 'main' });
  assert.equal(r.status, 403);
});

T('stars, forks, follow, new project, branches, tags', async () => {
  const c = await as('byteblaze');
  const s0 = await one(A, "SELECT star_count FROM projects WHERE full_path = 'primer/design'");
  let r = await postForm(c, '/primer/design', '/primer/design/-/toggle_star', { star: '1' });
  assert.equal(r.status, 302);
  assert.equal(await one(A, "SELECT star_count FROM projects WHERE full_path = 'primer/design'"), s0 + 1);
  assert.match((await c.get('/dashboard/projects/starred')).text, /primer\/design|Primer/);
  await postForm(c, '/primer/design', '/primer/design/-/toggle_star', { star: '0' });
  assert.equal(await one(A, "SELECT star_count FROM projects WHERE full_path = 'primer/design'"), s0);
  // fork into byteblaze's namespace
  const ns = await one(A, "SELECT id FROM namespaces WHERE path = 'byteblaze' AND kind = 'user'");
  const f0 = await one(A, "SELECT forks_count FROM projects WHERE full_path = 'convexegg/chatgpt'");
  r = await postForm(c, '/convexegg/chatgpt/-/forks/new', '/convexegg/chatgpt/-/forks', { name: 'chatgpt', path: 'chatgpt', namespace_id: String(ns), visibility: 'public' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/byteblaze/chatgpt');
  assert.equal(await one(A, "SELECT forked_from_id = (SELECT id FROM projects WHERE full_path = 'convexegg/chatgpt') FROM projects WHERE full_path = 'byteblaze/chatgpt'"), 1);
  assert.equal(await one(A, "SELECT forks_count FROM projects WHERE full_path = 'convexegg/chatgpt'"), f0 + 1);
  assert.equal((await c.get('/byteblaze/chatgpt')).status, 200);
  assert.equal((await c.get('/byteblaze/chatgpt/-/commits/main')).status, 200);
  // follow
  r = await postForm(c, '/vinta', '/users/vinta/follow', {});
  assert.equal(await one(A, "SELECT count(*) FROM follows WHERE follower_id = (SELECT id FROM users WHERE username = 'byteblaze') AND followee_id = (SELECT id FROM users WHERE username = 'vinta')"), 1);
  assert.match((await c.get('/users/byteblaze/following')).text, /@vinta/);
  // new projects
  r = await postForm(c, '/projects/new', '/projects', { name: 'Web Agent X', path: 'web_agent_x', namespace_id: String(ns), visibility: 'private', readme: '1', mode: 'blank' });
  assert.equal(r.location, '/byteblaze/web_agent_x');
  assert.match((await c.get('/byteblaze/web_agent_x')).text, /README\.md/);
  r = await postForm(c, '/projects/new', '/projects', { name: 'node app', path: 'node-app', namespace_id: String(ns), visibility: 'public', mode: 'template', template: 'express' });
  assert.equal(r.location, '/byteblaze/node-app');
  assert.equal(await one(A, "SELECT template_name FROM projects WHERE full_path = 'byteblaze/node-app'"), 'express');
  assert.match((await c.get('/byteblaze/node-app')).text, /app\.js|package\.json/);
  r = await postForm(c, '/projects/new', '/projects', { name: 'gimmiethat.space', path: 'gimmiethat.space', namespace_id: String(ns), visibility: 'private', mode: 'blank' });
  assert.equal(r.status, 422);
  // branches and tags
  r = await postForm(c, `/${P}/-/branches/new`, `/${P}/-/branches`, { branch_name: 'feature/x', ref: 'main' });
  assert.equal(r.status, 302);
  assert.match((await c.get(`/${P}/-/branches/all`)).text, /feature\/x/);
  assert.equal((await c.get(`/${P}/-/tree/feature/x`)).status, 200);
  r = await postForm(c, `/${P}/-/branches`, `/${P}/-/branches/delete`, { branch_name: 'feature/x' });
  assert.equal(await one(A, "SELECT count(*) FROM refs WHERE name = 'feature/x'"), 0);
  r = await postForm(c, `/${P}/-/tags/new`, `/${P}/-/tags`, { tag_name: 'v9.9', ref: 'main', message: 'Release 9.9' });
  assert.equal(r.status, 302);
  assert.match((await c.get(`/${P}/-/tags`)).text, /v9\.9/);
});

T('profile settings and status', async () => {
  const c = await as('byteblaze');
  let r = await postForm(c, '/-/profile', '/-/profile', { name: 'Byte Blaze', bio: 'Hello there', website_url: 'https://byteblaze.example', location: 'Pittsburgh' });
  assert.equal(r.status, 302);
  const u = (await q(A, "SELECT bio, website_url, location FROM users WHERE username = 'byteblaze'"))[0];
  assert.deepEqual(u, { bio: 'Hello there', website_url: 'https://byteblaze.example', location: 'Pittsburgh' });
  r = await postForm(c, '/-/profile', '/-/profile/status', { status_message: 'Out sick', status_busy: '1' });
  assert.equal(await one(A, "SELECT message || '|' || availability FROM user_statuses WHERE user_id = (SELECT id FROM users WHERE username = 'byteblaze')"), 'Out sick|busy');
  assert.match((await c.get('/byteblaze')).text, /Out sick/);
  assert.match((await c.get('/-/profile/personal_access_tokens')).text, /id="feed_token"/);
});

T('contributors page matches the contributors table (GitLab 15.7 numbers)', async () => {
  const c = new Client(A);
  const html = (await c.get('/vinta/awesome-python/-/graphs/master')).text;
  const m = /contributor-name">Vinta Chen<\/h3>\s*<div class="commits"><strong>([\d,]+)<\/strong>/.exec(html);
  assert.ok(m);
  const want = await one(A, "SELECT commits FROM contributors WHERE project_id = (SELECT id FROM projects WHERE full_path = 'vinta/awesome-python') AND branch = 'master' AND author_email = 'vinta.chen@gmail.com'");
  assert.equal(Number(m[1].replace(/,/g, '')), want);
});

T('commits list: author filter, path filter, pagination', async () => {
  const c = new Client(A);
  let html = (await c.get('/facebook/create-react-app/-/commits/main?author=Dan%20Abramov')).text;
  const authors = [...html.matchAll(/class="commit-author-link"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.ok(authors.length > 0 && authors.every((a) => a.includes('Dan Abramov')));
  html = (await c.get('/facebook/create-react-app/-/commits/main/README.md')).text;
  assert.ok((html.match(/class="commit-row"/g) || []).length > 0);
  html = (await c.get('/facebook/create-react-app/-/commits/main?page=2')).text;
  assert.match(html, /rel="prev"/);
});
