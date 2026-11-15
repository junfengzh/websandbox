'use strict';
// One tenant = one site instance: its own DB connection holding one open
// transaction for the whole rollout. Every request and job runs on that
// connection, serialized, each inside a SAVEPOINT. Reset = ROLLBACK + BEGIN.
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { als, sqlTime, parseTime } = require('./context');

const KIT_SCHEMA = `
CREATE TEMP TABLE IF NOT EXISTS kit_sessions (
  id TEXT PRIMARY KEY, user_id, data TEXT NOT NULL DEFAULT '{}', csrf TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE TEMP TABLE IF NOT EXISTS kit_jobs (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT, run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT, error TEXT, created_at TEXT NOT NULL, done_at TEXT);
CREATE INDEX IF NOT EXISTS temp.kit_jobs_due ON kit_jobs(status, run_at, id);
`;

// Copy base.db to the tenant file once; reuse it while base.db is unchanged.
// Nothing is ever committed to a tenant copy, so a reused copy == base.
async function ensureCopy(base, dest, fresh) {
  const st = fs.statSync(base);
  const stamp = JSON.stringify({ base, size: st.size, mtimeMs: st.mtimeMs });
  const marker = dest + '.src';
  if (!fresh && fs.existsSync(dest) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) return false;
  for (const f of [dest, dest + '-wal', dest + '-shm', marker]) fs.rmSync(f, { force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(base, dest + '.tmp');
  fs.renameSync(dest + '.tmp', dest);
  fs.writeFileSync(marker, stamp);
  return true;
}

class Tenant {
  constructor(site, index, o) {
    this.site = site; // the site runtime (config + jobs + auth)
    this.index = index;
    this.o = o; // { base, file, mode, uploadDir, cacheMB, fresh }
    this.uploadDir = o.uploadDir;
    this.queue = Promise.resolve();
    this.stats = { requests: 0, resets: 0, lastResetMs: null, maxResetMs: 0, jobsRun: 0, lostTransactions: 0 };
    this.skin = site.cfg.skinFor ? site.cfg.skinFor(index) : 'default';
    this.ready = this.open();
    this.ready.catch(() => {});
  }

  async open() {
    const { mode, base, file, cacheMB = 32 } = this.o;
    if (mode === 'copy') {
      this.copied = await ensureCopy(base, file, this.o.fresh);
      this.db = new Database(file, { fileMustExist: true });
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = OFF'); // nothing is ever committed
    } else {
      this.db = new Database(base, { readonly: true, fileMustExist: true });
    }
    const db = this.db;
    db.pragma(`cache_size = -${Math.round(cacheMB * 1024)}`);
    db.pragma('temp_store = MEMORY');
    db.function('now', { deterministic: false }, () => this.nowSql());
    db.function('today', { deterministic: false }, () => this.nowSql().slice(0, 10));
    db.exec(KIT_SCHEMA); // temp tables: committed empty, so ROLLBACK empties them
    if (this.site.cfg.onOpen) this.site.cfg.onOpen(db, this);
    this.st = {
      sess: db.prepare('SELECT * FROM kit_sessions WHERE id = ?'),
      due: db.prepare("SELECT * FROM kit_jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, id LIMIT 1"),
      enqueue: db.prepare('INSERT INTO kit_jobs (type, payload, run_at, created_at) VALUES (?, ?, ?, ?)'),
      jobDone: db.prepare("UPDATE kit_jobs SET status = 'done', attempts = attempts + 1, result = ?, done_at = ? WHERE id = ?"),
      jobFail: db.prepare("UPDATE kit_jobs SET status = 'failed', attempts = attempts + 1, error = ?, done_at = ? WHERE id = ?"),
    };
    this.resetClock();
    this.clearUploads();
    db.exec('BEGIN');
    return this;
  }

  // ---- clock: fixed per-site "today"; running (advances with real time) or frozen
  resetClock(o = {}) {
    const c = this.site.cfg.clock || {};
    this.clock = { base: parseTime(o.now || c.start || Date.now()), at: Date.now(), frozen: o.frozen ?? !!c.frozen };
  }
  setClock({ now, frozen, advance } = {}) {
    const cur = this.nowMs();
    this.clock = { base: now != null ? parseTime(now) : cur + (advance ? advance * 1000 : 0), at: Date.now(), frozen: frozen ?? this.clock.frozen };
  }
  nowMs() {
    const c = als.getStore();
    if (c && c.tenant === this && c.jobTime != null) return c.jobTime; // a job sees its scheduled time
    return this.clock.frozen ? this.clock.base : this.clock.base + (Date.now() - this.clock.at);
  }
  now() { return new Date(this.nowMs()); }
  nowSql() { return sqlTime(this.nowMs()); }

  // ---- serialization: one request/job at a time per tenant
  lock(fn) {
    const p = this.queue.then(() => fn());
    this.queue = p.catch(() => {});
    return p;
  }

  ensureTx() {
    if (!this.db.inTransaction) {
      // Site code ran COMMIT/ROLLBACK or SQLite aborted the transaction (I/O
      // error, SQLITE_FULL). Writes may have been lost or committed: flag it.
      this.stats.lostTransactions++;
      this.db.exec('BEGIN');
    }
  }

  // Run fn inside the tenant context + lock + a SAVEPOINT. A throw rolls back
  // only this unit of work; the rollout transaction stays usable.
  run(fn, extra = {}) {
    return this.lock(() => als.run({ tenant: this, db: this.db, ...extra }, async () => {
      const db = this.db;
      this.ensureTx();
      db.exec('SAVEPOINT wsb_unit');
      try {
        const r = await fn(db);
        db.exec('RELEASE wsb_unit');
        return r;
      } catch (e) {
        if (db.inTransaction) { db.exec('ROLLBACK TO wsb_unit'); db.exec('RELEASE wsb_unit'); }
        throw e;
      } finally {
        this.ensureTx();
      }
    }));
  }

  // ---- reset: ROLLBACK + BEGIN, uploads emptied, clock/skin/jobs/sessions reset
  reset(o = {}) {
    return this.lock(() => {
      const t0 = performance.now();
      if (this.db.inTransaction) this.db.exec('ROLLBACK'); else this.stats.lostTransactions++;
      this.clearUploads();
      if (o.skin) this.skin = o.skin;
      this.resetClock(o);
      this.db.exec('BEGIN');
      const ms = performance.now() - t0;
      Object.assign(this.stats, { resets: this.stats.resets + 1, lastResetMs: +ms.toFixed(3), maxResetMs: Math.max(this.stats.maxResetMs, +ms.toFixed(3)) });
      return ms;
    });
  }

  clearUploads() {
    this.uploadSeq = 0;
    if (!this.uploadDir) return;
    fs.rmSync(this.uploadDir, { recursive: true, force: true });
    fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  // ---- read-only SQL against the live (uncommitted) state, for graders
  query(sql, params = [], { raw = false, maxRows = 10000 } = {}) {
    return this.lock(() => {
      const s = String(sql).replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '');
      if (!/^(select|with|values)\b/i.test(s)) throw Object.assign(new Error('only SELECT / WITH / VALUES queries are allowed'), { statusCode: 400 });
      const db = this.db;
      const stmt = db.prepare(s);
      if (!stmt.reader || !stmt.readonly) throw Object.assign(new Error('query must be read-only'), { statusCode: 400 });
      this.ensureTx();
      db.exec('SAVEPOINT wsb_query');
      try {
        const columns = stmt.columns().map((c) => c.name);
        const rows = [];
        const it = (raw ? stmt.raw(true) : stmt).iterate(...(Array.isArray(params) ? params : [params]));
        for (const r of it) { if (rows.length >= maxRows) { it.return(); break; } rows.push(r); }
        return { columns, rows, truncated: rows.length >= maxRows };
      } finally {
        db.exec('ROLLBACK TO wsb_query'); db.exec('RELEASE wsb_query');
      }
    });
  }

  // ---- jobs: kit_jobs table on this connection, due by the site clock
  enqueue(type, payload = null, { delay = 0, at } = {}) {
    if (!this.site.cfg.jobs || !this.site.cfg.jobs[type]) throw new Error(`kit: unknown job type '${type}'`);
    const runAt = sqlTime(at != null ? parseTime(at) : this.nowMs() + delay * 1000);
    return Number(this.st.enqueue.run(type, JSON.stringify(payload), runAt, this.nowSql()).lastInsertRowid);
  }

  hasDueJobs() { return !!this.st.due.get(this.nowSql()); }

  // Run due jobs in (run_at, id) order. Each sees now() == its run_at.
  async runDueJobs(limit = 1000) {
    let n = 0;
    while (n < limit) {
      const job = this.st.due.get(this.nowSql());
      if (!job) break;
      const handler = this.site.cfg.jobs[job.type];
      const jobTime = parseTime(job.run_at);
      await this.run(async (db) => {
        const cur = db.prepare("SELECT status FROM kit_jobs WHERE id = ?").get(job.id);
        if (!cur || cur.status !== 'queued') return; // raced with a reset or another runner
        db.exec('SAVEPOINT wsb_job');
        try {
          const r = await handler({ payload: JSON.parse(job.payload), job, db, now: new Date(jobTime), tenant: this });
          db.exec('RELEASE wsb_job');
          this.st.jobDone.run(r === undefined ? null : JSON.stringify(r), sqlTime(jobTime), job.id);
        } catch (e) {
          db.exec('ROLLBACK TO wsb_job'); db.exec('RELEASE wsb_job');
          this.st.jobFail.run(String(e && e.stack || e).slice(0, 2000), sqlTime(jobTime), job.id);
        }
      }, { jobTime });
      n++;
    }
    this.stats.jobsRun += n;
    return n;
  }

  async advance(seconds) {
    await this.lock(() => this.setClock({ advance: seconds }));
    return this.runDueJobs();
  }

  close() { try { this.db && this.db.close(); } catch {} }
}

module.exports = { Tenant, ensureCopy };
