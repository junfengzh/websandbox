'use strict';
// Server-level behaviour: tenants, reset, transactions, CSRF, sessions, jobs, control API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildNotes, startNotes, Client, rl, q } = require('./helpers');
const kit = require('..');

let dir, s, A, B; // A = tenant 0 base URL, B = tenant 1
test.before(async () => {
  dir = buildNotes();
  s = await startNotes(dir);
  A = s.url(0); B = s.url(1);
});
test.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
test.beforeEach(async () => { await rl(A, '/reset?all=1', {}); });

const snapshot = async (base) => ({
  count: (await q(base, 'SELECT count(*) n FROM notes'))[0].n,
  sum: (await q(base, "SELECT total(likes) + total(length(title)) + total(length(body)) s FROM notes"))[0].s,
  seq: await q(base, 'SELECT * FROM sqlite_sequence'),
  fts: await q(base, "SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'zebra OR garden' ORDER BY bm25(notes_fts), rowid LIMIT 50"),
  ftsCount: (await q(base, "SELECT count(*) n FROM notes_fts WHERE notes_fts MATCH 'zebra'"))[0].n,
  sessions: (await q(base, 'SELECT count(*) n FROM kit_sessions'))[0].n,
  jobs: (await q(base, 'SELECT count(*) n FROM kit_jobs'))[0].n,
});

test('tenant isolation', async () => {
  const c = new Client(A);
  await c.login('bob');
  const r = await c.createNote({ title: 'Isolated zebra', body: 'only in tenant zero' });
  assert.equal(r.status, 302);
  assert.equal((await q(A, "SELECT count(*) n FROM notes WHERE title = 'Isolated zebra'"))[0].n, 1);
  assert.equal((await q(B, "SELECT count(*) n FROM notes WHERE title = 'Isolated zebra'"))[0].n, 0);
  assert.match((await new Client(A).get('/?q=isolated')).text, /Isolated zebra/);
  assert.doesNotMatch((await new Client(B).get('/?q=isolated')).text, /Isolated zebra/);
  // a tenant-0 session cookie means nothing on tenant 1
  const b = new Client(B); b.jar = new Map(c.jar);
  assert.equal((await b.get('/notes/new')).status, 302);
});

test('X-WSB-Tenant header selects the tenant from loopback, not from browsers', async () => {
  const h = await (await fetch(A + '/__rl/health', { headers: { 'x-wsb-tenant': '1' } })).json();
  assert.equal(h.tenant, 1);
  const b = await fetch(A + '/__rl/health', { headers: { 'x-wsb-tenant': '1', 'user-agent': 'Mozilla/5.0 Chrome' } });
  assert.equal(b.status, 403); // control API refuses browser-originated requests
  const o = await fetch(A + '/__rl/query', { method: 'POST', headers: { origin: 'http://notes.wa', 'content-type': 'application/json' }, body: '{"sql":"select 1"}' });
  assert.equal(o.status, 403);
});

test('reset restores state exactly, including FTS results and sequences', async () => {
  const before = await snapshot(A);
  const c = new Client(A);
  await c.login('alice');
  await c.createNote({ title: 'zebra garden party', body: 'zebra zebra garden' });
  let _csrf = await c.csrf('/notes/1/edit');
  assert.equal((await c.post('/notes/1/edit', { form: { title: 'garden zebra edited', body: 'new body', tag: 'work', likes: '7', _csrf } })).status, 302);
  _csrf = await c.csrf('/notes/2');
  assert.equal((await c.post('/notes/2/delete', { form: { _csrf } })).status, 302);
  await c.post('/notes/3/publish', { form: { _csrf: await c.csrf('/notes/3') } });
  const mid = await snapshot(A);
  assert.notDeepEqual(mid, before);
  assert.notDeepEqual(mid.fts, before.fts);
  const r = await rl(A, '/reset', {});
  assert.ok(r.ms < 50, `reset took ${r.ms} ms`);
  assert.deepEqual(await snapshot(A), before);
  // ids are reused after reset (sqlite_sequence rolled back): deterministic
  await c.login('alice');
  const r2 = await c.createNote({ title: 'again', body: 'x' });
  const r3 = (await rl(A, '/reset', {}), await (async () => { await c.login('alice'); return c.createNote({ title: 'again', body: 'x' }); })());
  assert.equal(r2.location, r3.location);
});

test('uncommitted writes are visible to the same tenant pages and /__rl/query', async () => {
  const c = new Client(A);
  await c.login('carol');
  const r = await c.createNote({ title: 'Visible before commit', body: 'pending write', tag: 'ideas' });
  const id = +r.location.split('/').pop();
  const page = await c.get(r.location);
  assert.match(page.text, /Visible before commit/);
  assert.match(page.text, /Note created\./); // flash, read once
  assert.doesNotMatch((await c.get(r.location)).text, /Note created\./);
  assert.deepEqual(await q(A, `SELECT title, tag FROM notes WHERE id = ${id}`), [{ title: 'Visible before commit', tag: 'ideas' }]);
  const h = await rl(A, '/health');
  assert.equal(h.inTransaction, true);
  // never committed: the tenant file still has the base state (separate connection)
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(dir, 'tenants', 't0.db'), { readonly: true });
  assert.equal(raw.prepare(`SELECT count(*) FROM notes WHERE id = ${id}`).pluck().get(), 0);
  raw.close();
});

test('a failed request rolls back only itself; the rollout transaction survives', async () => {
  const c = new Client(A);
  await c.login('bob');
  await c.createNote({ title: 'Kept write', body: 'before the failure' });
  const f = await c.post('/debug/fail', { form: {}, headers: { accept: 'text/html' } });
  assert.equal(f.status, 500);
  assert.match(f.text, /Server error/);
  assert.notEqual((await q(A, 'SELECT title FROM notes WHERE id = 1'))[0].title, 'POISON');
  assert.equal((await q(A, "SELECT count(*) n FROM notes WHERE title = 'Kept write'"))[0].n, 1);
  const h = await rl(A, '/health');
  assert.equal(h.ok, true);
  assert.equal(h.lostTransactions, 0);
  // and the site keeps working, still inside the same transaction
  assert.equal((await c.createNote({ title: 'After failure', body: 'ok' })).status, 302);
  await rl(A, '/reset', {});
  assert.equal((await q(A, "SELECT count(*) n FROM notes WHERE title IN ('Kept write', 'After failure')"))[0].n, 0);
});

test('CSRF: unsafe requests need the session token', async () => {
  const c = new Client(A);
  await c.login('bob');
  assert.equal((await c.post('/notes', { form: { title: 't', body: 'b', tag: 'work' } })).status, 403);
  assert.equal((await c.post('/notes', { form: { title: 't', body: 'b', tag: 'work', _csrf: 'nope' } })).status, 403);
  const tok = await c.csrf('/');
  assert.equal((await c.post('/notes', { form: { title: 't', body: 'b', tag: 'work', _csrf: tok } })).status, 302);
  // header form (XHR)
  const like = await c.post('/api/notes/5/like', { headers: { 'x-csrf-token': tok } });
  assert.equal(like.status, 200);
  assert.equal((await c.post('/api/notes/5/like')).status, 403);
  // another session's token does not work
  const d = new Client(A); await d.csrf('/');
  assert.equal((await d.post('/api/notes/5/like', { headers: { 'x-csrf-token': tok } })).status, 403);
});

test('login, roles, validation errors, logout', async () => {
  const c = new Client(A);
  assert.equal((await c.get('/notes/new')).location, '/login?next=%2Fnotes%2Fnew');
  const tok = await c.csrf('/login');
  const bad = await c.post('/login', { form: { login: 'bob', password: 'wrong', _csrf: tok } });
  assert.match(bad.text, /Invalid username or password/);
  await c.login('bob');
  assert.equal((await c.get('/admin', { headers: { accept: 'text/html' } })).status, 403);
  const v = await c.post('/notes', { form: { title: '', body: 'x', tag: 'nope', likes: '-3', _csrf: await c.csrf('/') } });
  assert.equal(v.status, 422);
  assert.match(v.text, /Title is required/);
  assert.match(v.text, /Tag has an invalid value/);
  assert.match(v.text, /Likes must be at least 0/);
  const a = new Client(A); await a.login('alice@example.com');
  assert.equal((await a.get('/admin')).status, 200);
  const out = await a.post('/logout', { form: { _csrf: await a.csrf('/') } });
  assert.equal(out.status, 302);
  assert.equal((await a.get('/admin')).status, 302);
});

test('sessions reset with the rollout; /__rl/login starts a rollout logged in', async () => {
  const c = new Client(A);
  await c.login('bob');
  assert.equal((await c.get('/notes/new')).status, 200);
  await rl(A, '/reset', {});
  assert.equal((await c.get('/notes/new')).status, 302);
  const r = await rl(A, '/login', { user: 'alice' });
  assert.equal(r.ok, true);
  assert.equal(r.user.role, 'admin');
  const d = new Client(A); d.jar.set(r.cookie.name, r.cookie.value);
  assert.equal((await d.get('/admin')).status, 200);
  assert.equal((await rl(A, '/login', { user: 'nobody' })).status, 404);
});

test('jobs run in order on the site clock, deterministically', async () => {
  await rl(A, '/clock', { now: '2023-06-01T12:00:00Z', frozen: true });
  const c = new Client(A);
  await c.login('alice');
  await c.post('/notes/4/publish', { form: { _csrf: await c.csrf('/notes/4') } });
  await c.post('/notes/6/publish', { form: { _csrf: await c.csrf('/notes/6') } });
  assert.equal((await q(A, 'SELECT status FROM notes WHERE id = 4'))[0].status, 'scheduled');
  await new Promise((r) => setTimeout(r, 120)); // timer ticks, but nothing is due on a frozen clock
  assert.equal((await rl(A, '/jobs/run', {})).jobsRun, 0);
  assert.equal((await rl(A, '/clock', { advance: 599 })).jobsRun, 0);
  assert.equal((await rl(A, '/clock', { advance: 1 })).jobsRun, 2);
  assert.deepEqual(await q(A, 'SELECT id, status, published_at FROM notes WHERE id IN (4, 6) ORDER BY id'), [
    { id: 4, status: 'published', published_at: '2023-06-01 12:10:00' },
    { id: 6, status: 'published', published_at: '2023-06-01 12:10:00' },
  ]);
  assert.deepEqual((await q(A, 'SELECT id, status FROM kit_jobs ORDER BY id')).map((j) => j.status), ['done', 'done']);
  // a failing job rolls back its own writes and is marked failed
  const t = s.tenants.get(0);
  const likes = (await q(A, 'SELECT likes FROM notes WHERE id = 7'))[0].likes;
  await t.run(() => kit.jobs.enqueue('note.fail', { id: 7 }));
  assert.equal(await t.runDueJobs(), 1);
  assert.equal((await q(A, 'SELECT likes FROM notes WHERE id = 7'))[0].likes, likes);
  assert.equal((await q(A, "SELECT status FROM kit_jobs WHERE type = 'note.fail'"))[0].status, 'failed');
  // reset restores the clock and empties the queue
  await rl(A, '/reset', {});
  const h = await rl(A, '/health');
  assert.equal(h.frozen, false);
  assert.ok(h.now.startsWith('2023-05-01T09:0'));
  assert.equal((await q(A, 'SELECT count(*) n FROM kit_jobs'))[0].n, 0);
});

test('running clock: the job timer picks up due jobs by itself', async () => {
  const t = s.tenants.get(0);
  await t.run(() => kit.jobs.enqueue('note.publish', { id: 8 }, { delay: 0 }));
  await t.run((db) => db.prepare("UPDATE notes SET status = 'scheduled' WHERE id = 8").run());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await q(A, 'SELECT status FROM notes WHERE id = 8'))[0].status, 'published');
});

test('/__rl/query refuses writes and transaction control', async () => {
  for (const sql of ['DELETE FROM notes', 'COMMIT', 'ROLLBACK', 'BEGIN', "ATTACH ':memory:' AS x", 'PRAGMA user_version = 3', 'VACUUM',
    'WITH x AS (SELECT 1) DELETE FROM notes', 'SELECT 1; DELETE FROM notes', "INSERT INTO notes_fts(notes_fts) VALUES('optimize')", 'SAVEPOINT a', 'RELEASE wsb_query']) {
    const r = await rl(A, '/query', { sql });
    assert.equal(r.status, 400, sql);
  }
  assert.equal((await q(A, 'SELECT count(*) n FROM notes'))[0].n, 600);
  assert.equal((await rl(A, '/health')).ok, true);
  const raw = await rl(A, '/query', { sql: 'SELECT id, title FROM notes WHERE id < ? ORDER BY id', params: [3], raw: true });
  assert.deepEqual(raw.columns, ['id', 'title']);
  assert.equal(raw.rows.length, 2);
  assert.ok(Array.isArray(raw.rows[0]));
});

test('uploads go to the tenant dir and reset empties it', async () => {
  const c = new Client(A);
  await c.login('bob');
  const fd = new FormData();
  fd.set('_csrf', await c.csrf('/notes/new'));
  fd.set('title', 'With file'); fd.set('body', 'see attachment'); fd.set('tag', 'work');
  fd.set('attachment', new Blob(['hello upload']), 'hello world.txt');
  const r = await fetch(A + '/notes', { method: 'POST', body: fd, headers: { cookie: c.cookie() }, redirect: 'manual' });
  assert.equal(r.status, 302);
  const att = (await q(A, "SELECT attachment FROM notes WHERE title = 'With file'"))[0].attachment;
  assert.equal(att, '/uploads/u1-hello_world.txt');
  assert.equal(await (await fetch(A + att)).text(), 'hello upload');
  assert.equal((await fetch(B + att)).status, 404);
  await rl(A, '/reset', {});
  assert.equal((await fetch(A + att)).status, 404);
});

test('404 page, skins and stats', async () => {
  const r = await new Client(A).get('/no/such/page', { headers: { accept: 'text/html' } });
  assert.equal(r.status, 404);
  assert.match(r.text, /Page not found/);
  await rl(A, '/reset', { skin: 'dark' });
  const p = await new Client(A).get('/');
  assert.match(p.text, /theme-dark/);
  assert.match(p.text, /All notes/);
  assert.match(p.text, /<title>Notes - Notebook<\/title>/);
  await rl(A, '/reset', { skin: 'default' });
  const st = await rl(A, '/stats');
  assert.equal(st.tenants, 2);
  assert.ok(st.perTenant[0].resets > 0);
});

test('shared (read-only) mode: site writes fail, sessions still work', async () => {
  const s2 = await startNotes(dir, { tenants: 1, dbMode: 'shared', uploads: path.join(dir, 'up2') });
  try {
    const c = new Client(s2.url(0));
    await c.login('bob');
    assert.equal((await c.get('/notes/new')).status, 200);
    const r = await c.createNote({ title: 'x', body: 'y' });
    assert.equal(r.status, 500); // attempt to write a readonly database
    assert.equal((await rl(s2.url(0), '/health')).ok, true);
  } finally { await s2.close(); }
});
