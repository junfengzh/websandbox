'use strict';
// Back-office helpers: store-timezone conversion (America/New_York), admin date inputs,
// number formatting, form-body access (Magento-style field names like product[price]).
const store = require('../../shared');

// ---------------------------------------------------------------- time zone (US Eastern)
// DST: second Sunday of March 02:00 local (07:00 UTC) .. first Sunday of November 02:00 local (06:00 UTC).
const dstCache = new Map();
function dstRange(y) {
  let r = dstCache.get(y);
  if (!r) {
    const mar1 = new Date(Date.UTC(y, 2, 1)).getUTCDay();
    const nov1 = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    r = [Date.UTC(y, 2, 1 + ((7 - mar1) % 7) + 7, 7), Date.UTC(y, 10, 1 + ((7 - nov1) % 7), 6)];
    dstCache.set(y, r);
  }
  return r;
}
const offsetH = (utcMs) => { const [a, b] = dstRange(new Date(utcMs).getUTCFullYear()); return utcMs >= a && utcMs < b ? -4 : -5; };
const parseUtc = (s) => Date.parse(String(s).replace(' ', 'T') + (String(s).length <= 10 ? 'T00:00:00Z' : 'Z'));
const sqlOf = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
// 'YYYY-MM-DD HH:MM:SS' UTC -> same format in store local time
function toLocal(s) {
  if (!s) return null;
  const ms = parseUtc(s);
  if (!Number.isFinite(ms)) return null;
  return sqlOf(ms + offsetH(ms) * 3600e3);
}
// local 'YYYY-MM-DD[ HH:MM:SS]' -> UTC 'YYYY-MM-DD HH:MM:SS'
function localToUtc(s) {
  const ms = parseUtc(s);
  let u = ms + 5 * 3600e3; // guess EST
  u = ms - offsetH(u) * 3600e3;
  return sqlOf(u);
}
const localDate = (s) => (s ? (toLocal(s) || '').slice(0, 10) : null);

// SQL functions on the tenant connection (registered once per connection; not a write).
const fnDone = new WeakSet();
function ensureSqlFunctions(db) {
  if (fnDone.has(db)) return;
  db.function('admin_local', { deterministic: true }, (s) => (s == null ? null : toLocal(String(s))));
  db.function('admin_local_date', { deterministic: true }, (s) => (s == null ? null : localDate(String(s))));
  fnDone.add(db);
}

// ---------------------------------------------------------------- admin date input
// Accepts M/D/YY, M/D/YYYY, YYYY-MM-DD (Magento admin shows M/D/YY in the report filters).
function parseDateInput(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  let y; let mo; let d;
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) { [mo, d, y] = [+m[1], +m[2], +m[3]]; if (y < 100) y += 2000; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}
// 'YYYY-MM-DD' -> 'M/D/YY' (Magento admin display)
const shortDate = (iso) => { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${+m}/${+d}/${y.slice(2)}`; };
// local date range (inclusive days) -> UTC bounds [from, to)
function localRangeUtc(fromIso, toIso) {
  const out = {};
  if (fromIso) out.from = localToUtc(`${fromIso} 00:00:00`);
  if (toIso) { const next = new Date(Date.parse(toIso + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10); out.to = localToUtc(`${next} 00:00:00`); }
  return out;
}

// ---------------------------------------------------------------- numbers
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const money = store.money;
const num = (v) => (v == null || v === '' ? '' : nf0.format(Number(v)));
// value for <input name="product[price]">: 2 decimals (Magento shows 27.00)
const priceInput = (v) => (v == null || v === '' ? '' : Number(v).toFixed(2));
// qty: whole numbers without decimals (50, not 50.0000)
const qtyInput = (v) => (v == null || v === '' ? '' : Number.isInteger(Number(v)) ? String(Number(v)) : String(Number(v)));
const pct = (v) => `${nf2.format(Number(v || 0))}%`;

// ---------------------------------------------------------------- form bodies
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => { if (Array.isArray(v)) v = v[v.length - 1]; return v == null ? '' : String(v).trim(); };
const has = (b, k) => b && Object.prototype.hasOwnProperty.call(b, k);
const ids = (v) => [...new Set(arr(v).flatMap((x) => String(x).split(',')).map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n) && n > 0))];
function numOrNull(v) {
  const s = str(v).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
const slugify = (s) => store.plainName(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const pad9 = (n) => String(n).padStart(9, '0');
const ucfirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

// Deterministic PRNG (coupon codes etc.): mulberry32 seeded from a string.
function prng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

module.exports = {
  TZ: store.TZ, toLocal, localToUtc, localDate, ensureSqlFunctions, parseDateInput, shortDate, localRangeUtc, offsetH,
  money, num, priceInput, qtyInput, pct, arr, str, has, ids, numOrNull, slugify, pad9, ucfirst, prng,
  date: store.date, htmlName: store.htmlName, plainName: store.plainName,
};
