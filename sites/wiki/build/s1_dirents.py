"""Step 1: dump the ZIM directory (all entries) into work/dirents.db.

Tables:
  art(id INTEGER PRIMARY KEY, path TEXT, title TEXT, mime INT, cl INT, bl INT, redir INT)
    -- namespace A only. id = ZIM entry index. redir = target entry index for
       redirects (NULL for content), cl/bl = cluster/blob for content.
  img(path TEXT PRIMARY KEY, cl INT, bl INT, mime INT)  -- namespace I
Resumable: skipped if the db is complete (meta.done=1).
"""
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import zimraw  # noqa: E402
from common import ZIM, WORK  # noqa: E402


def main():
    out = os.path.join(WORK, 'dirents.db')
    if os.path.exists(out):
        db = sqlite3.connect(out)
        try:
            if db.execute("select v from meta where k='done'").fetchone():
                print('dirents.db already complete')
                return
        except sqlite3.Error:
            pass
        db.close()
        os.remove(out)
    db = sqlite3.connect(out)
    db.executescript('''
      pragma journal_mode=off; pragma synchronous=off;
      create table meta(k text primary key, v text);
      create table art(id integer primary key, path text, title text, mime int, cl int, bl int, redir int);
      create table img(path text, cl int, bl int, mime int);
      create table other(id integer primary key, ns text, path text, mime int, cl int, bl int);
    ''')
    z = zimraw.Zim(ZIM)
    db.execute("insert into meta values('mimes', ?)", ('\n'.join(z.mimes),))
    t = time.time()
    arts, imgs, oth = [], [], []
    n = 0
    for (idx, mime, ns, cl, bl, path, title) in z.iter_dirents():
        n += 1
        if ns == 'A':
            if mime == zimraw.REDIRECT:
                arts.append((idx, path, title, mime, None, None, cl))
            else:
                arts.append((idx, path, title, mime, cl, bl, None))
        elif ns == 'I':
            imgs.append((path, cl, bl, mime))
        else:
            oth.append((idx, ns, path, mime, cl, bl))
        if len(arts) + len(imgs) > 500000:
            db.executemany('insert into art values(?,?,?,?,?,?,?)', arts)
            db.executemany('insert into img values(?,?,?,?)', imgs)
            arts, imgs = [], []
        if n % 2000000 == 0:
            print(n, '%.0fs' % (time.time() - t), flush=True)
    db.executemany('insert into art values(?,?,?,?,?,?,?)', arts)
    db.executemany('insert into img values(?,?,?,?)', imgs)
    db.executemany('insert into other values(?,?,?,?,?,?)', oth)
    print('indexing', flush=True)
    db.executescript('''
      create unique index art_path on art(path);
      create index img_path on img(path);
    ''')
    db.execute("insert into meta values('done','1')")
    db.commit()
    print('done', n, '%.0fs' % (time.time() - t))


if __name__ == '__main__':
    main()
