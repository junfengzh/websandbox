-- websandbox map geocoder schema (see ../SCHEMA.md)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

-- address-part combinations shared by many objects: parts = JSON [[key, name], ...] most specific first
-- (neighbourhood ... state), excluding street/housenumber/postcode/country.
CREATE TABLE combos (
  id INTEGER PRIMARY KEY,
  parts TEXT NOT NULL,
  country TEXT,
  country_code TEXT,
  region TEXT,
  postcode TEXT            -- postcode from a postal_code boundary, if any
);

-- every searchable object: admin areas, places, streets, POIs, postcodes
CREATE TABLE places (
  id INTEGER PRIMARY KEY,
  osm_type TEXT,           -- N / W / R (P = synthetic postcode)
  osm_id INTEGER,
  class TEXT,              -- OSM main key (amenity, shop, highway, boundary, place, ...)
  type TEXT,               -- its value (cafe, university, residential, administrative, city, ...)
  name TEXT,
  housenumber TEXT,
  street TEXT,
  postcode TEXT,
  combo INTEGER,           -- -> combos.id
  display_name TEXT,       -- Nominatim-style "name, housenumber, street, neighbourhood, city, county, state, postcode, country"
  lat REAL, lon REAL,
  minlon REAL, minlat REAL, maxlon REAL, maxlat REAL,
  rank INTEGER,            -- Nominatim-like search rank (4 country .. 16 city .. 26 street .. 30 POI)
  importance REAL,
  extratags TEXT,          -- JSON: opening_hours, website, phone, operator, cuisine, wikipedia, ...
  names TEXT               -- JSON of alternative names (name:en, alt_name, official_name, short_name, brand, ...)
);

-- normalised search text (build/textnorm.py == lib/textnorm.js); contentless, rowid = places.id
CREATE VIRTUAL TABLE places_fts USING fts5(name, addr, cat, content='', prefix='2 3', tokenize='unicode61 remove_diacritics 2');

CREATE VIRTUAL TABLE places_rtree USING rtree(id, minlon, maxlon, minlat, maxlat);

-- house numbers (incl. POIs that have one, and expanded addr:interpolation lines)
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY,
  street_id INTEGER,       -- places.id of the street (NULL if none matched)
  street TEXT,             -- street/place text when it differs from the street row (or no street row)
  housenumber TEXT,
  hn_norm TEXT,
  postcode TEXT,
  combo INTEGER,
  lat REAL, lon REAL,
  place_id INTEGER,        -- places.id of the POI carrying this address, if any
  cell INTEGER,            -- floor((lat+90)/0.002)*200000 + floor((lon+180)/0.002)
  osm TEXT,
  interpolated INTEGER
);

-- named road way geometries for reverse geocoding: coords = int32 lon*1e7, lat*1e7 pairs
CREATE TABLE street_ways (id INTEGER PRIMARY KEY, street_id INTEGER, coords BLOB);
CREATE VIRTUAL TABLE street_ways_rtree USING rtree(id, minlon, maxlon, minlat, maxlat);
