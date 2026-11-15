"""Step 3: choose the article selection.

1. Task articles (task_articles.json 'core' + 'always'), and every article they
   link to (one hop: a solver may open any link on a task page).
2. Then articles by score = in-links * (1.25 if the article has an infobox),
   skipping stubs (< 6 KB raw HTML), until the estimated size reaches
   the budget (WIKI_ARTICLE_BUDGET_MB of compressed HTML + text-index cost).

The per-article cost is estimated from its raw HTML size with ratios measured
by cleaning + compressing a sample (calibrate()).

Output: work/selection.tsv  (rank, id, path, reason, est_bytes)
"""
import json
import os
import random
import re
import sqlite3
import sys
import time
from urllib.parse import unquote
import html as htmlmod

import numpy as np
import zstandard

sys.path.insert(0, os.path.dirname(__file__))
from common import WORK  # noqa: E402
from zimget import ZimGet  # noqa: E402
import clean  # noqa: E402

BUDGET_MB = float(os.environ.get('WIKI_ARTICLE_BUDGET_MB', '2350'))
MIN_SIZE = 6000
HREF = re.compile(r'<a [^>]*?href="([^"#]+)')


def outlinks(g, raw):
    out = set()
    for m in HREF.finditer(raw.decode('utf-8', 'replace')):
        h = m.group(1)
        if h.startswith(('http', '//', '../', 'mailto:')):
            continue
        r = g.resolve(unquote(htmlmod.unescape(h)))
        if r:
            out.add(r[0])
    return out


def calibrate(g, ids, size, n=400):
    """Return (bytes per raw byte) for compressed html + fts text cost."""
    random.seed(7)
    sample = random.sample(list(ids), n)
    sample.sort(key=lambda i: g.db.execute('select cl from art where id=?', (int(i),)).fetchone()[0])
    cz = zstandard.ZstdCompressor(level=12)
    raw_t = cost_t = 0
    for i in sample:
        raw = g.html_by_id(int(i))
        r = clean.clean(raw, lambda p: p, lambda p, w, h: ('/media/x.webp', w, h))
        c = len(cz.compress(r['html'].encode()))
        # FTS (detail=full, contentless) costs roughly 0.45 x plain-text bytes; lead ~0.3 KB
        cost = c + 0.45 * len(r['text'].encode()) + 400
        raw_t += len(raw)
        cost_t += cost
    return cost_t / raw_t


def main():
    t0 = time.time()
    g = ZimGet(cache=8)
    st = np.load(os.path.join(WORK, 's2', 'stats.npz'))
    inl, size, infobox = st['inlinks'], st['size'], st['infobox']
    rows = g.db.execute('select id, path from art where redir is null').fetchall()
    path_of = {i: p for i, p in rows}
    content_ids = np.array([i for i, _ in rows], np.int64)

    sel = {}  # id -> reason
    tj = json.load(open(os.path.join(os.path.dirname(__file__), 'task_articles.json')))
    core = []
    for grp in tj['groups']:
        for p in grp['core']:
            r = g.resolve(p)
            if not r:
                print('MISSING task article', p, grp['tasks'])
                continue
            core.append((r[0], 'task:%s' % ','.join(map(str, grp['tasks']))))
    for p in tj['always']:
        r = g.resolve(p)
        if r:
            core.append((r[0], 'always'))
    for i, why in core:
        sel.setdefault(i, why)
    for i, why in list(core):
        for j in outlinks(g, g.html_by_id(i)):
            sel.setdefault(j, 'hop1:' + path_of[i])
    print('task core', len(core), 'with one hop', len(sel), '%.0fs' % (time.time() - t0), flush=True)

    ratio = calibrate(g, content_ids[(size[content_ids] > MIN_SIZE) & (inl[content_ids] > 200)], size)
    print('cost ratio (est bytes per raw HTML byte) %.4f' % ratio, flush=True)

    budget = BUDGET_MB * 1e6
    used = sum(size[i] * ratio for i in sel)
    score = inl[content_ids].astype(np.float64) * np.where(infobox[content_ids], 1.25, 1.0)
    score[size[content_ids] < MIN_SIZE] = -1
    order = content_ids[np.argsort(-score, kind='stable')]
    for i in order:
        i = int(i)
        if used >= budget:
            break
        if i in sel:
            continue
        if size[i] < MIN_SIZE:
            break
        sel[i] = 'inlinks'
        used += size[i] * ratio
    print('selected', len(sel), 'est MB %.0f' % (used / 1e6), 'last in-link count', inl[i], flush=True)

    # rank: task first, then by in-links
    items = sorted(sel.items(), key=lambda kv: (0 if not kv[1].startswith(('inlinks', 'hop1')) else 1, -int(inl[kv[0]])))
    with open(os.path.join(WORK, 'selection.tsv.tmp'), 'w') as f:
        for rank, (i, why) in enumerate(items):
            f.write('%d\t%d\t%s\t%s\t%d\n' % (rank, i, path_of[i], why, int(size[i] * ratio)))
    os.rename(os.path.join(WORK, 'selection.tsv.tmp'), os.path.join(WORK, 'selection.tsv'))
    print('done %.0fs' % (time.time() - t0))


if __name__ == '__main__':
    main()
