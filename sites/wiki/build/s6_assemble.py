"""Step 6: assemble OUT/base.db from work/build.db (+ dirents titles, s2 stats).

Creates the runtime schema (see ../SCHEMA.md): article, redirect, link,
media, suggest, suggest_top, article_fts (contentless FTS5), meta, zdict.
Writes to base.db.tmp and renames at the end (re-running rebuilds it).

Env: FTS_DETAIL=full|column (default full), FTS_LIMIT=N (only N articles, for
measurements), KEEP_TEXT=1 to also store zstd plain text per article.
"""
import json
import re
import os
import sqlite3
import sys
import time
import unicodedata

import numpy as np
import zstandard

sys.path.insert(0, os.path.dirname(__file__))
from common import OUT, WORK  # noqa: E402

DETAIL = os.environ.get('FTS_DETAIL', 'full')
LIMIT = int(os.environ.get('FTS_LIMIT', '0'))
KEEP_TEXT = os.environ.get('KEEP_TEXT', '0') == '1'
TOP_PREFIX = 3


def norm(s):
    s = unicodedata.normalize('NFKD', s.replace('_', ' '))
    s = ''.join(c for c in s if not unicodedata.combining(c))
    return ' '.join(s.lower().split())


SCHEMA = '''
pragma page_size=4096;
create table meta(k text primary key, v text);
create table zdict(id integer primary key, dict blob not null);
create table article(
  id integer primary key,          -- 1..N, task articles first, then by in-links
  path text not null unique,       -- URL path segment: /wiki/<path> (underscores)
  title text not null,
  html blob not null,              -- zstd (dictionary zdict.id=1) of cleaned article HTML
  html_len int not null,
  text blob,                       -- optional: zstd (no dict) plain text
  text_len int not null,
  lead text,                       -- first paragraph, plain text (search snippets)
  sections text,                   -- JSON [[level, anchor, heading], ...] for the TOC
  infobox int not null,
  image text,                      -- first non-icon image url (/media/..), or NULL
  inlinks int not null,            -- in-link count over the whole 2022-05 ZIM
  edited text,                     -- last edit date on Wikipedia (YYYY-MM-DD)
  oldid int,                       -- Wikipedia revision id of the snapshot
  reason text not null             -- why selected: task:<ids> | hop1:<path> | inlinks | always
);
create table redirect(path text primary key, title text not null, target int not null) without rowid;
create index redirect_target on redirect(target);
create table link(dst int not null, src int not null, primary key(dst, src)) without rowid;
create table media(url text primary key, w int, h int, bytes int not null) without rowid;
create table suggest(norm text not null, title text not null, target int not null, score int not null, is_redirect int not null);
create table suggest_top(prefix text primary key, items text not null) without rowid;
'''


def main():
    t0 = time.time()
    tmp = os.path.join(OUT, 'base.db.tmp')
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript('pragma journal_mode=off; pragma synchronous=off; pragma cache_size=-2000000;')
    db.executescript(SCHEMA)
    b = sqlite3.connect(os.path.join(WORK, 'build.db'))
    dd = sqlite3.connect(os.path.join(WORK, 'dirents.db'))
    st = np.load(os.path.join(WORK, 's2', 'stats.npz'))
    inl = st['inlinks']
    zd = b.execute("select v from meta where k='zdict'").fetchone()[0]
    db.execute('insert into zdict values(1, ?)', (zd,))
    tdz = zstandard.ZstdDecompressor()
    zdict = zstandard.ZstdCompressionDict(zd)
    hdz = zstandard.ZstdDecompressor(dict_data=zdict)
    hcz = zstandard.ZstdCompressor(level=15, dict_data=zdict)
    img_re = re.compile(r'<img src="(/media/[^"]+)"[^>]*>')
    stripped = 0
    media_ok = {u: (w, h, n) for u, w, h, n in b.execute('select url, w, h, bytes from media where bytes is not null')}
    db.executemany('insert into media values(?,?,?,?)', [(u, w, h, n) for u, (w, h, n) in media_ok.items()])

    q = 'select id, zid, path, reason, html, html_len, text, text_len, lead, sections, infobox, image, edited, oldid from art where error is null order by id'
    if LIMIT:
        q += ' limit %d' % LIMIT
    db.execute("create virtual table article_fts using fts5(title, body, content='', detail=%s, "
               "tokenize='porter unicode61 remove_diacritics 2')" % DETAIL)
    n = 0
    ids = set()
    score = {}
    for (i, zid, path, why, html, hl, text, tl, lead, sec, ib, image, edited, oldid) in b.execute(q):
        title = dd.execute('select title from art where id=?', (zid,)).fetchone()[0]
        if image and image not in media_ok:
            image = None
        h = hdz.decompress(html).decode()
        if any(m.group(1) not in media_ok for m in img_re.finditer(h)):
            # images not kept (media budget or fetch error): drop the <img> tags
            h = img_re.sub(lambda m: m.group(0) if m.group(1) in media_ok else '', h)
            hb = h.encode()
            html, hl = hcz.compress(hb), len(hb)
            stripped += 1
        db.execute('insert into article values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (i, path, title, html, hl, text if KEEP_TEXT else None, tl, lead, sec, ib, image,
                    int(inl[zid]), edited, oldid, why))
        body = tdz.decompress(text).decode()
        db.execute('insert into article_fts(rowid, title, body) values(?,?,?)', (i, title, body))
        ids.add(i)
        score[i] = int(inl[zid])
        n += 1
        if n % 20000 == 0:
            print('articles', n, '%.0fs' % (time.time() - t0), flush=True)
    print('articles', n, 'with images stripped', stripped, flush=True)
    db.execute("insert into article_fts(article_fts) values('optimize')")
    print('fts optimized %.0fs' % (time.time() - t0), flush=True)

    reds = [(p, p.replace('_', ' '), t) for p, t in b.execute('select path, target from redirect') if t in ids]
    db.executemany('insert or ignore into redirect values(?,?,?)', reds)
    db.executemany('insert or ignore into link values(?,?)',
                   ((d, s) for s, d in b.execute('select src, dst from link') if s in ids and d in ids))
    print('redirects', len(reds), 'links done %.0fs' % (time.time() - t0), flush=True)

    # title suggestions: articles + redirects (deduped by normalized title per target)
    sug = {}
    for i, title in db.execute('select id, title from article'):
        sug[(norm(title), i)] = (title, score[i] * 2 + 1, 0)
    for p, title, t in reds:
        k = (norm(title), t)
        if k not in sug:
            sug[k] = (title, score[t] // 10, 1)
    rows = [(k[0], v[0], k[1], v[1], v[2]) for k, v in sug.items() if k[0]]
    db.executemany('insert into suggest values(?,?,?,?,?)', rows)
    db.execute('create index suggest_norm on suggest(norm, score desc)')
    tops = {}
    for nm, title, t, s, r in rows:
        for L in range(1, TOP_PREFIX + 1):
            if len(nm) >= L:
                tops.setdefault(nm[:L], []).append((s, t, title, r))
    top_rows = []
    for pre, lst in tops.items():
        lst.sort(key=lambda x: -x[0])
        out, seen = [], set()
        for s, t, title, r in lst:
            if t in seen:
                continue
            seen.add(t)
            out.append([title, t])
            if len(out) == 10:
                break
        top_rows.append((pre, json.dumps(out, ensure_ascii=False)))
    db.executemany('insert into suggest_top values(?,?)', top_rows)
    print('suggest', len(rows), 'prefixes', len(top_rows), '%.0fs' % (time.time() - t0), flush=True)

    meta = {
        'source': 'wikipedia_en_all_maxi_2022-05.zim (Kiwix, mwoffliner 1.11.11, snapshot 2022-05-01)',
        'licence': 'CC BY-SA 4.0 (text, Wikipedia contributors); media under their own free licences (see SOURCES.md)',
        'built': time.strftime('%Y-%m-%d'),
        'articles': str(n), 'redirects': str(len(reds)),
        'links': str(db.execute('select count(*) from link').fetchone()[0]),
        'media': str(len(media_ok)),
        'fts_detail': DETAIL,
        'zstd': 'article.html: zstd with dictionary zdict(id=1); article.text: plain zstd',
        'categories': 'none: the ZIM (mwoffliner) strips category links',
        'main_page': 'User:The_other_Kiwix_guy/Landing',
    }
    db.executemany('insert into meta values(?,?)', meta.items())
    db.commit()
    db.execute('analyze')
    db.commit()
    db.execute('vacuum')
    db.close()
    os.rename(tmp, os.path.join(OUT, 'base.db'))
    print('done %.0fs' % (time.time() - t0))


if __name__ == '__main__':
    main()
