'use strict';
// One pass over every article's stored HTML (worker threads): infobox rows and simple
// wikitables, written to a JSONL cache that the templates read. Rebuilt when base.db changes
// (size + mtime key) or with --rebuild. Deterministic: lines in article-id order.
//   node tasks/wiki/gen/cache.js [--rebuild]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const CACHE_DIR = process.env.WIKI_GEN_CACHE || '$WSB_WORK/wiki/gen-cache';
const MAX_LINES = 25; const MAX_ROWS = 80;

function work({ lo, hi }) {
  const L = require('./lib');
  const E = require('./extract');
  const db = L.openDb();
  const ids = db.prepare('SELECT id FROM article WHERE id >= ? AND id < ? ORDER BY id').pluck().all(lo, hi);
  const out = [];
  for (const id of ids) {
    let doc;
    try { doc = E.parseArticle(L.html(db, id)); } catch { continue; }
    const ib = E.infobox(doc);
    const tb = E.tables(doc, E.sectionFinder(doc)).filter((t) => t.rows.length <= MAX_ROWS);
    if (!ib && !tb.length) continue;
    const rec = { id };
    if (ib) rec.ib = { cls: ib.cls, above: ib.above, rows: ib.rows.map((r) => ({ h: r.h, k: r.k, lines: r.lines.slice(0, MAX_LINES), more: r.lines.length > MAX_LINES ? 1 : undefined, links: r.links.slice(0, MAX_LINES), iso: r.iso.length ? r.iso : undefined })) };
    if (tb.length) rec.tables = tb;
    out.push(JSON.stringify(rec));
  }
  return out;
}

if (!isMainThread) {
  parentPort.postMessage(work(workerData));
} else if (require.main === module || process.env.WIKI_GEN_CACHE_BUILD) {
  build(process.argv.includes('--rebuild')).then((f) => console.error('cache', f));
}

function key() {
  const L = require('./lib');
  const st = fs.statSync(L.DB_PATH);
  return `${st.size}-${Math.floor(st.mtimeMs)}`;
}

async function build(force) {
  const L = require('./lib');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, 'articles.jsonl');
  const kf = path.join(CACHE_DIR, 'key');
  if (!force && fs.existsSync(file) && fs.existsSync(kf) && fs.readFileSync(kf, 'utf8') === key()) return file;
  const max = L.openDb().prepare('SELECT max(id) FROM article').pluck().get();
  const CH = 2000; const jobs = [];
  for (let lo = 1; lo <= max; lo += CH) jobs.push({ lo, hi: lo + CH });
  const res = new Array(jobs.length);
  const nw = Math.max(1, Math.min(6, os.cpus().length - 2));
  let next = 0; let done = 0; const t0 = Date.now();
  await Promise.all(Array.from({ length: nw }, () => new Promise((resolve, reject) => {
    const run = () => {
      if (next >= jobs.length) return resolve();
      const j = next++;
      const w = new Worker(__filename, { workerData: jobs[j] });
      w.once('message', (m) => { res[j] = m; done++; if (done % 10 === 0) console.error(`cache ${done}/${jobs.length} ${((Date.now() - t0) / 1000).toFixed(0)} s`); });
      w.once('error', reject);
      w.once('exit', () => run());
    };
    run();
  })));
  fs.writeFileSync(file + '.tmp', res.map((r) => r.join('\n')).filter(Boolean).join('\n') + '\n');
  fs.renameSync(file + '.tmp', file);
  fs.writeFileSync(kf, key());
  return file;
}

let _all = null;
// Map id -> record (ib / tables) for all cached articles
async function load() {
  if (_all) return _all;
  const file = await build(false);
  _all = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.ib) for (const x of r.ib.rows) x.text = x.lines.join(' ').replace(/\s+/g, ' ');
    _all.set(r.id, r);
  }
  return _all;
}

module.exports = { build, load, CACHE_DIR };
