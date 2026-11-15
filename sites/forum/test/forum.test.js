'use strict';
// Forum routes against the real base.db: node --test sites/forum/test/forum.test.js
// Env: FORUM_DATA (default $WSB_DATA_ROOT/forum). Overlay DB mode (kit
// default): tenants share base.db and never commit, so tests can run beside a dev server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, rl, q } = require('../../../kit/test/helpers');

const DATA = process.env.FORUM_DATA || '$WSB_DATA_ROOT/forum';
const TMP = (process.env.WSB_TMP || require('os').tmpdir());
const ME = 'MarvelsGrantMan136'; const ME_ID = 13915; const PW = 'test1234';

let s, A, B, uploads;
test.before(async () => {
  uploads = fs.mkdtempSync(path.join(fs.existsSync(TMP) ? TMP : os.tmpdir(), 'wsb-forum-up-'));
  const site = require('../server.js');
  s = await site.start({ tenants: 2, port: 0, data: DATA, bind: 'ports', uploads, jobTickMs: 50 });
  A = s.url(0); B = s.url(1);
});
test.after(async () => { await s.close(); fs.rmSync(uploads, { recursive: true, force: true }); });
test.beforeEach(async () => { await rl(A, '/reset?all=1', {}); });

const one = async (base, sql) => { const r = await q(base, sql); return r.length ? Object.values(r[0])[0] : null; };
async function login(base = A, user = ME) { const c = new Client(base); await c.login(user, PW); return c; }
const csrfOf = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)[1];

test('public pages render', async () => {
  const c = new Client(A);
  for (const p of ['/', '/new', '/all/top?t=year', '/f/books', '/f/BOOKS/new', '/f/DIY/active', '/forums', '/forums/all', '/forums/by_category', '/tag/technology',
    '/f/books/59421/friendly-reminder-bookshop-org-exists', '/f/books/59421/-/comment/1235250', '/user/MarvelsGrantMan136', '/user/MarvelsGrantMan136/comments',
    '/search?q=bookshop', '/search?q=bookshop&type=comments', '/search?q=book&type=forums', '/comments', '/moderation_log', '/wiki/_all', '/users', '/login', '/registration']) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
    assert.match(r.text, /<h1/, p);
  }
  assert.equal((await c.get('/f/nosuchforum')).status, 404);
  assert.equal((await c.get('/f/books/1')).status, 404); // submission 1 is in MachineLearning
  assert.equal((await c.get('/f/MachineLearning/1')).location, '/f/MachineLearning/1/nvidia-rtx-4090');
  assert.equal((await c.get('/submit')).status, 302); // login required
});

test('listing order matches Postmill sorts', async () => {
  const c = new Client(A);
  const ids = (html) => [...html.matchAll(/id="submission-(\d+)"/g)].map((m) => +m[1]);
  const fid = await one(A, "SELECT id FROM forums WHERE normalized_name = 'books'");
  const newest = (await q(A, `SELECT id FROM submissions WHERE forum_id = ${fid} AND visibility = 'visible' ORDER BY id DESC LIMIT 25`)).map((r) => r.id);
  assert.deepEqual(ids((await c.get('/f/books/new')).text), newest);
  assert.equal(newest[0], 124260); // task 404
  const top = (await q(A, `SELECT id FROM submissions WHERE forum_id = ${fid} AND visibility = 'visible' ORDER BY net_score DESC, id DESC LIMIT 25`)).map((r) => r.id);
  assert.deepEqual(ids((await c.get('/f/books/top')).text), top);
  const p2 = (await q(A, `SELECT id FROM submissions WHERE forum_id = ${fid} AND visibility = 'visible' ORDER BY ranking DESC, id DESC LIMIT 25 OFFSET 25`)).map((r) => r.id);
  assert.deepEqual(ids((await c.get('/f/books?page=2')).text), p2);
  const active = ids((await c.get('/f/DIY/active')).text).slice(0, 10);
  assert.deepEqual(active, [118903, 118923, 118935, 118904, 118960, 118931, 118824, 118866, 118820, 118836]); // tasks 562-566
  assert.equal(ids((await c.get('/f/gadgets/top')).text)[0], 19459); // task 714
});

test('login, header and logout', async () => {
  const c = await login();
  const r = await c.get('/');
  assert.match(r.text, /MarvelsGrantMan136/);
  assert.match(r.text, /action="\/logout"/);
  const bad = new Client(A);
  const t = await bad.csrf('/login');
  const f = await bad.post('/login', { form: { login: ME, password: 'wrong', _csrf: t } });
  assert.match(f.text, /Invalid username or password/);
});

test('CSRF is required for writes', async () => {
  const c = await login();
  const r = await c.post('/sv/59421', { form: { choice: '1' } });
  assert.equal(r.status, 403);
});

test('votes: JSON and form fallback, toggling', async () => {
  const c = await login();
  const t = await c.csrf('/f/books/59421/-');
  const before = await one(A, 'SELECT net_score FROM submissions WHERE id = 59421');
  let r = await c.post('/sv/59421.json', { form: { choice: '1' }, headers: { 'x-csrf-token': t, accept: 'application/json' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { netScore: before + 1, choice: 1 });
  assert.equal(await one(A, `SELECT upvote FROM submission_votes WHERE user_id = ${ME_ID} AND submission_id = 59421`), 1);
  r = await c.post('/sv/59421', { form: { choice: '-1', _csrf: t, next: '/f/books/59421/-' } });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/f/books/59421/-');
  assert.equal(await one(A, `SELECT upvote FROM submission_votes WHERE user_id = ${ME_ID} AND submission_id = 59421`), 0);
  assert.equal(await one(A, 'SELECT net_score FROM submissions WHERE id = 59421'), before - 1);
  const page = await c.get('/f/books/59421/-');
  assert.match(page.text, /class="vote vote--user-downvoted" data-vote="submission" data-id="59421"/);
  r = await c.post('/sv/59421', { form: { choice: '0', _csrf: t } });
  assert.equal(await one(A, `SELECT count(*) FROM submission_votes WHERE user_id = ${ME_ID} AND submission_id = 59421`), 0);
  r = await c.post('/cv/1235250.json', { form: { choice: '-1' }, headers: { 'x-csrf-token': t } });
  assert.equal(r.json().choice, -1);
  assert.equal(await one(A, `SELECT upvote FROM comment_votes WHERE user_id = ${ME_ID} AND comment_id = 1235250`), 0);
  const anon = await new Client(A).post('/sv/59421.json', { form: { choice: '1' } });
  assert.equal(anon.status, 403); // no session -> CSRF fails before the login check
});

test('comments: post, reply notification, edit, delete', async () => {
  const c = await login();
  const t = await c.csrf('/f/books/59421/-');
  let r = await c.post('/f/books/59421/-/comment', { form: { comment: 'Great tip, thanks!', _csrf: t } });
  assert.equal(r.status, 302);
  const cid = await one(A, `SELECT max(id) FROM comments WHERE user_id = ${ME_ID}`);
  assert.match(r.location, new RegExp(`#comment-${cid}$`));
  assert.equal(await one(A, `SELECT body FROM comments WHERE id = ${cid}`), 'Great tip, thanks!');
  assert.equal(await one(A, 'SELECT comment_count FROM submissions WHERE id = 59421'), 126);
  // reply to ameliaspond's comment -> she gets a notification
  r = await c.post('/f/books/59421/-/comment', { form: { comment: 'Agreed @ReallyGene', parent_id: '1235250', _csrf: t } });
  const rid = await one(A, `SELECT max(id) FROM comments WHERE user_id = ${ME_ID}`);
  assert.equal(await one(A, `SELECT parent_id FROM comments WHERE id = ${rid}`), 1235250);
  assert.equal(await one(A, `SELECT count(*) FROM notifications WHERE comment_id = ${rid} AND notification_type = 'comment' AND user_id = (SELECT user_id FROM comments WHERE id = 1235250)`), 1);
  assert.equal(await one(A, `SELECT count(*) FROM notifications WHERE comment_id = ${rid} AND notification_type = 'comment_mention'`), 1);
  const page = await c.get('/f/books/59421/-');
  assert.match(page.text, /Great tip, thanks!/);
  assert.match(page.text, new RegExp(`id="comment-${rid}"`));
  r = await c.post(`/f/books/59421/-/comment/${cid}/edit`, { form: { comment: 'Great tip, thanks! (edited)', _csrf: t } });
  assert.equal(r.status, 302);
  assert.equal(await one(A, `SELECT body FROM comments WHERE id = ${cid}`), 'Great tip, thanks! (edited)');
  r = await c.post(`/f/books/59421/-/comment/${cid}/delete_own`, { form: { _csrf: t } });
  assert.equal(await one(A, `SELECT visibility FROM comments WHERE id = ${cid}`), 'soft_deleted');
  r = await c.post('/f/books/59421/-/comment/1235250/edit', { form: { comment: 'hijack', _csrf: t } });
  assert.equal(r.status, 403);
  // the recipient sees the notification
  const n = await (await login(A, 'ameliaspond')).get('/notifications');
  assert.match(n.text, /replied to you/);
});

test('submit text and link posts; edit and delete', async () => {
  const c = await login();
  const t = await c.csrf('/submit/books');
  let r = await c.post('/submit', { form: { type: 'text', forum: 'books', title: 'What is your favourite book?', body: 'Mine is **Dune**.', _csrf: t } });
  assert.equal(r.status, 302);
  const id = await one(A, `SELECT max(id) FROM submissions WHERE user_id = ${ME_ID}`);
  assert.equal(r.location, `/f/books/${id}/what-is-your-favourite-book`);
  const row = (await q(A, `SELECT s.*, f.name forum FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.id = ${id}`))[0];
  assert.equal(row.forum, 'books'); assert.equal(row.body, 'Mine is **Dune**.'); assert.equal(row.net_score, 1);
  assert.equal(await one(A, `SELECT upvote FROM submission_votes WHERE submission_id = ${id} AND user_id = ${ME_ID}`), 1);
  assert.match((await c.get(r.location)).text, /<strong>Dune<\/strong>/);
  assert.equal(ids((await c.get('/f/books/new')).text)[0], id);
  r = await c.post('/submit', { form: { type: 'link', forum: 'books', title: '', url: 'not a url', _csrf: t } });
  assert.equal(r.status, 422);
  assert.match(r.text, /Title is required/);
  r = await c.post('/submit', { form: { type: 'link', forum: 'technology', title: 'A link', url: 'https://example.com/x', _csrf: t } });
  const lid = await one(A, `SELECT max(id) FROM submissions WHERE user_id = ${ME_ID}`);
  assert.equal(await one(A, `SELECT url FROM submissions WHERE id = ${lid}`), 'https://example.com/x');
  r = await c.post(`/f/books/${id}/-/edit`, { form: { title: 'What is your favourite novel?', body: 'Dune.', _csrf: t } });
  assert.equal(r.status, 302);
  assert.equal(await one(A, `SELECT title || '|' || body || '|' || (edited_at IS NOT NULL) FROM submissions WHERE id = ${id}`), 'What is your favourite novel?|Dune.|1');
  r = await c.post(`/f/books/${id}/-/delete`, { form: { _csrf: t } });
  assert.equal(await one(A, `SELECT visibility FROM submissions WHERE id = ${id}`), 'soft_deleted');
  assert.equal((await c.post('/f/books/59421/-/edit', { form: { title: 'x', _csrf: t } })).status, 403);
});
const ids = (html) => [...html.matchAll(/id="submission-(\d+)"/g)].map((m) => +m[1]);

test('image upload goes to the tenant upload dir and is served', async () => {
  const c = await login();
  const t = await c.csrf('/submit');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2a83d1f0000000049454e44ae426082', 'hex');
  const fd = new FormData();
  for (const [k, v] of Object.entries({ type: 'image', forum: 'pics', title: 'A tiny pixel', _csrf: t })) fd.append(k, v);
  fd.append('image', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const r = await fetch(A + '/submit', { method: 'POST', body: fd, headers: { cookie: c.cookie() }, redirect: 'manual' });
  assert.equal(r.status, 302);
  const row = (await q(A, `SELECT s.id, i.file_name, i.path FROM submissions s JOIN images i ON i.id = s.image_id WHERE s.user_id = ${ME_ID} ORDER BY s.id DESC LIMIT 1`))[0];
  assert.match(row.file_name, /^[0-9a-f]{64}\.png$/);
  assert.match(row.path, /^\/uploads\//);
  const img = await fetch(A + '/submission_images/' + row.file_name);
  assert.equal(img.status, 200);
  assert.equal(Buffer.from(await img.arrayBuffer()).length, png.length);
  assert.equal((await fetch(A + '/submission_images/b02113033af3e2f93a9e3b3e8b1d0b0e.jpg')).status, 404);
  const orig = await one(A, "SELECT i.file_name FROM submissions s JOIN images i ON i.id = s.image_id WHERE s.id = 110715");
  assert.equal((await fetch(A + '/submission_images/' + orig)).status, 200); // task 615's image by its original name
  await rl(A, '/reset', {});
  assert.equal((await fetch(A + '/submission_images/' + row.file_name)).status, 404);
});

test('subscriptions drive the subscribed front page and sidebar', async () => {
  const c = await login();
  const t = await c.csrf('/f/books');
  let r = await c.post('/f/books/subscribe', { form: { _csrf: t } });
  assert.equal(r.status, 302);
  await c.post('/f/nyc/subscribe', { form: { _csrf: t } });
  assert.equal(await one(A, `SELECT count(*) FROM forum_subscriptions WHERE user_id = ${ME_ID}`), 2);
  const front = await c.get('/');
  const side = /<aside id="sidebar"[\s\S]*?<\/aside>/.exec(front.text)[0];
  assert.match(side, /href="\/f\/books"/); assert.match(side, /href="\/f\/nyc"/);
  const forums = await q(A, `SELECT DISTINCT f.name FROM submissions s JOIN forums f ON f.id = s.forum_id WHERE s.id IN (${ids(front.text).join(',')})`);
  assert.deepEqual(forums.map((x) => x.name).sort(), ['books', 'nyc']);
  r = await c.post('/f/books/unsubscribe', { form: { _csrf: t } });
  assert.equal(await one(A, `SELECT count(*) FROM forum_subscriptions WHERE user_id = ${ME_ID}`), 1);
});

test('create and edit a forum; moderation: lock, remove, ban, log', async () => {
  const c = await login();
  const t = await c.csrf('/create_forum');
  let r = await c.post('/create_forum', { form: { name: 'cmu_lti', title: 'CMU LTI', description: 'Language Technologies Institute', sidebar: 'Be nice', tags: 'Technology, Education', _csrf: t } });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/f/cmu_lti');
  const fid = await one(A, "SELECT id FROM forums WHERE name = 'cmu_lti'");
  assert.equal(await one(A, `SELECT user_id FROM moderators WHERE forum_id = ${fid}`), ME_ID);
  assert.equal(await one(A, `SELECT group_concat(name) FROM (SELECT t.name FROM forums_tags ft JOIN forum_tags t ON t.id = ft.tag_id WHERE ft.forum_id = ${fid} ORDER BY t.name)`), 'Education,Technology');
  const edit = await c.get('/f/cmu_lti/edit');
  assert.match(edit.text, /id="forum_description"/); assert.match(edit.text, /id="forum_sidebar"/);
  r = await c.post('/f/cmu_lti/edit', { form: { title: 'CMU LTI', description: 'Updated description', sidebar: 'Rule 1: be nice', tags: 'Technology', _csrf: t } });
  assert.equal(await one(A, `SELECT description || '|' || sidebar FROM forums WHERE id = ${fid}`), 'Updated description|Rule 1: be nice');
  assert.equal((await c.post('/create_forum', { form: { name: 'Books', title: 'x', description: 'y', _csrf: t } })).status, 422);
  // a post by someone else, moderated by us
  const o = await login(A, 'ameliaspond');
  const ot = await o.csrf('/submit');
  await o.post('/submit', { form: { type: 'text', forum: 'cmu_lti', title: 'Hello LTI', body: 'hi', _csrf: ot } });
  const sid = await one(A, `SELECT id FROM submissions WHERE forum_id = ${fid}`);
  await c.post(`/f/cmu_lti/${sid}/-/lock`, { form: { _csrf: t } });
  assert.equal(await one(A, `SELECT locked FROM submissions WHERE id = ${sid}`), 1);
  r = await o.post(`/f/cmu_lti/${sid}/-/comment`, { form: { comment: 'blocked?', _csrf: ot } });
  assert.equal(r.status, 403);
  await c.post(`/f/cmu_lti/${sid}/-/delete`, { form: { reason: 'off topic', _csrf: t } });
  assert.equal(await one(A, `SELECT visibility FROM submissions WHERE id = ${sid}`), 'trashed');
  r = await c.post('/f/cmu_lti/ban/ameliaspond', { form: { reason: 'spam', _csrf: t } });
  assert.equal(r.status, 302);
  assert.equal(await one(A, `SELECT banned FROM forum_bans WHERE forum_id = ${fid} ORDER BY id DESC LIMIT 1`), 1);
  r = await o.post('/submit', { form: { type: 'text', forum: 'cmu_lti', title: 'again', _csrf: ot } });
  assert.equal(r.status, 403);
  const log = await q(A, `SELECT action_type FROM forum_log_entries WHERE forum_id = ${fid} ORDER BY id`);
  assert.deepEqual(log.map((x) => x.action_type), ['submission_lock', 'submission_deletion', 'ban']);
  assert.match((await c.get('/f/cmu_lti/moderation_log')).text, /Removed submission/);
  await c.post('/f/cmu_lti/unban/ameliaspond', { form: { _csrf: t } });
  assert.equal((await o.post('/submit', { form: { type: 'text', forum: 'cmu_lti', title: 'again', _csrf: ot } })).status, 302);
  // non-moderators cannot edit or moderate
  assert.equal((await o.post('/f/cmu_lti/edit', { form: { title: 'x', description: 'y', _csrf: ot } })).status, 403);
  assert.equal((await o.get('/f/books/edit')).status, 403);
});

test('user bio, preferences, account', async () => {
  const c = await login();
  const t = await c.csrf('/user/MarvelsGrantMan136/edit_biography');
  await c.post('/user/MarvelsGrantMan136/edit_biography', { form: { biography: 'I am a robot', _csrf: t } });
  assert.equal(await one(A, `SELECT biography FROM users WHERE id = ${ME_ID}`), 'I am a robot');
  assert.match((await c.get('/user/MarvelsGrantMan136')).text, /class="user-bio__biography"><p>I am a robot<\/p>/);
  await c.post('/user/MarvelsGrantMan136/preferences', { form: { front_page: 'all', front_page_sort_mode: 'new', timezone: 'UTC', night_mode: 'dark', notify_on_reply: '1', _csrf: t } });
  assert.deepEqual((await q(A, `SELECT front_page, front_page_sort_mode, timezone, night_mode, show_thumbnails, notify_on_reply FROM users WHERE id = ${ME_ID}`))[0],
    { front_page: 'all', front_page_sort_mode: 'new', timezone: 'UTC', night_mode: 'dark', show_thumbnails: 0, notify_on_reply: 1 });
  assert.equal((await c.post('/user/ameliaspond/edit_biography', { form: { biography: 'x', _csrf: t } })).status, 403);
  let r = await c.post('/user/MarvelsGrantMan136/account', { form: { username: ME, email: 'm@example.com', current_password: 'nope', _csrf: t } });
  assert.equal(r.status, 422);
  r = await c.post('/user/MarvelsGrantMan136/account', { form: { username: ME, email: 'm@example.com', current_password: PW, new_password: 'newpass123', new_password_repeat: 'newpass123', _csrf: t } });
  assert.equal(r.status, 302);
  assert.equal(await one(A, `SELECT email FROM users WHERE id = ${ME_ID}`), 'm@example.com');
  const n = new Client(A); await n.login(ME, 'newpass123');
});

test('registration', async () => {
  const c = new Client(A);
  const t = await c.csrf('/registration');
  let r = await c.post('/registration', { form: { username: 'MarvelsGrantMan136', password: 'abcdefgh', password_repeat: 'abcdefgh', _csrf: t } });
  assert.equal(r.status, 422);
  r = await c.post('/registration', { form: { username: 'new_user_1', password: 'abcdefgh', password_repeat: 'abcdefgh', _csrf: t } });
  assert.equal(r.status, 302);
  assert.match((await c.get('/')).text, /new_user_1/);
  assert.equal(await one(A, "SELECT count(*) FROM users WHERE normalized_username = 'new_user_1'"), 1);
});

test('private messages and notifications', async () => {
  const c = await login();
  const t = await c.csrf('/user/ameliaspond/compose_message');
  let r = await c.post('/user/ameliaspond/compose_message', { form: { subject: 'Hello', message: 'Nice comment about bookshop.org', _csrf: t } });
  assert.equal(r.status, 302);
  const tid = +/\/messages\/thread\/(\d+)/.exec(r.location)[1];
  const a = await login(A, 'ameliaspond');
  assert.match((await a.get('/')).text, /Messages \(1 unread\)/);
  assert.match((await a.get('/messages')).text, /Hello/);
  const th = await a.get(`/messages/thread/${tid}`);
  assert.match(th.text, /Nice comment about bookshop.org/);
  await a.post(`/messages/thread/${tid}/reply`, { form: { message: 'Thanks!', _csrf: csrfOf(th.text) } });
  assert.equal(await one(A, `SELECT count(*) FROM messages WHERE thread_id = ${tid}`), 2);
  assert.equal(await one(A, `SELECT count(*) FROM notifications WHERE user_id = ${ME_ID} AND notification_type = 'message' AND read_at IS NULL`), 1);
  await c.post('/notifications/clear', { form: { _csrf: t } });
  assert.equal(await one(A, `SELECT count(*) FROM notifications WHERE user_id = ${ME_ID} AND read_at IS NULL`), 0);
  assert.equal((await new Client(A).get(`/messages/thread/${tid}`)).status, 302);
  assert.equal((await (await login(A, 'rrlguy')).get(`/messages/thread/${tid}`)).status, 404);
});

test('wiki create, edit, history', async () => {
  const c = await login();
  const t = await c.csrf('/wiki/_create');
  let r = await c.post('/wiki/_create', { form: { path: 'rules', title: 'Site rules', body: '1. Be nice', _csrf: t } });
  assert.equal(r.location, '/wiki/rules');
  r = await c.post('/wiki/_edit/rules', { form: { title: 'Site rules', body: '1. Be nice\n2. No spam', _csrf: t } });
  assert.match((await c.get('/wiki/rules')).text, /No spam/);
  assert.equal(await one(A, "SELECT count(*) FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id WHERE p.path = 'rules'"), 2);
  assert.match((await c.get('/wiki/_history/rules')).text, /MarvelsGrantMan136/);
  assert.equal((await c.get('/wiki/nothing_here')).status, 404);
});

test('search finds posts, comments, forums', async () => {
  const c = new Client(A);
  assert.match((await c.get('/search?q=bookshop.org+exists')).text, /id="submission-59421"/);
  assert.match((await c.get('/search?q=indie+bookstore+manager&type=comments')).text, /id="comment-1235250"/);
  assert.match((await c.get('/search?q=machinelearning&type=forums')).text, /\/f\/MachineLearning/);
  // forum names are single tokens: spaced words / parts of the name match by substring
  assert.match((await c.get('/search?q=machine+learning&type=forums')).text, /\/f\/MachineLearning/);
  const learning = (await c.get('/search?q=learning&type=forums')).text;
  assert.match(learning, /\/f\/deeplearning/); assert.match(learning, /\/f\/MachineLearning/);
  assert.match((await c.get('/search?q=marvelsgrant&type=users')).text, /MarvelsGrantMan136/);
  assert.match((await c.get('/search?q=the&type=comments&t=week')).text, /No results found/);
  // new content is searchable inside the rollout, and gone after reset
  const m = await login();
  const t = await m.csrf('/submit');
  await m.post('/submit', { form: { type: 'text', forum: 'books', title: 'Zyxwvut quasar lantern', _csrf: t } });
  assert.match((await c.get('/search?q=zyxwvut')).text, /Zyxwvut quasar lantern/);
  await rl(A, '/reset', {});
  assert.doesNotMatch((await c.get('/search?q=zyxwvut')).text, /Zyxwvut quasar lantern/);
});

test('reset restores everything; tenants are isolated', async () => {
  const snap = async (base) => (await q(base, `SELECT (SELECT count(*) FROM submissions) s, (SELECT max(id) FROM submissions) ms, (SELECT count(*) FROM comments) c,
    (SELECT count(*) FROM submission_votes) v, (SELECT count(*) FROM forums) f, (SELECT total(net_score) FROM submissions) score,
    (SELECT count(*) FROM notifications) n, (SELECT count(*) FROM forum_subscriptions) fs, (SELECT seq FROM sqlite_sequence WHERE name = 'comments') cseq,
    (SELECT biography FROM users WHERE id = ${ME_ID}) bio`))[0];
  const before = await snap(A);
  const c = await login();
  const t = await c.csrf('/submit');
  await c.post('/submit', { form: { type: 'text', forum: 'books', title: 'temp', _csrf: t } });
  await c.post('/f/books/59421/-/comment', { form: { comment: 'temp', parent_id: '1235250', _csrf: t } });
  await c.post('/sv/59421', { form: { choice: '1', _csrf: t } });
  await c.post('/f/books/subscribe', { form: { _csrf: t } });
  await c.post('/create_forum', { form: { name: 'sci_fi', title: 'Sci-fi', description: 'x', _csrf: t } });
  await c.post('/user/MarvelsGrantMan136/edit_biography', { form: { biography: 'changed', _csrf: t } });
  const during = await snap(A);
  assert.notDeepEqual(during, before);
  assert.deepEqual(await snap(B), before, 'tenant 1 unaffected');
  const r = await rl(A, '/reset', {});
  assert.equal(r.ok, true);
  assert.deepEqual(await snap(A), before);
  assert.equal((await c.get('/submit')).status, 302, 'sessions are reset too');
  const h = await rl(A, '/health');
  assert.equal(h.ok, true);
});

test('grade.js: URL canonicalisation and SQL helpers', async () => {
  const g = require('../grade.js');
  const C = g.canonicalUrl;
  assert.equal(C('__REDDIT__/f/DIY/118903/some-slug'), C('http://forum.wa/f/diy/118903'));
  assert.equal(C('/f/books/59421/-/comment/1235250'), C('/f/Books/59421/friendly-reminder-bookshop-org-exists/comment/1235250'));
  assert.equal(C('/f/books/hot'), C('/f/books'));
  assert.equal(C('/f/books/top?t=all'), C('/f/books/top'));
  assert.notEqual(C('/f/books/top?t=week'), C('/f/books/top'));
  assert.equal(C('/u/MarvelsGrantMan136'), C('/user/marvelsgrantman136'));
  const query = (sql) => q(A, sql);
  let r = await g({ eval: { url: '__REDDIT__/f/books/new' } }, { url: 'http://127.0.0.1:7200/f/Books/new' });
  assert.equal(r.pass, true);
  r = await g({ eval: { url: '__REDDIT__/f/DIY/118903/x' } }, { url: 'http://forum.wa/f/diy/118903/' });
  assert.equal(r.pass, true);
  const c = await login();
  const t = await c.csrf('/submit');
  await c.post('/submit', { form: { type: 'text', forum: 'books', title: 'Grader check', body: 'good book!', _csrf: t } });
  const s = await g.latestSubmission(query, 'marvelsgrantman136', { forum: 'Books' });
  assert.equal(s.title, 'Grader check');
  r = await g({ eval: { state_sql: g.sql.latestSubmission('MarvelsGrantMan136', { forum: 'books' }).replace('SELECT s.id,', 'SELECT s.body AS b, s.id,'), state_expect: 'good book!' } }, { query });
  assert.equal(r.pass, true);
  await c.post('/sv/59421', { form: { choice: '-1', _csrf: t } });
  assert.equal(await g.vote(query, 'MarvelsGrantMan136', { submission: 59421 }), -1);
  assert.equal(await g.vote(query, 'MarvelsGrantMan136', { submission: 59396 }), 0);
});

test('user_stats (karma, counts) stay exact through writes', async () => {
  const exact = async (uid) => {
    const st = (await q(A, `SELECT submissions, comments, submission_karma, comment_karma FROM user_stats WHERE user_id = ${uid}`))[0];
    const agg = (await q(A, `SELECT (SELECT count(*) FROM submissions WHERE user_id = ${uid} AND visibility = 'visible') submissions,
      (SELECT count(*) FROM comments WHERE user_id = ${uid} AND visibility = 'visible') comments,
      (SELECT coalesce(sum(net_score), 0) FROM submissions WHERE user_id = ${uid} AND visibility = 'visible') submission_karma,
      (SELECT coalesce(sum(net_score), 0) FROM comments WHERE user_id = ${uid} AND visibility = 'visible') comment_karma`))[0];
    assert.deepEqual(st, agg);
    return st;
  };
  const before = await exact(ME_ID);
  const c = await login();
  const t = await c.csrf('/submit');
  await c.post('/submit', { form: { type: 'text', forum: 'books', title: 'stats', _csrf: t } });
  const sid = await one(A, `SELECT max(id) FROM submissions WHERE user_id = ${ME_ID}`);
  await c.post(`/f/books/${sid}/-/comment`, { form: { comment: 'one', _csrf: t } });
  const cid = await one(A, `SELECT max(id) FROM comments WHERE user_id = ${ME_ID}`);
  const o = await login(A, 'ameliaspond');
  const ot = await o.csrf('/');
  await o.post(`/sv/${sid}`, { form: { choice: '-1', _csrf: ot } });
  await o.post(`/cv/${cid}`, { form: { choice: '1', _csrf: ot } });
  await o.post(`/cv/${cid}`, { form: { choice: '-1', _csrf: ot } });
  const mid = await exact(ME_ID);
  assert.equal(mid.submissions, before.submissions + 1);
  assert.equal(mid.comment_karma, before.comment_karma + 1 - 1);
  await c.post(`/f/books/${sid}/-/comment/${cid}/delete_own`, { form: { _csrf: t } });
  await c.post(`/f/books/${sid}/-/delete`, { form: { _csrf: t } });
  assert.deepEqual(await exact(ME_ID), before);
  await exact(await one(A, "SELECT id FROM users WHERE normalized_username = 'ameliaspond'"));
  assert.match((await c.get('/user/MarvelsGrantMan136')).text, new RegExp(`karma--posts">${before.submission_karma.toLocaleString('en-US')}<`));
});
