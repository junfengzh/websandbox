-- websandbox store: lite schema (SQLite). Documented in ../SCHEMA.md.
-- Conventions: money REAL (source DECIMAL(20,4), exact to 4 dp); timestamps TEXT
-- 'YYYY-MM-DD HH:MM:SS' in UTC exactly as Magento stored them (store timezone in
-- store_config 'general/locale/timezone'); booleans INTEGER 0/1; `source` is
-- 'shop' (One Stop Market, WebArena shopping) or 'admin' (WebArena shopping_admin, Luma).

PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------- meta
CREATE TABLE store_config (path TEXT PRIMARY KEY, value TEXT);
CREATE TABLE id_map (
  source TEXT NOT NULL, entity TEXT NOT NULL, old_id TEXT NOT NULL, new_id TEXT NOT NULL,
  PRIMARY KEY (source, entity, old_id));
CREATE INDEX id_map_new ON id_map(entity, new_id);
CREATE TABLE build_info (key TEXT PRIMARY KEY, value TEXT);

-- ---------------------------------------------------------------- directory
CREATE TABLE countries (id TEXT PRIMARY KEY, iso3 TEXT, name TEXT);
CREATE TABLE regions (id INTEGER PRIMARY KEY, country_id TEXT, code TEXT, name TEXT);
CREATE INDEX regions_country ON regions(country_id);

-- ---------------------------------------------------------------- catalog
CREATE TABLE categories (
  id INTEGER PRIMARY KEY, parent_id INTEGER, path TEXT, level INTEGER, position INTEGER,
  name TEXT NOT NULL, url_key TEXT, url_path TEXT, is_active INTEGER, include_in_menu INTEGER,
  is_anchor INTEGER, display_mode TEXT, description TEXT, meta_title TEXT, meta_keywords TEXT,
  meta_description TEXT, image TEXT, children_count INTEGER, created_at TEXT, updated_at TEXT,
  source TEXT);
CREATE INDEX categories_parent ON categories(parent_id, position);
CREATE UNIQUE INDEX categories_url_path ON categories(url_path) WHERE url_path IS NOT NULL;

CREATE TABLE attribute_sets (id INTEGER PRIMARY KEY, name TEXT, source TEXT);

-- Product attributes (the long tail beyond the typed columns of `products`).
CREATE TABLE attributes (
  code TEXT PRIMARY KEY, label TEXT, input TEXT,          -- text|textarea|select|multiselect|boolean|price|date|weight|media_image
  backend_type TEXT, is_filterable INTEGER, is_searchable INTEGER, is_comparable INTEGER,
  is_visible_on_front INTEGER, used_in_listing INTEGER, is_variant_axis INTEGER, position INTEGER,
  is_user_defined INTEGER, typed_column TEXT);            -- name of the products column if the value lives there
CREATE TABLE attribute_options (
  id INTEGER PRIMARY KEY, attribute_code TEXT NOT NULL, label TEXT, position INTEGER, swatch TEXT);
CREATE INDEX attribute_options_attr ON attribute_options(attribute_code, position);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,                  -- simple|configurable|bundle|grouped|virtual|downloadable
  attribute_set_id INTEGER,
  name TEXT NOT NULL,
  url_key TEXT,                        -- storefront URL is '/' || url_key || '.html'
  status INTEGER NOT NULL DEFAULT 1,   -- 1 enabled, 2 disabled (Magento codes)
  visibility INTEGER NOT NULL DEFAULT 4, -- 1 not visible individually, 2 catalog, 3 search, 4 catalog+search
  price REAL, special_price REAL, special_from TEXT, special_to TEXT, cost REAL, msrp REAL,
  weight REAL, tax_class_id INTEGER,
  description TEXT, short_description TEXT,
  meta_title TEXT, meta_keywords TEXT, meta_description TEXT,
  brand TEXT,                          -- denormalised display label (manufacturer/brand attribute)
  category_names TEXT,                 -- names of the product's categories (search only; maintained by triggers)
  color TEXT, size TEXT,               -- option labels (variant axes)
  color_option_id INTEGER, size_option_id INTEGER,
  news_from TEXT, news_to TEXT, country_of_manufacture TEXT, gift_message_available INTEGER,
  qty REAL, is_in_stock INTEGER, manage_stock INTEGER, min_qty REAL, notify_stock_qty REAL,
  min_sale_qty REAL, max_sale_qty REAL, backorders INTEGER, low_stock_date TEXT,
  has_options INTEGER, required_options INTEGER,
  created_at TEXT, updated_at TEXT,
  source TEXT, source_id INTEGER);
CREATE INDEX products_url_key ON products(url_key);
CREATE INDEX products_name ON products(name);
CREATE INDEX products_price ON products(price);
CREATE INDEX products_brand ON products(brand);
CREATE INDEX products_vis ON products(status, visibility);

-- Long-tail attribute values: one row per (product, attribute, value);
-- multiselect values have one row per option.
CREATE TABLE product_attributes (
  product_id INTEGER NOT NULL, attribute_code TEXT NOT NULL, value TEXT, option_id INTEGER);
CREATE INDEX product_attributes_p ON product_attributes(product_id, attribute_code);
CREATE INDEX product_attributes_a ON product_attributes(attribute_code, value);

CREATE TABLE product_categories (
  product_id INTEGER NOT NULL, category_id INTEGER NOT NULL, position INTEGER,
  PRIMARY KEY (product_id, category_id));
CREATE INDEX product_categories_c ON product_categories(category_id, position);

-- Configurable products: the axes (super attributes) and the child simple products.
CREATE TABLE product_variant_axes (
  product_id INTEGER NOT NULL, attribute_code TEXT NOT NULL, position INTEGER, label TEXT,
  PRIMARY KEY (product_id, attribute_code));
CREATE TABLE product_variants (
  parent_id INTEGER NOT NULL, child_id INTEGER NOT NULL, PRIMARY KEY (parent_id, child_id));
CREATE INDEX product_variants_child ON product_variants(child_id);

-- related / upsell / crosssell / grouped (grouped = children of a grouped product)
CREATE TABLE product_links (
  product_id INTEGER NOT NULL, linked_product_id INTEGER NOT NULL, link_type TEXT NOT NULL,
  position INTEGER, qty REAL, PRIMARY KEY (product_id, linked_product_id, link_type));

CREATE TABLE bundle_options (
  id INTEGER PRIMARY KEY, product_id INTEGER, title TEXT, type TEXT, required INTEGER, position INTEGER);
CREATE TABLE bundle_selections (
  id INTEGER PRIMARY KEY, option_id INTEGER, product_id INTEGER, selection_product_id INTEGER,
  qty REAL, can_change_qty INTEGER, is_default INTEGER, price_type INTEGER, price_value REAL, position INTEGER);

-- Custom options (e.g. engraving text, dropdown add-ons)
CREATE TABLE product_options (
  id INTEGER PRIMARY KEY, product_id INTEGER, title TEXT, type TEXT, is_require INTEGER,
  sku TEXT, max_characters INTEGER, position INTEGER, price REAL, price_type TEXT);
CREATE TABLE product_option_values (
  id INTEGER PRIMARY KEY, option_id INTEGER, title TEXT, sku TEXT, position INTEGER, price REAL, price_type TEXT);

CREATE TABLE tier_prices (
  id INTEGER PRIMARY KEY, product_id INTEGER, customer_group_id INTEGER, all_groups INTEGER,
  qty REAL, value REAL, percentage_value REAL);

-- Images: files under media/ (WebP, long side <= 600 px)
CREATE TABLE product_images (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, file TEXT,  -- path relative to media/, NULL if missing
  orig_path TEXT,                      -- Magento path under pub/media/catalog/product
  position INTEGER, label TEXT, disabled INTEGER, is_base INTEGER, is_small INTEGER,
  is_thumbnail INTEGER, is_swatch INTEGER, width INTEGER, height INTEGER, bytes INTEGER);
CREATE INDEX product_images_p ON product_images(product_id, position);

-- Inventory reservations (Magento MSI): salable qty = products.qty + sum(quantity)
CREATE TABLE stock_reservations (
  id INTEGER PRIMARY KEY, sku TEXT, quantity REAL, metadata TEXT, source TEXT);
CREATE INDEX stock_reservations_sku ON stock_reservations(sku);

-- Exact Magento URL rewrites (category paths, product paths, CMS pages, redirects)
CREATE TABLE url_rewrites (
  id INTEGER PRIMARY KEY, entity_type TEXT, entity_id INTEGER, request_path TEXT NOT NULL,
  target_path TEXT, redirect_type INTEGER, category_id INTEGER, is_autogenerated INTEGER, source TEXT);
CREATE INDEX url_rewrites_path ON url_rewrites(request_path);
CREATE INDEX url_rewrites_entity ON url_rewrites(entity_type, entity_id);

-- ---------------------------------------------------------------- reviews
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, customer_id INTEGER,
  status TEXT NOT NULL,                -- approved|pending|not_approved
  title TEXT, detail TEXT, nickname TEXT, created_at TEXT, source TEXT);
CREATE INDEX reviews_product ON reviews(product_id, status);
CREATE INDEX reviews_customer ON reviews(customer_id);
CREATE INDEX reviews_created ON reviews(created_at);
CREATE TABLE ratings (id INTEGER PRIMARY KEY, code TEXT, position INTEGER, is_active INTEGER);
-- One row per (review, rating dimension). value 1..5, percent = value*20.
CREATE TABLE review_votes (
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL, rating_id INTEGER, value INTEGER, percent INTEGER);
CREATE INDEX review_votes_review ON review_votes(review_id);

-- ---------------------------------------------------------------- customers
CREATE TABLE customer_groups (id INTEGER PRIMARY KEY, code TEXT, tax_class_id INTEGER);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  prefix TEXT, firstname TEXT, middlename TEXT, lastname TEXT, suffix TEXT,
  dob TEXT, gender INTEGER,            -- 1 male, 2 female, 3 not specified
  taxvat TEXT, group_id INTEGER, is_active INTEGER,
  password_hash TEXT,                  -- kit format: scrypt$ (known WebArena password) or $argon2id$ PHC
  magento_password_hash TEXT,          -- original Magento 'hash:salt:3_32_2_67108864'
  default_billing_id INTEGER, default_shipping_id INTEGER,
  created_at TEXT, updated_at TEXT, created_in TEXT, confirmation TEXT, failures_num INTEGER,
  lock_expires TEXT, source TEXT);
CREATE INDEX customers_name ON customers(lastname, firstname);
CREATE TABLE customer_addresses (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, prefix TEXT, firstname TEXT, middlename TEXT,
  lastname TEXT, suffix TEXT, company TEXT, street TEXT, city TEXT, region TEXT, region_id INTEGER,
  postcode TEXT, country_id TEXT, telephone TEXT, fax TEXT, vat_id TEXT, is_active INTEGER,
  created_at TEXT, updated_at TEXT);
CREATE INDEX customer_addresses_c ON customer_addresses(customer_id);

CREATE TABLE newsletter_subscribers (
  id INTEGER PRIMARY KEY, customer_id INTEGER, email TEXT, status INTEGER, -- 1 subscribed, 2 not active, 3 unsubscribed, 4 unconfirmed
  change_status_at TEXT, confirm_code TEXT);
CREATE INDEX newsletter_customer ON newsletter_subscribers(customer_id);

CREATE TABLE wishlists (id INTEGER PRIMARY KEY, customer_id INTEGER UNIQUE, shared INTEGER, sharing_code TEXT, updated_at TEXT);
CREATE TABLE wishlist_items (
  id INTEGER PRIMARY KEY, wishlist_id INTEGER NOT NULL, product_id INTEGER NOT NULL, qty REAL,
  description TEXT, added_at TEXT, options_json TEXT);
CREATE INDEX wishlist_items_w ON wishlist_items(wishlist_id);

-- Shopping carts (Magento quotes); only customer carts with items are imported.
CREATE TABLE carts (
  id INTEGER PRIMARY KEY, customer_id INTEGER, is_active INTEGER, items_count INTEGER, items_qty REAL,
  subtotal REAL, grand_total REAL, coupon_code TEXT, created_at TEXT, updated_at TEXT, source TEXT);
CREATE INDEX carts_customer ON carts(customer_id, is_active);
CREATE TABLE cart_items (
  id INTEGER PRIMARY KEY, cart_id INTEGER NOT NULL, parent_item_id INTEGER, product_id INTEGER,
  product_type TEXT, sku TEXT, name TEXT, qty REAL, price REAL, row_total REAL, options_json TEXT,
  created_at TEXT, updated_at TEXT);
CREATE INDEX cart_items_cart ON cart_items(cart_id);

CREATE TABLE compare_items (id INTEGER PRIMARY KEY, customer_id INTEGER, visitor_id TEXT, product_id INTEGER, added_at TEXT);
CREATE TABLE contact_messages (id INTEGER PRIMARY KEY, name TEXT, email TEXT, telephone TEXT, comment TEXT, created_at TEXT);

-- ---------------------------------------------------------------- sales
CREATE TABLE order_statuses (status TEXT PRIMARY KEY, label TEXT);
CREATE TABLE order_status_states (status TEXT, state TEXT, is_default INTEGER, visible_on_front INTEGER,
  PRIMARY KEY (status, state));

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,              -- = entity_id (URLs /sales/order/view/order_id/<id>)
  increment_id TEXT NOT NULL UNIQUE,   -- order number shown to people, e.g. '000000299'
  state TEXT, status TEXT,
  customer_id INTEGER, customer_email TEXT, customer_firstname TEXT, customer_lastname TEXT,
  customer_group_id INTEGER, customer_is_guest INTEGER, customer_note TEXT,
  created_at TEXT, updated_at TEXT,
  subtotal REAL, subtotal_incl_tax REAL, discount_amount REAL, discount_description TEXT,
  shipping_amount REAL, shipping_incl_tax REAL, tax_amount REAL, grand_total REAL,
  total_paid REAL, total_due REAL, total_invoiced REAL, total_refunded REAL, total_canceled REAL,
  total_offline_refunded REAL, total_online_refunded REAL,
  subtotal_invoiced REAL, subtotal_refunded REAL, subtotal_canceled REAL,
  shipping_invoiced REAL, shipping_refunded REAL, shipping_canceled REAL,
  total_qty_ordered REAL, total_item_count INTEGER, weight REAL,
  shipping_method TEXT, shipping_description TEXT, payment_method TEXT, coupon_code TEXT,
  applied_rule_ids TEXT, remote_ip TEXT, currency TEXT, store_name TEXT,
  billing_address_id INTEGER, shipping_address_id INTEGER,
  source TEXT, source_id INTEGER);
CREATE INDEX orders_customer ON orders(customer_id, created_at);
CREATE INDEX orders_created ON orders(created_at);
CREATE INDEX orders_status ON orders(status);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, parent_item_id INTEGER, product_id INTEGER,
  product_type TEXT, sku TEXT, name TEXT, options_json TEXT,
  qty_ordered REAL, qty_invoiced REAL, qty_shipped REAL, qty_refunded REAL, qty_canceled REAL,
  price REAL, base_price REAL, original_price REAL, price_incl_tax REAL,
  discount_percent REAL, discount_amount REAL, tax_percent REAL, tax_amount REAL,
  row_total REAL, row_total_incl_tax REAL, amount_refunded REAL, row_invoiced REAL,
  weight REAL, row_weight REAL, applied_rule_ids TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX order_items_order ON order_items(order_id);
CREATE INDEX order_items_product ON order_items(product_id);
CREATE INDEX order_items_sku ON order_items(sku);

CREATE TABLE order_addresses (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, address_type TEXT, customer_address_id INTEGER,
  customer_id INTEGER, prefix TEXT, firstname TEXT, middlename TEXT, lastname TEXT, suffix TEXT,
  company TEXT, street TEXT, city TEXT, region TEXT, region_id INTEGER, postcode TEXT, country_id TEXT,
  telephone TEXT, fax TEXT, email TEXT);
CREATE INDEX order_addresses_order ON order_addresses(order_id);

CREATE TABLE order_payments (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, method TEXT, amount_ordered REAL, amount_paid REAL,
  amount_refunded REAL, amount_canceled REAL, shipping_amount REAL, cc_type TEXT, cc_last_4 TEXT,
  po_number TEXT, additional_information TEXT);
CREATE INDEX order_payments_order ON order_payments(order_id);

CREATE TABLE order_status_history (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, status TEXT, comment TEXT,
  is_customer_notified INTEGER, is_visible_on_front INTEGER, entity_name TEXT, created_at TEXT);
CREATE INDEX order_status_history_order ON order_status_history(order_id, created_at);

CREATE TABLE invoices (
  id INTEGER PRIMARY KEY, increment_id TEXT UNIQUE, order_id INTEGER NOT NULL, state INTEGER, -- 1 open, 2 paid, 3 canceled
  subtotal REAL, discount_amount REAL, shipping_amount REAL, tax_amount REAL, grand_total REAL,
  total_qty REAL, billing_address_id INTEGER, shipping_address_id INTEGER, email_sent INTEGER,
  created_at TEXT, updated_at TEXT);
CREATE INDEX invoices_order ON invoices(order_id);
CREATE TABLE invoice_items (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL, order_item_id INTEGER, product_id INTEGER,
  sku TEXT, name TEXT, qty REAL, price REAL, row_total REAL, discount_amount REAL, tax_amount REAL);
CREATE INDEX invoice_items_inv ON invoice_items(invoice_id);

CREATE TABLE shipments (
  id INTEGER PRIMARY KEY, increment_id TEXT UNIQUE, order_id INTEGER NOT NULL, total_qty REAL,
  total_weight REAL, shipping_address_id INTEGER, billing_address_id INTEGER, email_sent INTEGER,
  created_at TEXT, updated_at TEXT);
CREATE INDEX shipments_order ON shipments(order_id);
CREATE TABLE shipment_items (
  id INTEGER PRIMARY KEY, shipment_id INTEGER NOT NULL, order_item_id INTEGER, product_id INTEGER,
  sku TEXT, name TEXT, qty REAL, price REAL, weight REAL);
CREATE INDEX shipment_items_s ON shipment_items(shipment_id);
CREATE TABLE shipment_tracks (
  id INTEGER PRIMARY KEY, shipment_id INTEGER, order_id INTEGER, carrier_code TEXT, title TEXT,
  track_number TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX shipment_tracks_order ON shipment_tracks(order_id);

CREATE TABLE credit_memos (
  id INTEGER PRIMARY KEY, increment_id TEXT UNIQUE, order_id INTEGER NOT NULL, invoice_id INTEGER,
  state INTEGER, subtotal REAL, discount_amount REAL, shipping_amount REAL, tax_amount REAL,
  adjustment_positive REAL, adjustment_negative REAL, adjustment REAL, grand_total REAL,
  created_at TEXT, updated_at TEXT);
CREATE INDEX credit_memos_order ON credit_memos(order_id);
CREATE TABLE credit_memo_items (
  id INTEGER PRIMARY KEY, credit_memo_id INTEGER NOT NULL, order_item_id INTEGER, product_id INTEGER,
  sku TEXT, name TEXT, qty REAL, price REAL, row_total REAL, discount_amount REAL, tax_amount REAL);
CREATE INDEX credit_memo_items_cm ON credit_memo_items(credit_memo_id);

-- comments attached to invoices / shipments / credit memos
CREATE TABLE sales_comments (
  id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, parent_id INTEGER NOT NULL, comment TEXT,
  is_customer_notified INTEGER, is_visible_on_front INTEGER, created_at TEXT);

-- ---------------------------------------------------------------- marketing
CREATE TABLE sales_rules (
  id INTEGER PRIMARY KEY, name TEXT, description TEXT, is_active INTEGER, from_date TEXT, to_date TEXT,
  customer_group_ids TEXT,             -- comma list
  uses_per_customer INTEGER, uses_per_coupon INTEGER, coupon_type INTEGER, -- 1 no coupon, 2 specific, 3 auto
  use_auto_generation INTEGER, conditions_json TEXT, actions_json TEXT, stop_rules_processing INTEGER,
  sort_order INTEGER, simple_action TEXT, discount_amount REAL, discount_qty REAL, discount_step INTEGER,
  apply_to_shipping INTEGER, simple_free_shipping INTEGER, times_used INTEGER, is_rss INTEGER,
  store_label TEXT, source TEXT);
CREATE TABLE coupons (
  id INTEGER PRIMARY KEY, rule_id INTEGER, code TEXT UNIQUE, usage_limit INTEGER, usage_per_customer INTEGER,
  times_used INTEGER, expiration_date TEXT, is_primary INTEGER, created_at TEXT, type INTEGER);
CREATE TABLE sales_rule_usage (rule_id INTEGER, customer_id INTEGER, times_used INTEGER, PRIMARY KEY (rule_id, customer_id));

CREATE TABLE catalog_rules (
  id INTEGER PRIMARY KEY, name TEXT, description TEXT, is_active INTEGER, from_date TEXT, to_date TEXT,
  customer_group_ids TEXT, conditions_json TEXT, actions_json TEXT, stop_rules_processing INTEGER,
  sort_order INTEGER, simple_action TEXT, discount_amount REAL, source TEXT);

CREATE TABLE search_terms (
  id INTEGER PRIMARY KEY, query_text TEXT NOT NULL UNIQUE, num_results INTEGER, popularity INTEGER,
  redirect TEXT, display_in_terms INTEGER, is_active INTEGER, updated_at TEXT, source TEXT);
CREATE TABLE search_synonyms (id INTEGER PRIMARY KEY, synonyms TEXT);   -- comma list, applied at query time

-- ---------------------------------------------------------------- content
CREATE TABLE cms_pages (
  id INTEGER PRIMARY KEY, identifier TEXT UNIQUE, title TEXT, page_layout TEXT, meta_title TEXT,
  meta_keywords TEXT, meta_description TEXT, content_heading TEXT, content TEXT, is_active INTEGER,
  sort_order INTEGER, created_at TEXT, updated_at TEXT, source TEXT);
CREATE TABLE cms_blocks (
  id INTEGER PRIMARY KEY, identifier TEXT UNIQUE, title TEXT, content TEXT, is_active INTEGER,
  created_at TEXT, updated_at TEXT, source TEXT);
CREATE TABLE themes (id INTEGER PRIMARY KEY, parent_id INTEGER, code TEXT, title TEXT, area TEXT, preview_image TEXT);

-- ---------------------------------------------------------------- admin
CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE, firstname TEXT, lastname TEXT, email TEXT,
  password_hash TEXT, magento_password_hash TEXT, is_active INTEGER, role_id INTEGER, created_at TEXT, updated_at TEXT,
  logdate TEXT, lognum INTEGER, interface_locale TEXT);
CREATE TABLE admin_roles (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER, role_type TEXT); -- G group(role), U user
CREATE TABLE admin_role_rules (role_id INTEGER, resource_id TEXT, permission TEXT);
CREATE TABLE tax_classes (id INTEGER PRIMARY KEY, name TEXT, type TEXT);
CREATE TABLE tax_rates (id INTEGER PRIMARY KEY, country_id TEXT, region_id INTEGER, postcode TEXT, code TEXT, rate REAL);
CREATE TABLE shipping_table_rates (id INTEGER PRIMARY KEY, dest_country_id TEXT, dest_region_id INTEGER,
  dest_zip TEXT, condition_name TEXT, condition_value REAL, price REAL, cost REAL);

-- ---------------------------------------------------------------- reports
-- Snapshots of Magento's report aggregates as each source store last computed them
-- ("Refresh Statistics"). The back office regenerates reports from orders with a job;
-- these are kept so original task answers can be checked.
CREATE TABLE report_bestsellers (
  period_type TEXT, period TEXT, product_id INTEGER, product_name TEXT, product_price REAL,
  qty_ordered REAL, rating_pos INTEGER, source TEXT);
CREATE INDEX report_bestsellers_p ON report_bestsellers(period_type, period);
CREATE TABLE report_sales (                -- sales_order_aggregated_created
  period TEXT, order_status TEXT, orders_count INTEGER, total_qty_ordered REAL, total_qty_invoiced REAL,
  total_income_amount REAL, total_revenue_amount REAL, total_profit_amount REAL, total_invoiced_amount REAL,
  total_canceled_amount REAL, total_paid_amount REAL, total_refunded_amount REAL, total_tax_amount REAL,
  total_tax_amount_actual REAL, total_shipping_amount REAL, total_shipping_amount_actual REAL,
  total_discount_amount REAL, total_discount_amount_actual REAL, source TEXT);
CREATE TABLE report_refunded (period TEXT, order_status TEXT, orders_count INTEGER, refunded REAL,
  online_refunded REAL, offline_refunded REAL, source TEXT);
CREATE TABLE report_invoiced (period TEXT, order_status TEXT, orders_count INTEGER, orders_invoiced INTEGER,
  invoiced REAL, invoiced_captured REAL, invoiced_not_captured REAL, source TEXT);
CREATE TABLE report_shipping (period TEXT, order_status TEXT, shipping_description TEXT, orders_count INTEGER,
  total_shipping REAL, total_shipping_actual REAL, source TEXT);
CREATE TABLE report_tax (period TEXT, code TEXT, order_status TEXT, percent REAL, orders_count INTEGER,
  tax_base_amount_sum REAL, source TEXT);
CREATE TABLE report_coupons (period TEXT, order_status TEXT, coupon_code TEXT, coupon_uses INTEGER,
  subtotal_amount REAL, discount_amount REAL, total_amount REAL, rule_name TEXT, source TEXT);
-- Viewed-products / most-viewed counts if the source kept them
CREATE TABLE report_product_views (product_id INTEGER PRIMARY KEY, views INTEGER);
-- Customer login log (last login / last activity shown in the customer grid)
CREATE TABLE customer_log (customer_id INTEGER PRIMARY KEY, last_login_at TEXT, last_logout_at TEXT);
