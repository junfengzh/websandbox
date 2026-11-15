# Map lite: data layout and schema

Everything lives under `$WSB_DATA_ROOT/map/` (override with
`WSB_MAP_DATA`). All of it is read-only at runtime, so tenants share it and
reset is free.

```
data/map/
  tiles/map.mbtiles      vector tiles, OpenMapTiles schema, z0-14 (planetiler)
  static/style.json      OSM Bright style; URLs are site-relative (lib/tiles.js makes them absolute)
  static/glyphs/<font>/<range>.pbf   Noto Sans Regular / Bold / Italic
  static/sprites/sprite{,@2x}.{json,png}
  geocode.db             geocoder (SQLite, FTS5 + R*Tree)
  route/                 road graph + contraction hierarchies (car, bike, foot)
```

## Tiles (`tiles/map.mbtiles`)

Standard MBTiles 1.3 (`metadata`, `tiles` with TMS rows, gzip-compressed MVT).
Layers are the OpenMapTiles 3.x schema (`water`, `waterway`, `landcover`,
`landuse`, `mountain_peak`, `park`, `boundary`, `aeroway`, `transportation`,
`building`, `water_name`, `transportation_name`, `place`, `housenumber`, `poi`,
`aerodrome_label`). Tiles are generated only inside the region outlines
(`--polygon`), plus Natural Earth at low zooms worldwide. URL scheme served by
`lib/tiles.js`: `/tiles/{z}/{x}/{y}.pbf` (XYZ).

## Geocoder (`geocode.db`)

DDL: `build/geocode_schema.sql` (+ `build/geocode_index.sql`).

| Table | Rows | Purpose |
|---|---|---|
| `places` | admin areas, place nodes, streets, POIs, postcodes | every searchable object |
| `places_fts` | FTS5, contentless, rowid = `places.id` | columns `name` (all names), `addr` (street, hn, address parts, postcode, country), `cat` (type label, cuisine, brand) |
| `places_rtree` | R*Tree of `places` points | nearby / reverse / viewbox search |
| `combos` | shared address-part lists | `parts` = JSON `[[key, name], ...]` most specific first (neighbourhood, suburb, city, county, state), plus country / region / boundary postcode |
| `addresses` | house numbers (OSM addr:*, POIs with a housenumber, expanded addr:interpolation) | `street_id` -> `places.id`, `hn_norm`, `cell` grid for reverse |
| `street_ways` + `street_ways_rtree` | named road way geometries (int32 E7 pairs) | reverse geocoding to a street |
| `meta` | `info` JSON | build time, regions, counts |

`places` columns: `id, osm_type (N/W/R/P), osm_id, class, type, name,
housenumber, street, postcode, combo, display_name, lat, lon, minlon, minlat,
maxlon, maxlat, rank, importance, extratags (JSON), names (JSON)`.

- `class`/`type` are the OSM main tag (`amenity=cafe`, `tourism=hotel`,
  `highway=residential` for streets, `boundary=administrative`, `place=city`,
  `place=postcode`, ...).
- `display_name` is Nominatim-style:
  `name, housenumber, street, neighbourhood, suburb, city, county, state, postcode, country`,
  e.g. `Starbucks, 417, South Craig Street, Bellefield, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States`.
- `rank` follows Nominatim's search ranks (country 4, state 8, county 12,
  city 16, town 18, village 19, suburb 20, neighbourhood 24, street 26, POI 30).
- `importance` = `0.4 - rank/75` + 0.15 if wikipedia/wikidata + population and area boosts.
- `extratags`: `opening_hours, website, contact:website, phone, contact:phone,
  email, operator, brand, cuisine, wikipedia, wikidata, description, ele,
  wheelchair, iata, icao, population, ...` as tagged in OSM.

How the address hierarchy is built (build/build_geocode.py): admin boundaries
(admin_level 2-12 mapped to Nominatim ranks) and `place=*` polygons by
point-in-polygon; `place=*` nodes without a polygon within a rank-dependent
radius (neighbourhood ~600 m, suburb ~1.2 km, village 2 km, town 4 km, city 8 km);
place nodes are linked to the boundary with the same name/wikidata (so
"Pittsburgh" appears once). Street of a POI: `addr:street`, else the nearest
named road (<= ~300 m). Postcode: `addr:postcode`, else a postal_code boundary,
else the nearest address with a postcode (<= ~2 km).

Search text is normalised identically at build and query time
(`build/textnorm.py`, `lib/textnorm.js`, table `lib/abbrev.json`): lower case,
no diacritics/apostrophes, abbreviations folded to one form (street/st,
avenue/ave, university/univ, north/n, saint/st, ...).

## Routing (`route/`)

Written by `build/graph.cpp`; all little endian.

| File | Content |
|---|---|
| `nodes.bin` | int32 lon·1e7, lat·1e7 per graph node (junctions, way ends, barriers) |
| `edges.bin` | per base edge: uint32 `u, v, geom_off, geom_n, way`, float32 `length_m` |
| `geom.bin` | int32 lon/lat pairs of edge geometries (~1 m Douglas-Peucker), endpoints included |
| `ways.bin` | per OSM way: uint32 name id, uint8 highway class, uint8 flags (1 ferry, 2 roundabout, 4 toll, 8 bridge, 16 tunnel, 32 oneway) |
| `names.json` | `[[name, ref, class], ...]` |
| `grid.bin` | `{ncells, nentries}`, sorted cell keys (0.005° cells, key = row·72000 + col), offsets, edge ids |
| `<p>.edgew.bin` | per base edge: uint32 `dur_fwd, dur_bwd, weight_fwd, weight_bwd` in deciseconds (`0xFFFFFFFF` = no access) |
| `<p>.comp.bin` | uint8 per edge: in a component with >= 500 nodes (snapping prefers these) |
| `<p>.dur.bin` | A* profiles (bike, foot): per base edge uint32 `dur_fwd, dur_bwd` (deciseconds) |
| `<p>.ch.bin` | `{n, m_fwd, m_bwd}`, then forward-upward CSR (`off[n+1], to, w, pay`) and backward-upward CSR; `pay` bit 31 = shortcut via node `pay & 0x7fffffff`, else `edge*2 + dir` |

Profiles `p` = `car` (edgew + CH), `bike` and `foot` (dur, A*); speeds: see build/README.md.
