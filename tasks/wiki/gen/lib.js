'use strict';
// Shared helpers for the wiki (wiki.wa) task generator: base.db access, zstd article HTML,
// HTML parsing (node-html-parser), value cleaning, seeded randomness, task-line builder.
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..', '..');
const Database = require(path.join(ROOT, 'kit', 'node_modules', 'better-sqlite3'));
const { Decompressor } = require(path.join(ROOT, 'sites', 'wiki', 'node_modules', 'zstd-napi'));
const { parse } = require(path.join(__dirname, 'node_modules', 'node-html-parser'));

const DB_PATH = process.env.WIKI_DB || path.join(process.env.WSB_DATA_ROOT || path.join(__dirname, '../../..', 'data'), 'wiki/base.db');
let _db = null; let _dz = null;
function openDb() {
  if (!_db) _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}
function html(db, id) {
  if (!_dz) { _dz = new Decompressor(); _dz.loadDictionary(db.prepare('SELECT dict FROM zdict WHERE id = 1').pluck().get()); }
  const b = db.prepare('SELECT html FROM article WHERE id = ?').pluck().get(id);
  return b ? _dz.decompress(b).toString('utf8') : null;
}
module.exports = { openDb, html, parse, DB_PATH, ROOT };

// ---------------------------------------------------------------- randomness (seeded)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function strHash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
class Rand {
  constructor(seed) { this.r = mulberry32(seed); }
  next() { return this.r(); }
  int(n) { return Math.floor(this.r() * n); }
  pick(a) { return a[this.int(a.length)]; }
  shuffle(a) { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = this.int(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; }
  sample(a, n) { return this.shuffle(a).slice(0, n); }
}

// ---------------------------------------------------------------- SQL / text helpers
const q = (s) => (s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'");
const aid = (p) => `(SELECT id FROM article WHERE path = ${q(p)})`;
// suggest.norm-like normalisation for comparisons
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// must_include alternatives for an ISO date (the page shows "September 21, 1947" or "21 September 1947")
function dateAlts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const y = m[1]; const mo = MONTHS[+m[2] - 1]; const d = String(+m[3]);
  if (!mo || +m[3] < 1 || +m[3] > 31) return null;
  const ab = mo.slice(0, 3);
  return [`${mo} ${d}, ${y}`, `${d} ${mo} ${y}`, `${mo} ${d} ${y}`, `${ab} ${d}, ${y}`, `${d} ${ab} ${y}`, `${ab}. ${d}, ${y}`, `${y}-${m[2]}-${m[3]}`, `${mo} ${d}th, ${y}`, `${mo} ${d}st, ${y}`, `${mo} ${d}nd, ${y}`, `${mo} ${d}rd, ${y}`].join(' |OR| ');
}
const fmtDate = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`; };
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
const wikiPath = (p) => '/wiki/' + encodeURIComponent(p).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%27/g, "'")
  .replace(/%40/g, '@').replace(/%24/g, '$').replace(/%3B/g, ';');

// ---------------------------------------------------------------- phrasing / task lines
function fill(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`slot ${k} missing for "${tpl}"`);
    return vars[k];
  });
}
// inst = {vars, eval, start?, phrasing? (index), skills?, difficulty?}
function makeTask(t, inst, rand) {
  const phr = typeof inst.phrasing === 'string' ? inst.phrasing : t.phrasings[inst.phrasing ?? rand.int(t.phrasings.length)];
  const intent = fill(phr, inst.vars);
  return {
    task_id: null,
    site: 'wiki',
    intent,
    intent_template: phr.replace(/\{(\w+)\}/g, '{{$1}}'),
    intent_template_id: t.id,
    instantiation_dict: inst.vars,
    start_url: '__WIKIPEDIA__' + (inst.start || '/wiki/Main_Page'),
    require_login: false,
    login_user: null,
    eval: inst.eval,
    source: 'generated',
    template: t.id,
    kind: 'read',
    skills: inst.skills || t.skills,
    difficulty: inst.difficulty || t.difficulty,
    status: 'unverified',
  };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
// must_include reference for a small count: the digits or the word ("2 |OR| two")
const countRef = (n) => (n >= 0 && n <= 20 ? `${n} |OR| ${WORDS[n]}` : String(n));
module.exports.countRef = countRef;
module.exports.Rand = Rand; module.exports.strHash = strHash; module.exports.q = q; module.exports.aid = aid;
module.exports.norm = norm; module.exports.dateAlts = dateAlts; module.exports.fmtDate = fmtDate; module.exports.ordinal = ordinal;
module.exports.wikiPath = wikiPath; module.exports.fill = fill; module.exports.makeTask = makeTask; module.exports.MONTHS = MONTHS;
