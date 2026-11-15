"""Search-text normalisation shared with lib/textnorm.js (same rules, same table).

Index and query text are both lower-cased, stripped of apostrophes and
punctuation, and every token that has an abbreviation in lib/abbrev.json is
replaced by its canonical short form (street -> st, avenue -> ave, saint -> st,
university -> univ, ...). FTS5's unicode61 tokenizer removes diacritics.
"""
import functools, json, os, re, unicodedata

_ABBR = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib', 'abbrev.json')))
CANON = {}
for short, longs in _ABBR['abbrev'].items():
    CANON[short] = short
    for l in longs:
        CANON[l] = short

_APOS = re.compile(r"[’'`´]")
_NONWORD = re.compile(r"[\W_]+", re.UNICODE)


@functools.lru_cache(maxsize=1 << 21)
def _tokens(s):
    if not s.isascii():
        s = unicodedata.normalize('NFKD', s)
        s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace('&', ' and ')
    s = _APOS.sub('', s)
    return tuple(CANON.get(t, t) for t in _NONWORD.sub(' ', s).split())


def tokens(s):
    return list(_tokens(s)) if s else []


@functools.lru_cache(maxsize=1 << 21)
def _norm(s):
    return ' '.join(_tokens(s))


def norm(s):
    return _norm(s) if s else ''
