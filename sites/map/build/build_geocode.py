#!/usr/bin/env python3
"""Pass 2 of the geocoder build: address hierarchy, streets, postcodes, ranking and
the SQLite database (FTS5 + R*Tree). Mimics Nominatim's display names.

  python3 -I build_geocode.py WORK/geocode/extract.pkl OUT/geocode.db

See ../SCHEMA.md for the tables.
"""
import json, math, os, pickle, re, sqlite3, sys, time
from collections import defaultdict
import numpy as np
import shapely

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from textnorm import norm  # noqa: E402

ADMIN_RANK = {2: 4, 3: 6, 4: 8, 5: 10, 6: 12, 7: 14, 8: 16, 9: 18, 10: 20, 11: 22, 12: 24}
PLACE_RANK = {'country': 4, 'state': 8, 'province': 8, 'region': 18, 'county': 12, 'district': 12,
              'municipality': 18, 'city': 16, 'town': 18, 'village': 19, 'borough': 20, 'city_district': 20,
              'hamlet': 20, 'suburb': 20, 'quarter': 22, 'neighbourhood': 24, 'city_block': 25,
              'isolated_dwelling': 25, 'farm': 25, 'locality': 25, 'island': 17, 'islet': 20, 'square': 25,
              'archipelago': 17}
# radius (deg) within which a place *node* without polygon is used as an address part
PLACE_NODE_RADIUS = {16: 0.08, 17: 0.04, 18: 0.04, 19: 0.02, 20: 0.012, 22: 0.008, 24: 0.006}
ADDRESSABLE_PLACES = {'city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood', 'borough',
                      'city_district', 'municipality', 'county', 'state', 'island', 'isolated_dwelling',
                      'farm', 'locality'}
ROAD_FOR_POI = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
                'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
                'living_street', 'service', 'pedestrian', 'road', 'track', 'busway'}
STREET_RANK = 26


def addr_key(rank, place=None, admin_level=None):
    if rank <= 4:
        return 'country'
    if rank <= 8:
        return 'state'
    if rank <= 10:
        return 'state_district'
    if rank <= 12:
        return 'county'
    if rank <= 14:
        return 'municipality'
    if rank <= 17:
        return place if place in ('town', 'village', 'city', 'island') else 'city'
    if rank <= 19:
        return place if place in ('town', 'village', 'municipality') else 'city_district'
    if rank <= 20:
        return place if place in ('hamlet', 'borough', 'suburb') else 'suburb'
    if rank <= 22:
        return 'quarter'
    return 'neighbourhood'


def display_name_en(names, fallback):
    return names.get('name:en') or fallback


def load_regions():
    cfg = json.load(open(os.path.join(HERE, 'regions.json')))['regions']
    sys.path.insert(0, HERE)
    from prepare import read_poly
    polys = []
    for r in cfg:
        if 'poly' in r:
            rings = read_poly(os.path.join(HERE, r['poly']))
            g = shapely.union_all([shapely.Polygon(x) for x in rings])
        else:
            w, s, e, n = r['bbox']
            g = shapely.box(w, s, e, n)
        polys.append(g)
    return cfg, polys


def split_big(geoms, ids, maxv=400, cell=0.1):
    """Clip polygons with many vertices into grid pieces so point-in-polygon stays fast."""
    out_g, out_i = [], []
    for g, i in zip(geoms, ids):
        if shapely.get_num_coordinates(g) <= maxv:
            out_g.append(g)
            out_i.append(i)
            continue
        x0, y0, x1, y1 = g.bounds
        cs = cell
        while (x1 - x0) / cs * (y1 - y0) / cs > 4000:
            cs *= 2
        xs = np.arange(math.floor(x0 / cs) * cs, x1 + cs, cs)
        ys = np.arange(math.floor(y0 / cs) * cs, y1 + cs, cs)
        boxes = [shapely.box(a, b, a + cs, b + cs) for a in xs[:-1] for b in ys[:-1]]
        boxes = np.array(boxes, dtype=object)
        hit = shapely.intersects(g, boxes)
        pieces = shapely.intersection(g, boxes[hit])
        for p in pieces:
            if not p.is_empty and p.area > 0:
                out_g.append(p)
                out_i.append(i)
    return np.array(out_g, dtype=object), np.array(out_i)


class Hierarchy:
    """Address parts (rank -> name) for arbitrary points, from boundary polygons and place nodes."""

    def __init__(self, bounds, place_nodes, regions, region_polys):
        self.bounds = bounds
        self.place_nodes = place_nodes
        self.regions = regions
        geoms = shapely.from_wkb([b['wkb'] for b in bounds]) if bounds else np.array([], dtype=object)
        self.pieces, self.piece_owner = split_big(list(geoms), list(range(len(bounds))))
        self.tree = shapely.STRtree(self.pieces)
        self.node_trees = {}
        by_rank = defaultdict(list)
        for i, p in enumerate(place_nodes):
            if p.get('linked') or p['place'] not in ADDRESSABLE_PLACES:
                continue
            by_rank[p['rank']].append(i)
        for rank, idx in by_rank.items():
            if rank not in PLACE_NODE_RADIUS:
                continue
            pts = shapely.points([(place_nodes[i]['lon'], place_nodes[i]['lat']) for i in idx])
            self.node_trees[rank] = (shapely.STRtree(pts), np.array(idx))
        self.region_tree = shapely.STRtree(region_polys)
        rng = np.random.default_rng(42)
        self.hb = rng.integers(1, 2 ** 62, size=len(bounds) + 1, dtype=np.int64)
        self.hn = rng.integers(1, 2 ** 62, size=len(place_nodes) + 1, dtype=np.int64)
        self.combos = {}      # signature -> combo id
        self.combo_rows = []  # id -> (parts, country, cc, region, postcode)

    def assign(self, lons, lats, exclude_ranks_ge=None):
        """Return combo ids for points (numpy arrays)."""
        n = len(lons)
        if n == 0:
            return np.zeros(0, dtype=np.int64)
        pts = shapely.points(np.column_stack([lons, lats]))
        res = np.zeros(n, dtype=np.int64)
        CH = 2_000_000
        for s in range(0, n, CH):
            res[s:s + CH] = self._assign_chunk(pts[s:s + CH], exclude_ranks_ge)
        return res

    def _assign_chunk(self, pts, maxrank):
        n = len(pts)
        sig = np.zeros(n, dtype=np.int64)
        members_b = defaultdict(list)
        if len(self.pieces):
            pi, ti = self.tree.query(pts, predicate='within')
            owner = self.piece_owner[ti]
            # dedupe (point, owner) pairs coming from several pieces
            key = np.unique(pi.astype(np.int64) * (len(self.bounds) + 1) + owner)
            pi, owner = key // (len(self.bounds) + 1), key % (len(self.bounds) + 1)
            np.add.at(sig, pi, self.hb[owner])
        else:
            pi = owner = np.zeros(0, dtype=np.int64)
        node_hits = []
        for rank, (tree, idx) in self.node_trees.items():
            qi, ti = tree.query_nearest(pts, max_distance=PLACE_NODE_RADIUS[rank], all_matches=False)
            nodes = idx[ti]
            np.add.at(sig, qi, self.hn[nodes] * 3 + rank)
            node_hits.append((qi, nodes))
        ri, rt = self.region_tree.query(pts, predicate='within')
        region = np.full(n, -1, dtype=np.int64)
        region[ri] = rt
        sig = sig * 7 + region
        uniq, first, inv = np.unique(sig, return_index=True, return_inverse=True)
        # group memberships per representative point
        rep_set = set(first.tolist())
        rep_b = defaultdict(list)
        for p, o in zip(pi.tolist(), owner.tolist()):
            if p in rep_set:
                rep_b[p].append(o)
        rep_n = defaultdict(list)
        for qi, nodes in node_hits:
            for p, o in zip(qi.tolist(), nodes.tolist()):
                if p in rep_set:
                    rep_n[p].append(o)
        ids = np.zeros(len(uniq), dtype=np.int64)
        for k, (s, p) in enumerate(zip(uniq.tolist(), first.tolist())):
            cid = self.combos.get(s)
            if cid is None:
                cid = self.combos[s] = len(self.combo_rows)
                self.combo_rows.append(self._make_combo(rep_b[p], rep_n[p], int(region[p])))
            ids[k] = cid
        return ids[inv]

    def _make_combo(self, bidx, nidx, region):
        parts = []  # (rank, key, name)
        postcode = None
        for b in bidx:
            B = self.bounds[b]
            if B['boundary'] == 'postal_code':
                postcode = B['name']
                continue
            parts.append((B['rank'], B['key'], B['dname']))
        poly_ranks = {p[0] for p in parts}
        names = {norm(p[2]) for p in parts}
        for i in nidx:
            P = self.place_nodes[i]
            nn = norm(P['dname'])
            if nn in names:
                continue
            # a polygon of the same address rank wins over a node
            if P['rank'] in poly_ranks:
                continue
            parts.append((P['rank'], P['key'], P['dname']))
            names.add(nn)
        parts.sort(key=lambda x: -x[0])
        # drop duplicate names keeping the most specific
        seen, out = set(), []
        for r, k, nm in parts:
            nn = norm(nm)
            if nn in seen:
                continue
            seen.add(nn)
            out.append((r, k, nm))
        reg = self.regions[region] if region >= 0 else None
        country = None
        for r, k, nm in out:
            if k == 'country':
                country = nm
        out = [x for x in out if x[1] != 'country']
        if country is None and reg:
            country = reg['country']
        if reg:
            have = {k for r, k, nm in out}
            for k, nm in reg.get('default_parts', []):
                if k not in have:
                    out.append(({'county': 12, 'state': 8}.get(k, 10), k, nm))
            out.sort(key=lambda x: -x[0])
            seen2, o2 = set(), []
            for x in out:
                if norm(x[2]) in seen2:
                    continue
                seen2.add(norm(x[2]))
                o2.append(x)
            out = o2
        return dict(parts=out, country=country, cc=reg['country_code'] if reg else None,
                    region=reg['id'] if reg else None, postcode=postcode)


def importance(rank, extra, area=0.0, pop=None):
    imp = 0.40001 - rank / 75.0
    if extra.get('wikipedia') or extra.get('wikidata'):
        imp += 0.25
    if pop:
        try:
            imp += min(0.3, math.log10(max(1.0, float(str(pop).replace(',', '').split(';')[0]))) / 25)
        except ValueError:
            pass
    if area > 1e-4:
        imp += 0.1
    elif area > 1e-5:
        imp += 0.05
    return round(imp, 5)


def label(cls, typ):
    return typ.replace('_', ' ').capitalize() if typ not in ('yes',) else cls.replace('_', ' ').capitalize()


def compose(name, hn, street, combo, postcode, skip_name_dupes=True, own_rank=30):
    parts = []
    if name:
        parts.append(name)
    if hn:
        parts.append(hn)
    if street and norm(street) != norm(name or ''):
        parts.append(street)
    nn = norm(name or '')
    for r, k, nm in combo['parts']:
        if skip_name_dupes and norm(nm) == nn:
            continue
        if own_rank < 26 and r >= own_rank:
            continue
        parts.append(nm)
    pc = postcode or combo.get('postcode')
    if pc:
        parts.append(pc)
    if combo.get('country') and norm(combo['country']) != nn:
        parts.append(combo['country'])
    return ', '.join(parts)


def interpolate(interp, addrs_by_node_hn):
    """Expand addr:interpolation lines into address points (Nominatim does this at query time)."""
    out = []
    for it in interp:
        coords, hns = it['coords'], it['hns']
        step = 2 if it['kind'] in ('odd', 'even') else 1 if it['kind'] in ('all', '1') else None
        if step is None or not it.get('street'):
            continue
        idx = [i for i, h in enumerate(hns) if h and re.fullmatch(r'\d+', h)]
        for a, b in zip(idx, idx[1:]):
            h1, h2 = int(hns[a]), int(hns[b])
            if h1 == h2 or abs(h2 - h1) > 2000:
                continue
            seg = coords[a:b + 1]
            line = shapely.LineString(seg) if len(seg) > 1 else None
            if line is None or line.length == 0:
                continue
            lo, hi = sorted((h1, h2))
            n = (hi - lo) // step
            for k in range(1, n):
                h = h1 + (k * step if h2 > h1 else -k * step)
                f = k / n
                p = line.interpolate(f, normalized=True)
                out.append(dict(osm='W%d' % it['id'], lon=p.x, lat=p.y,
                                addr={'addr:housenumber': str(h), 'addr:street': it['street'],
                                      **({'addr:postcode': it['postcode']} if it.get('postcode') else {})},
                                poi=None, interpolated=1))
    return out


def main():
    srcs, dbpath = sys.argv[1:-1], sys.argv[-1]
    t0 = time.time()
    D = None
    for src in srcs:  # several extract pickles (e.g. a side region) are concatenated
        d = pickle.load(open(src, 'rb'))
        if D is None:
            D = d
        else:
            for k in D:
                D[k] += d[k]
    pois, addrs, roads, bounds, places = D['pois'], D['addrs'], D['roads'], D['bounds'], D['places']
    print(f'loaded {len(pois)} pois {len(addrs)} addrs {len(roads)} roads {len(bounds)} bounds '
          f'{len(places)} place nodes in {time.time()-t0:.0f}s', flush=True)
    regions, region_polys = load_regions()

    # --- boundaries: ranks, keys, de-dup by osm id
    seen = set()
    B = []
    for b in bounds:
        if b['osm'] in seen or b.get('lon') is None:
            continue
        seen.add(b['osm'])
        if b['boundary'] == 'postal_code':
            b['rank'], b['key'] = 5, 'postcode'
        elif b['boundary'] == 'administrative' and b.get('admin_level'):
            try:
                lvl = int(float(b['admin_level']))
            except ValueError:
                continue
            if lvl not in ADMIN_RANK:
                continue
            b['rank'] = ADMIN_RANK[lvl]
            b['key'] = addr_key(b['rank'], b.get('place'))
        elif b.get('place') in PLACE_RANK:
            b['rank'] = PLACE_RANK[b['place']]
            b['key'] = addr_key(b['rank'], b['place'])
        else:
            continue
        b['dname'] = display_name_en(b['names'], b['name']) if b['rank'] <= 8 else b['name']
        B.append(b)
    bounds = B
    # --- place nodes: rank, link to boundaries with the same name / wikidata
    seen = set()
    P = []
    for p in places:
        if p['osm'] in seen:
            continue
        seen.add(p['osm'])
        p['rank'] = PLACE_RANK.get(p['place'], 25)
        p['key'] = addr_key(p['rank'], p['place'])
        p['dname'] = display_name_en(p['names'], p['name']) if p['rank'] <= 8 else p['name']
        P.append(p)
    places = P
    if bounds and places:
        bg = shapely.from_wkb([b['wkb'] for b in bounds])
        tree = shapely.STRtree(bg)
        pts = shapely.points([(p['lon'], p['lat']) for p in places])
        pi, bi = tree.query(pts, predicate='within')
        cand = defaultdict(list)
        for a, b in zip(pi.tolist(), bi.tolist()):
            cand[a].append(b)
        nlinked = 0
        for a, bl in cand.items():
            p = places[a]
            pn = norm(p['name'])
            best = None
            for b in bl:
                bb = bounds[b]
                if bb['boundary'] == 'postal_code' or bb.get('linked_node') is not None:
                    continue
                same = (p.get('wikidata') and p['wikidata'] == bb.get('wikidata')) or norm(bb['name']) == pn or \
                    norm(bb['name']) in ('city of ' + pn, 'town of ' + pn, 'village of ' + pn, 'borough of ' + pn)
                if same and abs(bb['rank'] - p['rank']) <= 6:
                    if best is None or abs(bb['rank'] - p['rank']) < abs(bounds[best]['rank'] - p['rank']):
                        best = b
            if best is not None:
                bb = bounds[best]
                bb['linked_node'] = a
                bb['lon'], bb['lat'] = p['lon'], p['lat']
                for k, v in p['extra'].items():
                    bb['extra'].setdefault(k, v)
                if not bb.get('place'):
                    bb['place'] = p['place']
                    if bb['key'] == 'city':
                        bb['key'] = addr_key(bb['rank'], p['place'])
                p['linked'] = True
                nlinked += 1
        print(f'linked {nlinked} place nodes to boundaries', flush=True)

    H = Hierarchy(bounds, places, regions, region_polys)
    print(f'hierarchy: {len(H.pieces)} polygon pieces, {time.time()-t0:.0f}s', flush=True)

    # --- streets: group named road ways by (name, cls, locality); one searchable row per group
    road_lon = np.array([r['coords'][len(r['coords']) // 2][0] for r in roads])
    road_lat = np.array([r['coords'][len(r['coords']) // 2][1] for r in roads])
    road_combo = H.assign(road_lon, road_lat)
    groups = defaultdict(list)
    for i, r in enumerate(roads):
        combo = H.combo_rows[road_combo[i]]
        loc = tuple(nm for rk, k, nm in combo['parts'] if rk <= 16) + (combo['region'] or '',)
        groups[(norm(r['name']), r['cls'], loc)].append(i)
    streets = []  # dict(name, cls, type, ways, lon, lat, bbox, combo, names, ref)
    road_street = np.zeros(len(roads), dtype=np.int64)
    for key, idx in groups.items():
        best = max(idx, key=lambda i: len(roads[i]['coords']))
        xs = [c[0] for i in idx for c in (roads[i]['coords'][0], roads[i]['coords'][-1])]
        ys = [c[1] for i in idx for c in (roads[i]['coords'][0], roads[i]['coords'][-1])]
        allx = [c[0] for i in idx for c in roads[i]['coords']]
        ally = [c[1] for i in idx for c in roads[i]['coords']]
        rb = roads[best]
        mid = rb['coords'][len(rb['coords']) // 2]
        order = {'motorway': 0, 'trunk': 1, 'primary': 2, 'secondary': 3, 'tertiary': 4}
        typ = min((roads[i]['type'] for i in idx), key=lambda t: order.get(t, 9))
        sid = len(streets)
        names = {}
        for i in idx:
            for k, v in roads[i]['names'].items():
                names.setdefault(k, v)
        pcs = [roads[i]['postcode'] for i in idx if roads[i].get('postcode')]
        streets.append(dict(name=rb['name'], cls=rb['cls'], type=typ, lon=mid[0], lat=mid[1],
                            bbox=(min(allx), min(ally), max(allx), max(ally)), combo=int(road_combo[best]),
                            names=names, ref=rb.get('ref'), osm='W%d' % rb['id'], postcode=pcs[0] if pcs else None,
                            nways=len(idx)))
        for i in idx:
            road_street[i] = sid
    print(f'{len(streets)} streets from {len(roads)} named ways, {time.time()-t0:.0f}s', flush=True)

    # line geometries of roads (highway only) for nearest-street lookups
    hw_idx = np.array([i for i, r in enumerate(roads) if r['cls'] == 'highway'], dtype=np.int64)
    road_lines = np.array([shapely.LineString(roads[i]['coords']) for i in hw_idx], dtype=object)
    poi_road_idx = np.array([j for j, i in enumerate(hw_idx) if roads[i]['type'] in ROAD_FOR_POI], dtype=np.int64)
    poi_road_tree = shapely.STRtree(road_lines[poi_road_idx]) if len(poi_road_idx) else None
    by_name = defaultdict(list)
    for j, i in enumerate(hw_idx):
        by_name[norm(roads[i]['name'])].append(j)

    def street_for(points_lon, points_lat, street_names, maxd_named=0.02, maxd_any=0.003):
        """Return (street_id or -1) for each point: nearest way with that street name, else (if no name)
        the nearest road."""
        n = len(points_lon)
        res = np.full(n, -1, dtype=np.int64)
        groups = defaultdict(list)
        for k in range(n):
            groups[norm(street_names[k]) if street_names[k] else None].append(k)
        for nm, ks in groups.items():
            ks = np.array(ks)
            pts = shapely.points(np.column_stack([points_lon[ks], points_lat[ks]]))
            if nm is None:
                if poi_road_tree is None:
                    continue
                qi, ti = poi_road_tree.query_nearest(pts, max_distance=maxd_any, all_matches=False)
                res[ks[qi]] = road_street[hw_idx[poi_road_idx[ti]]]
                continue
            cand = by_name.get(nm)
            if not cand:
                continue
            if len(cand) == 1:
                d = shapely.distance(road_lines[cand[0]], pts)
                ok = d <= maxd_named
                res[ks[ok]] = road_street[hw_idx[cand[0]]]
                continue
            tr = shapely.STRtree(road_lines[cand])
            qi, ti = tr.query_nearest(pts, max_distance=maxd_named, all_matches=False)
            res[ks[qi]] = road_street[hw_idx[np.array(cand)[ti]]]
        return res

    # --- interpolations
    extra_addrs = interpolate(D['interp'], None)
    print(f'{len(extra_addrs)} interpolated addresses', flush=True)
    addrs = addrs + extra_addrs

    # --- POIs: hierarchy + street + postcode
    seen = set()
    pois2 = []
    for p in pois:
        if p['osm'] in seen:
            continue
        seen.add(p['osm'])
        pois2.append(p)
    pois = pois2
    plon = np.array([p['lon'] for p in pois])
    plat = np.array([p['lat'] for p in pois])
    poi_combo = H.assign(plon, plat)
    poi_street = street_for(plon, plat, [p['addr'].get('addr:street') for p in pois])
    print(f'pois assigned, {time.time()-t0:.0f}s', flush=True)

    seen = set()
    a2 = []
    for a in addrs:
        k = (a['osm'], a['addr'].get('addr:housenumber'))
        if a.get('interpolated') is None and k in seen:
            continue
        seen.add(k)
        a2.append(a)
    addrs = a2
    alon = np.array([a['lon'] for a in addrs])
    alat = np.array([a['lat'] for a in addrs])
    addr_combo = H.assign(alon, alat)
    addr_street = street_for(alon, alat, [a['addr'].get('addr:street') for a in addrs])
    print(f'{len(addrs)} addresses assigned, {time.time()-t0:.0f}s', flush=True)

    # --- postcodes: own tag, else postal_code boundary, else nearest address with a postcode
    a_pc = [a['addr'].get('addr:postcode') for a in addrs]
    have = np.array([i for i, pc in enumerate(a_pc) if pc], dtype=np.int64)
    pc_tree = shapely.STRtree(shapely.points(np.column_stack([alon[have], alat[have]]))) if len(have) else None

    def fill_postcodes(lons, lats, given, combos):
        out = list(given)
        miss = [i for i, pc in enumerate(out) if not pc]
        for i in miss:
            pc = H.combo_rows[combos[i]].get('postcode')
            if pc:
                out[i] = pc
        miss = np.array([i for i, pc in enumerate(out) if not pc], dtype=np.int64)
        if len(miss) and pc_tree is not None:
            qi, ti = pc_tree.query_nearest(shapely.points(np.column_stack([lons[miss], lats[miss]])),
                                           max_distance=0.02, all_matches=False)
            for q, t in zip(qi.tolist(), ti.tolist()):
                out[miss[q]] = a_pc[have[t]]
        return out

    a_pc_full = fill_postcodes(alon, alat, a_pc, addr_combo)
    p_pc_full = fill_postcodes(plon, plat, [p['addr'].get('addr:postcode') for p in pois], poi_combo)
    slon = np.array([s['lon'] for s in streets])
    slat = np.array([s['lat'] for s in streets])
    s_pc_full = fill_postcodes(slon, slat, [s['postcode'] for s in streets], [s['combo'] for s in streets])
    print(f'postcodes filled, {time.time()-t0:.0f}s', flush=True)

    # place nodes / boundaries that are searchable themselves
    pl_rows = []
    for b in bounds:
        if b['boundary'] == 'postal_code':
            continue
        pl_rows.append(('boundary' if b['boundary'] == 'administrative' else 'place',
                        'administrative' if b['boundary'] == 'administrative' else b['place'], b))
    for p in places:
        if p.get('linked'):
            continue
        pl_rows.append(('place', p['place'], p))
    pl_lon = np.array([r[2]['lon'] for r in pl_rows])
    pl_lat = np.array([r[2]['lat'] for r in pl_rows])
    pl_combo = H.assign(pl_lon, pl_lat)

    # ------------------------------------------------------------------ write SQLite
    if os.path.exists(dbpath):
        os.remove(dbpath)
    db = sqlite3.connect(dbpath)
    db.execute('PRAGMA journal_mode=OFF')
    db.execute('PRAGMA synchronous=OFF')
    db.execute('PRAGMA page_size=4096')
    db.executescript(open(os.path.join(HERE, 'geocode_schema.sql')).read())
    combo_json = []
    for cid, c in enumerate(H.combo_rows):
        combo_json.append((cid, json.dumps([[k, nm] for r, k, nm in c['parts']]), c['country'], c['cc'],
                           c['region'], c.get('postcode')))
    db.executemany('INSERT INTO combos VALUES (?,?,?,?,?,?)', combo_json)

    place_rows, fts_rows, rtree_rows = [], [], []

    def add_place(osm, cls, typ, name, names, hn, street, postcode, combo, lon, lat, bbox, rank, imp, extra,
                  cat_extra=''):
        pid = len(place_rows) + 1
        c = H.combo_rows[combo]
        dn = compose(name, hn, street, c, postcode, own_rank=rank)
        if not name:
            dn = (label(cls, typ) + ', ' + dn) if dn else label(cls, typ)
        osm_type, osm_id = osm[0], int(osm[1:])
        place_rows.append((pid, osm_type, osm_id, cls, typ, name, hn, street, postcode, combo, dn,
                           round(lat, 7), round(lon, 7), round(bbox[0], 7), round(bbox[1], 7), round(bbox[2], 7),
                           round(bbox[3], 7), rank, imp, json.dumps(extra) if extra else None,
                           json.dumps({k: v for k, v in names.items() if k != 'name'}) if len(names) > 1 else None))
        allnames = ' '.join(dict.fromkeys(norm(v) for v in names.values())) if names else ''
        addr = ' '.join([norm(street or ''), norm(hn or '')] +
                        [norm(nm) for r, k, nm in c['parts'] if rank >= 26 or r < rank] +
                        [norm(postcode or ''), norm(c['country'] or '')])
        cat = ' '.join([norm(label(cls, typ)), norm(extra.get('cuisine', '').replace(';', ' ')) if extra else '',
                        norm(cat_extra)])
        fts_rows.append((pid, allnames, addr, cat))
        rtree_rows.append((pid, lon, lon, lat, lat))
        return pid

    # boundaries & places
    for k, (cls, typ, r) in enumerate(pl_rows):
        rank = r['rank']
        nm = r.get('dname') or r['name']
        names = dict(r['names'])
        names.setdefault('name', r['name'])
        add_place(r['osm'], cls, typ, nm, names, None, None, None, int(pl_combo[k]), r['lon'], r['lat'],
                  r.get('bbox') or (r['lon'], r['lat'], r['lon'], r['lat']), rank,
                  importance(rank, r['extra'], r.get('area', 0) or 0, r['extra'].get('population')), r['extra'])
    print(f'{len(place_rows)} admin/place rows', flush=True)
    # streets
    street_pid = np.zeros(len(streets), dtype=np.int64)
    for sid, s in enumerate(streets):
        names = dict(s['names'])
        names.setdefault('name', s['name'])
        extra = {'ref': s['ref']} if s.get('ref') else {}
        street_pid[sid] = add_place(s['osm'], s['cls'], s['type'], s['name'], names, None, None, s_pc_full[sid],
                                    s['combo'], s['lon'], s['lat'], s['bbox'], STREET_RANK if s['cls'] == 'highway' else 22,
                                    importance(STREET_RANK, {}) + min(0.05, 0.002 * s['nways']), extra)
    print(f'{len(streets)} street rows', flush=True)
    # POIs
    poi_pid = np.zeros(len(pois), dtype=np.int64)
    for i, p in enumerate(pois):
        names = p['names']
        nm = names.get('name') or names.get('brand') or ''
        sid = poi_street[i]
        street = p['addr'].get('addr:street') or p['addr'].get('addr:place')
        if not street and sid >= 0:
            street = streets[sid]['name']
        rank = 30
        if p['cls'] in ('boundary', 'landuse', 'leisure', 'natural') and p.get('area', 0) > 1e-3:
            rank = 22
        poi_pid[i] = add_place(p['osm'], p['cls'], p['type'], nm, names, p['addr'].get('addr:housenumber'),
                               street, p_pc_full[i], int(poi_combo[i]), p['lon'], p['lat'], p['bbox'], rank,
                               importance(rank, p['extra'], p.get('area', 0) or 0), p['extra'],
                               p['extra'].get('brand', ''))
    print(f'{len(pois)} poi rows, {time.time()-t0:.0f}s', flush=True)
    # postcodes as places (centroid of their addresses)
    pc_groups = defaultdict(list)
    for i, pc in enumerate(a_pc):
        if pc:
            pc_groups[(pc, H.combo_rows[addr_combo[i]]['region'])].append(i)
    for (pc, reg), idx in pc_groups.items():
        if len(idx) < 3:
            continue
        lo, la = float(np.median(alon[idx])), float(np.median(alat[idx]))
        cmb = int(H.assign(np.array([lo]), np.array([la]))[0])
        add_place('P0', 'place', 'postcode', pc, {'name': pc}, None, None, None, cmb, lo, la,
                  (float(alon[idx].min()), float(alat[idx].min()), float(alon[idx].max()), float(alat[idx].max())),
                  21, importance(21, {}), {})

    db.executemany('INSERT INTO places VALUES (' + ','.join('?' * 21) + ')', place_rows)
    db.executemany('INSERT INTO places_fts(rowid, name, addr, cat) VALUES (?,?,?,?)', fts_rows)
    db.executemany('INSERT INTO places_rtree VALUES (?,?,?,?,?)', rtree_rows)
    print(f'places written: {len(place_rows)}, {time.time()-t0:.0f}s', flush=True)
    del place_rows, fts_rows, rtree_rows

    # addresses
    rows = []
    for i, a in enumerate(addrs):
        hn = a['addr'].get('addr:housenumber')
        sid = addr_street[i]
        st_txt = None if sid >= 0 and norm(streets[sid]['name']) == norm(a['addr'].get('addr:street') or streets[sid]['name']) \
            else (a['addr'].get('addr:street') or a['addr'].get('addr:place'))
        poi = int(poi_pid[a['poi']]) if a.get('poi') is not None else None
        cell = int(math.floor((a['lat'] + 90) / 0.002)) * 200000 + int(math.floor((a['lon'] + 180) / 0.002))
        rows.append((i + 1, int(street_pid[sid]) if sid >= 0 else None, st_txt, hn, norm(hn),
                     a_pc_full[i], int(addr_combo[i]), round(a['lat'], 7), round(a['lon'], 7), poi, cell,
                     a['osm'], a.get('interpolated', 0)))
    db.executemany('INSERT INTO addresses VALUES (' + ','.join('?' * 13) + ')', rows)
    del rows
    print(f'addresses written, {time.time()-t0:.0f}s', flush=True)

    # street way geometries (reverse geocoding), simplified ~2 m
    rows, rrows = [], []
    for j, i in enumerate(hw_idx.tolist()):
        r = roads[i]
        line = shapely.simplify(road_lines[j], 0.00002)
        cs = np.round(np.array(line.coords) * 1e7).astype('<i4')
        x0, y0, x1, y1 = line.bounds
        rows.append((j + 1, int(street_pid[road_street[i]]), cs.tobytes()))
        rrows.append((j + 1, x0, x1, y0, y1))
    db.executemany('INSERT INTO street_ways VALUES (?,?,?)', rows)
    db.executemany('INSERT INTO street_ways_rtree VALUES (?,?,?,?,?)', rrows)
    meta = dict(built=time.strftime('%Y-%m-%dT%H:%M:%S'), regions=regions,
                counts=dict(places=int(len(pois) + len(streets) + len(pl_rows)), addresses=len(addrs),
                            streets=len(streets), pois=len(pois), combos=len(H.combo_rows)))
    db.execute('INSERT INTO meta VALUES (?,?)', ('info', json.dumps(meta)))
    db.commit()
    print('creating indexes / optimising FTS', flush=True)
    db.executescript(open(os.path.join(HERE, 'geocode_index.sql')).read())
    db.commit()
    db.execute('VACUUM')
    db.close()
    print(f'done {dbpath} {os.path.getsize(dbpath)/1e6:.0f} MB in {time.time()-t0:.0f}s')


if __name__ == '__main__':
    main()
