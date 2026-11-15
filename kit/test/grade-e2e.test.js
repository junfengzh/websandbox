'use strict';
// The toy site's sample tasks, graded end to end via the control API (in-process and CLI).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { buildNotes, startNotes, Client, rl, NOTES } = require('./helpers');
const kit = require('..');
const gradeNotes = require(path.join(NOTES, 'grade.js'));

const tasks = fs.readFileSync(path.join(NOTES, 'tasks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let dir, s, A;
test.before(async () => { dir = buildNotes(300); s = await startNotes(dir, { tenants: 1 }); A = s.url(0); });
test.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const cli = (args) => new Promise((res) => execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'wsb-grade.js'), ...args], (err, stdout) => res({ code: err ? err.code : 0, out: JSON.parse(stdout || '{}') })));

test('answer task (answer_sql reference)', async () => {
  const query = kit.grader.remoteQuery(A);
  const n = (await query("SELECT count(*) FROM notes n JOIN users u ON u.id = n.user_id WHERE u.username = 'alice'"))[0];
  const want = String(Object.values(n)[0]);
  assert.equal((await gradeNotes(tasks[0], { answer: want, query })).pass, true);
  assert.equal((await gradeNotes(tasks[0], { answer: '1', query })).pass, false);
  const r = await cli(['--site', A, '--task', path.join(NOTES, 'tasks.jsonl'), '--id', 'notes-1', '--answer', want]);
  assert.equal(r.code, 0); assert.equal(r.out.pass, true);
});

test('url task', async () => {
  assert.equal((await gradeNotes(tasks[1], { url: `${A}/?sort=likes_desc&tag=travel&author=bob&page=1` })).pass, true);
  assert.equal((await gradeNotes(tasks[1], { url: `${A}/?tag=travel&author=bob` })).pass, false);
});

test('state task sees the rollout\'s uncommitted writes; reset undoes them', async () => {
  const query = kit.grader.remoteQuery(A);
  assert.equal((await gradeNotes(tasks[2], { query })).pass, false);
  const c = new Client(A);
  await c.login('bob');
  await c.createNote({ title: 'Grocery list', body: 'eggs, milk, bread', tag: 'food' });
  assert.equal((await gradeNotes(tasks[2], { query })).pass, true);
  const r = await cli(['--site', A, '--task', path.join(NOTES, 'tasks.jsonl'), '--id', 'notes-3', '--grader', path.join(NOTES, 'grade.js')]);
  assert.equal(r.code, 0);
  await rl(A, '/reset', {});
  assert.equal((await gradeNotes(tasks[2], { query })).pass, false);
});
