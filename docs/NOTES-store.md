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
| product images | 195,383 originals, 5.66 GB (+37 GB Magento resize cache, not used) | 45 referenced, **1 exists** (Luma sample images were never installed; added later from Magento's sample data, see notes) |
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

- `data/store/base.db`: **1.15 GB** (target was 2-3 GB; this is all the data).
  Largest parts: products 372 MB (of which descriptions 251 MB), FTS word
  index 330 MB + trigram 40 MB (external-content, no text copy), reviews
  155 MB, product_attributes + indexes ~75 MB. Shop descriptions shrank from
  1.44 GB to 251 MB with `htmlclean.py` (attributes/scripts/images/empty
  wrappers removed; visible text and table structure kept). Rollback-journal
  mode, ANALYZEd, VACUUMed, integrity_check ok.
- `data/store/media/`: **4.5 GB**, 194,635 WebP files (long side <= 600 px,
  q80, libwebp method 2): 194,592 shop product images (4.34 GB, avg 22 KB,
  avg 475x488 px; 0 unreadable), 1 Luma product image, Luma category/CMS
  banners, the One Stop Market logo. Took 55 min with 6 processes on the
  shared box.
- Kept intermediates: `work/store/raw_admin.db` (5 MB), `raw_shop.db`
  (1.8 GB; lets `transform` re-run without MariaDB). MariaDB containers,
  data-dir copies and mounts are removed.
- Row counts: products 106,408 (shop 104,368 + admin 2,040); categories 342
  (incl. new "Luma Apparel" department, id 404); reviews 309,290; review votes
  304,051; customers 72; customer addresses 71; orders 497; order items 2,174;
  product images 194,645 rows; product attributes 563,938 rows (incl. 120
  `spec_*` attributes from the Amazon product-details tables); product options
  68,584 / values 425,384; URL rewrites 104,902; id_map 414,124.
- `verify.py`: all row counts match the sources, 0 dangling references, unique
  url keys / url paths / order numbers / e-mails, FTS integrity-check ok,
  every image file present, all password hashes kit-verifiable, 30 task spot
  checks pass (123 checks in total).

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
8. Search: external-content FTS5 over `products` (porter, prefix 2/3) on
   name, brand, category_names, SKU, description (weights 10/5/3/2/1), plus a
   trigram index on name + SKU; triggers keep both in sync inside the tenant
   transaction (kit convention).
9. Passwords: kit.auth cannot verify Magento's `hash:salt:3_32_2_67108864`.
   Accounts whose hash matches the public WebArena demo password (70 of 72
   customers incl. emma.lopez, and admin) get a cheap kit `scrypt$` hash
   (deterministic salt); the other 2 customers keep their argon2id hash
   re-encoded as a PHC string (verifiable, ~100 ms). The candidate passwords
   are read from WebArena's `browser_env/env_config.py`, not stored in this
   repo; the original hash is kept in `magento_password_hash`.

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

- ~~No Luma product images~~: the admin image never had the sample images
  (1 of 45 referenced files exists); fixed by the `luma-images` build step
  (Magento sample data), see below.
- Shop descriptions of the default store view were `This is the description
  placeholder for the product` at store 0; the store-1 (storefront) HTML is
  what is kept (what the storefront showed).
- No shipment tracks, almost no invoices/credit memos in the sources: back
  office invoice/ship/credit-memo flows start from near-empty tables (tasks
  create them).
- `fraud` / `holded` statuses exist as definitions only (task 676 "suspected
  fraud" has no matching orders in either source).
- The image step is CPU-bound (~1,000-3,500 images/min depending on box
  load); it is resumable (existing WebP files are reused).
- Search relevance is untuned (e.g. "usb wifi" ranks a TV box first);
  tune per §3.5 with the search tasks (274-278, 324-328) when the storefront
  exists. Magento's own search showed different result sets; tasks whose
  answers came from Magento search results (e.g. 124 price range of
  "wireless earphone") must be re-derived.

## Storefront (2026-11-15)

Server and routes: `sites/store/server.js` (storefront + `/admin` mount, contract at the
top), `sites/store/storefront/`, [../sites/store/ROUTES.md](../sites/store/ROUTES.md).

- **Luma product images: not recoverable from WebArena** (superseded below). The WebArena admin docker tar
  (`shopping_admin_final_0719.tar`, Magento root `/var/www/magento2`) holds only ~100
  md5-named product images (layers `ed902127...`, `3206c30c...`) and no Luma sample files
  (`m/b/mb01-blue-0.jpg` etc.); the shopping tar has none under `m/` either, and the live
  reference admin (:7780) returns a 1692-byte placeholder for every Luma path. Luma products
  render with a "No image" placeholder; base.db/media are unchanged (no image step edit).
- **Luma product images added from Magento's sample data** (2026-11-15). The official
  sample data (github.com/magento/magento2-sample-data, AFL-3.0/OSL-3.0; see
  `sites/store/SOURCES.md`) has the Luma originals (725 files under
  `pub/media/catalog/product/`) and the import fixtures (sku -> base/small/thumbnail/additional
  images). Build step `luma-images` (`sites/store/build/luma_images.py`, idempotent) sparse-clones
  it to `work/store/sample-data/repo`, matches by SKU, converts with `images.convert` (same WebP
  settings) and updates base.db in place: 52 existing gallery rows got a file, 3,364 rows were
  inserted (orig_path set, positions after existing ones, fixture roles where none held);
  717 WebP files, 11 MB. **Coverage: 2,040 of 2,040 Luma products have an image** (147
  configurables, 1,891 simples incl. color-specific child images, the bundle and the grouped
  product). verify.py: 0 failures. Tenant DBs created before this hold their own
  `product_images` ids; reset tenants so new base ids cannot collide.
- **Clock**: `2023-06-12 16:00 UTC` ("Today is 6/12/2023" in the shop tasks). Dates show in
  America/New_York like Magento (order history `6/12/23`, order page "June 12, 2023").
- **Prices**: final price = special price when lower and in its date window; configurables
  show "As low as" the cheapest child. **Catalog price rules are not applied** on the
  storefront: admin rule 2 "Spring sale" (20% off everything for group General from
  2023-05-01) would change every shop price the shop tasks quote.
- **Cart price rules are applied** (one store): the Luma rules "Spend $50 or more - shipping is
  free!" and "20% OFF Every $200-plus purchase!" (both no coupon, all groups) now affect shop
  checkouts, and `H20` works. Orders placed in WebArena's shop had neither; only totals of
  *new* orders differ.
- **Shipping**: Flat Rate $5.00 per item (what all 497 source orders used) and the table rate.
- **Listing performance**: rows of `products` are large (descriptions), so reading 20k of them
  per category page cost 0.5-2 s. `storefront/lib/pindex.js` keeps the listing fields of all
  products and category memberships in process memory (built from base.db at start, ~5-10 s
  on a loaded box, shared by all tenants of a worker); temp triggers on `products`,
  `product_categories`, `product_variants` report each tenant's changes, which are read from
  the tenant DB (cleared at reset). Category rows/facets/sort orders and search results are
  cached per day while the tenant has no catalog changes. Single client, 234 mixed URLs:
  p50 13 ms, p95 80 ms (load average ~6).
- Imported carts (active Magento quotes) keep Magento's `info_buyRequest`; their custom
  option ids are resolved with the shop offset (+10) for display and ordering. Emma's cart
  starts with 3 items, as in WebArena.
- New reviews are `pending` (Magento moderation); new orders `pending`/state `new`, numbered
  after the current maximum (`000001190` is the first new one).

## WebArena shopping tasks (storefront, 2026-11-15)

`tasks/store/webarena-shopping.jsonl` (187 tasks, site `shopping`, login emma.lopez@gmail.com) is
generated by `python3 -I tasks/store/convert_shopping.py` (every change per task is in `changes`);
manual UI runs and negative checks are in `tasks/store/verify-shopping.jsonl` (browse.js + grade.js).
Result: **186 verified, 1 dropped** (368 "find discounted items": the merged store has Luma Sale
categories, a `sale` filter and a home-page Deals block, so the N/A reference no longer holds).

- Grading: answers keep WebArena references where the data is unchanged; data-derived ones have
  `answer_sql` (order counts/totals, spend per period, search/brand price ranges, latest order).
  program_html became SQL: cart, wish list, newest rollout order (`created_at >= '2023-06-12'`),
  review + Rating vote, newsletter row, default billing/shipping address, and the **contact-form
  draft** (storefront autosaves unsent text to the session: `kit_sessions.data $.contact_draft`)
  plus "not submitted" (`contact_messages` empty). Fuzzy (LLM-judge) tasks were judged by hand
  in the log; their negatives need the judge.
- The kit grader now matches numeric must_include refs as whole numbers ("406" not in "406.00"),
  so the converter widens numeric refs (`406 |OR| 406.00`, `1170 |OR| 000001170`).
- Reference corrections (data identical to WebArena; annotations wrong): 50/51 order counts,
  142 (95.23 -> 95.50), 330 (81.31 -> 83.31), 332 (Feb 947.50), 437/438 (wrong SKU of the
  canceled item), 529 (Feb speaker = order 1161 $56.35), 241 (Skin Care Tools max = Atdoriat $529),
  277 (search URL), 325/355 (missing sort direction), 163/165 (non-verbatim joined sentences),
  280 (exact product name). Intents tightened: 118 (show a product page), 124-126 (range of the
  search results), 226-230 (brand or name starts with the brand), 509/510 (best rating among
  >= 5 reviews, ties -> cheapest). Order numbers +1000 in intents/URLs (180, 206, 153 templates).
- Storefront fixes made for the tasks: price range form (`price_from`/`price_to` -> `price=a-b`),
  sorted listings always carry `product_list_dir` (redirect), contact draft autosave, review form
  shows only the "Rating" rating (all imported votes are Rating; Quality/Value/Price were required
  and unused), HTML entities in option values (`75&quot; X 48&quot;`), empty-name countries in
  address selects, `product_images.file` starting with `/` rendered as a URL (admin uploads).
- Known gaps: Reorder adds separate cart rows instead of merging with the imported (Magento
  buyRequest) cart lines of the same product; no rating sort (by design: 792/793 stay N/A).

## Back-office task conversion (2026-11-15)

The 182 WebArena `shopping_admin` tasks: `tasks/store/webarena-admin.jsonl` (generated by
`tasks/store/convert_admin.py`), evidence in `tasks/store/verify-admin.jsonl`. 179 verified by a
manual run through the admin UI (headless Chrome, `tasks/tools/browse.js`) plus a negative check per
template; 3 dropped (2, 5: "best-selling product type" is undefined -- by kind, watches/shorts beat the
reference; 127: "brands among the top search terms" is undefined once the shop's generic search terms
dominate).

- **Store-wide aggregates, re-derived on the merged store (answer_sql, `"$sql"` references)** where the
  admin UI path still answers them: bestsellers (Reports > Bestsellers; 2023 now includes a shop
  detergent), reviews mentioning a term (All Reviews, Review filter: e.g. "disappointed" 6 -> 10,251),
  review counts by status / period (309,290 total), top search terms (hollister, laundry detergent, ...),
  customers by complete orders (Bob Jones 44) and cancellations (John Smith 14), monthly complete orders
  (Orders report, status Complete, store-local months), most recent N orders / last N orders by status,
  newest canceled / complete order, Jane Doe's and Grace Nguyen's newest pending orders (1092, 65).
  Ties are accepted with `|OR|` alternatives; counts >= 1000 also accept thousands commas.
- **Scoped to the Luma Apparel department** where the merged data would change the meaning: products
  with N units left (shop quantities are uniform 0-100, ~1,000 products per value -> "Luma Apparel
  simple products"), dissatisfied customers of "tanks products" (223 shop "tank" products), the blue
  running t-shirts price change (shop running shirts).
- **WebArena reference errors fixed** (data unchanged): 115 (Chloe tank has a 2-star review), 184
  (only Luma simple at qty 0 is Cronus Yoga Pant -33-Blue), 214 (Zing Jump Rope reviews are all
  positive; reference quoted the Ana Running Short), 493 (Grace Nguyen's newest pending order is 65),
  546 (checked the Affirm Water Bottle page), 771 (review 349 is "not impressed", not positive), 772
  (checked a non-existent review 999), 780 (84 + 17 = 101, not 64), 782 (+23%, reference was -23%),
  545 (a verbatim quote of review 282 contains "gamefor").
- State checks read the rows the action writes: product price/status/stock/qty/attributes, variant
  children by size/color label (not by the default name: "Frankie  Sweatshirt" has two spaces), order
  status / comment (+ notified) / shipment track / address, review rows, CMS title (pages 1/11 and 3/13
  share titles in the merged store; either copy passes), sales rule (all four customer groups), and the
  last report shown (`temp.admin_report_runs.last_shown`, dates compared as parsed days).
- Back-office fixes found while running the tasks: customer keyword search matches phone numbers by
  digits (`+1 2058812302`, `555-229-3326`); a new product with an empty SKU takes its name as SKU
  (Magento's form does this in JS; before, the save failed with "This is a required field");
  `admin_local()` / `admin_local_date()` registered on every tenant connection at open (they were
  only registered once a report page ran, so graders on a fresh tenant failed); report runs record
  `last_shown`.
- Build: `product_options(product_id, position)` and `product_option_values(option_id, position)`
  indexes added to `build/schema.sql` and created in place in base.db (0.4 s; the admin's temp
  `admin_popt`/`admin_povr` maps are now left empty). base.db's mtime changed, so servers started
  before this must be restarted (`/__rl/health` reports `baseChanged`).

## Generated tasks (2026-11-15)

`node tasks/store/gen/index.js --seed 1` writes `tasks/store/generated-shopping.jsonl` (site `shopping`,
30 templates, 1,796 tasks: 795 read / 1,001 write) and `tasks/store/generated-admin.jsonl` (site
`shopping_admin`, 37 templates, 1,962 tasks: 1,061 read / 901 write); deterministic per seed, ids
`gen-shopping-*` / `gen-admin-*` (`<template>-NNNN`). Modules: `gen/shopping/*.js`, `gen/admin/*.js`
(one file per family), shared SQL in `gen/lib.js` (final/listing prices, anchor-category listings, ratings,
store-local dates, the storefront's FTS match, fake US addresses). Report templates reuse
`sites/store/admin/lib/reports.js` to pick unique answers. Storefront tasks log in as many different
customers (not only Emma); the guest order lookup runs signed out.

- Self-check at generation (every task, on base.db with the kit grader): answer tasks pass with their
  reference and `answer_sql` reproduces it (no drift), a wrong answer fails; state tasks fail on the
  untouched base data. Samplers reject ties, empty results, substring-ambiguous grid filters (name /
  nickname / brand / ZIP), and storefront color+size pairs where independent filters differ from the
  combination.
- Validation: every template has 2 instances done by hand through the UI (browse.js) + 1 negative,
  graded with grade.js: `tasks/store/verify-generated.jsonl` (4 lines marked `superseded` from runs
  before a template fix). `gen/verified.json` lists the validated templates (task `status`).
- Fixes found while validating: dimension specs graded on the part before ';'; units-bought needs >= 2
  non-canceled orders; search-add-cheapest requires the query words in the cheapest result's name;
  wishlist-most-reviewed brands must be in the Brand facet's top 30; URL key / meta title graded exact;
  search-term stats ask one number (two numbers could be swapped).
- Site fix: under /admin a fresh admin `wsb_sid` (from `/__rl/login`) now wins over a stale
  `wsb_admin_sid` whose session a tenant reset rolled back (before: login page).
- Known: count answers use must_include, so any equal number in the answer passes (phrasings avoid
  echoing numbers, e.g. "five-star"); listing ratings are in a `role=img` aria-label, so text-only
  snapshots show "Rating:" without the percent (product pages show "x.x out of 5"); complete orders have
  no `total_paid`, so credit memos are generated as invoice-then-refund on open orders.
