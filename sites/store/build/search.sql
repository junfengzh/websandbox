-- Product search (PLAN §3.5). Two external-content FTS5 tables over `products`
-- (content_rowid = products.id), so the index adds no second copy of the text.
--
-- product_search: word index, porter stemming, prefix indexes for autocomplete.
--   Columns: name, brand, category_names, sku, description.
--   Rank with:  bm25(product_search, 10.0, 5.0, 3.0, 2.0, 1.0)
--               (name > brand > categories > sku > description); lower = better.
--   Snippets:   snippet(product_search, 4, '<b>', '</b>', '…', 16)
--               (description is HTML; prefer snippets of column 0 or strip tags).
-- product_search_tri: trigram index on name + sku for substring matches
--   ("lumaflex", "WH-1000") when the word index finds nothing.
-- Every product is indexed; the storefront filters on
--   products.status = 1 AND products.visibility IN (3, 4)
-- by joining, so enabling/disabling a product needs no reindex.
-- Facets: GROUP BY over the matching rowids joined to products /
-- product_categories / product_attributes.
--
-- products.category_names (space-separated names of the product's categories,
-- level > 1) exists for this index; triggers on product_categories maintain it,
-- and the products triggers below keep both FTS tables in sync inside the
-- tenant transaction (so ROLLBACK resets the index too).

CREATE VIRTUAL TABLE product_search USING fts5(
  name, brand, category_names, sku, description,
  content = 'products', content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2',
  prefix = '2 3');

CREATE VIRTUAL TABLE product_search_tri USING fts5(
  name, sku, content = 'products', content_rowid = 'id', tokenize = 'trigram');

CREATE TRIGGER products_search_ai AFTER INSERT ON products BEGIN
  INSERT INTO product_search(rowid, name, brand, category_names, sku, description)
    VALUES (new.id, new.name, new.brand, new.category_names, new.sku, new.description);
  INSERT INTO product_search_tri(rowid, name, sku) VALUES (new.id, new.name, new.sku);
END;

CREATE TRIGGER products_search_ad AFTER DELETE ON products BEGIN
  INSERT INTO product_search(product_search, rowid, name, brand, category_names, sku, description)
    VALUES ('delete', old.id, old.name, old.brand, old.category_names, old.sku, old.description);
  INSERT INTO product_search_tri(product_search_tri, rowid, name, sku) VALUES ('delete', old.id, old.name, old.sku);
END;

CREATE TRIGGER products_search_au AFTER UPDATE OF name, brand, category_names, sku, description ON products BEGIN
  INSERT INTO product_search(product_search, rowid, name, brand, category_names, sku, description)
    VALUES ('delete', old.id, old.name, old.brand, old.category_names, old.sku, old.description);
  INSERT INTO product_search(rowid, name, brand, category_names, sku, description)
    VALUES (new.id, new.name, new.brand, new.category_names, new.sku, new.description);
  INSERT INTO product_search_tri(product_search_tri, rowid, name, sku) VALUES ('delete', old.id, old.name, old.sku);
  INSERT INTO product_search_tri(rowid, name, sku) VALUES (new.id, new.name, new.sku);
END;

CREATE TRIGGER product_categories_names_ai AFTER INSERT ON product_categories BEGIN
  UPDATE products SET category_names = (
    SELECT group_concat(c.name, ' ') FROM product_categories pc JOIN categories c ON c.id = pc.category_id
    WHERE pc.product_id = new.product_id AND c.level > 1) WHERE id = new.product_id;
END;

CREATE TRIGGER product_categories_names_ad AFTER DELETE ON product_categories BEGIN
  UPDATE products SET category_names = (
    SELECT group_concat(c.name, ' ') FROM product_categories pc JOIN categories c ON c.id = pc.category_id
    WHERE pc.product_id = old.product_id AND c.level > 1) WHERE id = old.product_id;
END;

CREATE TRIGGER categories_names_au AFTER UPDATE OF name ON categories BEGIN
  UPDATE products SET category_names = (
    SELECT group_concat(c.name, ' ') FROM product_categories pc JOIN categories c ON c.id = pc.category_id
    WHERE pc.product_id = products.id AND c.level > 1)
  WHERE id IN (SELECT product_id FROM product_categories WHERE category_id = new.id);
END;
