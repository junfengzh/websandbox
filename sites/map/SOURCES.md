# Map lite: data sources, licences, attribution

All map data in `data/map/` (tiles, geocoder DB, routing graph) is derived from
OpenStreetMap. Required attribution, shown on every map view (it is in the
style's source `attribution` and in the MBTiles metadata):

> © OpenStreetMap contributors, © OpenMapTiles

## OpenStreetMap data (ODbL 1.0)

- Licence: Open Database License 1.0, <https://opendatacommons.org/licenses/odbl/1-0/>.
  The tiles, geocoder database and routing graph are *Derivative Databases* /
  *Produced Works* of OSM and are published under the ODbL with this notice.
  Attribution text: "© OpenStreetMap contributors", linking to
  <https://www.openstreetmap.org/copyright>.
- Extracts used (snapshot dates in `docs/NOTES-map.md`):

| Region | File | Source |
|---|---|---|
| US Northeast (CT, ME, MA, NH, NJ, NY, PA, RI, VT) | `us-northeast-latest.osm.pbf` | Geofabrik, <https://download.geofabrik.de/north-america/us-northeast.html> |
| Greater London | `greater-london-latest.osm.pbf` | Geofabrik, <https://download.geofabrik.de/europe/united-kingdom/england/greater-london.html> |
| San Francisco | `bbbike-SanFrancisco.osm.pbf`, cut to bbox -122.54,37.54,-122.32,37.93 | BBBike extracts, <https://download.bbbike.org/osm/bbbike/SanFrancisco/> |
| Singapore | `bbbike-Singapore.osm.pbf`, cut to bbox 103.6033,1.2385,104.028,1.4804 | BBBike extracts, <https://download.bbbike.org/osm/bbbike/Singapore/> |

The region outlines in `build/regions/*.poly` are Geofabrik's extract polygons (ODbL, © OpenStreetMap contributors).

WebArena's own map (an OpenStreetMap website + tile server + Nominatim + OSRM on
a US-Northeast import) is not redistributed; its database was not available, so
the data here is a newer Geofabrik snapshot of the same region.

## Auxiliary data used by planetiler for the tiles

- OSM water polygons (`water-polygons-split-3857.zip`), <https://osmdata.openstreetmap.de/data/water-polygons.html>
  -- ODbL, © OpenStreetMap contributors.
- Natural Earth (`natural_earth_vector.sqlite.zip`), <https://www.naturalearthdata.com/> -- public domain.
- Lake centerlines (`lake_centerline.shp.zip`), <https://github.com/acalcutt/osm-lakelines> (from
  <https://github.com/lukasmartinelli/osm-lakelines>) -- MIT licence, derived from OSM (ODbL).

## Tile schema and tooling

- Tiles are built with **planetiler** (<https://github.com/onthegomap/planetiler>, Apache-2.0)
  using its **OpenMapTiles** profile. The OpenMapTiles schema
  (<https://github.com/openmaptiles/openmaptiles>) is BSD-3-Clause (code) and
  CC-BY 4.0 (design); vector tiles in this schema must credit "© OpenMapTiles".
- Style: **OSM Bright GL** v1.11 (<https://github.com/openmaptiles/osm-bright-gl-style>),
  BSD-3-Clause (code) and CC-BY 4.0 (design, © OpenMapTiles, derived from
  Mapbox Open Styles); sprites from the same release (icons derived from Maki, CC0).
- Glyphs: **Noto Sans** Regular / Bold / Italic as MapLibre glyph PBFs from
  <https://github.com/openmaptiles/fonts> (v2.0). Noto fonts: SIL Open Font License 1.1, © Google.
- Client library: **MapLibre GL JS** (<https://github.com/maplibre/maplibre-gl-js>), BSD-3-Clause,
  served from `node_modules` (no CDN at runtime).

## Engines

- Geocoder (`lib/geocode.js`, `build/build_geocode.py`): own code, modelled on Nominatim's
  behaviour (address ranks, display names, special phrases); no Nominatim code or data.
- Routing (`lib/route*.js`, `build/route_extract.cpp`, `build/graph.cpp`): own contraction
  hierarchy; speed tables and turn penalties follow OSRM's default `car.lua`,
  `bicycle.lua`, `foot.lua` profiles (OSRM: BSD-2-Clause). Built with libosmium (BSL-1.0)
  and pyosmium (BSD-2-Clause).
