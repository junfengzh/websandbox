'use strict';
// Table lookups in article bodies: simple wikitables (one header row, no row/col spans; see
// extract.js) -- look up a cell by its row key, count rows with a value, find the row with the
// largest / smallest number in a column.
const L = require('./lib');
const F = require('./facts');

const T = [];
const BORING = /^(See also|References|External links|Notes|Further reading|Bibliography|Sources)$/i;
const NUM = /^-?\d[\d,]*(\.\d+)?%?$/;
const num = (s) => (NUM.test(s) ? +s.replace(/[,%]/g, '') : null);
const okHdr = (h) => h.length >= 2 && h.length <= 30 && /[A-Za-z]/.test(h) && !/[\[\]"]/.test(h);
// a row key as a solver would write it: no trailing "(IRL)" / footnote marks (+, *, †, ‡, ^, #)
const keyClean = (v) => v.replace(/\s*\([^()]*\)\s*$/, '').replace(/[\s+*†‡^#§¤]+$/, '').trim();
// plain cell text a solver can type back: letters, digits and common punctuation only
const okCell = (v) => v && v.length <= 50 && !/^[-–—?]$/.test(v) && /^[\p{L}\p{N} .,'’&()\-–:\/%$]+$/u.test(v);
const TOTAL = /^(totals?|overall|sum|all|grand total|average|mean)\b/i;

// usable tables: [{id, m, t, key (column index of unique names)}], one table per (article, section)
function* usableTables(c) {
  for (const [id, rec] of c.all) {
    if (!rec.tables) continue;
    const m = c.meta.get(id);
    if (!m || m.inlinks < 30 || /^(Main_Page|User:|Wikipedia)/.test(m.path) || c.byNorm.get(L.norm(m.title)) !== id) continue;
    const perSec = new Map();
    for (const t of rec.tables) { const k = t.section ? t.section.text : ''; perSec.set(k, (perSec.get(k) || 0) + 1); }
    for (let t of rec.tables) {
      if (!t.section || BORING.test(t.section.text) || perSec.get(t.section.text) !== 1) continue;
      if (t.section.text.length > 60 || /["]/.test(t.section.text)) continue;
      if (!t.header.every(okHdr)) continue;
      { const kept = t.rows.filter((r) => !TOTAL.test(r[0])); t = { ...t, rows: kept, dropped: kept.length !== t.rows.length }; } // total / summary rows out
      if (t.rows.length < 4) continue;
      // key column: first column (of the first 3) with unique, non-numeric, short values
      let key = -1;
      for (let j = 0; j < Math.min(3, t.header.length); j++) {
        const vs = t.rows.map((r) => keyClean(r[j] || ''));
        if (vs.every((v) => v.length >= 2 && v.length <= 40 && okCell(v) && num(v) == null && !/^\d/.test(v)) && new Set(vs.map(L.norm)).size === vs.length) { key = j; break; }
      }
      if (key < 0) continue;
      // no key that is a substring of another (so must_include of a key is unambiguous)
      for (const r of t.rows) r[key] = keyClean(r[key]);
      const ks = t.rows.map((r) => L.norm(r[key]));
      if (ks.some((a, ia) => ks.some((b, ib) => ia !== ib && b.includes(a)))) continue;
      yield { id, m, t, key };
    }
  }
}

T.push({
  id: 'gen-wiki-table-lookup', skills: ['search', 'navigate', 'read-detail'], difficulty: 2, cap: 60,
  phrasings: [
    'In the wiki article {title}, the table in the "{sec}" section has a "{keyh}" column. What is the "{colh}" value for "{key}"?',
    'Open {title} and find the table under "{sec}". For the row "{key}", what does the "{colh}" column say?',
    'According to the table in the "{sec}" section of {title}, what is the {colh} of {key}?',
  ],
  generate({ c }) {
    const out = [];
    for (const { m, t, key } of usableTables(c)) {
      const h = L.strHash(m.path + t.section.text);
      const ri = h % t.rows.length;
      const row = t.rows[ri];
      const cols = t.header.map((_, j) => j).filter((j) => j !== key && okCell(row[j]) && row[j].length >= 1 && L.norm(t.header[j]) !== L.norm(t.header[key]));
      if (!cols.length) continue;
      const j = cols[(h >>> 8) % cols.length];
      const v = row[j];
      // yes/no style or very short values are guessable; keep values with letters or numbers of >= 2 chars
      if (/^(yes|no|n\/a|—|-)$/i.test(v) || v.length < 2) continue;
      out.push({ vars: { title: m.title, sec: t.section.text, keyh: t.header[key], key: row[key], colh: t.header[j] }, eval: { type: 'answer', answer: { must_include: [v] } }, ref: v });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-table-count', skills: ['search', 'navigate', 'aggregate'], difficulty: 3, cap: 55,
  phrasings: [
    'In the table under the "{sec}" section of {title}, how many rows have "{val}" in the "{colh}" column?',
    'Open {title}. In the "{sec}" table, count the entries whose {colh} is "{val}".',
  ],
  generate({ c }) {
    const out = [];
    for (const { m, t, key } of usableTables(c)) {
      if (t.rows.length > 60 || t.dropped) continue; // counts must match the table as shown
      let best = null;
      for (let j = 0; j < t.header.length; j++) {
        if (j === key) continue;
        const cnt = new Map();
        for (const r of t.rows) cnt.set(r[j], (cnt.get(r[j]) || 0) + 1);
        if (cnt.size < 2 || cnt.size > t.rows.length / 2) continue;
        for (const [v, n] of cnt) {
          if (!okCell(v) || num(v) != null || v.length < 2 || /^(yes|no)$/i.test(v) || n < 2 || n > 15 || n === t.rows.length) continue;
          // other values must not contain this one (a solver matching by substring would overcount)
          if ([...cnt.keys()].some((w) => w !== v && L.norm(w).includes(L.norm(v)))) continue;
          if (!best || n > best.n) best = { j, v, n };
        }
      }
      if (!best) continue;
      out.push({ vars: { title: m.title, sec: t.section.text, colh: t.header[best.j], val: best.v }, eval: { type: 'answer', answer: { must_include: [L.countRef(best.n)] } }, ref: best.n });
    }
    return out;
  },
});

T.push({
  id: 'gen-wiki-table-extreme', skills: ['search', 'navigate', 'compare'], difficulty: 3, cap: 55,
  phrasings: [
    'In the table in the "{sec}" section of {title}, which {keyh} has the {dir} {colh}?',
    'Open {title} and look at the "{sec}" table. Which entry has the {dir} value in the "{colh}" column? Give its {keyh}.',
  ],
  generate({ c }) {
    const out = [];
    for (const { m, t, key } of usableTables(c)) {
      if (t.rows.length > 60) continue;
      const h = L.strHash(m.path + t.section.text);
      const cands = [];
      for (let j = 0; j < t.header.length; j++) {
        if (j === key || /\b(No|Rank|Year|Season|Refs?|Number|Pos|Pick|Round|Notes?|Overall|Seed|Code|ID)\b|#/i.test(t.header[j])) continue;
        const vs = t.rows.map((r) => num(r[j]));
        if (vs.some((v) => v == null)) continue;
        if (new Set(vs).size < 4) continue;
        for (const dir of ['highest', 'lowest']) {
          const s = vs.map((v, i) => [v, i]).sort((a, b) => (dir === 'highest' ? b[0] - a[0] : a[0] - b[0]));
          if (s[0][0] === s[1][0]) continue;
          cands.push({ j, dir, ri: s[0][1] });
        }
      }
      if (!cands.length) continue;
      const x = cands[h % cands.length];
      const win = t.rows[x.ri][key];
      out.push({ vars: { title: m.title, sec: t.section.text, keyh: t.header[key], colh: t.header[x.j], dir: x.dir }, eval: { type: 'answer', answer: { must_include: [win] } }, ref: `${win} (${t.rows[x.ri][x.j]})` });
    }
    return out;
  },
});

module.exports = T;
void F;
