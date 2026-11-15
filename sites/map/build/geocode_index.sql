CREATE INDEX addresses_street ON addresses(street_id, hn_norm);
CREATE INDEX addresses_cell ON addresses(cell);
CREATE INDEX places_class ON places(class, type);
CREATE INDEX places_osm ON places(osm_type, osm_id);
INSERT INTO places_fts(places_fts) VALUES ('optimize');
ANALYZE;
