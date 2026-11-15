'use strict';
// Helpers for sites/<site>/build/ scripts that produce base.db.
const Database = require('better-sqlite3');
const fs = require('node:fs');

// Open a fresh build DB with fast (unsafe) pragmas -- only for offline builds.
function open(file, { fresh = true } = {}) {
  if (fresh) for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + s, { force: true });
  const db = new Database(file);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -262144');
  db.pragma('temp_store = MEMORY');
  return db;
}

// Finish a base.db: FTS optimize, ANALYZE, rollback-journal mode (so it can be
// opened read-only and copied as one file), VACUUM. List FTS5 tables in `fts`.
function finalize(db, { fts = [], vacuum = true } = {}) {
  for (const t of fts) db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`);
  db.exec('ANALYZE');
  db.pragma('journal_mode = DELETE');
  if (vacuum) db.exec('VACUUM');
  const ok = db.pragma('integrity_check', { simple: true });
  if (ok !== 'ok') throw new Error('integrity_check: ' + ok);
  db.close();
}

module.exports = { open, finalize };
