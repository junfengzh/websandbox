# Store: build notes

Builder notes for the store site (`sites/store/`). Schema:
[../sites/store/SCHEMA.md](../sites/store/SCHEMA.md); rebuild:
[../sites/store/build/README.md](../sites/store/build/README.md).

## Sources measured (2026-11-14)

| | shopping (One Stop Market) | shopping_admin (Luma) |
|---|---|---|
| squashfs | 40.8 GB | 1.26 GB |
| DB engine | MariaDB 10.6.12 | MariaDB 10.6.12 |
| MySQL data dir | 3.7 GB | 233 MB |
| `catalog_product_entity_text` | 1.72 GB (descriptions: scraped Amazon HTML, avg 13.8 KB, 1.44 GB in total) | small |
| product images | 195,383 originals, 5.66 GB (+37 GB Magento resize cache, not used) | 45 referenced, **1 exists** (Luma sample images were never installed) |
| products | 104,368 simple (with 68,584 custom "radio" options: Color/Size/...) | 2,040 (147 configurable, 1,891 simple, 1 bundle, 1 grouped) |
| categories | 303 | 40 |
| reviews | 308,939 (all approved) | 351 (346 approved, 5 pending) |
| customers | 27 (25 also in admin) | 70 |
| orders | 189 (`000000001`-`000000189`; 129 complete, 41 canceled, 19 pending) | 308 (`000000001`-`000000308`; 153 complete, 142 canceled, 10 pending, 2 processing, 1 closed) |
| invoices / shipments / credit memos | 0 / 1 / 0 | 2 / 3 / 1 |
| search terms | 117 | 7 |
| CMS pages | 4 | 6 |
| raw SQLite export (`work/store/raw_*.db`) | 1.9 GB | 5 MB |

## Output

- `data/store/base.db`: **1.42 GB** (target was 2-3 GB; this is all the data).
  Largest parts: products 366 MB (of which descriptions 251 MB), FTS 577 MB
  (word index + its content copy), reviews 155 MB, trigram index 55 MB,
  product_attributes + indexes 75 MB. Shop descriptions shrank from 1.44 GB to
  251 MB with `htmlclean.py` (attributes/scripts/images/empty wrappers removed;
  visible text and table structure kept).
- `data/store/media/`: WebP, long side 600 px, q80 (size in the table below once
  the image step has finished).
- Row counts: products 106,408 (shop 104,368 + admin 2,040); categories 342
  (incl. new "Luma Apparel" department, id 404); reviews 309,290; review votes
  304,051; customers 72; customer addresses 71; orders 497; order items 2,174;
  product images 194,645 rows; product attributes 563,938 rows (incl. 120
  `spec_*` attributes from the Amazon product-details tables); product options
  68,584 / values 425,384; URL rewrites 104,902; id_map 414,124.
- `verify.py`: all row counts match the sources, 0 dangling references, unique
  url keys / url paths / order numbers / e-mails, FTS row counts = products,
  30 task spot checks pass.

## Decisions

1. **Renumbering (admin IDs kept, shop shifted).** The admin tasks put admin
   product IDs (~60 tasks), order IDs (299-307, 65, 125), review IDs, CMS page
   IDs and theme IDs in URLs; the shop tasks address products by URL key and
   name, never by ID. So admin keeps every ID and the shop is shifted:
   products +10000, categories +100, reviews +1000, orders +1000 (both `id`
   and `increment_id`: shop order 170 → id 1170, `000001170`). Orders are the
   one real conflict: both stores' tasks quote order numbers (shop: 148, 161,
   170, 178, 180, 187, 189 in ~21 tasks; admin: 1, 2, 65, 125, 299-307 in ~22
   tasks). Admin wins by a small margin and because its invoice numbers and
   URLs (order_id/…) appear in program_html checks. Every change is in
   `id_map`; the shop tasks' order numbers must be rewritten (+1000).
2. **Customers merged by e-mail.** 25 of the 27 shop customers are the same
   people as admin customers (identical names, e-mails, addresses, phones; the
   WebArena authors seeded both stores from one list). One account each, admin
   ID kept (emma.lopez@gmail.com: shop 27 → 70). Identical addresses are
   deduplicated. The shop password hash is kept for merged accounts so
   storefront logins keep working; the admin store's emma has 0 orders, so
   all of Emma's order history is the shop's (37 orders).
3. **Luma as a department.** Luma's top-level categories (Gear, Training, Men,
   Women, Collections, Promotions, Sale, What's New) moved under a new
   `Luma Apparel` category (id 404, `luma-apparel`); every category keeps its
   original `url_path`, so all WebArena category URLs still resolve.
4. **Exact values.** Prices, totals, SKUs, names (incl. HTML entities like
   `&trade;`), e-mails, statuses, dates (UTC as stored) are unchanged. The
   only rewritten text is shop product descriptions (shrunk HTML, same text)
   and form noise in buyRequest JSON (`login`, `form_key` removed from
   wishlist/cart/order item options: one shop wishlist item carried a login
   form with the WebArena demo password).
5. **Brand** for shop products is lifted from the description's details table
   (Brand, else Manufacturer): 86,280 of 104,368 products have one. Luma
   products have none.
6. **Reports**: each store's Magento report aggregates (bestsellers
   daily/monthly/yearly, sales, invoiced, refunded, shipping, tax, coupons) are
   kept as snapshots with `source`; the back office should compute live reports
   from the orders (a job), and task conversion can compare with the
   snapshots.
7. **CMS**: identifiers collide (`home`, `no-route`, ...). Admin pages keep
   identifier and ID (tasks edit pages 1-5); the shop copies are
   `<identifier>-shop` (ids 11-14), e.g. `home-shop` "One Stop Market". The
   storefront home is page 2 `home` (title "Home Page", empty content in
   Luma); the storefront should render its own product showcase there.
8. Search: FTS5 word index (porter, prefix 2/3) over name, brand, category
   names, SKU, HTML-stripped description, weights 10/5/3/2/1, plus a trigram
   index on name + SKU; triggers keep both in sync inside the tenant
   transaction.

## Effects on task conversion

- Shop order numbers +1000 (`id_map` entity `order` / `order_increment_id`):
  e.g. task 358 "order number 187" → 1187; 528-532/653-657 must_include
  `000000180` → `000001180`; start/reference URLs
  `/sales/order/view/order_id/180/` → `/1180/`.
- Store-wide aggregates now include both stores, so these admin answers change
  and must be re-derived by SQL: total review count (351 → 309,290), reviews
  mentioning a term, pending count (unchanged, 5), customer with most orders /
  completed orders / cancellations (e.g. complete orders: Bob Jones 44 now
  leads; was Jane Smith on admin alone), bestsellers, monthly order counts,
  "most recent N orders", order-status counts, search terms (top is still
  `hollister`). The shop's per-customer answers (Emma) are unchanged.
- Admin product, review, order, CMS and theme IDs are unchanged.
- Customer IDs in the shop store changed for everyone (merged); no task
  references customer IDs.

## Open issues / gaps

- **No Luma product images**: the admin image never had the sample images
  (1 of 45 referenced files exists). Luma products render without images
  unless someone adds placeholders.
- Shop descriptions of the default store view were `This is the description
  placeholder for the product` at store 0; the store-1 (storefront) HTML is
  what is kept (what the storefront showed).
- No shipment tracks, almost no invoices/credit memos in the sources: back
  office invoice/ship/credit-memo flows start from near-empty tables (tasks
  create them).
- `fraud` / `holded` statuses exist as definitions only (task 676 "suspected
  fraud" has no matching orders in either source).
- Image step runs ~1,300 images/min on the shared, saturated box (~2.5 h for
  195k); it is resumable (existing WebP files are reused).
