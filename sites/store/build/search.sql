-- Product search (PLAN §3.5). Two FTS5 tables, rowid = products.id.
--
-- product_search: word index, porter stemming, prefix indexes for autocomplete.
--   Rank with:  bm25(product_search, 10.0, 5.0, 3.0, 2.0, 1.0)
--               (name > brand > categories > sku > description); lower = better.
--   Snippets:   snippet(product_search, 4, '<b>', '</b>', '…', 16)
-- product_search_tri: trigram index on name + sku for substring matches
--   ("lumaflex", "WH-1000") when the word index finds nothing.
-- Rows exist for every product; the storefront filters on
--   products.status = 1 AND products.visibility IN (3, 4)
-- by joining, so enabling/disabling a product needs no reindex.
-- Facets: GROUP BY over the matching rowids joined to products /
-- product_categories / product_attributes.
--
-- Triggers keep both tables in sync with products and product_categories
-- inside the tenant transaction (so ROLLBACK resets the index too). The build
-- indexes HTML-stripped descriptions; runtime edits index the raw description.

CREATE VIRTUAL TABLE product_search USING fts5(
  name, brand, categories, sku, description,
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3');

CREATE VIRTUAL TABLE product_search_tri USING fts5(
  name, sku, tokenize = 'trigram');

-- category names of a product (space separated) for the 'categories' column
CREATE VIEW product_category_names AS
  SELECT pc.product_id, group_concat(c.name, ' ') AS names
  FROM product_categories pc JOIN categories c ON c.id = pc.category_id AND c.level > 1
  GROUP BY pc.product_id;

CREATE TRIGGER products_ai AFTER INSERT ON products BEGIN
  INSERT INTO product_search(rowid, name, brand, categories, sku, description)
    VALUES (new.id, new.name, new.brand,
            (SELECT names FROM product_category_names WHERE product_id = new.id), new.sku, new.description);
  INSERT INTO product_search_tri(rowid, name, sku) VALUES (new.id, new.name, new.sku);
END;

CREATE TRIGGER products_ad AFTER DELETE ON products BEGIN
  DELETE FROM product_search WHERE rowid = old.id;
  DELETE FROM product_search_tri WHERE rowid = old.id;
END;

CREATE TRIGGER products_au AFTER UPDATE OF name, brand, sku, description ON products BEGIN
  DELETE FROM product_search WHERE rowid = old.id;
  DELETE FROM product_search_tri WHERE rowid = old.id;
  INSERT INTO product_search(rowid, name, brand, categories, sku, description)
    VALUES (new.id, new.name, new.brand,
            (SELECT names FROM product_category_names WHERE product_id = new.id), new.sku, new.description);
  INSERT INTO product_search_tri(rowid, name, sku) VALUES (new.id, new.name, new.sku);
END;

CREATE TRIGGER product_categories_ai AFTER INSERT ON product_categories BEGIN
  UPDATE product_search SET categories = (SELECT names FROM product_category_names WHERE product_id = new.product_id)
    WHERE rowid = new.product_id;
END;

CREATE TRIGGER product_categories_ad AFTER DELETE ON product_categories BEGIN
  UPDATE product_search SET categories = (SELECT names FROM product_category_names WHERE product_id = old.product_id)
    WHERE rowid = old.product_id;
END;
