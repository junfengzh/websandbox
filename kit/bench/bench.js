#!/usr/bin/env node
'use strict';
// Kit benchmark on the notes toy site. Results go to stdout as JSON lines.
//   node bench/bench.js multi --dir WORK --notes 200000 --tenants 32 --workers 1,4 --seconds 30
//     32 tenants in one server (or W worker processes): startup/copy time, RSS per tenant,
//     page latency under C concurrent closed-loop clients with periodic resets.
//   node bench/bench.js big --dir WORK --notes 1500000 --tenants 4
//     a 1-2 GB base DB: copy time, page latency, long transactions (WAL growth, reset time).
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'examples', 'notes', 'server.js');
const { positionals: [mode = 'multi'], values: a } = parseArgs({ allowPositionals: true, options: {
  dir: { type: 'string' }, notes: { type: 'string', default: '200000' }, words: { type: 'string', default: '60' }, tenants: { type: 'string', default: '32' },
  workers: { type: 'string', default: '1,4' }, seconds: { type: 'string', default: '30' }, clients: { type: 'string' }, port: { type: 'string', default: '7120' },
  'think-ms': { type: 'string', default: '0' }, 'cache-mb': { type: 'string', default: '32' },
} });
if (!a.dir) { console.error('--dir WORKDIR required'); process.exit(2); }
const PORT = +a.port;
const log = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDb(dir, notes) {
  const db = path.join(dir, 'base.db');
  if (fs.existsSync(db) && fs.existsSync(db + '.notes') && fs.readFileSync(db + '.notes', 'utf8') === `${notes}/${a.words}`) return db;
  const t0 = Date.now();
  execFileSync(process.execPath, [path.join(ROOT, 'examples', 'notes', 'build', 'build.js'), '--out', dir, '--notes', String(notes), '--words', a.words], { stdio: 'inherit' });
  fs.writeFileSync(db + '.notes', `${notes}/${a.words}`);
  log({ step: 'build', notes, sizeMB: +(fs.statSync(db).size / 2 ** 20).toFixed(0), secs: (Date.now() - t0) / 1000 });
  return db;
}

const rssOf = (pid) => {
  const kids = (() => { try { return execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').filter(Boolean).map(Number); } catch { return []; } })();
  return [pid, ...kids].reduce((s, p) => { try { return s + +/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8'))[1] / 1024; } catch { return s; } }, 0);
};

// CPU seconds (user+sys) of a process and its children
const cpuOf = (pid) => {
  const kids = (() => { try { return execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').filter(Boolean).map(Number); } catch { return []; } })();
  return [pid, ...kids].reduce((s, p) => { try { const f = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' '); return s + (+f[11] + +f[12]) / 100; } catch { return s; } }, 0);
};

async function startServer(dir, tenants, workers, extra = []) {
  const t0 = Date.now();
  const p = spawn(process.execPath, [SERVER, '--tenants', String(tenants), '--port', String(PORT), '--bind', 'rl', '--data', dir, '--workers', String(workers),
    '--uploads', path.join(dir, 'uploads'), '--cache-mb', a['cache-mb'], ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', () => {});
  live.add(p);
  // ready when every tenant answers health
  for (let i = 0; i < tenants; i++) {
    for (;;) {
      if (p.exitCode != null) throw new Error('server exited');
      try { if ((await fetch(`http://127.10.${i}.9:${PORT}/__rl/health`)).ok) break; } catch {}
      await sleep(100);
    }
  }
  return { p, startMs: Date.now() - t0 };
}
const live = new Set();
process.on('exit', () => { for (const p of live) try { p.kill('SIGTERM'); } catch {} });
const stop = async (p) => {
  live.delete(p); p.kill('SIGTERM'); for (let i = 0; i < 50 && p.exitCode == null; i++) await sleep(100); if (p.exitCode == null) p.kill('SIGKILL'); };

function load(o) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'load.js'), '--port', String(PORT), '--clients', String(o.clients), '--seconds', String(o.seconds),
      '--think-ms', String(o.think || 0), '--max-id', String(o.maxId), '--reset-every', String(o.resetEvery || 200)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', (c) => (c ? rej(new Error('load failed')) : res(JSON.parse(out))));
  });
}

const walSizes = (dir) => fs.readdirSync(path.join(dir, 'tenants')).filter((f) => f.endsWith('-wal')).map((f) => fs.statSync(path.join(dir, 'tenants', f)).size / 2 ** 20);

async function multi() {
  const dir = a.dir; fs.mkdirSync(dir, { recursive: true });
  ensureDb(dir, +a.notes);
  const T = +a.tenants;
  fs.rmSync(path.join(dir, 'tenants'), { recursive: true, force: true });
  // baseline: 1 tenant
  let s = await startServer(dir, 1, 1);
  await load({ clients: 1, seconds: 5, maxId: +a.notes });
  const rss1 = rssOf(s.p.pid);
  await stop(s.p);
  log({ step: 'baseline', tenants: 1, rssMB: +rss1.toFixed(0) });
  for (const W of a.workers.split(',').map(Number)) {
    const cold = !fs.existsSync(path.join(dir, 'tenants', `t${T - 1}.db`));
    s = await startServer(dir, T, W);
    const rssIdle = rssOf(s.p.pid);
    const cpu0 = cpuOf(s.p.pid);
    const r = await load({ clients: +(a.clients || T), seconds: +a.seconds, maxId: +a.notes, think: +a['think-ms'] });
    const rss = rssOf(s.p.pid);
    const cpuMsPerReq = +(((cpuOf(s.p.pid) - cpu0) * 1000) / r.requests).toFixed(2);
    // reset timing measured from outside, after the run (dirty tenants)
    const ext = [];
    for (let i = 0; i < T; i++) { const t0 = performance.now(); const j = await (await fetch(`http://127.10.${i}.9:${PORT}/__rl/reset`, { method: 'POST' })).json(); ext.push({ http: performance.now() - t0, server: j.ms }); }
    await stop(s.p);
    log({ step: 'multi', tenants: T, workers: W, thinkMs: +a['think-ms'], cpuMsPerReq, startMs: s.startMs, coldCopy: cold, rssIdleMB: +rssIdle.toFixed(0), rssLoadedMB: +rss.toFixed(0),
      perTenantMB: +((rss - rss1) / (T - 1)).toFixed(1), resetAfterRun: { serverMsMax: +Math.max(...ext.map((x) => x.server)).toFixed(2), httpMsMax: +Math.max(...ext.map((x) => x.http)).toFixed(2) },
      walMBmax: +Math.max(0, ...walSizes(dir)).toFixed(1), load: r });
  }
}

async function big() {
  const dir = a.dir; fs.mkdirSync(dir, { recursive: true });
  const base = ensureDb(dir, +a.notes);
  const T = +a.tenants;
  fs.rmSync(path.join(dir, 'tenants'), { recursive: true, force: true });
  execFileSync('sync');
  const s = await startServer(dir, T, 1);
  log({ step: 'big-start', baseMB: +(fs.statSync(base).size / 2 ** 20).toFixed(0), tenants: T, coldStartMs: s.startMs, note: 'includes copying base.db once per tenant (4 concurrent)' });
  const r = await load({ clients: T, seconds: +a.seconds, maxId: +a.notes });
  log({ step: 'big-load', load: r });
  // long rollout transaction: many writes in tenant 0, then measure WAL + reset
  const kitq = (sql) => fetch(`http://127.10.0.9:${PORT}/__rl/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql }) }).then((x) => x.json());
  const session = async () => {
    const j = await (await fetch(`http://127.10.0.9:${PORT}/__rl/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"user":"alice"}' })).json();
    const cookie = `${j.cookie.name}=${j.cookie.value}`;
    const page = await (await fetch(`http://127.10.0.9:${PORT}/`, { headers: { cookie } })).text();
    return { cookie, csrf: /name="csrf-token" content="([^"]+)"/.exec(page)[1] };
  };
  for (const n of [2000, 20000]) {
    const { cookie, csrf } = await session();
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      await fetch(`http://127.10.0.9:${PORT}/notes`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, title: `long txn ${i}`, body: `zebra garden body ${i} `.repeat(20), tag: 'work' }), redirect: 'manual' });
    }
    const secs = (Date.now() - t0) / 1000;
    const tq = performance.now(); const c = await kitq("SELECT count(*) n FROM notes_fts WHERE notes_fts MATCH 'long'"); const qms = performance.now() - tq;
    const tp = performance.now(); await fetch(`http://127.10.0.9:${PORT}/?q=zebra+garden`, { headers: { cookie } }); const pms = performance.now() - tp;
    const wal = walSizes(dir);
    const rr = await (await fetch(`http://127.10.0.9:${PORT}/__rl/reset`, { method: 'POST' })).json();
    log({ step: 'long-txn', inserts: n, insertSecs: secs, ftsHits: c.rows[0].n, ftsQueryMs: +qms.toFixed(1), searchPageMs: +pms.toFixed(1), walMBmax: +Math.max(0, ...wal).toFixed(1), resetMs: rr.ms });
  }
  await stop(s.p);
  // a pathological rollout: one statement that dirties the whole DB, in-process
  delete require.cache[require.resolve(SERVER)];
  const site = require(SERVER);
  const srv = await site.start({ tenants: 1, port: PORT + 50, data: dir, bind: 'ports', uploads: path.join(dir, 'uploads2'), cacheMB: +a['cache-mb'] });
  const t = srv.tenants.get(0);
  const t0 = performance.now();
  await t.run((db) => db.prepare('UPDATE notes SET likes = likes + 1').run());
  const ums = performance.now() - t0;
  const wal = walSizes(dir);
  const rms = await t.reset();
  const after = await t.query('SELECT sum(likes) s FROM notes');
  await srv.close();
  log({ step: 'whole-db-update', updateMs: +ums.toFixed(0), walMBmax: +Math.max(0, ...wal).toFixed(0), resetMs: +rms.toFixed(2), sumLikesAfterReset: after.rows[0].s });
}

(mode === 'big' ? big() : multi()).catch((e) => { console.error(e); process.exit(1); });
