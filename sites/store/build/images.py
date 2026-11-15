#!/usr/bin/env python3
"""Downscale product images into media/ as WebP and record them in base.db.

Usage: python -I images.py --db base.db --media OUT/media \
          --src admin=<mnt>/.../admin/pub/media --src shop=<mnt>/.../shop/pub/media [--jobs 6]

For every product_images row (orig_path relative to <pub/media>/catalog/product)
of the given source, writes media/product/<orig path without ext>.webp
(long side <= --max px, quality --q) and fills file/width/height/bytes. Missing
or unreadable originals leave file NULL. Also converts category images and the
CMS wysiwyg images (home page banners) and the store logo to media/{category,wysiwyg,logo}/<source>/.
Idempotent: existing outputs are reused.
"""
import argparse
import os
import sqlite3
import sys
from concurrent.futures import ProcessPoolExecutor

from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True
Image.MAX_IMAGE_PIXELS = 80_000_000
MAX = 600
Q = 80
METHOD = 2   # libwebp effort 0-6; 2 is ~2x faster than 4 at ~same size/quality


def convert(job):
    src, dst = job
    try:
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            with Image.open(dst) as im:
                return dst, im.width, im.height, os.path.getsize(dst), None
        with Image.open(src) as im:
            im.draft('RGB', (MAX, MAX))
            if im.mode in ('P', 'LA', 'PA'):
                im = im.convert('RGBA')
            elif im.mode not in ('RGB', 'RGBA'):
                im = im.convert('RGB')
            im.thumbnail((MAX, MAX), Image.LANCZOS)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = dst + '.tmp'
            im.save(tmp, 'WEBP', quality=Q, method=METHOD)
            os.replace(tmp, dst)
            return dst, im.width, im.height, os.path.getsize(dst), None
    except Exception as e:  # missing / corrupt original
        return dst, None, None, None, '%s: %s' % (type(e).__name__, e)


def out_name(orig):
    base = os.path.splitext(orig.lstrip('/'))[0]
    return base + '.webp'


def main():
    global MAX, Q, METHOD
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--media', required=True)
    ap.add_argument('--src', action='append', required=True, help='name=/path/to/pub/media')
    ap.add_argument('--jobs', type=int, default=6)
    ap.add_argument('--max', type=int, default=MAX)
    ap.add_argument('--q', type=int, default=Q)
    ap.add_argument('--method', type=int, default=METHOD)
    a = ap.parse_args()
    MAX, Q, METHOD = a.max, a.q, a.method
    db = sqlite3.connect(a.db)
    srcs = dict(s.split('=', 1) for s in a.src)
    for name, root in srcs.items():
        rows = db.execute("select i.id, i.orig_path from product_images i join products p on p.id=i.product_id "
                          "where p.source=? and i.orig_path is not null", (name,)).fetchall()
        jobs, ids = {}, {}
        for iid, orig in rows:
            rel = 'product/%s/%s' % (name, out_name(orig))
            ids.setdefault(rel, []).append(iid)
            jobs[rel] = (os.path.join(root, 'catalog/product', orig.lstrip('/')), os.path.join(a.media, rel))
        # category images and CMS media
        extra = []
        for sub in ('catalog/category', 'wysiwyg', 'logo'):
            d = os.path.join(root, sub)
            for dp, _, fs in os.walk(d):
                for f in fs:
                    if f.lower().endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp')):
                        p = os.path.join(dp, f)
                        rel = os.path.join(sub.replace('catalog/', ''), name, out_name(os.path.relpath(p, d)))
                        extra.append((p, os.path.join(a.media, rel)))
        print('%s: %d product images, %d other' % (name, len(jobs), len(extra)), file=sys.stderr, flush=True)
        done = errs = 0
        upd = []
        rels = list(jobs)
        with ProcessPoolExecutor(a.jobs) as ex:
            for rel, res in zip(rels, ex.map(convert, [jobs[r] for r in rels], chunksize=64)):
                dst, w, h, b, err = res
                done += 1
                if err:
                    errs += 1
                    for iid in ids[rel]:
                        upd.append((None, None, None, None, iid))
                else:
                    for iid in ids[rel]:
                        upd.append((rel, w, h, b, iid))
                if done % 5000 == 0:
                    print('  %d/%d (%d errors)' % (done, len(rels), errs), file=sys.stderr, flush=True)
                    db.executemany('update product_images set file=?, width=?, height=?, bytes=? where id=?', upd)
                    db.commit()
                    upd = []
            db.executemany('update product_images set file=?, width=?, height=?, bytes=? where id=?', upd)
            db.commit()
            list(ex.map(convert, extra, chunksize=16))
        print('%s: %d done, %d missing/unreadable' % (name, done, errs), file=sys.stderr, flush=True)
    db.execute("insert or replace into build_info values ('images.max_px', ?)", (str(MAX),))
    db.execute("insert or replace into build_info values ('images.webp_quality', ?)", (str(Q),))
    db.commit()


if __name__ == '__main__':
    main()
