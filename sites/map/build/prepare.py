#!/usr/bin/env python3
"""Cut each region out of its source extract and merge them into one PBF.

  python3 -I prepare.py [--only us-northeast,sf]

Outputs (WORK = $WSB_WORK/map):
  WORK/regions/<id>.osm.pbf   region cut (osmium extract, smart strategy)
  WORK/all.osm.pbf            all regions merged (input of every later step)
  WORK/all.poly               multi-section .poly of the region outlines (planetiler --polygon)
"""
import argparse, json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get('SRC', '$WSB_SRC')
WORK = os.environ.get('WORK', '$WSB_WORK/map')


def run(cmd):
    print('+', ' '.join(cmd), flush=True)
    subprocess.run(cmd, check=True)


def read_poly(path):
    """Return list of rings (list of (lon, lat)) from an osmosis .poly file."""
    rings, cur = [], None
    with open(path) as f:
        lines = [l.strip() for l in f][1:]
    for l in lines:
        if not l:
            continue
        if l == 'END':
            if cur is not None:
                rings.append(cur)
                cur = None
            continue
        parts = l.split()
        if len(parts) == 2:
            try:
                cur.append((float(parts[0]), float(parts[1])))
                continue
            except (ValueError, AttributeError):
                pass
        cur = []  # section header
    return rings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    args = ap.parse_args()
    cfg = json.load(open(os.path.join(HERE, 'regions.json')))['regions']
    if args.only:
        keep = set(args.only.split(','))
        cfg = [r for r in cfg if r['id'] in keep]
    os.makedirs(os.path.join(WORK, 'regions'), exist_ok=True)
    outs, rings = [], []
    for r in cfg:
        src = os.path.join(SRC, r['src'])
        out = os.path.join(WORK, 'regions', r['id'] + '.osm.pbf')
        t = time.time()
        if 'poly' in r:
            poly = os.path.join(HERE, r['poly'])
            rings += [(r['id'], ring) for ring in read_poly(poly)]
            if r.get('as_is'):  # the source already is exactly this extract
                outs.append(src)
                continue
            run(['osmium', 'extract', '-O', '-s', 'smart', '-p', poly, src, '-o', out])
        else:
            w, s, e, n = r['bbox']
            rings.append((r['id'], [(w, s), (e, s), (e, n), (w, n), (w, s)]))
            run(['osmium', 'extract', '-O', '-s', 'smart', '-b', f'{w},{s},{e},{n}', src, '-o', out])
        print(f'  {r["id"]}: {os.path.getsize(out)/1e6:.0f} MB in {time.time()-t:.0f}s', flush=True)
        outs.append(out)
    allpbf = os.path.join(WORK, 'all.osm.pbf')
    run(['osmium', 'merge', '-O', *outs, '-o', allpbf])
    with open(os.path.join(WORK, 'all.poly'), 'w') as f:
        f.write('websandbox-map\n')
        for i, (rid, ring) in enumerate(rings):
            f.write(f'{rid}_{i}\n')
            for lon, lat in ring:
                f.write(f'   {lon:.6f}   {lat:.6f}\n')
            f.write('END\n')
        f.write('END\n')
    print('merged', os.path.getsize(allpbf) / 1e6, 'MB')


if __name__ == '__main__':
    sys.exit(main())
