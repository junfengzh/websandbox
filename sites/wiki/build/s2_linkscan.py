"""Step 2: stream every HTML cluster of the ZIM once and compute, per article:
in-link count (distinct source articles, redirects resolved), HTML size,
infobox flag, image count, out-link count.

Clusters are read sequentially (libzim's random access over NFS is ~1 s per
article; sequential cluster streaming is limited only by NFS bandwidth).
Work is split into chunks of clusters; each chunk's result is saved to
work/s2/chunk_NNNNN.npz so the scan is resumable. Final: work/s2/stats.npz.
"""
import html
import multiprocessing as mp
import os
import re
import sqlite3
import sys
import time
from urllib.parse import unquote

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import zimraw  # noqa: E402
from common import ZIM, WORK  # noqa: E402

CHUNK = 1000  # clusters per work unit
NPROC = int(os.environ.get('S2_PROCS', '6'))
S2 = os.path.join(WORK, 's2')

HREF = re.compile(rb'<a [^>]*?href="([^"#]+)')
G = {}


def load():
    db = sqlite3.connect(os.path.join(WORK, 'dirents.db'))
    mimes = db.execute("select v from meta where k='mimes'").fetchone()[0].split('\n')
    html_mime = mimes.index('text/html')
    rows = db.execute('select id, path, mime, cl, bl, redir from art').fetchall()
    n = max(r[0] for r in rows) + 1
    path2id = {}
    redir = {}
    content = {}
    for (i, p, m, cl, bl, rd) in rows:
        path2id[p] = i
        if rd is not None:
            redir[i] = rd
        elif m == html_mime:
            content[i] = (cl, bl)
    # resolve redirect chains to a content article id (or -1)
    final = {}
    for i in redir:
        j, hops = i, 0
        while j in redir and hops < 8:
            j = redir[j]
            hops += 1
        final[i] = j if j in content else -1
    canon = {}
    for p, i in path2id.items():
        if i in content:
            canon[p] = i
        elif i in final and final[i] >= 0:
            canon[p] = final[i]
    bycl = {}
    for i, (cl, bl) in content.items():
        bycl.setdefault(cl, []).append((bl, i))
    return n, canon, bycl


def resolve(href):
    h = href.decode('utf-8', 'replace')
    if h.startswith('http') or h.startswith('//') or h.startswith('../') or h.startswith('mailto:'):
        return None
    if h.startswith('./'):
        h = h[2:]
    h = unquote(html.unescape(h))
    return G['canon'].get(h)


def work(job):
    ci, cls = job
    out = os.path.join(S2, 'chunk_%05d.npz' % ci)
    if os.path.exists(out):
        return ci, 0
    z = zimraw.Zim(ZIM)
    bycl = G['bycl']
    inl = {}
    ids, size, infobox, nimg, nout = [], [], [], [], []
    nbytes = 0
    for cl in cls:
        raw = z.read_cluster_raw(cl)
        nbytes += len(raw)
        blobs = zimraw.decode_cluster(raw)
        for bl, aid in bycl[cl]:
            doc = blobs[bl]
            targets = set()
            for m in HREF.finditer(doc):
                t = resolve(m.group(1))
                if t is not None and t != aid:
                    targets.add(t)
            for t in targets:
                inl[t] = inl.get(t, 0) + 1
            ids.append(aid)
            size.append(len(doc))
            infobox.append(b'class="infobox' in doc)
            nimg.append(doc.count(b'<img '))
            nout.append(len(targets))
    k = np.fromiter(inl.keys(), dtype=np.int32, count=len(inl))
    v = np.fromiter(inl.values(), dtype=np.int32, count=len(inl))
    tmp = out + '.tmp.npz'
    np.savez(tmp, ids=np.array(ids, np.int32), size=np.array(size, np.int32),
             infobox=np.array(infobox, np.bool_), nimg=np.array(nimg, np.int32),
             nout=np.array(nout, np.int32), ink=k, inv=v)
    os.rename(tmp, out)
    return ci, nbytes


def main():
    os.makedirs(S2, exist_ok=True)
    if os.path.exists(os.path.join(S2, 'stats.npz')):
        print('stats.npz exists (delete it to rescan)')
        return
    t0 = time.time()
    n, canon, bycl = load()
    G.update(canon=canon, bycl=bycl)
    print('loaded', n, 'entries,', len(bycl), 'html clusters, %.0fs' % (time.time() - t0), flush=True)
    cls = sorted(bycl)
    jobs = [(ci, cls[s:s + CHUNK]) for ci, s in enumerate(range(0, len(cls), CHUNK))]
    t1 = time.time()
    tot = 0
    done = 0
    with mp.get_context('fork').Pool(NPROC) as pool:
        for ci, nb in pool.imap_unordered(work, jobs):
            done += 1
            tot += nb
            el = time.time() - t1
            print('chunk %d done (%d/%d) %.1f MB/s, %.0fs elapsed, eta %.0fs' % (
                ci, done, len(jobs), tot / 1e6 / max(el, 1e-9), el, el / done * (len(jobs) - done)), flush=True)
    # merge
    inlinks = np.zeros(n, np.int32)
    size = np.zeros(n, np.int32)
    infobox = np.zeros(n, np.bool_)
    nimg = np.zeros(n, np.int32)
    nout = np.zeros(n, np.int32)
    for ci, _ in jobs:
        d = np.load(os.path.join(S2, 'chunk_%05d.npz' % ci))
        np.add.at(inlinks, d['ink'], d['inv'])
        size[d['ids']] = d['size']
        infobox[d['ids']] = d['infobox']
        nimg[d['ids']] = d['nimg']
        nout[d['ids']] = d['nout']
    np.savez(os.path.join(S2, 'stats.npz'), inlinks=inlinks, size=size, infobox=infobox, nimg=nimg, nout=nout)
    print('done %.0fs' % (time.time() - t0))


if __name__ == '__main__':
    main()
