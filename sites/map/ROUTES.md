# Map routes (`map.wa`)

Every URL the map site serves, for graders and the task converter. The OpenStreetMap
website's URL scheme is kept where WebArena tasks use it (`/search?query=`, `/directions?engine=&route=`,
`/node|way|relation/<id>`, `#map=<zoom>/<lat>/<lon>`). Server: [server.js](server.js);
handlers: [routes/](routes/); data: [SCHEMA.md](SCHEMA.md).

All pages are server-rendered: every answer (result names and addresses, coordinates, route
distance/time and turn list) is text in `#sidebar_content`, readable without the map canvas.
`public/map.js` draws the map from the page's `<script type="application/json" id="map-data">`
and navigates in place (fetch + swap `#sidebar` + `pushState`), so the final URL is the same
with or without JS. Read-only site: shared DB mode, no logins, no writes; `/__rl/reset` is a no-op
apart from the kit's state, `/__rl/query` runs on `geocode.db` (tables in SCHEMA.md).

## Map permalink

`#map=<zoom>/<lat>/<lon>` on any page (MapLibre `hash: 'map'`, as on openstreetmap.org), e.g.
`/#map=15/40.4443/-79.9436` (the default view: CMU). Page navigation keeps the hash; place,
search and directions pages fit the map to their results when loaded without a hash.

## Pages

| URL | Page |
|---|---|
| `/` | welcome sidebar + map |
| `/search?query=<text>` (alias `q=`) | "Search Results" -- up to 15 Nominatim-like results: `<li class="search_results_entry">` with `.result-type` (University, Cafe, City, ...) and `a.set_position` = full display name linking to the place page. Understands names, addresses (`401 Shady Ave, Pittsburgh`), `<category> near <place>` / `<category> in <place>` (results sorted by straight-line distance, shown as "(350m away, straight line)"), bare categories (near the map view). A coordinate pair as the query is treated like `lat=&lon=`. Ranking uses the map view centre (header `X-Map-Center: lon,lat`, sent by the page script on in-place navigation; default CMU for a plain page load), like OSM's viewbox. Also understood: `<name> at <place>`; US state codes after a comma (`Scranton, PA`); `NYC`/`Philly`; when no result has all the words, `<name words> <place words>` in either order (`AMC theatre pittsburgh`, `CMU Hunt library`, `gates building at CMU`: POIs named by the leading/trailing words within 30 km of the place); a rare category near a place looks up to 50 km (`airports near CMU`) |
| `/search?lat=<lat>&lon=<lon>[&zoom=<z>]` | "Where is this?" (reverse geocoding): the coordinates, then the nearest building/POI/address, street, neighbourhood and city results |
| `/node/<osm id>`, `/way/<osm id>`, `/relation/<osm id>` | place page of an OSM object in the geocoder (404 if it is not) |
| `/place/<place_id>` | place page by geocoder `place_id` -- for results without an OSM object: house numbers (`/place/a%3A<street_id>%3A<id>`, i.e. `a:<street_id>:<id>`) and postcodes |
| `/query?lat=&lon=` | "Query Features": nearby named features (≤ 60 m) + enclosing features (street, neighbourhood, city, county, state, postcode) |
| `/query?lat=&lon=&category=<phrase>` | "What's nearby": the 20 nearest places of a category (`restaurant`, `cafe`, `hotel`, `supermarket`, `parking`, `bar`, `pharmacy`, `gas station`, ... any phrase of `lib/categories.json`), radius growing to 20 km, with straight-line distance and address |
| `/directions` | empty directions form |
| `/directions?engine=<engine>&route=<lat>,<lon>;<lat>,<lon>[&from=<name>&to=<name>]` | **canonical directions URL**: route drawn on the map, `#routing_summary` with `Distance: <span class="route-distance" data-meters>33km</span>. Time: <span class="route-time" data-seconds>36 min</span>.` (also `h:mm`), links to the same route by the other modes, and the turn list `ol.routing_steps > li.routing_step` (instruction + distance; last step "You have arrived at your destination"). `from`/`to` are the names shown in the From/To fields; if absent the endpoints are reverse geocoded. Either side of `route` may be empty (one-sided form, e.g. "Directions from here") |
| `/directions?engine=..&route_from=<text>&route_to=<text>[&from_ll=..&from=..&to_ll=..&to=..]` | the directions form submit: each field is geocoded (top hit near the map view; a field equal to its hidden `from`/`to` keeps `from_ll`/`to_ll`; `lat, lon` text is used as is), then **302 to the canonical URL** with `from`/`to` = the full display names. Unknown text: the form again with `Could not find "<text>" (from)` |
| `/about`, `/copyright` | about / ODbL attribution |

Directions form (as on openstreetmap.org, so WebArena's DOM checks map 1:1):
`div#content select.routing_engines[name=engine]` with options in this order -- index 0
`fossgis_osrm_bike` "Bicycle (OSRM)", 1 `fossgis_osrm_car` "Car (OSRM)", 2 `fossgis_osrm_foot`
"Foot (OSRM)"; inputs `[name=route_from]`, `[name=route_to]`. Changing the mode with both fields
filled resubmits the form. Engine aliases accepted: `car|driving`, `bike|bicycle|cycling`,
`foot|walking`, and OSM's `graphhopper_*` / `fossgis_valhalla_*` names; unknown -> car.

Place page (`article.place`, inside `#sidebar_content`): kind + OSM ref, `h2#place_h` name,
`dl.place-facts` (Category `University (amenity=university)`, Address = full display name,
Postcode, Coordinates `40.443698, -79.943408` (decimal degrees, `.latitude`/`.longitude` spans),
Opening hours, Website, Phone, Email, Operator, Brand, Cuisine, ... when tagged), "Directions from
here" / "Directions to here" links, a "What's nearby?" category form (-> `/query`), the tag table
`table.browse-tag-list` (key/value, rebuilt from the geocoder row: main tag, names, addr:*,
extra tags) and up to 10 named places within 250 m.

Map click (JS): a popup with "Directions from here", "Directions to here" (keeping the other end
of the current directions form), "Show address" (`/search?lat=&lon=&zoom=`), "Query features",
"Centre map here".

## Grading (`grade.js`)

The site is read-only, so WebArena's DOM checks of the last page are checks of the final URL:
`directions` (engine + From/To names = the `from`/`to` params + route end points near the
expected places), `place` (the final URL is the page of one of the listed OSM objects / its
name+address contain given strings) and `search` (`/search?query=<category> near <place>`, any
category wording, any name of the place). Answers go to the kit grader (`answer.numeric` for
times, distances and coordinates). Tasks start at `__MAP__/#map=15/40.4443/-79.9436` (CMU).

## JSON API

| URL | Returns |
|---|---|
| `/api/search?q=&limit=` | Nominatim jsonv2-like results (`display_name`, `address`, `extratags`, `boundingbox`, `distance`) |
| `/api/autocomplete?q=` | `[{display_name, name, type, lat, lon, url}]` (search box / From / To suggestions) |
| `/api/reverse?lat=&lon=&zoom=` | one Nominatim-like result |
| `/api/nearby?lat=&lon=&category=&limit=&radius=` | places, nearest first |
| `/api/route?engine=&route=lat,lon;lat,lon[&steps=1]` | `{code, distance (m), duration (s), distance_text, duration_text, bbox, geometry (GeoJSON), waypoints[, steps]}` |

## Map assets

`/style.json` (OSM Bright, URLs made absolute for the request's Host), `/tiles/{z}/{x}/{y}.pbf`
(MBTiles, gzip MVT; 204 outside the regions), `/glyphs/<fontstack>/<range>.pbf`,
`/sprites/sprite{,@2x}.{json,png}`, `/vendor/maplibre-gl.{js,css}` (from node_modules, no CDN),
`/static/*` (site CSS/JS). Attribution "© OpenMapTiles © OpenStreetMap contributors" is shown on
the map and "© OpenStreetMap contributors" in the sidebar footer.

## Skins

`default`, `dark` (dark theme), `right` (sidebar on the right; "Search" button, "Route planner"
menu label, "Find a place" placeholder). Set per tenant with `POST /__rl/reset {"skin": ...}`.
