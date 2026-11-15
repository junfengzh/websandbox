#!/usr/bin/env python3
"""Downscale Postmill's submission images to WebP.

Usage: python3 -I images.py --src MOUNT/var/www/html/public/submission_images \
           --out DATA/media --manifest WORK/images_manifest.jsonl [--jobs 7]

For every source file `<sha256>.<ext>` writes
  DATA/media/submission_images/<sha256>.webp        long side <= 800 px (never upscaled)
  DATA/media/submission_images/thumb/<sha256>.webp  long side <= 160 px (list thumbnails)
Animated GIFs keep only their first frame. The manifest has one JSON line per source
file: file_name, src_bytes, width/height (of the 800 px image), bytes, thumb_bytes, or
an `error`. Existing outputs are reused (incremental), so the step can be re-run.
"""
import argparse
import json
import os
import sys
from multiprocessing import Pool

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 400_000_000
LONG = 800
THUMB = 160
QUALITY = 80

ARGS = None


def convert(name):
    src = os.path.join(ARGS.src, name)
    stem = os.path.splitext(name)[0]
    out = os.path.join(ARGS.out, 'submission_images', stem + '.webp')
    th = os.path.join(ARGS.out, 'submission_images', 'thumb', stem + '.webp')
    rec = {'file_name': name, 'src_bytes': os.path.getsize(src)}
    try:
        if not (os.path.exists(out) and os.path.exists(th)):
            with Image.open(src) as im:
                if im.format == 'JPEG':
                    im.draft('RGB', (LONG, LONG))  # fast DCT-domain downscale (>= LONG)
                im.seek(0)
                im = ImageOps.exif_transpose(im)
                if im.mode not in ('RGB', 'RGBA'):
                    im = im.convert('RGBA' if ('transparency' in im.info or im.mode in ('LA', 'PA', 'P')) else 'RGB')
                big = im.copy()
                big.thumbnail((LONG, LONG), Image.LANCZOS)
                big.save(out + '.tmp', 'WEBP', quality=QUALITY, method=4)
                small = big.copy()
                small.thumbnail((THUMB, THUMB), Image.LANCZOS)
                small.save(th + '.tmp', 'WEBP', quality=75, method=4)
            os.replace(out + '.tmp', out)
            os.replace(th + '.tmp', th)
        with Image.open(out) as im:
            rec['width'], rec['height'] = im.size
        rec['bytes'] = os.path.getsize(out)
        rec['thumb_bytes'] = os.path.getsize(th)
    except Exception as e:  # unreadable/corrupt source: recorded, no output
        rec['error'] = f'{type(e).__name__}: {e}'[:300]
        for p in (out + '.tmp', th + '.tmp'):
            if os.path.exists(p):
                os.remove(p)
    return rec


def init(args):
    global ARGS
    ARGS = args


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--jobs', type=int, default=7)
    args = ap.parse_args()
    os.makedirs(os.path.join(args.out, 'submission_images', 'thumb'), exist_ok=True)
    names = sorted(os.listdir(args.src))
    n = err = 0
    with Pool(args.jobs, initializer=init, initargs=(args,)) as pool, open(args.manifest + '.tmp', 'w') as mf:
        for rec in pool.imap(convert, names, chunksize=16):
            mf.write(json.dumps(rec) + '\n')
            n += 1
            err += 'error' in rec
            if n % 1000 == 0:
                print(f'{n}/{len(names)} errors={err}', file=sys.stderr, flush=True)
    os.replace(args.manifest + '.tmp', args.manifest)
    print(f'done {n} errors={err}', file=sys.stderr)


if __name__ == '__main__':
    main()
