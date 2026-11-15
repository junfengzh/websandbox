# Store schema (`base.db`)

One SQLite database for the one store with two front ends: the storefront
(`shopping.wa`, WebArena "One Stop Market") and the back office
(`shopping-admin.wa`, WebArena Magento admin). DDL: [build/schema.sql](build/schema.sql)
and [build/search.sql](build/search.sql); how it is built: [build/README.md](build/README.md);
data sources: [SOURCES.md](SOURCES.md); measurements and open issues:
[../../docs/NOTES-store.md](../../docs/NOTES-store.md).

## Conventions

- **Values are the Magento values, unchanged**: prices, totals, SKUs, names,
  e-mails, dates, statuses. Product and category names keep Magento's HTML
  entities (`Quest Lumaflex&trade; Band`); render them as HTML, compare
  after unescaping.
- **Money** is `REAL` (Magento `DECIMAL(20,4)`, exact to 4 dp); show 2 dp.
- **Timestamps** are `TEXT 'YYYY-MM-DD HH:MM:SS'` in **UTC**, as Magento stored
  them. Magento displays them in the store timezone
  `store_config['general/locale/timezone']` = `America/New_York`; do the same
  (an order at `2022-03-02 11:01:12` UTC shows as Mar 2, 2022 6:01 AM).
- **Codes** follow Magento so that UI labels match the originals:
  `products.status` 1 enabled / 2 disabled; `products.visibility`
  1 not visible individually / 2 catalog / 3 search / 4 catalog+search;
  order `state`/`status` strings (`pending`, `processing`, `complete`,
  `canceled`, `closed`, `holded`, ...; labels in `order_statuses`);
  `reviews.status` `approved` / `pending` / `not_approved`;
  newsletter status 1 subscribed / 2 not active / 3 unsubscribed / 4 unconfirmed;
  `customers.gender` 1 male / 2 female / 3 not specified.
- `source` column: `'shop'` = row from WebArena `shopping` (One Stop Market),
  `'admin'` = row from WebArena `shopping_admin` (Luma). `source_id` on
  products/orders is the Magento entity id in that store.
- Booleans are `INTEGER` 0/1. JSON blobs (`options_json`, `conditions_json`,
  `additional_information`) are Magento's JSON, unchanged.
- No foreign-key constraints are declared (bulk-load speed, tenant writes);
  `build/verify.py` checks every reference listed in it.

## IDs and renumbering

Both stores numbered everything from 1. Rule: **admin (Luma) IDs are kept**
(the admin tasks put product, order, review, CMS page and theme IDs in URLs);
**shop IDs are shifted** by a fixed offset where they would collide, unless the
row is merged with an admin row by natural key. Every changed ID is in
`id_map(source, entity, old_id, new_id)`; offsets are in `build_info`
(`offset.shop.<entity>`).

| Entity | admin | shop | merge rule |
|---|---|---|---|
| products | kept (1-2040) | +10000 | - (SKUs and url keys are disjoint) |
| categories | kept; Luma top levels moved under a new **Luma Apparel** department (`build_info.luma_department_category_id`) | +100 | 1 Root Catalog, 2 Default Category shared; `url_path` kept exactly |
| orders (`id`) | kept (1-308) | +1000 (WebArena 170 → 1170) | - |
| order numbers (`increment_id`) | kept `000000001`-`000000308` | +1000, same width: `000000170` → `000001170` | entity `order_increment_id` in id_map |
| order items/addresses/payments/history, invoices, shipments, credit memos | kept | offset per table (see build_info) | - |
| customers | kept (1-70) | +100 for new ones | **merged by e-mail**: 25 of the 27 shop customers are the same people as admin customers (same names, e-mails, addresses); they become one account with the admin ID (shop `emma.lopez@gmail.com` 27 → 70). The shop password hash is kept for merged accounts (storefront logins). |
| customer addresses | kept | +100; identical addresses of merged customers are deduplicated | |
| reviews | kept (1-351) | +1000 | - |
| attribute options | kept | +1000 | merged by (attribute, label) |
| CMS pages / blocks | kept (page 1-6) | +10 | same identifier: admin keeps it, the shop page gets `<identifier>-shop` (`cms_page_identifier` in id_map) |
| search terms | kept | +1000 | merged by query text (popularity summed) |
| sales / catalog rules, coupons | kept | offset | - |
| admin users | kept | merged by username | |

## Tables

### Meta
- `store_config(path, value)`: merged Magento `core_config_data` (admin wins);
  every source value also under `source.<src>.<path>`. Secrets were never exported.
- `id_map(source, entity, old_id, new_id)`; `build_info(key, value)`.
- `countries(id ISO2, iso3, name)`, `regions(id, country_id, code, name)`.

### Catalog
- `categories`: tree via `parent_id` / `path` ('1/2/45/46') / `level`;
  `url_path` (unique) is the storefront URL `/<url_path>.html`
  (e.g. `video-games/playstation-4/accessories`). `is_anchor` categories list
  the products of all descendants.
- `products`: one row per Magento product (simple, configurable, bundle,
  grouped, virtual). Typed columns: `sku` (unique), `type`, `name`,
  `url_key` (storefront URL `/<url_key>.html`), `status`, `visibility`, `price`,
  `special_price`/`special_from`/`special_to`, `cost`, `msrp`, `weight`,
  `description` (HTML), `short_description`, `meta_*`, `brand`, `color`,
  `size` (+ `*_option_id`), stock (`qty`, `is_in_stock`, `manage_stock`,
  `min_qty`, `notify_stock_qty`, `min_sale_qty`, `max_sale_qty`,
  `backorders`), `created_at`, `updated_at`.
  - shop `description` is the Amazon HTML **shrunk** (attributes, scripts,
    images and empty wrappers removed; visible text kept); `brand` for shop
    products is lifted from the description's product-details table (Brand,
    else Manufacturer). Luma products have no brand.
  - Configurable products have no own price in Magento; the price shown is the
    minimum of the children's prices.
- `attributes(code, label, input, ..., is_variant_axis, typed_column)`: every
  product attribute; `typed_column` names the `products` column holding it.
  `spec_*` attributes (shop) come from the description's product-details
  table (`spec_product_dimensions`, `spec_item_model_number`, `spec_asin`, ...).
- `attribute_options(id, attribute_code, label, position, swatch)`.
- `product_attributes(product_id, attribute_code, value, option_id)`: the long
  tail (Luma `material`, `pattern`, `climate`, `eco_collection`, `sale`, `new`,
  ...; shop `spec_*`). Multiselects have one row per option.
- `product_categories(product_id, category_id, position)`.
- Configurables: `product_variant_axes(product_id, attribute_code, position,
  label)` (e.g. size, color) and `product_variants(parent_id, child_id)`; the
  children are ordinary `products` rows (visibility 1) carrying `size`/`color`.
- `product_links(product_id, linked_product_id, link_type related|upsell|crosssell|grouped)`.
- `bundle_options`, `bundle_selections`; `tier_prices`.
- Custom options (the shop's "Color"/"Size"/... radio choices on simple
  products): `product_options(id, product_id, title, type, ...)`,
  `product_option_values(id, option_id, title, sku, price, ...)`.
- `product_images(id, product_id, file, orig_path, position, label, disabled,
  is_base, is_small, is_thumbnail, is_swatch, width, height, bytes)`: `file`
  is relative to `media/` (`product/shop/B/0/B071GML3JS.0.webp`), NULL when
  the original image does not exist.
- `stock_reservations(sku, quantity, metadata)`: Magento MSI reservations;
  salable qty = `qty + sum(quantity)`.
- `url_rewrites(request_path, entity_type, entity_id, target_path,
  redirect_type, category_id)`: Magento's URL table (store view 1) with IDs
  remapped; use it to resolve legacy paths and 301s.

### Search (`build/search.sql`)
- `product_search`: FTS5 **external-content** table over `products`
  (`name, brand, category_names, sku, description`; porter, prefix 2/3),
  rowid = `products.id`; rank `bm25(product_search, 10, 5, 3, 2, 1)`.
  `products.category_names` is a search-only column kept current by triggers
  on `product_categories` / `categories.name`.
- `product_search_tri`: FTS5 trigram (`name, sku`, external content) for
  substring fallbacks.
- Triggers keep both in sync with `products`; filter results with
  `status = 1 AND visibility IN (3,4)`.
- Example: `SELECT p.* FROM product_search s JOIN products p ON p.id = s.rowid
  WHERE product_search MATCH ? AND p.status = 1 AND p.visibility IN (3,4)
  ORDER BY bm25(product_search, 10, 5, 3, 2, 1) LIMIT 24`.

### Passwords
`customers.password_hash` and `admin_users.password_hash` are in a format
`kit.auth.verifyPassword` accepts: accounts whose Magento hash matches the
public WebArena demo password (70 of 72 customers incl. emma.lopez, and
`admin`) get a cheap `scrypt$1024$...` hash (deterministic salt); the others
keep their Magento argon2id hash re-encoded as `$argon2id$v=19$m=65536,t=2,p=1$...`
(same password, ~100 ms to verify). The original Magento value is in
`magento_password_hash`.

### Reviews
- `reviews(id, product_id, customer_id, status, title, detail, nickname, created_at)`.
- `ratings(id, code)` (Quality, Value, Price, Rating) and
  `review_votes(review_id, rating_id, value 1-5, percent)`. WebArena reviews
  carry one vote ("Rating"); the product rating = avg(percent).

### Customers
- `customers` (`email` unique), `customer_groups`, `customer_addresses`
  (`street` may contain newlines for multiple lines), `customer_log`
  (last login).
- `newsletter_subscribers`, `wishlists` / `wishlist_items`, `carts` /
  `cart_items` (active customer quotes with items), `compare_items` (empty),
  `contact_messages` (empty; storefront contact form).

### Sales
- `orders` (`id` used in URLs, `increment_id` shown to people), `order_items`
  (configurable lines have a child row via `parent_item_id`; options in
  `options_json`), `order_addresses` (`address_type` billing|shipping),
  `order_payments`, `order_status_history` (order comments; `entity_name`
  order|invoice|shipment|creditmemo), `order_statuses`, `order_status_states`.
- `invoices`/`invoice_items`, `shipments`/`shipment_items`/`shipment_tracks`
  (`carrier_code`, `title`, `track_number`), `credit_memos`/`credit_memo_items`,
  `sales_comments` (comments on invoices/shipments/credit memos).

### Marketing, content, admin
- `sales_rules` (cart price rules; `conditions_json`/`actions_json`),
  `coupons`, `sales_rule_usage`; `catalog_rules`.
- `search_terms` (`query_text`, `num_results`, `popularity`, ...), `search_synonyms`.
- `cms_pages` (id 1 `no-route` 404, 2 `home`, ...), `cms_blocks`, `themes`
  (1 Magento Blank, 2 backend, 3 Luma).
- `admin_users`, `admin_roles`,
  `admin_role_rules`; `tax_classes`, `tax_rates`, `shipping_table_rates`.

### Reports
Snapshots of each source store's Magento report tables ("Refresh Statistics"),
with `source`: `report_bestsellers` (daily/monthly/yearly),
`report_sales` (orders by period and status), `report_invoiced`,
`report_refunded`, `report_shipping`, `report_tax`, `report_coupons`.
The back office should regenerate reports from `orders`/`order_items` (a job);
the snapshots let task conversion compare with what the original admin showed.
