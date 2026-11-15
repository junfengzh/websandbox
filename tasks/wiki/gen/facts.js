'use strict';
// Fact helpers over the extraction cache (cache.js): article metadata, infobox row lookup and
// value parsers that REJECT anything missing, multi-valued or ambiguous (return null).
const L = require('./lib');
const C = require('./cache');

let ctx = null;
async function context() {
  if (ctx) return ctx;
  const db = L.openDb();
  const all = await C.load();
  const meta = new Map(); const byPath = new Map(); const byNorm = new Map();
  for (const r of db.prepare('SELECT id, path, title, inlinks, sections FROM article ORDER BY id').iterate()) {
    meta.set(r.id, r);
    byPath.set(r.path, r.id);
    const n = L.norm(r.title);
    byNorm.set(n, byNorm.has(n) ? -1 : r.id);
  }
  // redirect resolution for infobox links (links are canonical already, but keep it safe)
  const redir = db.prepare('SELECT target FROM redirect WHERE path = ?').pluck();
  const resolve = (p) => byPath.get(p) ?? redir.get(p) ?? null;
  ctx = { db, all, meta, byPath, byNorm, resolve };
  return ctx;
}

const SKIP_TITLE = /^(Main_Page|Wikipedia|User:|List_of|Lists_of|Timeline|Index_of|Outline_of|\d)/;
// an article is a usable task entity: plain title, unique normalised title, not a list page
function usable(c, id) {
  const m = c.meta.get(id);
  if (!m || SKIP_TITLE.test(m.path)) return false;
  if (c.byNorm.get(L.norm(m.title)) !== id) return false;
  if (/[|<>"]/.test(m.title)) return false;
  return true;
}

// infobox rows matching a label regex (and optionally a section-header regex)
function rows(rec, kRe, hRe) {
  if (!rec || !rec.ib) return [];
  return rec.ib.rows.filter((r) => kRe.test(r.k) && (!hRe || hRe.test(r.h)));
}
function one(rec, kRe, hRe) {
  const rs = rows(rec, kRe, hRe);
  return rs.length === 1 ? rs[0] : null;
}

// ---- value parsers (null = reject)
const NAME_BAD = /\d|[():;/\[\]?]|\b(and|or|vacant|none|unknown|various|see|list|tba|tbd|interim|acting|et al)\b/i;
// one person/place name: a single line, no digits/parentheses/lists, 2..60 chars
function singleName(r, { allowDigits = false, allowParen = false } = {}) {
  if (!r || r.more || r.lines.length !== 1) return null;
  let s = r.lines[0].trim();
  if (!allowParen) s = s.replace(/\s*\((?:[A-Z]{1,3}|[a-z ]+)\)$/, '');
  if (s.length < 2 || s.length > 60) return null;
  if (!allowDigits && /\d/.test(s)) return null;
  if (/[():;/\[\]?]/.test(s) && !allowParen) return null;
  if (/\b(and|or|vacant|none|unknown|various|see|list|tba|tbd|interim|acting|et al)\b/i.test(s)) return null;
  if (/,/.test(s)) return null;
  return s;
}
// the linked article of a single-valued row (exactly one link, link text = whole value)
function singleLink(c, r) {
  if (!r || r.lines.length !== 1 || r.links.length !== 1) return null;
  const id = c.resolve(r.links[0]);
  return id && c.meta.has(id) ? id : null;
}
// one 4-digit year (all years in the row equal); range 1000..2022
function year(r) {
  if (!r || r.more) return null;
  const ys = [...new Set((r.text.match(/(?<![\d,.])(1\d{3}|20[0-2]\d)(?![\d,])/g) || []))];
  if (ys.length !== 1) return null;
  if (/\b(BC|BCE|c\.|circa|century)\b/i.test(r.text)) return null;
  return ys[0];
}
// one plain number (integers with thousands separators), nothing else numeric in the row
function count(r, { min = 1, max = 1e10 } = {}) {
  if (!r || r.more || r.lines.length !== 1) return null;
  const t = r.lines[0];
  const ns = t.match(/\d[\d,.]*/g) || [];
  if (ns.length !== 1) return null;
  if (!/^\d{1,3}(,\d{3})*$|^\d+$/.test(ns[0])) return null;
  const v = +ns[0].replace(/,/g, '');
  if (!(v >= min && v <= max)) return null;
  if (/[a-z]{3,}/i.test(t.replace(/\b(approx(imately)?|about|est(imated)?|people|seats?|persons?|spectators?)\b/gi, ''))) return null;
  return { v, shown: ns[0] };
}
// "1,370 ft (420 m)" / "420 m (1,378 ft)" -> metres; one measurement only
function lengthM(r, unitRe) {
  if (!r || r.more || r.lines.length !== 1) return null;
  const t = r.lines[0];
  const mm = [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(km|mi|m|ft)\b/g)];
  if (mm.length < 1 || mm.length > 2) return null;
  if ((t.match(/\d[\d,]*(?:\.\d+)?/g) || []).length !== mm.length) return null;
  const toM = { km: 1000, mi: 1609.344, m: 1, ft: 0.3048 };
  const vals = mm.map((m) => ({ v: +m[1].replace(/,/g, ''), u: m[2] }));
  if (unitRe && !vals.some((x) => unitRe.test(x.u))) return null;
  const ms = vals.map((x) => x.v * toM[x.u]);
  if (ms.length === 2 && Math.abs(ms[0] - ms[1]) > 0.03 * Math.max(ms[0], ms[1]) + 2) return null; // inconsistent pair
  const metric = vals.find((x) => x.u === 'm' || x.u === 'km') || vals[0];
  return { m: metric.v * toM[metric.u], shown: t, metric };
}
// "58.35 sq mi (151.12 km2)" -> km2
function areaKm2(r) {
  if (!r || r.more || r.lines.length !== 1) return null;
  const t = r.lines[0];
  const km = [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*km2/g)];
  const mi = [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*sq\s*mi/g)];
  if (km.length !== 1 || mi.length > 1) return null;
  if ((t.replace(/km2/g, 'km').match(/\d[\d,]*(?:\.\d+)?/g) || []).length !== km.length + mi.length) return null;
  const v = +km[0][1].replace(/,/g, '');
  if (mi.length) { const w = +mi[0][1].replace(/,/g, '') * 2.589988; if (Math.abs(w - v) > 0.03 * v + 0.05) return null; }
  return v > 0 ? { v, shown: t } : null;
}
// "148 minutes"
function minutes(r) {
  if (!r || r.more || r.lines.length !== 1) return null;
  const m = /^(\d{1,3}) (minutes|min\.?)$/.exec(r.lines[0]);
  return m && +m[1] >= 3 ? +m[1] : null;
}
// Born/Died row: {iso, place} (place = the last line, a plain "City, Region, Country" text)
// a written date "May 23, 2015" / "23 May 2015" -> ISO (exactly one in the text)
function textDate(t) {
  const M = L.MONTHS.join('|');
  const a = [...t.matchAll(new RegExp(`\\b(${M}) (\\d{1,2}), (\\d{4})\\b`, 'g'))].map((m) => [m[3], L.MONTHS.indexOf(m[1]) + 1, +m[2]]);
  const b = [...t.matchAll(new RegExp(`\\b(\\d{1,2}) (${M}) (\\d{4})\\b`, 'g'))].map((m) => [m[3], L.MONTHS.indexOf(m[2]) + 1, +m[1]]);
  const all = a.concat(b);
  if (all.length !== 1) return null;
  const [y, mo, d] = all[0];
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function bornDied(r, cls) {
  if (!r) return null;
  const iso = r.iso && r.iso.length ? (r.iso.length === 1 ? r.iso[0] : null) : textDate(r.text);
  if (!iso) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  let place = null;
  const last = r.lines[r.lines.length - 1];
  if (r.lines.length >= 2 && !/\d/.test(last) && !/[()]/.test(last) && /^[A-Z]/.test(last)) place = last;
  // the line before the place must hold the date
  if (place && !/\d{4}/.test(r.lines[r.lines.length - 2])) place = null;
  const age = /\(aged? (\d{1,3})\)/.exec(r.text);
  void cls;
  return { iso, place, age: age ? +age[1] : null };
}
const city = (place) => {
  if (!place) return null;
  const c = place.split(',')[0].trim();
  if (c.length < 3 || /\b(near|outside|suburb|unknown)\b/i.test(c)) return null;
  return c;
};

module.exports = { textDate, context, usable, rows, one, singleName, singleLink, year, count, lengthM, areaKm2, minutes, bornDied, city, NAME_BAD };
