'use strict';
// Search-text normalisation; must match build/textnorm.py (same abbrev.json table).
const ABBR = require('./abbrev.json');

const CANON = new Map();
for (const [short, longs] of Object.entries(ABBR.abbrev)) {
  CANON.set(short, short);
  for (const l of longs) CANON.set(l, short);
}
const LONG_FORMS = new Map(); // short -> [long forms] (for prefix expansion while typing)
for (const [short, longs] of Object.entries(ABBR.abbrev)) LONG_FORMS.set(short, longs);
const STOP = new Set(ABBR.stopwords);

function rawTokens(s) {
  if (!s) return [];
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[’'`´]/g, '')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function tokens(s) { return rawTokens(s).map((t) => CANON.get(t) || t); }
function norm(s) { return tokens(s).join(' '); }
/** canonical forms whose long form starts with the typed prefix (e.g. "aven" -> "ave") */
function prefixCanon(prefix) {
  const out = new Set();
  for (const [short, longs] of LONG_FORMS) {
    if (short.startsWith(prefix) && short !== prefix) out.add(short);
    for (const l of longs) if (l.startsWith(prefix) && l.length > prefix.length) out.add(short);
  }
  return [...out];
}
module.exports = { tokens, rawTokens, norm, prefixCanon, STOP, CANON };
