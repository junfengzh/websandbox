# Map lite: build notes

Builder notes for `sites/map` (data + engines). Pipeline: `sites/map/build/README.md`;
schema: `sites/map/SCHEMA.md`; sources/licences: `sites/map/SOURCES.md`.

## Data snapshot

| Region | Source | Snapshot |
|---|---|---|
| US Northeast | Geofabrik `us-northeast-latest.osm.pbf` (1.81 GB) | 2026-11-14T21:20Z |
| Greater London | Geofabrik (130 MB) | 2026-11-14 |
| San Francisco | BBBike (33 MB, cut to bbox) | 2026-11-07 |
| Singapore | BBBike (39 MB, cut to bbox) | 2026-11-07 |
| Mackinac Straits (MI) | Overpass API bbox (geocoder only, for task 425) | 2026-11-14 |

Merged input `all.osm.pbf`: 1.92 GB.

## Outputs (`$WSB_DATA_ROOT/map/`)

| Part | Size | Content |
|---|---|---|
| `tiles/map.mbtiles` | 1.53 GB | 249k vector tiles, OpenMapTiles schema, z0-14, only inside the region outlines |
| `static/` | 0.10 GB | OSM Bright style, Noto Sans R/B/I glyphs (CJK ranges included for Singapore), sprites |
| `geocode.db` | 1.71 GB | 2.57M searchable places (1.38M POIs, 1.11M streets, 45k admin/place rows, postcodes), 12.3M house numbers (incl. 143k from addr:interpolation), 2.1M street way geometries |
| `route/` | 2.06 GB | 11.7M nodes, 15.1M base edges, 52.8M geometry points; car CH (8.6M nodes, 16.4M+16.4M upward arcs); bike/foot durations (A*) |
| **total** | **5.4 GB** | |

Shrinking done so far: FTS5 `detail=column` without prefix indexes, house numbers in a
WITHOUT ROWID table clustered by street (street postcode/combo inherited), no reverse grid
(reverse uses street ways), no CH for bike/foot (A* is exact and fast enough: saved ~1.6 GB).
Further options if needed: delta-encode `geom.bin` (~-200 MB), drop `car.edgew` weights
(~-120 MB), drop interpolated house numbers.

## Build timings (8-core box shared with 4 other builders, load average 25-35)

| Step | Time |
|---|---|
| Geofabrik us-northeast download (1.81 GB, shared bandwidth) | ~45 min |
| `prepare.py` (cut SF/London/Singapore, merge, 1.92 GB) | ~10 min |
| planetiler tiles (4 threads, -Xmx16g) | 1 h 43 min (pass1 6 min, pass2 55 min, archive 34 min) |
| `route_extract` (C++/libosmium) | ~3 min (7.17M routable ways, 63.7M way-nodes) |
| `graph` base graph + grid | 3 min; car CH 12 min (bike/foot CH were 28 / 37 min before switching them to A*) |
| `geocode_extract.py` (pyosmium) | 2 h 39 min (24M objects; Python-bound, the slowest step) |
| `build_geocode.py` | 28-33 min, peak RSS ~25 GB |

## Geocoder: WebArena task places -> top hit

`node build/check_places.js` (map view centred on CMU, as the WebArena map starts there).
"ok" = the expected name is in the top hit's display_name. Query latency on the loaded box:
median ~25 ms, p90 ~170 ms.

| Query | Top hit (display_name, class/type) | OK | ms | Tasks |
|---|---|---|---|---|
| Carnegie Mellon University | Carnegie Mellon University, Forbes Avenue, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/university) | ok | 12 | 7 8 17 19 20 36 52 54 70 74 80 151 218 363 370 428 737 |
| Pittsburgh International Airport | Pittsburgh International Airport, Findlay Township, Allegheny County, Pennsylvania, 15108, United States (aeroway/aerodrome) | ok | 11 | 7 9 32 38 80 219 255 |
| Carnegie Museum of Art | Carnegie Museum of Art, 4400, Forbes Avenue, Panther Hollow, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (tourism/gallery) | ok | 7 | 9 56 256 |
| Niagara Falls International Airport | Niagara Falls International Airport, 2035, Niagara Falls Boulevard, Town of Niagara, Niagara County, New York, 14304, United States (aeroway/aerodrome) | ok | 31 | 10 |
| Buffalo Niagara International Airport | Buffalo-Niagara International Airport, Town of Cheektowaga, Erie County, New York, 14225, United States (aeroway/aerodrome) | ok | 24 | 10 |
| Niagara Falls | City of Niagara Falls, Niagara County, New York, United States (boundary/administrative) | ok | 19 | 10 140 |
| 5000 Fifth Avenue, Pittsburgh | 5000, Fifth Avenue, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (place/house) | ok | 69 | 16 |
| UPMC Family Health Center | UPMC Shadyside Family Health Center, 5215, Centre Avenue, Bloomfield, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (amenity/clinic) | ok | 68 | 16 |
| AMC Waterfront | AMC Waterfront 22, West Bridge Street, West Homestead, Allegheny County, Pennsylvania, 15120, United States (amenity/cinema) | ok | 2 | 17 18 |
| University of Pittsburgh | University of Pittsburgh, 4200, Fifth Avenue, Schenley Farms Historic District, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15260, United States (amenity/university) | ok | 54 | 18 53 54 81 98 151 |
| Carnegie Science Center | Kamin Science Center, 1, Allegheny Avenue, Chateau, Pittsburgh, Allegheny County, Pennsylvania, 15212, United States (tourism/museum) | ok | 44 | 19 87 761 |
| Randyland | Randyland, 1501, Arch Street, Mexican War Streets Historic District, Central Northside, Pittsburgh, Allegheny County, Pennsylvania, 15212, United States (tourism/museum) | ok | 2 | 20 |
| DoubleTree by Hilton Hotel Pittsburgh Airport | DoubleTree by Hilton Hotel Pittsburgh Airport, 8402, University Boulevard, Carnot, Moon Township, Allegheny County, Pennsylvania, 15108, United States (tourism/hotel) | ok | 36 | 32 33 |
| Hyatt Regency Pittsburgh International Airport | Hyatt Regency Pittsburgh International Airport, 1111, Airport Boulevard, Findlay Township, Allegheny County, Pennsylvania, 15231, United States (tourism/hotel) | ok | 32 | 34 35 383 |
| Social Security Administration | Social Security Administration, Crabapple Lane, Williamsburg, North Buffalo Township, Armstrong County, Pennsylvania, 16201, United States (office/government) | ok | 11 | 36 382 |
| police near Carnegie Mellon University | Carnegie Mellon Police Station, 300, South Craig Street, Bellefield, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/police) | ok | 246 | 37 |
| Gates Hillman Centers | Gates and Hillman Centers, Forbes Avenue, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (building/university) | ok | 5 | 37 154 356 |
| Duquesne University | Duquesne University, Academic Walk, Bluff, Pittsburgh, Allegheny County, Pennsylvania, 15219, United States (amenity/university) | ok | 17 | 38 |
| Walmart Pittsburgh | Walmart Pharmacy, Pittsburgh Mills Circle, Harwick, Harmar Heights, Frazer Township, Allegheny County, Pennsylvania, 15084, United States (amenity/pharmacy) | ok | 8 | 39 |
| 5600 Fifth Avenue, Pittsburgh | 5600, Fifth Avenue, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (place/house) | ok | 66 | 39 |
| AMC theatre pittsburgh | - | MISS | 13 | 40 |
| Hobart Street, Pittsburgh | Hobart Street, Squirrel Hill South, Pittsburgh, Allegheny County, Pennsylvania, 15217, United States (highway/secondary) | ok | 111 | 40 |
| Starbucks Craig Street | Starbucks, 428, South Craig Street, Panther Hollow, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/cafe) | ok | 222 | 52 53 74 80 81 83 100 |
| Chatham University | Chatham University, Chapel Hill Road, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15217, United States (amenity/university) | ok | 42 | 55 71 429 |
| Hunt Library | Hunt Library, 4909, Frew Street, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/library) | ok | 39 | 56 58 59 761 |
| University Center | Cohon University Center, 5034, Forbes Avenue, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (building/university) | ok | 247 | 57 |
| Posner Hall | Posner Hall, 4980, Margaret Morrison Street, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (building/university) | ok | 10 | 60 |
| Sorrells Library | Sorrells Library, Hamerschlag Drive, Panther Hollow, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/library) | ok | 6 | 61 |
| Yale University | Yale University, West Campus Drive, West Haven, South Central Connecticut Planning Region, Connecticut, 06516, United States (amenity/university) | ok | 26 | 72 76 140 |
| Columbia University | Columbia University, 116th Street, Morningside Heights, Manhattan Community Board 9, Manhattan, New York County, New York, 10027, United States (amenity/university) | ok | 38 | 73 |
| Apple Store Shadyside | Apple Store, Walnut Street, Shadyside, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (shop/electronics) | ok | 17 | 74 83 250 |
| Massachusetts Institute of Technology | Massachusetts Institute of Technology, Massachusetts Avenue, MIT, Cambridge, Middlesex County, Massachusetts, 02139, United States (amenity/university) | ok | 103 | 75 82 427 |
| Harvard University | Harvard University, John F. Kennedy Street, Riverside, Cambridge, Middlesex County, Massachusetts, 02138, United States (amenity/university) | ok | 35 | 75 76 82 |
| Boston Logan International Airport | Logan International Airport, 1, Harborside Dr, East Boston, Boston, Suffolk County, Massachusetts, 02128, United States (aeroway/aerodrome) | ok | 39 | 75 82 |
| Princeton University | Princeton University, Woodland Way, Princeton, Mercer County, New Jersey, 08540, United States (amenity/university) | ok | 29 | 76 |
| DoubleTree by Hilton New York Downtown | DoubleTree by Hilton, 8, Stone Street, Whitehall, Manhattan Community Board 1, Manhattan, New York County, New York, 10004, United States (tourism/hotel) | ok | 465 | 84 |
| Keens Steakhouse | Keens Steakhouse, 72, West 36th Street, Midtown South, Midtown, Manhattan Community Board 5, Manhattan, New York County, New York, 10018, United States (amenity/restaurant) | ok | 1 | 84 |
| La Quinta Inn Pittsburgh Airport | La Quinta Inn Pittsburgh Airport, University Boulevard, Carnot, Moon Township, Allegheny County, Pennsylvania, 15108, United States (tourism/hotel) | ok | 32 | 85 86 |
| Red Roof Inn Pittsburgh | Red Roof Inn Pittsburgh East Monroeville, 2729, Mosside Boulevard, Monroeville, Allegheny County, Pennsylvania, 15146, United States (tourism/hotel) | ok | 17 | 87 |
| Homewood Suites Southpointe | Homewood Suites by Hilton Pittsburgh-Southpointe, 3000, Horizon Vue Drive, Morganza, Cecil Township, Washington County, Pennsylvania, 15317, United States (tourism/hotel) | ok | 3 | 88 |
| PPG Paints Arena | PPG Paints Arena, 1001, Fifth Avenue, Downtown, Pittsburgh, Allegheny County, Pennsylvania, 15219, United States (leisure/stadium) | ok | 4 | 88 |
| Connecticut | Connecticut, United States (boundary/administrative) | ok | 66 | 89 |
| Pennsylvania | Pennsylvania, United States (boundary/administrative) | ok | 180 | 90 |
| Massachusetts | Massachusetts, United States (boundary/administrative) | ok | 97 | 91 |
| Vermont | Vermont, United States (boundary/administrative) | ok | 64 | 92 |
| New Hampshire | New Hampshire, United States (boundary/administrative) | ok | 217 | 93 |
| Fuku Tea | Fuku Tea, 3800, Forbes Avenue, Oakland, Central Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/cafe) | ok | 5 | 98 |
| 5700 Penn Ave, Pittsburgh | Whole Foods Market, 5700, Penn Avenue, East Liberty, Pittsburgh, Allegheny County, Pennsylvania, 15206, United States (shop/supermarket) | ok | 69 | 99 766 |
| Five Guys | Five Guys, 117, South Bouquet Street, Oakland, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/fast_food) | ok | 25 | 99 |
| Philadelphia | Philadelphia, Philadelphia County, Pennsylvania, United States (boundary/administrative) | ok | 36 | 137 138 287 |
| Pittsburgh | Pittsburgh, Allegheny County, Pennsylvania, United States (boundary/administrative) | ok | 25 | 137 287 424 757 |
| New York | New York, United States (boundary/administrative) | ok | 394 | 138 758 759 |
| Scranton | Scranton, Lackawanna County, Pennsylvania, United States (boundary/administrative) | ok | 17 | 139 |
| Bridgeport | Bridgeport, Greater Bridgeport Planning Region, Connecticut, United States (boundary/administrative) | ok | 17 | 139 |
| New Haven | New Haven, South Central Connecticut Planning Region, Connecticut, United States (boundary/administrative) | ok | 198 | 140 |
| Schenley Park | Schenley Park, Lower Panther Hollow Trail, Squirrel Hill South, Pittsburgh, Allegheny County, Pennsylvania, 15217, United States (leisure/park) | ok | 32 | 152 154 155 |
| REI Pittsburgh | REI, 412, South 27th Street, South Side Flats, Pittsburgh, Allegheny County, Pennsylvania, 15203, United States (shop/outdoor) | ok | 7 | 153 |
| Animal Rescue League of Pittsburgh | Humane Animal Rescue of Pittsburgh, 6926, Hamilton Avenue, Homewood West, Pittsburgh, Allegheny County, Pennsylvania, 15208, United States (amenity/animal_shelter) | ok | 14 | 155 |
| Gardner Steel Conference Center | Gardner Steel Conference Center, 130, Thackeray Street, Schenley Farms Historic District, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15260, United States (building/university) | ok | 43 | 220 |
| Wyndham Pittsburgh University Center | La Quinta Inn Pittsburgh Airport, University Boulevard, Carnot, Moon Township, Allegheny County, Pennsylvania, 15108, United States (tourism/hotel) | MISS | 89 | 220 |
| The Oaklander Hotel | The Oaklander Hotel, 5130, Bigelow Boulevard, Schenley Farms Historic District, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15260, United States (tourism/hotel) | ok | 6 | 220 |
| post office near Carnegie Mellon University | Oakland Post Office, 347, South Bouquet Street, Panther Hollow, Central Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/post_office) | ok | 186 | 221 |
| Cold Stone Creamery | Cold Stone Creamery, 5800, Forbes Avenue, Squirrel Hill, Squirrel Hill South, Pittsburgh, Allegheny County, Pennsylvania, 15217, United States (amenity/ice_cream) | ok | 18 | 222 |
| McDonald's | McDonald's, 3708, Forbes Avenue, Oakland, Central Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/fast_food) | ok | 51 | 223 |
| Wendy's | Wendy's, 5422, Baum Boulevard, Bloomfield, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (amenity/fast_food) | ok | 27 | 224 |
| Schiller's Pharmacy | Schiller's Pharmacy, 811, S. Aiken Ave, Shadyside, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (amenity/pharmacy) | ok | 6 | 236 |
| Sunoco Craig Street | Sunoco, 195, North Craig Street, Bellefield, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/fuel) | ok | 224 | 237 |
| Carnegie Mellon Café | Carnegie Mellon Café, Margaret Morrison Street, Squirrel Hill North, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/restaurant) | ok | 13 | 248 253 |
| Western Pennsylvania Hospital Heliport | West Penn Hospital Heliport, Liberty Avenue, Bloomfield, Pittsburgh, Allegheny County, Pennsylvania, 15224, United States (aeroway/helipad) | ok | 509 | 249 |
| Western Pennsylvania Hospital | West Penn Hospital, 4800, Friendship Avenue, Bloomfield, Pittsburgh, Allegheny County, Pennsylvania, 15224, United States (amenity/hospital) | ok | 406 | 254 |
| Tokyo Japanese Food Store | Tokyo Japanese Food Store, 5855, Ellsworth Avenue, Shadyside, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (shop/supermarket) | ok | 24 | 252 257 765 |
| Acadia National Park | Acadia National Park, Hadlock Pond Road, Mount Desert, Hancock County, Maine, 04609, United States (leisure/nature_reserve) | ok | 32 | 265 266 267 268 |
| Boston | Boston, Suffolk County, Massachusetts, United States (boundary/administrative) | ok | 41 | 265 759 |
| Portland, Maine | University of Southern Maine Portland Campus, 96, Falmouth Street, Oakdale, Portland, Cumberland County, Maine, 04103, United States (amenity/university) | ok | 63 | 266 758 |
| Bangor | Bangor, Penobscot County, Maine, United States (boundary/administrative) | ok | 18 | 267 |
| Vinalhaven | Vinalhaven, Knox County, Maine, United States (boundary/administrative) | ok | 2 | 268 |
| Independence Hall | Independence Hall, 520, Chestnut Street, Society Hill, Center City, Philadelphia, Philadelphia County, Pennsylvania, 19106, United States (tourism/museum) | ok | 5 | 356 |
| Carnegie Music Hall | Carnegie Music Hall, 4400, Forbes Avenue, Panther Hollow, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/theatre) | ok | 18 | 363 365 369 380 381 |
| UPMC Shadyside | UPMC Shadyside, 5230, Centre Avenue, Shadyside, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (amenity/hospital) | ok | 1 | 364 365 366 |
| CVS | CVS Pharmacy, 4610, Centre Avenue, Bellefield, North Oakland, Pittsburgh, Allegheny County, Pennsylvania, 15213, United States (amenity/pharmacy) | ok | 39 | 366 367 |
| Piada | Piada, Babcock Boulevard, Keown Station, Ross Township, Allegheny County, Pennsylvania, 15237, United States (amenity/restaurant) | ok | 1 | 371 |
| Costco | Costco, 501, Waterfront Drive West, West Homestead, Allegheny County, Pennsylvania, 15120-5009, United States (shop/wholesale) | ok | 16 | 372 |
| Whole Foods Market | Whole Foods Market, 5700, Penn Avenue, East Liberty, Pittsburgh, Allegheny County, Pennsylvania, 15206, United States (shop/supermarket) | ok | 33 | 373 766 |
| CMU ArtPark Lab | - | MISS | 4 | 377 |
| US Citizenship and Immigration Services | US Citizenship and Immigration Services, 1543, Atwood Avenue, Johnston, Providence County, Rhode Island, 02919, United States (office/government) | ok | 40 | 382 |
| Giant Eagle | Giant Eagle, 5550, Centre Avenue, Shadyside, Pittsburgh, Allegheny County, Pennsylvania, 15232, United States (shop/supermarket) | ok | 13 | 383 767 |
| ALDI | Aldi, 5631, Baum Boulevard, Friendship, Pittsburgh, Allegheny County, Pennsylvania, 15206, United States (shop/supermarket) | ok | 22 | 383 |
| Mackinac Bridge | Mackinac Bridge, Michigan, United States (man_made/bridge) | ok | 4 | 425 |
| Somerset County, Pennsylvania | Somerset County, Pennsylvania, United States (boundary/administrative) | ok | 387 | 426 |
| Flight 93 National Memorial | Flight 93 National Memorial, Stonycreek Township, Somerset County, Pennsylvania, United States (leisure/park) | ok | 15 | 426 |
| Washington & Jefferson College | Washington & Jefferson College, East Beau Street, Washington, Washington County, Pennsylvania, 15301, United States (amenity/university) | ok | 148 | 430 |
| Wells Fargo Center | Xfinity Mobile Arena, 3601, South Broad Street, South Philadelphia, Philadelphia, Philadelphia County, Pennsylvania, 19148, United States (leisure/stadium) | ok | 35 | 737 |
| Yankee Stadium | Yankee Stadium, 1, East 161st Street, The Bronx, Bronx County, New York, 10451, United States (leisure/stadium) | ok | 20 | 739 |
| Madison Square Garden | Madison Square Garden, 4, Pennsylvania Plaza, Chelsea District, Manhattan Community Board 5, Manhattan, New York County, New York, 10001, United States (tourism/attraction) | ok | 44 | 740 |
| TD Garden | TD Garden, 100, Legends Way, West End, Boston, Suffolk County, Massachusetts, 02114, United States (leisure/stadium) | ok | 36 | 741 |
| Allentown | Allentown, Pittsburgh, Allegheny County, Pennsylvania, United States (boundary/administrative) | ok | 20 | 760 |
| Hoboken | Hoboken, Hudson County, New Jersey, United States (boundary/administrative) | ok | 12 | 760 |
| Carnegie Hall | Carnegie Hall, West 56th Street, Columbus Circle, Manhattan Community Board 5, Manhattan, New York County, New York, 10019, United States (amenity/arts_centre) | ok | 7 | 762 |
| 401 Shady Ave, Pittsburgh | Kenmawr Apartments, 401, Shady Avenue, Shadyside, Pittsburgh, Allegheny County, Pennsylvania, 15206, United States (building/apartments) | ok | 64 | 763 764 765 766 767 |
| Trader Joe's | Trader Joe's, 6343, Penn Avenue, East Liberty, Pittsburgh, Allegheny County, Pennsylvania, 15206, United States (shop/supermarket) | ok | 14 | 763 |
| Target Pittsburgh | Target, 6231, Penn Avenue, East Liberty, Pittsburgh, Allegheny County, Pennsylvania, 15206-3978, United States (shop/supermarket) | ok | 9 | 764 |

98/101 top hits as expected

Not found (open issues): *AMC theatre pittsburgh* (the cinema is "AMC Waterfront 22" in West
Homestead; the query words "theatre"/"pittsburgh" are not in its name/address; Nominatim behaves
the same), *Wyndham Pittsburgh University Center* (not in current OSM), *CMU ArtPark Lab* (not in OSM).

Renamed since the WebArena snapshot; old names added by `build/aliases.json` so the task wording
still finds them: Carnegie Science Center -> **Kamin Science Center**, Animal Rescue League of
Pittsburgh -> **Humane Animal Rescue of Pittsburgh**, Wells Fargo Center -> **Xfinity Mobile Arena**
(old_name already in OSM), University Center (CMU) -> **Cohon University Center**, plus
"Western Pennsylvania Hospital Heliport" and "DoubleTree by Hilton New York Downtown".

Display-name differences vs WebArena's Nominatim that matter for task conversion:
- WebArena's import lacked the Pennsylvania state boundary, so its PA addresses have no
  "Pennsylvania" (e.g. task 7 expects `Pittsburgh International Airport, Southern Beltway, Findlay
  Township, Allegheny County, 15231, United States`); ours include the state. Postcodes of objects
  without `addr:postcode` come from the nearest house number (PIT airport: 15108, WebArena 15231).
- Neighbourhood names follow current OSM (e.g. Starbucks on Craig St is now "Panther Hollow, North
  Oakland", WebArena "Bellefield"); Fuku Tea is at 3800 Forbes (WebArena 3716).
- Answers that depend on such details must be re-derived on the lite data during conversion.

## Routing sanity checks vs WebArena (OSRM) answers

`node build/check_routes.js` (endpoints geocoded with the queries in the table).

| Task | From -> To | Mode | WebArena | Lite | ms |
|---|---|---|---|---|---|
| 16 | 5000 Fifth Avenue, Pittsburgh -> UPMC Family Health Center | car | 2min | 2 min, 1.2km | 236 |
| 16 | 5000 Fifth Avenue, Pittsburgh -> UPMC Family Health Center | foot | 16min | 14 min, 1.2km | 13 |
| 17 | AMC Waterfront -> Carnegie Mellon University | car | 13min | 15 min, 7.6km | 8 |
| 17 | AMC Waterfront -> Carnegie Mellon University | foot | 1h 35min | 1h 22min, 6.8km | 15 |
| 18 | AMC Waterfront -> University of Pittsburgh | car | 15min | 16 min, 9.0km | 5 |
| 19 | Carnegie Science Center -> Carnegie Mellon University | car | 12min | 12 min, 8.3km | 3 |
| 19 | Carnegie Science Center -> Carnegie Mellon University | foot | 1h 44min | 1h 29min, 7.5km | 21 |
| 20 | Randyland -> Carnegie Mellon University | car | 13min | 14 min, 9.9km | 7 |
| 20 | Randyland -> Carnegie Mellon University | foot | 1h 45min | 1h 32min, 7.7km | 18 |
| 52 | Carnegie Mellon University -> Starbucks Craig Street | foot | 7 min | 7 min, 563m | 4 |
| 53 | University of Pittsburgh -> Starbucks Craig Street | foot | 18 min | 12 min, 1.0km | 5 |
| 54 | Carnegie Mellon University -> University of Pittsburgh | foot | 25 min | 19 min, 1.6km | 7 |
| 56 | Carnegie Museum of Art -> Hunt Library | foot | 11 min | 11 min, 884m | 5 |
| 84 | DoubleTree by Hilton New York Downtown -> Keens Steakhouse | car | 14 minutes | 14 min, 9.1km | 4 |
| 85 | La Quinta Inn Pittsburgh Airport -> Carnegie Mellon University | car | 30 minutes | 32 min, 31km | 4 |
| 86 | La Quinta Inn Pittsburgh Airport -> University of Pittsburgh | car | 29 minutes | 30 min, 31km | 4 |
| 88 | Homewood Suites Southpointe -> PPG Paints Arena | car | 34 minutes | 34 min, 33km | 3 |
| 97 | Carnegie Mellon University -> Massachusetts Institute of Technology | car | 914km | 11h 34min, 913km | 31 |
| 137 | Philadelphia -> Pittsburgh | car | 5h 47min | 5h 46min, 489km | 17 |
| 138 | New York -> Philadelphia | car | 1h 58min | 2h 5min, 148km | 9 |
| 139 | Scranton -> Bridgeport | car | 3h 20min | 3h 28min, 264km | 10 |
| 140 | Niagara Falls, New York -> New Haven | car | 8h 33min | 8h 50min, 689km | 15 |
| 151 | Carnegie Mellon University -> University of Pittsburgh | car | 4min | 4 min, 1.8km | 2 |
| 152 | Schenley Park -> University of Pittsburgh | car | 4min | 6 min, 2.8km | 3 |
| 153 | REI Pittsburgh -> Carnegie Mellon University | car | 7min | 8 min, 3.6km | 2 |
| 155 | Animal Rescue League of Pittsburgh -> Schenley Park | car | 9min | 9 min, 4.8km | 2 |
| 265 | Boston -> Acadia National Park | car | 457km | 5h 41min, 422km | 12 |
| 267 | Bangor -> Acadia National Park | car | 1h 23min | 1h 18min, 74km | 4 |
| 268 | Vinalhaven -> Acadia National Park | bike | 10h 33min | 10h 13min, 158km | 24 |
| 287 | Pittsburgh -> Philadelphia | car | 5h 47min | 5h 46min, 489km | 9 |
| 363 | Carnegie Mellon University -> Carnegie Music Hall | foot | 748m | 9 min, 780m | 4 |
| 364 | Carnegie Mellon University -> UPMC Shadyside | foot | 1.7km | 19 min, 1.5km | 4 |
| 365 | Carnegie Music Hall -> UPMC Shadyside | foot | 2.2km | 23 min, 1.9km | 6 |

Car durations are within ~10 % of WebArena's OSRM for city and long trips (Pittsburgh ->
Philadelphia 5h 46min vs 5h 47min; Vinalhaven -> Acadia by bike incl. the Rockland ferry
10h 13min vs 10h 33min). Walking times are 10-20 % shorter than WebArena's: OSRM's
foot profile is also 5 km/h, but our routes use more footpaths/shortcuts through campus.
Distances differ where the endpoint chosen for a large area (Acadia NP, cities) differs.
Query time: car CH 2-30 ms; foot/bike A* 5-700 ms (160 km bike trip ~0.4 s); engine load
~10 s (2 GB of typed arrays) once per worker.

## Open issues / notes for the UI and task conversion

- The Mackinac Bridge (task 425) is in Michigan; it is in the geocoder (Overpass bbox extract)
  but not in tiles/routing. `regions.json` has the region, so a full rebuild would include it.
- `geocode.js` `search()` result shape follows Nominatim jsonv2 (`display_name`, `address`,
  `extratags`, `boundingbox` = [minlat, maxlat, minlon, maxlon]); house-number results have
  string `place_id`s (`a:<street_id>:<id>`).
- Snapping prefers large (weakly connected) components and retries the next-nearest edges when
  the nearest one is a one-way trap; a strongly-connected-component filter in `graph.cpp` would
  be cleaner.
- Turn penalties (OSRM formula) are added to reported durations but do not steer the search.


## Site UI (sites/map/server.js) -- 2026-11-15

OSM-website-like UI on the kit; URL scheme in `sites/map/ROUTES.md`. Shared DB mode (`geocode.db`
is the kit's base DB, so graders can `/__rl/query` the `places` table); all pages are raw routes
(no tenant lock, no session) because nothing is written. Geocoding runs in a worker pool (3 threads,
`lib/geo-worker.js`) and routing in one worker thread (`lib/route.js`), both per process and shared
by its tenants (`lib/engines.js`, LRU caches for geocoder calls and routes). The ~10 s graph load
starts with the first tenant; routing requests wait for it.

- Server-rendered sidebar is the source of truth (results, place facts, route summary
  `Distance: 33km. Time: 36 min.` with `data-meters`/`data-seconds`, turn list); `public/map.js`
  draws MapLibre from `#map-data` JSON and navigates in place (fetch + swap `#sidebar` + pushState).
- Directions keep OSM's DOM: `div#content select.routing_engines` (index 0 bike, 1 car, 2 foot),
  `[name=route_from]`/`[name=route_to]`; form submits geocode and 302 to
  `/directions?engine=fossgis_osrm_car&route=lat,lon;lat,lon&from=<name>&to=<name>`.
- Fix in `lib/geocode.js` reverse(): area-level results now pick the same-named admin/place row that
  contains the point (was "Oakland, Bergen County, NJ" for Pittsburgh's Oakland).
- **Bike/foot limited to 250 km straight line** (`WSB_MAP_MAX_SLOW_KM`): A* on one worker took ~8 s
  (CMU -> MIT on foot) to ~50 s (500+ km) and stalled every other route of the process. None of the
  WebArena walk/bike tasks is longer (longest: Vinalhaven -> Acadia by bike, ~60 km straight line;
  task 382 USCIS RI -> SSA PA on foot expects N/A anyway).
- Perf (`node test/bench.js`, 2 tenants, box load ~3.5, uncached first pass): concurrency 1 --
  search p50 33 / p95 428 ms, place page p50 4 / p95 10 ms, car route page p95 248 ms, bike p95
  961 ms (259 km), where-is p95 214 ms, tiles p95 3 ms; concurrency 8 -- search p95 ~800 ms,
  routes p95 ~1.2 s (single route worker). Repeats are cached (all p95 < 30 ms). RSS ~3.6 GB per
  process (routing graph ~2.6 GB incl. bike/foot adjacency): run the map with `--workers 1` (or 2)
  and many tenants, not many worker processes.
- Tests: `npm test` (site.test.js: 11 route tests + geocode/route engine tests), `npm run smoke`
  (headless Chrome: tiles render, search CMU, place page, car CMU -> PIT 33km / 36 min, switch to
  foot 29km / 5h 46min, back button, map click -> Where is this?, zero console errors).
- Gaps: no user accounts/notes (read-only site); search ranking depends on the map view centre
  (header from the page script, default CMU), not on the URL; foot/bike > 250 km refused; the
  "Nearby" list on place pages is straight-line; no GPX/export, layers switcher or map keys.

## Cross-site tasks (2026-11-15, tasks/cross)

- Geocoder fix for task 760: "Allentown, PA" now finds the city (Lehigh County) instead of the
  Allentown neighbourhood of Pittsburgh near the CMU view (a qualified settlement name -- exact first
  comma segment on a boundary/place row -- gets 1/3 of the view-proximity bonus). Bare "Allentown"
  is unchanged; `build/check_places.js` top hits are otherwise identical (fixture q -> "Allentown, PA").
  Restart map servers started before 9d3578c to pick it up. The 19 map cross tasks: docs/NOTES-cross.md.
