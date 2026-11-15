# Map lite build pipeline

Turns OSM extracts into the read-only map data: vector tiles, client assets, a
geocoder DB and routing graphs. Outputs go to `$OUT` (default
`$WSB_DATA_ROOT/map`), intermediates to `$WORK`
(default `$WSB_WORK/map`; delete when done).

```
./build_all.sh                      # download prepare compile assets tiles route geocode
STEPS="geocode" ./build_all.sh      # one step (tiles, route and geocode run in parallel)
```

Requirements: osmium-tool, libosmium2-dev (+ protozero, zlib, bz2, expat), g++ (C++17),
Java >= 21 for planetiler (`JAVA=/usr/lib/jvm/java-21-openjdk-amd64/bin/java`),
Python 3 with pyosmium >= 4, shapely >= 2, numpy. Node >= 20 for the runtime libs
(`npm install` in `sites/map`).

| Step | Script | What |
|---|---|---|
| download | `download.sh` | Geofabrik / BBBike extracts into `$SRC`; planetiler jar, water polygons, Natural Earth, lake centerlines, OpenMapTiles fonts, OSM Bright style |
| prepare | `prepare.py` | cut each region of `regions.json` (`osmium extract`, smart strategy), merge into `$WORK/all.osm.pbf`, write `$WORK/all.poly` (outline for planetiler) |
| compile | `route_extract.cpp`, `graph.cpp` | g++ -O3 |
| assets | `assets.py` | `static/style.json` (OSM Bright, local URLs), glyphs (Noto Sans R/B/I), sprites |
| tiles | planetiler OpenMapTiles profile | `tiles/map.mbtiles`, z0-14, `--polygon all.poly` |
| route | `route_extract` -> `graph` | routable ways with per-profile speeds, then base graph, spatial grid, contraction hierarchy per profile (`route/`) |
| geocode | `geocode_extract.py` -> `build_geocode.py` | pyosmium pass (POIs, addresses, roads, boundaries, places, interpolations) to a pickle; then hierarchy, streets, postcodes, ranking and `geocode.db` |

Regions (`regions.json`): `us-northeast` (Geofabrik file used as is), `sf`,
`london`, `singapore`. To add one: download an extract, add an entry with a
`poly` file or `bbox`, `country`, `country_code`, then rebuild.

## Routing profiles (OSRM defaults)

- **car** (`car.lua`): motorway 90, motorway_link 45, trunk 85, trunk_link 40,
  primary 65, primary_link 30, secondary 55, secondary_link 25, tertiary 40,
  tertiary_link 20, unclassified/residential 25, living_street 10, service 15 km/h;
  `maxspeed` (incl. mph, `US:urban` style) x 0.8 overrides; service=parking_aisle /
  driveway / alley get a 0.5 route-weight rate (duration unchanged);
  access hierarchy motorcar > motor_vehicle > vehicle > access (blacklist no,
  private, agricultural, forestry, emergency, psv, customers, delivery);
  oneway (implied on motorways and roundabouts); blocking barriers (anything
  but gate, lift_gate, toll_booth, cattle_grid, ...); traffic signals +2 s;
  turn penalty 7.5 s sigmoid on the angle (bias 1.075), u-turn +20 s.
- **bike** (`bicycle.lua`): 15 km/h on roads/cycleways, path 13, track 12,
  service and living_street 10; footway/pedestrian/steps pushed at 4 (steps 2)
  unless bicycle=yes; against a oneway pushed at 4; no motorways; turn penalty 6 s (bias 1.4).
- **foot** (`foot.lua`): 5 km/h on everything walkable except motorways; no oneways.
- **ferries** (route=ferry): `duration` tag if present, else 5 km/h; all profiles unless access denies.

Turn penalties are added to the reported duration of the found path (they do not
steer the search, which keeps the graph node-based and the CH small).

Search methods (both exact for the given weights):

- **car: contraction hierarchy.** Car speeds vary 10-110 km/h, so a geometric
  A* bound is weak; the CH answers Boston -> Acadia or Pittsburgh -> NYC after
  settling a few hundred nodes, in milliseconds. Preprocessing (edge-difference
  ordering with lazy updates, 500-node witness searches) took ~12 min for the
  car graph (8.6M nodes) on the loaded build box.
- **bike, foot: A\*** on the base graph (adjacency built in memory at load) with
  the straight-line distance at the profile's top speed (15 / 5 km/h) as the
  heuristic. Speeds are nearly constant, so the bound is tight: a 160 km bike
  trip with a ferry settles ~27k nodes (~0.4 s), typical city walks < 0.1 s.
  Results are identical to the CH (checked on sample pairs) and this saves
  ~1.6 GB of CH files (`graph ... car,bike:astar,foot:astar`).
