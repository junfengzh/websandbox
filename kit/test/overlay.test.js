'use strict';
// Overlay mode (the default): all tenants on the same base.db, never written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { buildNotes, startNotes, Client, rl, q, NOTES } = require('./helpers');
const kit = require('..');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let dir, base, h0;
test.before(() => { dir = buildNotes(2000); base = path.join(dir, 'base.db'); h0 = sha(base); });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('guard refuses COMMIT and friends; nested db.transaction still works', async () => {
  const s = await startNotes(dir, { tenants: 1 });
  try {
    const t = s.tenants.get(0);
    assert.equal(s.options.mode, 'overlay');
    for (const sql of ['COMMIT', 'END', 'BEGIN', 'ROLLBACK', '/* x */ commit', "ATTACH ':memory:' AS z", 'DETACH z', 'VACUUM', 'PRAGMA journal_mode = DELETE',
      'PRAGMA cache_spill = ON', 'RELEASE wsb_unit', 'ROLLBACK TO wsb_unit', 'SELECT 1; COMMIT']) {
      await assert.rejects(t.run((db) => db.exec(sql)), /kit guard/, sql);
      await assert.rejects(t.run((db) => db.prepare(sql.split(';').pop()).run()), /kit guard|syntax|no such/, sql);
    }
    assert.equal(t.db.inTransaction, true);
    await t.run((db) => db.transaction(() => db.prepare("UPDATE notes SET title = 'tx' WHERE id = 1").run())());
    assert.equal((await t.query('SELECT title FROM notes WHERE id = 1')).rows[0].title, 'tx');
    // transaction lost (e.g. SQLite auto-rollback): writes are refused instead of autocommitting
    t.x('ROLLBACK');
    assert.throws(() => t.db.prepare("UPDATE notes SET title = 'x' WHERE id = 2").run(), /outside the rollout transaction/);
    assert.throws(() => t.db.exec("UPDATE notes SET title = 'x' WHERE id = 2"), /outside the rollout transaction/);
    assert.throws(() => t.db.transaction(() => 1)(), /outside the rollout transaction/);
    await t.run(() => {}); // the kit re-begins and counts it
    assert.equal(t.stats.lostTransactions, 1);
    assert.equal(sha(base), h0);
  } finally { await s.close(); }
});

test('many tenants writing heavily in parallel (2 worker processes): isolated, base.db byte-identical', async () => {
  const port = 7150;
  const p = spawn(process.execPath, [path.join(NOTES, 'server.js'), '--tenants', '4', '--workers', '2', '--port', String(port), '--bind', 'ports', '--data', dir,
    '--uploads', path.join(dir, 'up-ov'), '--cache-mb', '2'], { stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    const url = (i) => `http://127.0.0.1:${port + i}`;
    for (let i = 0; i < 4; i++) for (;;) { try { if ((await fetch(url(i) + '/__rl/health')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const before = (await q(url(0), 'SELECT count(*) n FROM notes'))[0].n;
    await Promise.all([0, 1, 2, 3].map(async (i) => {
      const c = new Client(url(i));
      await c.login('alice');
      const _csrf = await c.csrf('/');
      for (let k = 0; k < 40 + 20 * i; k++) {
        const r = await c.post('/notes', { form: { _csrf, title: `t${i} zebra ${k}`, body: `tenant ${i} `.repeat(200), tag: 'work' } });
        assert.equal(r.status, 302);
      }
      for (let k = 1; k <= 300; k++) await c.post(`/notes/${k}/edit`, { form: { _csrf, title: `edited by ${i}`, body: 'x'.repeat(3000), tag: 'food', likes: String(i) } });
    }));
    for (let i = 0; i < 4; i++) {
      assert.equal((await q(url(i), 'SELECT count(*) n FROM notes'))[0].n, before + 40 + 20 * i);
      assert.equal((await q(url(i), "SELECT count(*) n FROM notes_fts WHERE notes_fts MATCH 'zebra'"))[0].n >= 40 + 20 * i, true);
      assert.deepEqual(await q(url(i), 'SELECT DISTINCT title FROM notes WHERE id <= 300'), [{ title: `edited by ${i}` }]);
      assert.equal((await q(url(i), `SELECT count(*) n FROM notes WHERE title LIKE 't${(i + 1) % 4} zebra%'`))[0].n, 0);
    }
    assert.equal(sha(base), h0, 'base.db changed while tenants were writing');
    for (let i = 0; i < 4; i++) {
      const r = await rl(url(i), '/reset', {});
      assert.ok(r.ms < 50, `reset ${r.ms} ms`);
      assert.equal((await q(url(i), 'SELECT count(*) n FROM notes'))[0].n, before);
      assert.equal((await rl(url(i), '/health')).ok, true);
    }
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('base.db')), ['base.db'], 'no journal/wal/shm files next to base.db');
  } finally {
    p.kill('SIGTERM');
    await new Promise((r) => p.once('exit', r));
  }
  assert.equal(sha(base), h0);
});

test('overlay refuses a base.db with a hot journal or in WAL mode', async () => {
  fs.writeFileSync(base + '-journal', 'x');
  try { await assert.rejects(startNotes(dir, { tenants: 1 }), /journal exists|-journal exists/); } finally { fs.rmSync(base + '-journal'); }
  const w = path.join(dir, 'wal'); fs.mkdirSync(w, { recursive: true });
  fs.copyFileSync(base, path.join(w, 'base.db'));
  const D = require('better-sqlite3'); const d = new D(path.join(w, 'base.db')); d.pragma('journal_mode = WAL'); d.close();
  await assert.rejects(startNotes(w, { tenants: 1 }), /WAL mode/);
  void kit;
});
