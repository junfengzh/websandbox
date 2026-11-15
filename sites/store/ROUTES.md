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
| `product_list_dir` | `asc` (default; relevance: `desc`), `desc` | direction |
| `product_list_mode` | `grid` (default), `list` | view |
| `product_list_limit` | grid `12` (default) / `24` / `36`; list `10` (default) / `20` / `30` | page size |
| `p` | 2, 3, ... | page (`page` also accepted) |
| `price` | `10-20` (10 <= price < 20), `0-25`, `100-` (100 and above) | price filter; ranges in the "Price" facet use Magento's automatic step (10^n) |
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
| POST | `/contact/index/post/` | `name`, `email`, `telephone`, `comment` -> `contact_messages` |

## Back office

`/admin/...` -- documented by the back office (`admin/`); this section is theirs.
