"""Step 5: write the thumbnails referenced by the selected articles to OUT/media/.

Image clusters in the ZIM are uncompressed, so each image is read directly
(offset table + blob) without reading whole clusters; requests are grouped by
cluster and processed in cluster order by a thread pool.

Images wider than 320 px are downscaled to 320 px (WebP q=72); WebP images
already <= 320 px are copied byte for byte; PNG/GIF/JPEG are converted to WebP;
SVG is copied (it scales).  Resumable: existing files are skipped.
Results (w, h, bytes or error) are recorded in work/build.db media table.
"""
import io
import os
import sqlite3
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import zimraw  # noqa: E402
from common import OUT, WORK, ZIM  # noqa: E402

THREADS = int(os.environ.get('S5_THREADS', '12'))
MAXW = 320
local = threading.local()
Image.MAX_IMAGE_PIXELS = 200_000_000


def zim():
    if not hasattr(local, 'z'):
        local.z = zimraw.Zim(ZIM)
    return local.z


def convert(data, mime):
    if 'svg' in mime:
        return data, 0, 0
    im = Image.open(io.BytesIO(data))
    w, h = im.size
    if w <= MAXW and mime == 'image/webp':
        return data, w, h
    if getattr(im, 'n_frames', 1) > 1:
        im.seek(0)
    if im.mode not in ('RGB', 'RGBA'):
        im = im.convert('RGBA' if ('transparency' in im.info or im.mode in ('LA', 'P', 'PA')) else 'RGB')
    if w > MAXW:
        nh = max(1, round(h * MAXW / w))
        im = im.resize((MAXW, nh), Image.LANCZOS)
        w, h = MAXW, nh
    b = io.BytesIO()
    im.save(b, 'WEBP', quality=72, method=4)
    return b.getvalue(), w, h


def do_cluster(job):
    cl, items = job  # items: [(bl, url, mime)]
    z = zim()
    p = z.cluster_ptrs()
    base = p[cl]
    info = z._read(base, 1)[0]
    ext = bool(info & 0x10)
    comp = info & 0x0F
    res = []
    if comp not in (0, 1):
        blobs = zimraw.decode_cluster(z.read_cluster_raw(cl))
        get = lambda bl: blobs[bl]  # noqa: E731
    else:
        osz = 8 if ext else 4
        fmt = '<Q' if ext else '<I'
        maxbl = max(i[0] for i in items)
        offs = struct.unpack('<%d%s' % (maxbl + 2, fmt[1]), z._read(base + 1, osz * (maxbl + 2)))
        get = lambda bl: z._read(base + 1 + offs[bl], offs[bl + 1] - offs[bl])  # noqa: E731
    for bl, url, mime in items:
        fn = os.path.join(OUT, url.lstrip('/'))
        if os.path.exists(fn):
            res.append((url, None, None, os.path.getsize(fn), None))
            continue
        try:
            data, w, h = convert(get(bl), mime)
            os.makedirs(os.path.dirname(fn), exist_ok=True)
            with open(fn + '.tmp', 'wb') as f:
                f.write(data)
            os.rename(fn + '.tmp', fn)
            res.append((url, w, h, len(data), None))
        except Exception as e:
            res.append((url, None, None, None, repr(e)[:200]))
    return res


def main():
    t0 = time.time()
    bdb = sqlite3.connect(os.path.join(WORK, 'build.db'))
    cols = {r[1] for r in bdb.execute('pragma table_info(media)')}
    for c in ('w', 'h', 'bytes', 'error'):
        if c not in cols:
            bdb.execute('alter table media add column %s' % c)
    dd = sqlite3.connect(os.path.join(WORK, 'dirents.db'))
    rows = bdb.execute('select url, zpath, mime from media where bytes is null').fetchall()
    bycl = {}
    for url, zpath, mime in rows:
        r = dd.execute('select cl, bl from img where path=?', (zpath,)).fetchone()
        if r:
            bycl.setdefault(r[0], []).append((r[1], url, mime))
    jobs = sorted((cl, sorted(v)) for cl, v in bycl.items())
    print('images todo', len(rows), 'clusters', len(jobs), flush=True)
    n = 0
    with ThreadPoolExecutor(THREADS) as ex:
        for res in ex.map(do_cluster, jobs):
            with bdb:
                bdb.executemany('update media set w=coalesce(?,w), h=coalesce(?,h), bytes=?, error=? where url=?',
                                [(w, h, b, e, u) for u, w, h, b, e in res])
            n += len(res)
            if n % 5000 < len(res):
                el = time.time() - t0
                print('%d/%d images %.0fs eta %.0fs' % (n, len(rows), el, el / n * (len(rows) - n)), flush=True)
    print('errors', bdb.execute('select count(*) from media where error is not null').fetchone()[0])
    print('bytes', bdb.execute('select sum(bytes) from media').fetchone()[0])
    print('done %.0fs' % (time.time() - t0))


if __name__ == '__main__':
    main()
