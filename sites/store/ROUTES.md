# Store routes

One server (`server.js`) for both front ends of the one store; both hostnames reach the
same process and tenant (`--bind rl` listens on `127.10.<i>.2` and `127.10.<i>.3`).

- **Storefront** (`shopping.wa`, "One Stop Market"): everything outside `/admin` -- this file, below.
- **Back office** (`shopping-admin.wa`): `/admin/...` -- section "Back office" (maintained with `admin/`).

Common: control API `/__rl/*` (kit README), product/category images `/media/...`
(`DATA/media`), storefront assets `/static/...`, admin assets `/admin/static/...`, kit assets `/_kit/...`.
A request to `/` on a host starting with `shopping-admin` redirects to `/admin`.

## Sessions

| | cookie | `req.user` | role | login |
|---|---|---|---|---|
| customer (storefront) | `wsb_sid` | `customers` row + `kind: 'customer'` | `customer` | `POST /customer/account/loginPost/` (e-mail) |
| admin user (`/admin/*`) | `wsb_admin_sid` | `admin_users` row + `kind: 'admin'` | `admin` | back office login (username) |

Both can be signed in at once on one host; each area ignores the other's user.
`POST /__rl/login {"user": "emma.lopez@gmail.com"}` starts a customer session, `{"user": "admin"}`
an admin session (both return a `wsb_sid` cookie; under `/admin` a `wsb_sid` cookie is honoured
when it belongs to an admin session). `{"user": "customer:<email>"}` / `{"user": "admin:<name>"}`
force the kind. Login-required storefront pages redirect to `/customer/account/login?next=<url>`.

## Storefront

URLs follow Magento 2 / Luma, so converted WebArena tasks keep their URLs (except renumbered
shop order ids: WebArena shop order `N` is now `N + 1000`, see `docs/NOTES-store.md`).
Trailing slashes are optional everywhere. POST forms need the CSRF token (`_csrf` field, or the
`X-CSRF-Token` header that `/_kit/kit.js` adds to same-origin `fetch`).

### Catalog

| Method | Path | What |
|---|---|---|
| GET | `/` | Home: promos, departments, "Product Showcases" (24 products, `?pbaocw=2` = page 2), deals |
| GET | `/<category url_path>.html` | Category listing, e.g. `/video-games/playstation-4/accessories.html` (anchor categories list their whole subtree) |
| GET | `/catalog/category/view/id/<id>` | Category listing by id |
| GET | `/<product url_key>.html` | Product page (gallery, price incl. special price, configurable swatches, custom options, stock, SKU, details, "More Information" attributes, reviews with histogram, review form, related products) |
| GET | `/catalog/product/view/id/<id>` | Product page by id |
| GET | `/review/product/list/id/<id>` | -> product page `#reviews` |
| GET | any other path | Magento URL rewrites (`url_rewrites`: 301/302 redirects or internal), then CMS pages by identifier (`/about-us`, `/customer-service`, `/privacy-policy-cookie-restriction-mode`, `/enable-cookies`; the shop's own copy `<identifier>-shop` wins), else the 404 page |

**Listing parameters** (category and search pages):

| Param | Values | Meaning |
|---|---|---|
| `product_list_order` | `position` (category default), `relevance` (search default), `name`, `price` | sort key |
| `product_list_dir` | `asc` (default; relevance: `desc`), `desc` | direction; a request with `product_list_order` but no `product_list_dir` redirects to the same URL with the default direction spelled out (one canonical URL per sorted listing), and the sort menu links carry it |
| `product_list_mode` | `grid` (default), `list` | view |
| `product_list_limit` | grid `12` (default) / `24` / `36`; list `10` (default) / `20` / `30` | page size |
| `p` | 2, 3, ... | page (`page` also accepted) |
| `price` | `10-20` (10 <= price < 20), `0-25`, `100-` (100 and above) | price filter; ranges in the "Price" facet use Magento's automatic step (10^n) |
| `price_from`, `price_to` | numbers | the "From $ .. to $ .. Go" form under the Price facet: redirects to the canonical `price=<from>-<to>` (`price_to` exclusive, empty `price_from` = 0), e.g. `?price_to=25` -> `?price=0-25` |
| `brand` | label, repeatable or comma list (`brand=Sony`) | brand filter (shop products: brand from the product details) |
| `cat` | category id | category filter (search pages; categories link directly to the sub-category page) |
| `color`, `size`, `material`, `activity`, `pattern`, `climate`, `style_*`, `gender`, `sleeve`, `collar`, `format`, ... | attribute option id (`color=49`); booleans `eco_collection`, `erin_recommends`, `new`, `sale`, `performance_fabric` take `1`/`0` | Luma attribute filters (configurables match by their children) |

Prices shown and filtered/sorted on are final prices: `special_price` when lower and within
`special_from`/`special_to` (store clock); configurables "As low as" the cheapest enabled child.
Catalog price rules are not applied (they are back-office data only).

### Search

| Method | Path | What |
|---|---|---|
| GET | `/catalogsearch/result/?q=<terms>` (also `/catalogsearch/result/index/`) | Search results with the listing parameters above; facets Category / Price / Brand (/ Luma attributes); "Related search terms"; "Did you mean" when nothing matches. Logs the query in `search_terms` (popularity, num_results) |
| GET | `/search/ajax/suggest/?q=<prefix>` | Autocomplete JSON `{terms: [{title, num_results}], products: [{name, url}]}` (used by the header search box) |
| GET | `/search/term/popular/` | Popular search terms cloud |
| GET | `/catalogsearch/advanced/` | Advanced search form |
| GET | `/catalogsearch/advanced/result/?name=&sku=&description=&short_description=&manufacturer=&price[from]=&price[to]=` | Advanced search results (substring match) |

Search: FTS5 `product_search` (name 10, brand 5, categories 3, SKU 2, description 1), all words
required (stemmed); scores x2 when the product name has every word and x2 more for the exact
phrase. Fallbacks when nothing matches: prefix on the last word, any word (a notice says so),
substring (trigram) on name/SKU.

### Compare

| Method | Path | Form fields |
|---|---|---|
| GET | `/catalog/product_compare/` | Compare table (SKU, brand, comparable attributes) |
| POST | `/catalog/product_compare/add/` | `product` |
| POST | `/catalog/product_compare/remove/` | `product` |
| POST | `/catalog/product_compare/clear/` | |

### Cart and checkout

| Method | Path | Form fields / what |
|---|---|---|
| GET | `/checkout/cart/` | Cart: items with options, qty inputs `cart[<item id>][qty]`, totals with discounts, coupon form, cross-sells |
| POST | `/checkout/cart/add/` | `product`, `qty`, configurable `super_attribute[<attribute code>]=<option id>` (e.g. `super_attribute[size]=167`), custom options `options[<option id>]=<value id or text>` (checkbox/multiple: `options[<id>][]`), optional `return_url` |
| POST | `/checkout/cart/updatePost/` | `cart[<id>][qty]` (0 removes), `update_cart_action=update_qty` or `empty_cart` |
| POST | `/checkout/cart/delete/` | `id` (cart item) |
| POST | `/checkout/cart/couponPost/` | `coupon_code` (apply) or `remove=1`; `return_url` |
| GET | `/checkout/` (also `/checkout/index/`, `/checkout/onepage/`) | Step 1 "Shipping": e-mail (guests), saved addresses (`address_id`) or new address, shipping methods |
| POST | `/checkout/shipping/` | `email` (guests), `address_id` (saved id or `new`) + new address fields (below) + `save_in_address_book`, `shipping_method` = `flatrate_flatrate` ($5.00 per item) or `tablerate_bestway` (table rates by order value) |
| GET | `/checkout/payment/` | Step 2 "Review & Payments": summary, payment methods, billing same as shipping, discount code |
| POST | `/checkout/placeOrder/` | `payment_method` = `checkmo` (Check / Money order) or `cashondelivery`, `billing_same=1`, `comment` |
| GET | `/checkout/onepage/success/` | "Thank you for your purchase!" with the order number (link to the order for customers) |

Cart price rules (`sales_rules`, `coupons`) apply as in Magento: conditions (subtotal, qty,
categories, SKUs, attributes, "if all/any ... true/false"), actions `by_percent`, `by_fixed`,
`cart_fixed`, `buy_x_get_y`, free shipping, coupon codes (e.g. `H20`), usage limits. Placing an order
writes `orders` (state `new`, status `pending`, next 9-digit `increment_id`), `order_items`
(configurables: parent + child row), `order_addresses`, `order_payments`,
`order_status_history`, `stock_reservations` (-qty), rule usage; the cart is closed. Customers
and guests have one active cart (`carts.is_active`); a guest cart merges into the customer's at login.

### Customer account

| Method | Path | What / form fields |
|---|---|---|
| GET | `/customer/account/login/` | Sign-in form (`?next=/path` to return) |
| POST | `/customer/account/loginPost/` | `login[username]` (e-mail), `login[password]`, `next` |
| GET/POST | `/customer/account/logout/` | Sign out -> `/customer/account/logoutSuccess/` |
| GET | `/customer/account/create/` | Registration form |
| POST | `/customer/account/createpost/` | `firstname`, `lastname`, `email`, `password`, `password_confirmation`, `is_subscribed` |
| GET/POST | `/customer/account/forgotpassword/`, `/customer/account/forgotpasswordpost/` | Password reminder (message only) |
| GET | `/customer/account/` | My Account dashboard: contact info, newsletter, default addresses, recent orders, recent reviews |
| GET | `/customer/account/edit/` (`?changepass=1`, `?changeemail=1`) | Account Information form |
| POST | `/customer/account/editPost/` | `firstname`, `lastname`, `change_email`, `email`, `change_password`, `current_password`, `password`, `password_confirmation` |
| GET | `/customer/address/` | Address Book: default billing (`.box-address-billing`), default shipping (`.box-address-shipping`), other addresses |
| GET | `/customer/address/new/`, `/customer/address/edit/id/<id>/` | Address form |
| POST | `/customer/address/formPost/` (new), `/customer/address/formPost/id/<id>/` (edit) | `firstname`, `lastname`, `company`, `telephone`, `street[0]`..`street[2]`, `city`, `region_id` (or `region` text), `postcode`, `country_id`, `default_billing=1`, `default_shipping=1` |
| POST | `/customer/address/delete/id/<id>/` | Delete a non-default address |
| GET | `/newsletter/manage/` | Newsletter Subscriptions (checkbox `title="General Subscription"`) |
| POST | `/newsletter/manage/save/` | `is_subscribed=1` (absent = unsubscribe) |
| POST | `/newsletter/subscriber/new/` | `email` (footer form, guests too) |
| GET | `/downloadable/customer/products/`, `/vault/cards/listaction/` | Empty sections (My Downloadable Products, Stored Payment Methods) |

### Orders

| Method | Path | What |
|---|---|---|
| GET | `/sales/order/history/` | My Orders (`?p=`, `?limit=10/20/50`): Order #, Date, Ship To, Order Total, Status (incl. Canceled, Complete, Pending, Processing, Closed), View / Reorder |
| GET | `/sales/order/view/order_id/<id>/` | Order: status, date, Items Ordered (`.order-details-items.ordered`), totals, addresses, shipping and payment method, comments |
| GET | `/sales/order/invoice/order_id/<id>/`, `/sales/order/shipment/order_id/<id>/`, `/sales/order/creditmemo/order_id/<id>/` | Invoices / Order Shipments (tracking numbers) / Refunds tabs |
| GET | `/sales/order/print/order_id/<id>/` | Printable order |
| POST | `/sales/order/reorder/order_id/<id>/` | Add the order's items (same options) to the cart -> `/checkout/cart/` |
| GET | `/sales/guest/form/` | Orders and Returns (guest lookup) |
| POST | `/sales/guest/view/` | `oar_order_id` (increment id), `oar_billing_lastname`, `oar_email` -> the order page |

`<id>` is `orders.id` (shop orders: WebArena id + 1000, e.g. `/sales/order/view/order_id/1180/`
is order `000001180`).

### Wish list, reviews, contact

| Method | Path | What / form fields |
|---|---|---|
| GET | `/wishlist/` (also `/wishlist/index/index/`) | My Wish List (`.products-grid.wishlist`): comment, qty, Add to Cart, remove |
| POST | `/wishlist/index/add/` | `product` (guests are sent to sign in) |
| POST | `/wishlist/index/remove/` | `item` |
| POST | `/wishlist/index/update/` | `qty[<item>]`, `description[<item>]` |
| POST | `/wishlist/index/cart/` | `item`, `qty` (moves the item to the cart) |
| POST | `/wishlist/index/allcart/` | Add all simple items to the cart |
| POST | `/review/product/post/id/<product id>/` | `ratings[<rating id>]=1..5` (rating 4 = "Rating"), `nickname`, `title`, `detail` -> review with status `pending` ("You submitted your review for moderation.") |
| GET | `/review/customer/` | My Product Reviews (`?p=`) |
| GET | `/review/customer/view/id/<id>/` | Review details |
| GET | `/contact/` (also `/contact/index/`) | Contact Us form ("What’s on your mind?" textarea has that `title`) |
| POST | `/contact/index/post/` | `name`, `email`, `telephone`, `comment` -> `contact_messages` (clears the draft) |
| POST | `/contact/draft` | JSON `{name, email, telephone, comment, seq, page}`: autosaved unsent draft (store.js, 150 ms after typing, on change and on pagehide) -> session `contact_draft` `{..fields, seq, page, at}` (`kit_sessions.data`); `/contact/` restores it. Graders of "fill the form, don't submit" tasks read it |

## Back office

`/admin/...` (`shopping-admin.wa`), implemented in `admin/` (a Fastify plugin registered by
`server.js` with prefix `/admin`). Paths and form field names follow the Magento 2 admin that the
WebArena tasks use (`/admin/catalog/product/edit/id/N/`, `product[price]`, `status_id`, ...), so
converted tasks keep their URLs; admin ids (products 1-2040, orders 1-308, reviews 1-351, CMS
pages 1-6, themes) are unchanged. Every path below is relative to `/admin`; trailing slashes are
optional; paths with `:id` also accept extra Magento segments (`/key/<hash>/`, `/back/edit/`).
Every write is a plain row change in the tenant DB (graders check SQL); POSTs need `_csrf`.

**Session.** Anonymous GETs redirect to `/admin/admin/auth/login?next=<url>` (`login[username]`,
`login[password]`; also shown at `/admin`). `POST /__rl/login {"user":"admin"}` starts an admin
session for rollouts. Admin pages use their own layout (`admin/views/layout.eta`): sidebar menu
(flyouts; `/admin/admin/menu/<section>/` is the no-JS page), header global search
(`/admin/admin/index/globalSearch/?query=`), user menu (Account Setting, Sign Out), flash messages
in `#messages .message`.

**Data grids** (every list below, `admin/lib/grid.js`). URL params: `q` keyword search,
`<column>=<v>` text (LIKE) or select (=) filters, `<column>_from` / `<column>_to` ranges and date
ranges (dates as `M/D/YY`, `M/D/YYYY` or `YYYY-MM-DD`, store-local days), `sort=<column>_asc|desc`,
`page`, `per_page` (20, 30, 50, 100, 200), `cols=a,b,c` (column chooser, remembered per session).
Active filters are listed in `div.admin__data-grid-filters-current` ("Status: Suspected Fraud").
Mass actions: `POST <grid url>massAction/` with `mass_action`, `selected=<id>` (repeated), or
`select_all=1` + `grid_query=<the grid's query string>` (+ `excluded=<id>`), `mass_value` for
actions that take a value; `back_url` returns to the grid.

### Dashboard, account

| Method | Path | What |
|---|---|---|
| GET | `/dashboard/` (also `/admin/dashboard/`) | Lifetime Sales (`#lifetime-sales`), Average Order, Last Orders, Last / Top Search Terms, orders chart + Revenue / Tax / Shipping / Quantity (`?period=24h\|7d\|1m\|1y\|2y`, `?chart=amounts`), Bestsellers, Most Viewed, New Customers, Customers |
| GET/POST | `/admin/auth/login/`, `/admin/auth/logout/` | Sign in (`login[username]`, `login[password]`, `next`) / out |
| GET/POST | `/admin/system_account/index/`, `/admin/system_account/save/` | Own account (name, e-mail, new password; `current_password` required) |

### Catalog

| Method | Path | What |
|---|---|---|
| GET | `/catalog/product/` | Product grid. Columns / filters: `id`, `name` (trigram index, substring), `type`, `attribute_set`, `sku`, `price`, `qty`, `visibility` (1-4), `status` (1 enabled, 2 disabled), `is_in_stock`, `special_price`, `cost`, `weight`, `color`, `size`, `brand`, `url_key`, `created_at`, `updated_at`; Salable Quantity, Websites; keyword = full-text product search |
| POST | `/catalog/product/massAction/` | `mass_action` = `delete` \| `status_1` \| `status_2` \| `update_attributes` \| `price_set` (`mass_value` = new price) \| `price_adjust` (`mass_value` = `-5`, `+10`, `-10%`) |
| GET | `/catalog/product/edit/id/N/` | Product form: `product[status]`, `product[attribute_set_id]`, `product[name]`, `product[sku]`, `product[price]` (shown `27.00`), `product[tax_class_id]`, `product[quantity_and_stock_status][qty]`, `product[quantity_and_stock_status][is_in_stock]` (1/0), `product[product_has_weight]`, `product[weight]`, `product[category_ids][]`, `product[visibility]`, `product[news_from_date]`/`_to_date`, `product[country_of_manufacture]`, `product[size]` / `product[color]` (option ids, e.g. 167 = S, 50 = Blue); Advanced Pricing (`product[special_price]`, `product[special_from_date]`, `product[special_to_date]`, `product[cost]`, `product[msrp]`, tier prices); Advanced Inventory (`product[stock_data][...]`); Configurations (configurable: variants table + Add Configuration); Content (`product[description]`, `product[short_description]`); Images (labels, base/small/thumbnail roles, hide, remove, upload); SEO (`product[url_key]`, `product[meta_title]`, `product[meta_keyword]`, `product[meta_description]`); Related / Up-Sell / Cross-Sell (`product[links][<type>][add]` = SKUs or ids, `product[links][<type>][remove][]`); Customizable Options (read-only); Attributes (long tail: `product[sale]`, `product[new]`, `product[material][]`, ..., shop `spec_*`) |
| POST | `/catalog/product/save/id/N/` | Save (only the fields sent change; `back=close\|duplicate\|new`); errors re-render the form (422) |
| GET | `/catalog/product/new/set/S/type/T/` | New product (T = simple, configurable, virtual, bundle, grouped, downloadable); `/catalog/product/new/` = set 4 simple |
| POST | `/catalog/product/save/set/S/type/T/` | Create (url key from the name if empty; an empty SKU becomes the name, `-1`, `-2`, ... on a clash, as Magento's form fills it) -> redirect to its edit page |
| POST | `/catalog/product/delete/id/N/` | Delete (with its categories, attributes, images, links, variants, options, reviews) |
| POST | `/catalog/product/addVariant/id/N/` | Add a configuration: `variant[size]`, `variant[color]` (option ids of the product's axes), `variant[price]`, `variant[qty]`, `variant[weight]`, optional `variant[sku]`, `variant[name]` (default `<name>-<size>-<color>`, e.g. `Phoebe Zipper Sweatshirt-S-Brown`) -> new simple child (visibility 1) + `product_variants` |
| POST | `/catalog/product/removeVariant/id/N/child/C/`, `/catalog/product/variantStatus/id/N/child/C/` | Remove a configuration from the product / enable-disable it |
| POST | `/catalog/product/upload/id/N/` | Image upload (multipart `image`, `label`) -> `product_images.file` = `/uploads/<name>` (tenant upload dir; a `file` starting with `/` is a URL, else relative to `/media/`) |
| GET/POST | `/catalog/product_action_attribute/edit/`, `.../save/` | Mass "Update attributes" for the selected products: `attributes[<code>]` + `toggle[<code>]=1` (status, visibility, price, special price/dates, cost, weight, tax class, color, size, country, descriptions, meta, boolean/select/multiselect attributes), `inventory[qty]` / `inventory[is_in_stock]` (+ `toggle[qty]`, `toggle[is_in_stock]`), `categories[add][]`, `categories[remove][]` |
| GET | `/catalog/category/` (= Default Category), `/catalog/category/edit/id/N/` | Category tree (product counts) + form: `is_active`, `include_in_menu`, `name`, `parent_id` (move), `description`, `display_mode`, `is_anchor`, `position`, `url_key`, `meta_*`; Products in Category (paged; `category_products[add]` SKUs/ids, `category_products[remove][]`, `category_products[position][<id>]`) |
| GET/POST | `/catalog/category/add/parent/P/`, `/catalog/category/save/[id/N/]`, `/catalog/category/delete/id/N/` | New subcategory / save (moves rebuild `path`, `level`, `url_path` of the subtree) / delete with subtree |

### Sales

| Method | Path | What |
|---|---|---|
| GET | `/sales/order/` | Orders grid: `increment_id` (ID), Purchase Point, `created_at` (Purchase Date), `billing_name`, `shipping_name`, `base_grand_total`, `grand_total`, `status` (`pending`, `processing`, `complete`, `canceled`, `closed`, `holded`, `fraud` = Suspected Fraud, ...); optional `billing_address`, `shipping_address`, `customer_email`, `customer_group`, `subtotal`, `customer_name`, `payment_method`, `total_refunded`; keyword = number, name, e-mail, address, phone |
| POST | `/sales/order/massAction/` | `cancel` \| `hold` \| `unhold` |
| GET | `/sales/order/view/order_id/N/` | Order view: Order & Account Information (`#order_status`), addresses (Edit links), payment / shipping, Items Ordered, Order Totals, "Notes for this Order" (comment form + history). Tabs: `.../active_tab/order_invoices\|order_creditmemos\|order_shipments\|order_history/` |
| GET | `/sales/order/commentsHistory/order_id/N/[active_tab/...]` | Comments History: comments, "Invoice #... created", "Shipment #... created", "Credit memo #... created", "Tracking number X for Federal Express assigned" |
| POST | `/sales/order/addComment/order_id/N/` | `history[status]` (statuses of the order's state), `history[comment]`, `history[is_customer_notified]`, `history[is_visible_on_front]` -> `order_status_history` (+ `orders.status`) |
| POST | `/sales/order/cancel/order_id/N/` (also `cancelOrder`), `/hold/`, `/unhold/`, `/email/` | Cancel (state/status `canceled`, items `qty_canceled`, stock returned), hold (`holded`), unhold, send e-mail (history row, notified) |
| GET/POST | `/sales/order/address/address_id/A/`, `/sales/order/addressSave/address_id/A/` | Edit an order address: `firstname`, `lastname`, `company`, `street[0..2]` (stored joined by newlines), `city`, `country_id`, `region_id` (US states) or `region`, `postcode`, `telephone`, `fax` |
| GET/POST | `/sales/order_invoice/new/order_id/N/`, `/sales/order_invoice/save/order_id/N/` | Invoice: `invoice[items][<item id>]` qty (default all), `invoice[comment_text]`, `invoice[send_email]`, `invoice[do_shipment]`; offline capture -> `invoices`, `invoice_items`, totals paid, state `processing`/`complete` |
| GET/POST | `/admin/order_shipment/new/order_id/N/`, `/admin/order_shipment/save/order_id/N/` | Ship: `shipment[items][<item id>]`, `tracking[n][carrier_code]` (`custom`, `dhl`, `fedex`, `ups`, `usps`), `tracking[n][title]`, `tracking[n][number]`, `shipment[comment_text]` -> `shipments`, `shipment_items`, `shipment_tracks` |
| GET | `/admin/order_shipment/view/shipment_id/S/` | Shipment view; `POST .../addTrack/shipment_id/S/` (`carrier`, `title`, `number`), `POST .../removeTrack/track_id/T/` |
| GET/POST | `/sales/order_creditmemo/new/order_id/N/`, `/sales/order_creditmemo/save/order_id/N/` | Credit memo (offline refund): `creditmemo[items][<item id>][qty]`, `creditmemo[return_to_stock]`, `creditmemo[shipping_amount]`, `creditmemo[adjustment_positive]`, `creditmemo[adjustment_negative]`, `creditmemo[comment_text]` -> `credit_memos`, refunded totals, "We refunded $X offline." history, `closed` when fully refunded |
| GET | `/sales/invoice/`, `/sales/shipment/`, `/sales/creditmemo/` | Document grids; views `/sales/order_invoice/view/invoice_id/I/`, `/sales/order_creditmemo/view/creditmemo_id/C/`; comments `POST /sales/order/addDocComment/kind/<invoice\|shipment\|creditmemo>/id/I/` (`comment[comment]`) |
| GET | `/sales/order_status/` | Order statuses and their states |

### Customers

| Method | Path | What |
|---|---|---|
| GET | `/customer/index/` | Customers grid: `entity_id`, `name`, `email`, `group_id`, `billing_telephone` (Phone), `billing_postcode`, `billing_country_id`, `billing_region`, `created_at` (Customer Since), web site, confirmed e-mail; optional addresses, `dob`, `taxvat`, `gender`, street, city, company, account lock, last logged in; keyword = name, e-mail, phone, address (a phone-like keyword such as `+1 2058812302` or `555-229-3326` matches by digits) |
| POST | `/customer/index/massAction/` | `delete` \| `subscribe` \| `unsubscribe` (newsletter) \| `group_<id>` (assign group) |
| GET | `/customer/index/edit/id/N/` | Customer View; tabs `.../active_tab/account\|addresses\|orders\|cart\|newsletter\|reviews\|wishlist/` |
| POST | `/customer/index/save/id/N/`, `/customer/index/save/` | Account: `customer[group_id]`, `customer[prefix]`, `customer[firstname]`, `customer[middlename]`, `customer[lastname]`, `customer[suffix]`, `customer[email]`, `customer[dob]`, `customer[taxvat]`, `customer[gender]` (1/2/3), `customer[is_active]`; newsletter tab: `subscription` (1/0) |
| GET | `/customer/index/new/` | New customer |
| POST | `/customer/index/delete/id/N/`, `/customer/index/resetPassword/customer_id/N/` | Delete (orders/reviews keep their data, `customer_id` NULL) / reset-password notice |
| POST | `/customer/address/save/parent_id/N/` | Add / edit (`address_id`) an address: `address[firstname]`, ..., `address[street][0]`, `address[street][1]`, `address[city]`, `address[country_id]`, `address[region_id]`, `address[postcode]`, `address[telephone]`, `address[default_billing]`, `address[default_shipping]` |
| POST | `/customer/address/delete/id/A/`, `/customer/address/default/id/A/type/billing\|shipping/` | Delete / make default |
| GET/POST | `/customer/group/`, `/customer/group/new/`, `/customer/group/edit/id/N/`, `/customer/group/save/[id/N/]`, `/customer/group/delete/id/N/` | Customer groups (`code`, `tax_class_id`) |

### Marketing

| Method | Path | What |
|---|---|---|
| GET | `/sales_rule/promo_quote/` | Cart price rules grid (`rule_id`, `name`, `coupon_code`, `sort_order`, `is_active`, `from_date`, `to_date`) |
| GET/POST | `/sales_rule/promo_quote/new/`, `/sales_rule/promo_quote/edit/id/N/`, `/sales_rule/promo_quote/save/[id/N/]` | Rule: `name`, `description`, `is_active`, `website_ids[]`, `customer_group_ids[]` (0 NOT LOGGED IN, 1 General, 2 Wholesale, 3 Retailer), `coupon_type` (1 none, 2 specific, 3 auto), `coupon_code`, `use_auto_generation`, `uses_per_coupon`, `uses_per_customer`, `from_date`, `to_date`, `sort_order`, `is_rss`; conditions (`conditions[aggregator]` all/any, `conditions[value]` 1/0, `conditions[new][n][attribute\|operator\|value]` e.g. `address:base_subtotal` `>=` `50`, `product:category_ids` `()` `25,16`; `conditions[remove][]`) and action conditions (`actions[...]`); `simple_action` (`by_percent`, `by_fixed`, `cart_fixed`, `buy_x_get_y`), `discount_amount`, `discount_qty`, `discount_step`, `apply_to_shipping`, `stop_rules_processing`, `simple_free_shipping`, `store_label` -> `sales_rules` (Magento `conditions_json`), `coupons` |
| POST | `/sales_rule/promo_quote/generate/id/N/`, `/sales_rule/promo_quote/couponsMassDelete/id/N/`, `/sales_rule/promo_quote/delete/id/N/` | Generate coupons (`qty`, `length`, `format` alphanum/alpha/num, `prefix`, `suffix`, `dash`; deterministic per state) / delete coupons (`ids`) / delete rule |
| GET/POST | `/catalog_rule/promo_catalog/` (+ `new/`, `edit/id/N/`, `save/[id/N/]`, `delete/id/N/`, `applyRules/`) | Catalog price rules (same fields; `simple_action` `by_percent`, `by_fixed`, `to_percent`, `to_fixed`; product conditions) |
| GET | `/newsletter/subscriber/` | Subscribers grid (`email`, `type` 1 guest / 2 customer, names, `status` 1 subscribed, 2 not activated, 3 unsubscribed, 4 unconfirmed); mass `unsubscribe`, `delete` |
| GET/POST | `/newsletter/template/` (+ `new/`, `edit/id/N/`, `save/[id/N/]`, `delete/id/N/`) | Newsletter templates (`code`, `subject`, `sender_name`, `sender_email`, `text`, `styles`) -> `temp.newsletter_templates` |
| GET/POST | `/newsletter/queue/`, `/newsletter/queue/edit/template_id/N/`, `/newsletter/queue/save/template_id/N/`, `/newsletter/queue/cancel/id/Q/` | Queue a newsletter (`start_at` store time, subject, sender, text) -> `temp.newsletter_queue` + job `admin.newsletter.send` at the start time (marks it Sent to the subscribed recipients) |
| GET/POST | `/search/term/index/` (+ `new/`, `edit/id/N/`, `save/[id/N/]`, `delete/id/N/`, mass delete) | Search terms (`query_text`, `num_results`, `popularity`, `redirect`, `display_in_terms`) |
| GET/POST | `/search/synonyms/` (+ `new/`, `edit/group_id/N/`, `save/[group_id/N/]`, `delete/group_id/N/`) | Search synonym groups (`synonyms`, comma list) |
| GET | `/review/product/` | All Reviews grid: `review_id`, `created_at`, `status` (1 Approved, 2 Pending, 3 Not Approved), `title`, `nickname`, `detail` (Review), visibility, `type` (customer/guest), `name` (Product), `sku`; hidden filters `product_id`, `customer_id` |
| GET | `/review/product/pending/` | Pending Reviews grid |
| POST | `/review/product/massAction/` | `delete` \| `status_1` \| `status_2` \| `status_3` (also Magento's `massDelete/`, `massUpdateStatus/` with `reviews[]`, `status`) |
| GET/POST | `/review/product/edit/id/N/`, `/review/product/save/id/N/` | Review: `status_id`, `nickname`, `title` (Summary of Review), `detail`, `ratings[<rating id>]` 1-5; Summary Rating ("Rating isn't Available" without votes, also for a missing review id, 404) |
| POST | `/review/product/delete/id/N/` | Delete a review (+ votes) |
| GET/POST | `/review/product/new/?product_id=P`, `/review/product/post/` | New review (admin, `product_id`) |

### Content

| Method | Path | What |
|---|---|---|
| GET | `/cms/page/` | Pages grid (`id`, `title`, `identifier` URL Key, `page_layout`, `is_active`, `created_at`, `updated_at`); mass `delete`, `disable`, `enable` |
| GET/POST | `/cms/page/new/`, `/cms/page/edit/page_id/N/`, `/cms/page/save/` (`page_id`), `/cms/page/delete/page_id/N/` | Page: `is_active`, `title`, `content_heading`, `content`, `identifier`, `meta_title`, `meta_keywords`, `meta_description`, `page_layout`; `back=close\|duplicate` |
| GET/POST | `/cms/block/` (+ `new/`, `edit/block_id/N/`, `save/` with `block_id`, `delete/block_id/N/`) | Blocks: `is_active`, `title`, `identifier`, `content` |
| GET | `/admin/system_design_theme/` (also `/system_design_theme/`), `.../edit/id/N/` | Themes (1 Magento Blank, 3 Magento Luma) |
| GET/POST | `/theme/design_config/`, `/theme/design_config/edit/...`, `/theme/design_config/save/` | Design configuration: `theme_theme_id` -> `store_config design/theme/theme_id`, head title / description, welcome text, footer copyright |

### Reports

Report pages run on the **background job** `admin.report`: submitting the filter (GET with the
params) creates a run in `temp.admin_report_runs` and enqueues the job; the page shows "being
generated" and reloads until the run is `done`, then reads the rows from `temp.admin_report_rows`.
A run is reused while its params and the underlying data are unchanged; every time a report page shows a run it sets `last_shown` (increasing counter), so graders read the last report the agent looked at with `SELECT ... FROM temp.admin_report_runs ORDER BY last_shown DESC LIMIT 1` (`params` JSON: `from`, `to` as `YYYY-MM-DD`, `period`, `statuses`). Filter params:
`report_from`, `report_to` (`#sales_report_from` / `#sales_report_to`, shown as `M/D/YY`),
`report_period` `day|month|year`, sales reports also `report_type` `created_at_order|updated_at_order`,
`show_order_statuses` 0/1 + `order_statuses` (repeated), `show_empty_rows` 0/1. Sales reports
skip orders in state `new` / `pending_payment` (as Magento's aggregation); bestsellers and
customer reports skip canceled orders.

| Method | Path | What |
|---|---|---|
| GET | `/reports/report_sales/sales/` | Orders: Interval, Orders, Sales Items, Sales Total, Invoiced, Refunded, Sales Tax, Sales Shipping, Sales Discount, Canceled (+ totals) |
| GET | `/reports/report_sales/tax/`, `.../invoiced/`, `.../shipping/`, `.../refunded/`, `.../coupons/` | Tax, Invoiced, Shipping, Refunds, Coupons |
| GET | `/reports/report_sales/bestsellers/` | Bestsellers: top 5 simple products per period (e.g. 2022: Quest Lumaflex&trade; Band) |
| GET | `/reports/report_product/sold/`, `/reports/report_product/viewed/` | Ordered products; product views (empty data) |
| GET | `/reports/report_product/lowstock/` | Low stock grid (qty below the product's notify quantity; filters `name`, `sku`, `qty`) |
| GET | `/reports/report_customer/totals/`, `.../orders/`, `.../accounts/` | Customers by order total / order count (top 5 per period), new accounts |
| GET | `/reports/report_review/customer/`, `/reports/report_review/product/` | Reviews by customers / by products (paged, `sort=<column>_asc\|desc`) |
| GET | `/search/term/report/`, `/reports/report_shopcart/product/`, `/reports/report_shopcart/abandoned/` | Search terms (`query_text`, `num_results`, `popularity`), products in carts, abandoned carts |
| GET/POST | `/reports/report_statistics/`, `/reports/report_statistics/refresh/` (`codes`, `mode` recent\|lifetime) | Refresh Statistics -> job `admin.statistics.refresh` rewrites `report_sales`, `report_bestsellers`, `report_tax`, `report_shipping`, `report_invoiced`, `report_refunded`, `report_coupons` rows with `source = 'live'`, time in `store_config reports/statistics/<code>/updated_at` |

### Stores, System

| Method | Path | What |
|---|---|---|
| GET/POST | `/admin/system_config/edit/section/<s>/`, `/admin/system_config/save/section/<s>/` | Configuration, `s` = `general`, `web`, `currency`, `contact`, `catalog`, `cataloginventory`, `customer`, `newsletter`, `sales`, `carriers`, `payment`; fields `groups[<config path>]` -> `store_config` |
| GET | `/admin/system_store/` | All stores (one website / store / store view) |
| GET/POST | `/tax/rate/` (+ `add/`, `edit/rate/N/`, `save/[rate/N/]`, `delete/rate/N/`) | Tax rates (`code`, `tax_country_id`, `tax_region_id`, `tax_postcode`, `rate`) |
| GET/POST | `/catalog/product_attribute/`, `.../edit/attribute_id/N/`, `.../save/attribute_id/N/` | Product attributes (N = attributes rowid): `frontend_label`, storefront flags, options (`option[value][<id>]`, `option[order][<id>]`, `option[delete][<id>]`, `option[value][new]`) |
| GET | `/catalog/product_set/`, `/review/rating/` (+ `edit/id/N/`, `save/id/N/`) | Attribute sets (product counts); ratings |
| GET/POST | `/admin/user/` (+ `new/`, `edit/user_id/N/`, `save/[user_id/N/]`, `delete/user_id/N/`) | Admin users: `username`, `firstname`, `lastname`, `email`, `password`, `password_confirmation`, `interface_locale`, `is_active`, `roles` (role id); `current_password` required |
| GET/POST | `/admin/user_role/` (+ `editrole/[rid/N/]`, `saverole/[rid/N/]`, `delete/rid/N/`) | Roles: `rolename`, `all` (1 = all resources) or `resource[]`; `current_password` -> `admin_roles`, `admin_role_rules` |
| GET/POST | `/admin/cache/` (+ `flushAll/`), `/indexer/indexer/list/` | Cache / index management (informational) |

### Back-office state outside the base tables

Per tenant, in the connection's `temp` schema (created when the tenant opens, so a reset empties
or restores them; graders can query them by name): `admin_report_runs`, `admin_report_rows`
(report jobs), `newsletter_templates`, `newsletter_queue`; helper indexes kept in sync by temp
triggers: `admin_pgrid` (narrow copy of `products` for the product grid), `admin_rstat`
(non-approved review ids), `admin_popt` / `admin_povr` (custom-option lookups, left empty now that
base.db indexes `product_options(product_id)` / `product_option_values(option_id)`). Their initial rows
come from `/dev/shm/wsb-store-admin-<hash>.db`, built once per base.db version (~5 s).
SQL functions on every tenant connection (registered at open, so graders' `/__rl/query` can use
them): `admin_local(ts)` (UTC -> store time `America/New_York`, `YYYY-MM-DD HH:MM:SS`) and
`admin_local_date(ts)`.
