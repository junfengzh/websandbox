'use strict';
// Commit guard: site code on a tenant connection can never end the rollout
// transaction or write outside it. Installed on every tenant connection; the kit
// keeps the raw exec for its own BEGIN/ROLLBACK/SAVEPOINT.
//  - statements that end/start transactions, touch kit savepoints, ATTACH/DETACH,
//    VACUUM or change journal/locking/spill modes throw when run;
//  - any writing statement throws if the connection is not inside the transaction
//    (e.g. SQLite auto-rolled back after an I/O or OOM error) -- so nothing autocommits.
const Database = require('better-sqlite3');

const LEAD = String.raw`(?:^|;)\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*`;
const FORBID = new RegExp(LEAD + String.raw`(?:(?:COMMIT|END|BEGIN|ROLLBACK(?!\s+TO\b)|VACUUM|ATTACH|DETACH)\b|` +
  String.raw`(?:RELEASE|ROLLBACK\s+TO)\s+(?:SAVEPOINT\s+)?["'\x60\[]?wsb_|` +
  String.raw`PRAGMA\s+(?:\w+\.)?(?:journal_mode|locking_mode|cache_spill|wal_checkpoint|writable_schema|query_only|schema_version|user_version\s*=)\b)`, 'i');

class GuardError extends Error {
  constructor(msg) { super(`kit guard: ${msg}`); this.statusCode = 500; }
}

const P = Database.prototype;
const S = Object.getPrototypeOf(new Database(':memory:').prepare('SELECT 1'));

function install(db) {
  const raw = { exec: P.exec.bind(db), prepare: P.prepare.bind(db) };
  db.prepare = function (sql, ...rest) {
    const st = P.prepare.call(db, sql, ...rest);
    const bad = FORBID.test(String(sql));
    if (!bad && st.readonly) return st; // plain reads: untouched, no overhead
    for (const m of ['run', 'get', 'all', 'iterate']) {
      const f = S[m];
      st[m] = function (...args) {
        if (bad) throw new GuardError(`statement not allowed on a tenant connection: ${String(sql).trim().slice(0, 60)}`);
        if (!db.inTransaction) throw new GuardError('write outside the rollout transaction refused');
        return f.apply(this, args);
      };
    }
    return st;
  };
  db.exec = function (sql) {
    if (FORBID.test(String(sql))) throw new GuardError(`statement not allowed on a tenant connection: ${String(sql).trim().slice(0, 60)}`);
    if (!db.inTransaction) throw new GuardError('exec outside the rollout transaction refused');
    return P.exec.call(db, sql);
  };
  // db.transaction(fn) nested in the rollout transaction uses savepoints; outside it, it would COMMIT.
  db.transaction = function (fn) {
    const t = P.transaction.call(db, fn);
    const wrap = (g) => function (...args) {
      if (!db.inTransaction) throw new GuardError('transaction outside the rollout transaction refused');
      return g.apply(this, args);
    };
    const w = wrap(t);
    for (const k of ['deferred', 'immediate', 'exclusive']) w[k] = wrap(t[k]);
    w.default = w;
    return w;
  };
  return raw;
}

module.exports = { install, FORBID, GuardError };
