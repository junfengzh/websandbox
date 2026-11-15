"""Step 4: clean + compress every selected article into work/build.db.

Reads selection.tsv (s3), streams the needed ZIM clusters in order with a
process pool, and stores per article: zstd(dict) HTML, zstd plain text (for
the FTS build in s6), lead, sections, out-links (to selected articles), the
thumbnails it references, and the revision footer (oldid, last-edited date).

Article ids in the output = selection rank + 1 (task articles first, then by
in-link count), so ids are stable for a given selection.

Resumable: work units already in build.db (table job) are skipped.
"""
import hashlib
import json
import multiprocessing as mp
import os
import random
import re
import sqlite3
import sys
import time

import zstandard

sys.path.insert(0, os.path.dirname(__file__))
import clean  # noqa: E402
import zimraw  # noqa: E402
from common import WORK, ZIM  # noqa: E402

NPROC = int(os.environ.get('S4_PROCS', '6'))
LEVEL = 15
THUMB_W = 320
TINY = 40
G = {}
FOOT = re.compile(rb'title="Last edited on (\d{4}-\d\d-\d\d)" href="https://en\.wikipedia\.org/wiki/\?title=[^"&]*&amp;oldid=(\d+)"')


def media_url(zpath, mime):
    h = hashlib.sha1(zpath.encode()).hexdigest()
    ext = 'svg' if 'svg' in mime else 'webp'
    return '/media/%s/%s.%s' % (h[:2], h[2:18], ext)


def k_for(rank, reason):
    if not reason.startswith(('inlinks', 'hop1')):
        return 12  # task + always articles: all figures
    if rank < 25000 or reason.startswith('hop1'):
        return 4
    return 2


def load_selection():
    sel = []
    with open(os.path.join(WORK, 'selection.tsv')) as f:
        for line in f:
            rank, zid, path, why, _ = line.rstrip('\n').split('\t')
            sel.append((int(rank), int(zid), path, why))
    return sel


def build_maps(sel):
    """path (any ZIM path incl. redirects) -> (new id, canonical path) for selected targets."""
    db = sqlite3.connect(os.path.join(WORK, 'dirents.db'))
    by_zid = {zid: (rank + 1, path) for rank, zid, path, _ in sel}
    m = {}
    for zid, (nid, path) in by_zid.items():
        m[path] = (nid, path)
    redir = {}
    for (i, p, rd) in db.execute('select id, path, redir from art where redir is not null'):
        redir[i] = (p, rd)
    redirects = []
    for i, (p, rd) in redir.items():
        j, hops = rd, 0
        while j in redir and hops < 8:
            j = redir[j][1]
            hops += 1
        if j in by_zid and p not in m:
            m[p] = by_zid[j]
            redirects.append((p, by_zid[j][0]))
    return m, redirects


def init_worker():
    G['z'] = zimraw.Zim(ZIM)
    G['img'] = sqlite3.connect(os.path.join(WORK, 'dirents.db'))
    G['zc'] = zstandard.ZstdCompressor(level=LEVEL, dict_data=G['dict'])
    G['tc'] = zstandard.ZstdCompressor(level=3)
    G['mimes'] = G['img'].execute("select v from meta where k='mimes'").fetchone()[0].split('\n')


def img_lookup(zpath):
    r = G['img'].execute('select mime from img where path=?', (zpath,)).fetchone()
    return None if r is None else G['mimes'][r[0]]


def process(raw, rank, reason):
    m = G['map']
    k = k_for(rank, reason)
    used = []
    seen = {}

    def link_fn(p):
        v = m.get(p)
        return v[1] if v else None

    def img_fn(zpath, w, h):
        if zpath in seen:
            return seen[zpath]
        mime = img_lookup(zpath)
        res = None
        if mime and (mime.startswith('image/')):
            tiny = 0 < w <= TINY and 0 < h <= TINY
            if tiny or len([u for u in used if not u[3]]) < k:
                if w > THUMB_W:
                    h = max(1, round(h * THUMB_W / w))
                    w = THUMB_W
                url = media_url(zpath, mime)
                used.append((url, zpath, mime, tiny))
                res = (url, w, h)
        seen[zpath] = res
        return res

    fm = FOOT.search(raw)
    r = clean.clean(raw, link_fn, img_fn)
    links = sorted({m[p][0] for p in r['links']})
    first_img = next((u[0] for u in used if not u[3]), None)
    hb, tb = r['html'].encode(), r['text'].encode()
    return dict(html=G['zc'].compress(hb), html_len=len(hb),
                text=G['tc'].compress(tb), text_len=len(tb),
                lead=r['lead'], sections=json.dumps(r['sections'], ensure_ascii=False),
                infobox=int(r['infobox']), links=links, media=[u[:3] for u in used], image=first_img,
                edited=fm.group(1).decode() if fm else None, oldid=int(fm.group(2)) if fm else None)


def work(job):
    jn, items = job  # items: [(cl, bl, nid, rank, reason)]
    out = []
    cur = None
    blobs = None
    for cl, bl, nid, rank, reason in items:
        if cl != cur:
            blobs = zimraw.decode_cluster(G['z'].read_cluster_raw(cl))
            cur = cl
        try:
            out.append((nid, process(blobs[bl], rank, reason)))
        except Exception as e:  # keep going; logged and retried as a stub
            out.append((nid, {'error': repr(e)}))
    return jn, out


def train_dict(sel, by_zid_loc):
    random.seed(3)
    sample = random.sample(sel, min(3000, len(sel)))
    sample.sort(key=lambda s: by_zid_loc[s[1]])
    z = zimraw.Zim(ZIM)
    docs = []
    cur = None
    for rank, zid, path, why in sample:
        cl, bl = by_zid_loc[zid]
        if cl != cur:
            blobs = zimraw.decode_cluster(z.read_cluster_raw(cl))
            cur = cl
        r = clean.clean(blobs[bl], lambda p: p, lambda p, w, h: ('/media/ab/0123456789abcdef.webp', w, h))
        docs.append(r['html'].encode())
    return zstandard.train_dictionary(112640, docs, level=LEVEL)


def main():
    t0 = time.time()
    sel = load_selection()
    dd = sqlite3.connect(os.path.join(WORK, 'dirents.db'))
    loc = {}
    for rank, zid, path, why in sel:
        loc[zid] = dd.execute('select cl, bl from art where id=?', (zid,)).fetchone()
    bdb = sqlite3.connect(os.path.join(WORK, 'build.db'))
    bdb.executescript('''
      pragma journal_mode=wal; pragma synchronous=normal;
      create table if not exists meta(k text primary key, v);
      create table if not exists job(jn integer primary key);
      create table if not exists art(id integer primary key, zid int, path text, reason text,
        html blob, html_len int, text blob, text_len int, lead text, sections text, infobox int,
        image text, edited text, oldid int, error text);
      create table if not exists link(src int, dst int);
      create table if not exists media(url text primary key, zpath text, mime text, refs int default 1);
      create table if not exists redirect(path text primary key, target int);
    ''')
    row = bdb.execute("select v from meta where k='zdict'").fetchone()
    if row:
        dict_bytes = row[0]
    else:
        print('training zstd dictionary', flush=True)
        dict_bytes = train_dict(sel, loc).as_bytes()
        bdb.execute("insert into meta values('zdict', ?)", (dict_bytes,))
        bdb.commit()
        print('dict trained %.0fs' % (time.time() - t0), flush=True)
    G['dict'] = zstandard.ZstdCompressionDict(dict_bytes)
    m, redirects = build_maps(sel)
    G['map'] = m
    if not bdb.execute('select count(*) from redirect').fetchone()[0]:
        bdb.executemany('insert or ignore into redirect values(?,?)', redirects)
        bdb.commit()
    print('maps: %d paths, %d redirects, %.0fs' % (len(m), len(redirects), time.time() - t0), flush=True)

    items = sorted(((loc[zid][0], loc[zid][1], rank + 1, rank, why, zid, path) for rank, zid, path, why in sel))
    jobs = []
    for s in range(0, len(items), 400):
        jobs.append((len(jobs), [it[:5] for it in items[s:s + 400]]))
    meta = {it[2]: (it[5], it[6], it[4]) for it in items}
    done = {r[0] for r in bdb.execute('select jn from job')}
    todo = [j for j in jobs if j[0] not in done]
    print('jobs', len(jobs), 'todo', len(todo), flush=True)
    t1 = time.time()
    n = 0
    with mp.get_context('fork').Pool(NPROC, initializer=init_worker) as pool:
        for jn, out in pool.imap_unordered(work, todo):
            with bdb:
                for nid, r in out:
                    zid, path, why = meta[nid]
                    bdb.execute('delete from art where id=?', (nid,))
                    bdb.execute('delete from link where src=?', (nid,))
                    if 'error' in r:
                        bdb.execute('insert into art(id, zid, path, reason, error) values(?,?,?,?,?)', (nid, zid, path, why, r['error']))
                        continue
                    bdb.execute('insert into art values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
                                (nid, zid, path, why, r['html'], r['html_len'], r['text'], r['text_len'], r['lead'],
                                 r['sections'], r['infobox'], r['image'], r['edited'], r['oldid']))
                    bdb.executemany('insert into link values(?,?)', [(nid, d) for d in r['links'] if d != nid])
                    for url, zpath, mime in r['media']:
                        bdb.execute('insert into media(url, zpath, mime) values(?,?,?) on conflict(url) do update set refs=refs+1',
                                    (url, zpath, mime))
                bdb.execute('insert into job values(?)', (jn,))
            n += 1
            el = time.time() - t1
            if n % 10 == 0 or n == len(todo):
                print('job %d/%d  %.0fs  eta %.0fs' % (n, len(todo), el, el / n * (len(todo) - n)), flush=True)
    print('errors', bdb.execute('select count(*) from art where error is not null').fetchone()[0])
    print('done %.0fs' % (time.time() - t0))


if __name__ == '__main__':
    main()
