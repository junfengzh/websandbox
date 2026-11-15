#!/usr/bin/env python3
"""Pass 1 of the geocoder build: read the merged PBF with pyosmium and pull out
everything the geocoder needs, as plain Python lists pickled to WORK/geocode/extract.pkl.

  python3 -I geocode_extract.py WORK/all.osm.pbf WORK/geocode

Collected:
  pois       named (or a few unnamed useful) objects with a main class tag
  addrs      objects with addr:housenumber (incl. POIs that have one)
  roads      named highway lines (become streets) + named rivers/canals
  bounds     admin / postal-code boundaries and place=* areas (shapely WKB)
  places     place=* nodes
  interp     addr:interpolation lines
"""
import os, pickle, sys, time
import osmium
import shapely
from shapely import wkb as swkb

MAIN_KEYS = ['amenity', 'shop', 'tourism', 'aeroway', 'railway', 'public_transport', 'healthcare',
             'emergency', 'historic', 'leisure', 'office', 'craft', 'club', 'man_made', 'military',
             'natural', 'waterway', 'mountain_pass', 'landuse', 'building', 'highway', 'place', 'boundary']
SKIP_VALUES = {'no', 'yes;no', 'disused', 'abandoned', 'construction', 'proposed', 'razed', 'demolished'}
RAILWAY_OK = {'station', 'halt', 'tram_stop', 'subway_entrance', 'platform'}
HIGHWAY_POI = {'bus_stop', 'rest_area', 'services', 'traffic_signals', 'motorway_junction', 'trailhead', 'elevator'}
ROAD_TYPES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
              'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
              'living_street', 'service', 'pedestrian', 'track', 'road', 'footway', 'path', 'cycleway',
              'bridleway', 'steps', 'busway', 'bus_guideway'}
UNNAMED_OK = {('amenity', 'parking'), ('amenity', 'fuel'), ('amenity', 'atm'), ('amenity', 'toilets'),
              ('amenity', 'charging_station'), ('amenity', 'post_box'), ('amenity', 'parking_entrance'),
              ('amenity', 'bicycle_rental'), ('aeroway', 'helipad')}
PLACE_TYPES = {'country', 'state', 'region', 'province', 'county', 'district', 'municipality', 'city', 'town',
               'village', 'hamlet', 'borough', 'city_district', 'suburb', 'quarter', 'neighbourhood',
               'city_block', 'isolated_dwelling', 'farm', 'locality', 'island', 'islet', 'square', 'archipelago'}
EXTRA_KEYS = ['opening_hours', 'website', 'contact:website', 'url', 'phone', 'contact:phone', 'email',
              'contact:email', 'operator', 'brand', 'brand:wikidata', 'cuisine', 'wikipedia', 'wikidata',
              'description', 'ele', 'wheelchair', 'internet_access', 'capacity', 'population', 'iata', 'icao',
              'denomination', 'religion', 'sport', 'level', 'fee', 'takeaway', 'delivery', 'drive_through',
              'outdoor_seating', 'diet:vegetarian', 'start_date', 'heritage', 'official_name', 'ref']
NAME_KEYS = ['name', 'name:en', 'alt_name', 'official_name', 'short_name', 'old_name', 'loc_name',
             'alt_name:en', 'official_name:en', 'short_name:en', 'brand', 'int_name']
ADDR_KEYS = ['addr:housenumber', 'addr:street', 'addr:place', 'addr:postcode', 'addr:city', 'addr:suburb',
             'addr:unit', 'addr:state']


def main_class(tags):
    for k in MAIN_KEYS:
        v = tags.get(k)
        if not v or v in SKIP_VALUES:
            continue
        if k == 'railway' and v not in RAILWAY_OK:
            continue
        if k == 'highway' and v not in HIGHWAY_POI:
            continue
        if k == 'boundary' and v not in ('administrative', 'national_park', 'protected_area', 'postal_code'):
            continue
        if k == 'building' and 'name' not in tags:
            continue
        if k == 'landuse' and 'name' not in tags:
            continue
        if k == 'natural' and v in ('tree', 'tree_row', 'scrub', 'wood', 'grassland') and 'name' not in tags:
            continue
        return k, v.split(';')[0].strip()
    return None


def tagdict(t, keys):
    out = {}
    for k in keys:
        v = t.get(k)
        if v:
            out[k] = v
    return out


def finish_geoms(recs, keep_wkb):
    """Vectorised centroid / bbox / area for records that carry a hex WKB multipolygon."""
    idx = [i for i, r in enumerate(recs) if r.get('wkb') is not None and r.get('lon') is None]
    for r in recs:
        if r.get('wkb') is None:
            r.pop('wkb', None)
    if not idx:
        return
    g = shapely.from_wkb([recs[i]['wkb'] for i in idx], on_invalid='ignore')
    ok = ~shapely.is_missing(g)
    bad = ok & ~shapely.is_valid(g)
    if bad.any():
        g[bad] = shapely.make_valid(g[bad])
    c = shapely.centroid(g)
    inside = shapely.contains(g, c)
    if (~inside & ok).any():
        sel = ~inside & ok
        c[sel] = shapely.point_on_surface(g[sel])
    bb = shapely.bounds(g)
    ar = shapely.area(g)
    xs, ys = shapely.get_x(c), shapely.get_y(c)
    wk = shapely.to_wkb(g) if keep_wkb else None
    for j, i in enumerate(idx):
        r = recs[i]
        if not ok[j] or shapely.is_empty(g[j]):
            r['lon'] = None
            r.pop('wkb', None)
            continue
        r['lon'], r['lat'] = float(xs[j]), float(ys[j])
        r['bbox'] = tuple(float(v) for v in bb[j])
        r['area'] = float(ar[j])
        if keep_wkb:
            r['wkb'] = wk[j]
        else:
            r.pop('wkb', None)


def main():
    pbf, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    idx = 'sparse_file_array,' + os.path.join(outdir, 'nodes.cache')
    wkbf = osmium.geom.WKBFactory()
    pois, addrs, roads, bounds, places, interp = [], [], [], [], [], []
    addr_nodes = {}  # node id -> housenumber, for interpolation endpoints
    keyf = osmium.filter.KeyFilter('name', 'addr:housenumber', 'addr:interpolation', 'boundary', 'place',
                                   'amenity', 'aeroway')
    fp = (osmium.FileProcessor(pbf)
          .with_locations(idx)
          .with_areas()
          .with_filter(keyf))
    t0 = time.time()
    n = 0
    skipped_area_ways = 0
    for o in fp:
        n += 1
        if n % 1000000 == 0:
            print(f'  {n/1e6:.0f}M objects, {len(pois)} pois {len(addrs)} addrs {len(roads)} roads '
                  f'{len(bounds)} bounds {time.time()-t0:.0f}s', flush=True)
        if o.is_relation():
            continue
        tags = {t.k: t.v for t in o.tags}
        if False:
            continue
        if o.is_way():
            hw = tags.get('highway')
            ww = tags.get('waterway')
            if 'addr:interpolation' in tags:
                try:
                    coords = [(nd.lon, nd.lat) for nd in o.nodes]
                except osmium.InvalidLocationError:
                    continue
                interp.append(dict(id=o.id, kind=tags['addr:interpolation'], street=tags.get('addr:street'),
                                   postcode=tags.get('addr:postcode'), refs=[nd.ref for nd in o.nodes],
                                   coords=coords))
                continue
            line_road = hw in ROAD_TYPES and 'name' in tags and tags.get('area') != 'yes'
            line_water = ww in ('river', 'canal', 'stream') and 'name' in tags
            if line_road or line_water:
                try:
                    coords = [(nd.lon, nd.lat) for nd in o.nodes]
                except osmium.InvalidLocationError:
                    continue
                if len(coords) < 2:
                    continue
                roads.append(dict(id=o.id, name=tags['name'], cls='highway' if line_road else 'waterway',
                                  type=hw if line_road else ww, ref=tags.get('ref'),
                                  names=tagdict(tags, NAME_KEYS), coords=coords,
                                  postcode=tags.get('addr:postcode') or tags.get('postal_code')))
                continue
            if o.is_closed():
                skipped_area_ways += 1
                continue  # becomes an area
            # open named way that is not a road: treat as a line POI (e.g. bridge, pier, aerialway)
            mc = main_class(tags)
            if mc is None or 'name' not in tags:
                continue
            try:
                coords = [(nd.lon, nd.lat) for nd in o.nodes]
            except osmium.InvalidLocationError:
                continue
            ls = shapely.LineString(coords) if len(coords) > 1 else shapely.Point(coords[0])
            pt = ls.interpolate(0.5, normalized=True) if len(coords) > 1 else ls
            pois.append(dict(osm='W%d' % o.id, cls=mc[0], type=mc[1], lon=pt.x, lat=pt.y,
                             bbox=ls.bounds, names=tagdict(tags, NAME_KEYS), addr=tagdict(tags, ADDR_KEYS),
                             extra=tagdict(tags, EXTRA_KEYS)))
            continue

        # nodes and areas
        if o.is_node():
            if not o.location.valid():
                continue
            lon, lat = o.location.lon, o.location.lat
            geom = None
            osm = 'N%d' % o.id
            bbox = (lon, lat, lon, lat)
            area = 0.0
        else:  # area
            hw = tags.get('highway')
            if o.from_way() and ((hw and tags.get('area') != 'yes') or tags.get('waterway') or
                                 tags.get('barrier') or tags.get('railway')):
                continue  # closed line handled as a way above
            osm = ('W%d' if o.from_way() else 'R%d') % o.orig_id()
            need_geom = (not o.from_way()) or 'boundary' in tags or 'place' in tags
            geom = None
            if need_geom:
                try:
                    geom = wkbf.create_multipolygon(o)
                except Exception:
                    continue
                lon = lat = None
                bbox = None
                area = 0.0
            else:
                # cheap: vertex mean / bbox / shoelace of the outer ring(s)
                xs, ys, area = [], [], 0.0
                try:
                    for ring in o.outer_rings():
                        rx = [n.lon for n in ring]
                        ry = [n.lat for n in ring]
                        xs += rx[:-1]
                        ys += ry[:-1]
                        area += abs(sum(rx[i] * ry[i + 1] - rx[i + 1] * ry[i] for i in range(len(rx) - 1))) / 2
                except osmium.InvalidLocationError:
                    continue
                if not xs:
                    continue
                lon, lat = sum(xs) / len(xs), sum(ys) / len(ys)
                bbox = (min(xs), min(ys), max(xs), max(ys))

        b = tags.get('boundary')
        pl = tags.get('place')
        name = tags.get('name')
        # boundaries / place areas used for the address hierarchy
        if geom is not None and name and (
                (b == 'administrative' and tags.get('admin_level')) or pl in PLACE_TYPES):
            bounds.append(dict(osm=osm, name=name, names=tagdict(tags, NAME_KEYS), boundary=b,
                               admin_level=tags.get('admin_level'), place=pl, wkb=geom,
                               lon=lon, lat=lat, bbox=bbox, extra=tagdict(tags, EXTRA_KEYS),
                               wikidata=tags.get('wikidata')))
            continue
        if geom is not None and b == 'postal_code' and tags.get('postal_code'):
            bounds.append(dict(osm=osm, name=tags['postal_code'], names={}, boundary=b, admin_level=None,
                               place=None, wkb=geom, lon=lon, lat=lat, bbox=bbox, extra={},
                               wikidata=None))
            continue
        if geom is None and pl in PLACE_TYPES and name:
            places.append(dict(osm=osm, name=name, names=tagdict(tags, NAME_KEYS), place=pl, lon=lon, lat=lat,
                               extra=tagdict(tags, EXTRA_KEYS), wikidata=tags.get('wikidata'),
                               addr=tagdict(tags, ADDR_KEYS)))
            continue
        hn = tags.get('addr:housenumber')
        mc = main_class(tags)
        if mc is not None and (name or mc in UNNAMED_OK or tags.get('brand')):
            if mc[0] in ('boundary', 'place') and not name:
                continue
            rec = dict(osm=osm, cls=mc[0], type=mc[1], lon=lon, lat=lat, bbox=bbox,
                       names=tagdict(tags, NAME_KEYS), addr=tagdict(tags, ADDR_KEYS), extra=tagdict(tags, EXTRA_KEYS))
            if geom is not None:
                rec['wkb'] = geom
            elif area:
                rec['area'] = area
            pois.append(rec)
            if hn:
                addrs.append(dict(osm=osm, lon=lon, lat=lat, addr=rec['addr'], poi=len(pois) - 1))
            continue
        if hn:
            addrs.append(dict(osm=osm, lon=lon, lat=lat, addr=tagdict(tags, ADDR_KEYS), poi=None, wkb=geom))
            if o.is_node():
                addr_nodes[o.id] = hn

    t1 = time.time()
    finish_geoms(pois, keep_wkb=False)
    finish_geoms(bounds, keep_wkb=True)
    finish_geoms(addrs, keep_wkb=False)
    for a in addrs:
        if a['poi'] is not None:
            p = pois[a['poi']]
            a['lon'], a['lat'] = p['lon'], p['lat']
    addrs = [a for a in addrs if a['lon'] is not None]
    pois = [p for p in pois if p['lon'] is not None]
    print(f'geometry post-processing {time.time()-t1:.0f}s', flush=True)
    for it in interp:
        it['hns'] = [addr_nodes.get(r) for r in it['refs']]
        del it['refs']
    print(f'done {n} objects in {time.time()-t0:.0f}s: {len(pois)} pois, {len(addrs)} addrs, {len(roads)} roads, '
          f'{len(bounds)} bounds, {len(places)} place nodes, {len(interp)} interpolations', flush=True)
    with open(os.path.join(outdir, 'extract.pkl'), 'wb') as f:
        pickle.dump(dict(pois=pois, addrs=addrs, roads=roads, bounds=bounds, places=places, interp=interp), f,
                    protocol=pickle.HIGHEST_PROTOCOL)
    os.remove(os.path.join(outdir, 'nodes.cache'))


if __name__ == '__main__':
    main()
