CREATE INDEX places_osm ON places(osm_type, osm_id);
INSERT INTO places_fts(places_fts) VALUES ('optimize');
ANALYZE;
