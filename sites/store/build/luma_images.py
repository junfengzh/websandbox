#!/usr/bin/env python3
"""Add the Luma product images from Magento 2's official sample data.

Usage: python -I luma_images.py --db base.db --media OUT/media \
          --sample $WSB_WORK/store/sample-data/repo [--jobs 6]

WebArena's shopping_admin image never installed the Luma sample media (1 of
the 53 gallery files exists) and most Luma products have no gallery rows at
all. The sample-data repo (github.com/magento/magento2-sample-data,
AFL-3.0/OSL-3.0) holds both the import fixtures (sku -> base/small/thumbnail/
additional image paths) and the originals under pub/media/catalog/product/.

For every admin (Luma) product whose SKU appears in the fixtures:
  - existing product_images rows (from Magento's media gallery) whose original
    exists in the sample media get file/width/height/bytes filled;
  - fixture images the product has no row for are inserted (orig_path set,
    positions appended after the existing ones; base/small/thumbnail roles
    from the fixture, only where no existing row holds that role).
Rows already holding a file are not touched. The sample files are only read
(CSV parse + PIL decode via images.convert); nothing in the clone is executed.
Idempotent: re-running inserts nothing new and reuses existing WebP files.
"""
import argparse
import csv
import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import images  # noqa: E402  (this directory's image step: convert(), out_name())

FIX = 'app/code/Magento'
FIXTURES_ROLES = [f'{FIX}/ConfigurableSampleData/fixtures/products.csv']   # base/small/thumbnail/additional columns
FIXTURES_LIST = [                                                         # sku,image (first row = main image)
    f'{FIX}/CatalogSampleData/fixtures/SimpleProduct/images_gear_bags.csv',
    f'{FIX}/CatalogSampleData/fixtures/SimpleProduct/images_gear_fitness_equipment.csv',
    f'{FIX}/CatalogSampleData/fixtures/SimpleProduct/images_gear_watches.csv',
    f'{FIX}/BundleSampleData/fixtures/images_yoga_bundle.csv',
    f'{FIX}/GroupedProductSampleData/fixtures/images_yoga_grouped.csv',
    f'{FIX}/DownloadableSampleData/fixtures/images_products_training_video.csv',
]


def norm(p):
    p = (p or '').strip()
    return '/' + p.lstrip('/') if p and p != 'no_selection' else None


def load_fixtures(root):
    """sku -> ordered list of [orig_path, label, is_base, is_small, is_thumbnail]."""
    csv.field_size_limit(1 << 28)
    out = {}

    def add(sku, path, label=None, base=0, small=0, thumb=0):
        path = norm(path)
        if not sku or not path:
            return
        lst = out.setdefault(sku, [])
        for e in lst:
            if e[0] == path:
                e[2], e[3], e[4] = e[2] or base, e[3] or small, e[4] or thumb
                e[1] = e[1] or label
                return
        lst.append([path, label or None, base, small, thumb])

    for rel in FIXTURES_ROLES:
        with open(os.path.join(root, rel), newline='', encoding='utf-8') as f:
            for r in csv.DictReader(f):
                sku = r['sku'].strip()
                add(sku, r.get('base_image'), r.get('base_image_label'), base=1)
                add(sku, r.get('small_image'), r.get('small_image_label'), small=1)
                add(sku, r.get('thumbnail_image'), r.get('thumbnail_image_label'), thumb=1)
                for p in (r.get('additional_images') or '').split(','):
                    add(sku, p)
    for rel in FIXTURES_LIST:
        with open(os.path.join(root, rel), newline='', encoding='utf-8') as f:
            for r in csv.DictReader(f):
                sku = r['sku'].strip()
                first = sku not in out
                add(sku, r['image'], None, *(1, 1, 1) if first else (0, 0, 0))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--media', required=True)
    ap.add_argument('--sample', required=True, help='clone of magento/magento2-sample-data')
    ap.add_argument('--jobs', type=int, default=6)
    a = ap.parse_args()
    src_root = os.path.join(a.sample, 'pub/media/catalog/product')
    fx = load_fixtures(a.sample)

    db = sqlite3.connect(a.db)
    prods = db.execute("select id, sku from products where source='admin'").fetchall()
    rows = {}
    for iid, pid, orig, f, pos, b, s, t in db.execute(
            "select i.id, i.product_id, i.orig_path, i.file, i.position, i.is_base, i.is_small, i.is_thumbnail "
            "from product_images i join products p on p.id=i.product_id where p.source='admin'"):
        rows.setdefault(pid, []).append([iid, orig, f, pos, b, s, t])

    def exists(orig):
        return orig and os.path.isfile(os.path.join(src_root, orig.lstrip('/')))

    inserts, updates = [], []   # inserts: (pid, orig, pos, label, b, s, t); updates: (iid, orig)
    for pid, sku in prods:
        have = rows.get(pid, [])
        for r in have:
            if r[2] is None and exists(r[1]):
                updates.append((r[0], r[1]))
        known = {r[1] for r in have}
        held = [any(r[k] for r in have) for k in (4, 5, 6)]
        pos = max([r[3] or 0 for r in have] or [0])
        for orig, label, b, s, t in fx.get(sku, []):
            if orig in known or not exists(orig):
                continue
            pos += 1
            inserts.append((pid, orig, pos, label, 0 if held[0] else b, 0 if held[1] else s, 0 if held[2] else t))
            known.add(orig)

    origs = sorted({o for _, o in updates} | {i[1] for i in inserts})
    rel = {o: 'product/admin/' + images.out_name(o) for o in origs}
    jobs = [(os.path.join(src_root, o.lstrip('/')), os.path.join(a.media, rel[o])) for o in origs]
    res = {}
    with ProcessPoolExecutor(a.jobs) as ex:
        for o, (dst, w, h, nb, err) in zip(origs, ex.map(images.convert, jobs, chunksize=16)):
            if err:
                print('  %s: %s' % (o, err), file=sys.stderr)
            else:
                res[o] = (rel[o], w, h, nb)

    with db:
        for iid, o in updates:
            if o in res:
                db.execute('update product_images set file=?, width=?, height=?, bytes=? where id=?', (*res[o], iid))
        for pid, o, pos, label, b, s, t in inserts:
            if o in res:
                db.execute('insert into product_images (product_id, file, orig_path, position, label, disabled, '
                           'is_base, is_small, is_thumbnail, is_swatch, width, height, bytes) '
                           'values (?,?,?,?,?,0,?,?,?,0,?,?,?)', (pid, res[o][0], o, pos, label, b, s, t, *res[o][1:]))
        try:
            rev = subprocess.run(['git', '-C', a.sample, 'rev-parse', 'HEAD'], capture_output=True, text=True,
                                 check=True).stdout.strip()
        except Exception:
            rev = 'unknown'
        db.execute("insert or replace into build_info values ('images.luma_sample_data', ?)",
                   ('github.com/magento/magento2-sample-data@' + rev,))

    tot, withimg = db.execute(
        "select count(*), sum(exists(select 1 from product_images i where i.product_id=p.id and i.file is not null)) "
        "from products p where p.source='admin'").fetchone()
    print('luma: %d rows updated, %d inserted, %d files converted (%d errors); %d of %d Luma products have an image'
          % (sum(o in res for _, o in updates), sum(i[1] in res for i in inserts), len(res), len(origs) - len(res),
             withimg, tot), file=sys.stderr)


if __name__ == '__main__':
    main()
