#!/usr/bin/env python3
"""Convert the 182 WebArena shopping_admin-only tasks to the store back office (lite site).

    python3 -I tasks/store/convert_admin.py [--src .../test.raw.json] [--out tasks/store/webarena-admin.jsonl]

One task per line (docs/CONVENTIONS.md "WebArena tasks"), site "shopping_admin", start URLs
under __SHOPPING_ADMIN__/admin (WebArena's __SHOPPING_ADMIN__ already ended in /admin).
Evaluators: string_match -> answer (+ answer_sql; "$sql" where the reference is data-derived);
url_match -> lite admin URL; program_html -> state_sql/state_expect on the rows the admin action
changes. The store is ONE merged store (docs/NOTES-store.md): store-wide aggregates were either
re-derived on the merged data (answer_sql, reachable in the admin UI) or scoped to the Luma
Apparel department so the original meaning holds; each task's `changes` says which.
Every task was run through the admin UI (tasks/store/verify-admin.jsonl).
"""
import argparse
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = '$WEBARENA_TASKS'
H = '__SHOPPING_ADMIN__'
# Rows that existed before the rollout end before the store clock (2023-06-12 16:00 UTC); rows the
# agent creates get ids above these maxima (base.db, checked at conversion time).
MAX_PRODUCT = 114499
MAX_RULE_SQL = '4'  # base.db sales_rules ids 1-4 (Luma); new rules get higher ids


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def num_alts(count_sql):
    """answer_sql: '<n> |OR| <n with thousands commas>' from a query returning one column n (agents copy '10,251')."""
    return f"SELECT CASE WHEN n >= 1000 THEN n || ' |OR| ' || printf('%,d', n) ELSE CAST(n AS TEXT) END AS answer FROM ({count_sql})"


# ---------------------------------------------------------------- reusable SQL fragments
LOCAL = 'admin_local'  # store-local (America/New_York) time, registered on every tenant connection
# Magento bestsellers semantics (= Reports > Products > Bestsellers): simple lines, canceled orders out
BEST = ("SELECT replace(replace(i.name, '&trade;', '™'), '&reg;', '®') AS name, sum(i.qty_ordered - coalesce(i.qty_canceled, 0)) AS qty "
        "FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.state <> 'canceled' "
        "AND coalesce(i.product_type, 'simple') NOT IN ('configurable', 'bundle', 'grouped') "
        "AND substr(admin_local(o.created_at), 1, {n}) {op} {v} GROUP BY i.product_id ORDER BY qty DESC, i.product_id")
ORDERS_RECENT = 'ORDER BY o.created_at DESC, o.id DESC'
CUST_NAME = "trim(o.customer_firstname || ' ' || o.customer_lastname)"


def best(period_len, op, v, limit):
    return BEST.format(n=period_len, op=op, v=v) + f' LIMIT {limit}'


def review_status_count(status):
    return num_alts(f'SELECT count(*) AS n FROM reviews WHERE status = {lit(status)}')


def product_state(pid, col, want, fmt=None):
    sql = f'SELECT {col} FROM products WHERE id = {pid}'
    return sql, want


def attr_state(pid, code):
    return f"SELECT value FROM product_attributes WHERE product_id = {pid} AND attribute_code = {lit(code)}"


# ---------------------------------------------------------------- per-task conversions
# Each entry: eval (lite), changes (list), optional intent override, start (lite path), status.
T = {}


def task(*ids, **kw):
    for i in ids:
        T[i] = dict(kw)


# ---- 279 bestsellers (Reports > Products > Bestsellers; top 5 per period, ties by price then id)
task(0, eval={'type': 'answer', 'answer': {'exact': 'Quest Lumaflex™ Band'},
              'answer_sql': best(4, '=', "'2022'", 1)},
     changes=['Merged store: 2022 bestsellers unchanged by the shop orders (shop lines are 1 qty each); Quest Lumaflex™ Band (5) still #1 (answer_sql = the Bestsellers report computation, yearly 2022).'])
task(1, eval={'type': 'answer', 'answer': {'exact': 'Sprite'}},
     changes=['Kept: Q1 2022 has one shop order (2 grocery items), so the Luma brands are unchanged; "brand" = the Luma product line prefix (Sprite stasis balls + yoga straps: 9 units, more than any other line). Luma products have no brand attribute.'])
task(2, status='dropped', drop_reason='Ambiguous: "product type" has no attribute in the data; grouping Q1 2022 bestsellers by kind gives watches (7 units) over the reference "Yoga ball" (5 units).',
     eval={'type': 'answer', 'answer': {'exact': 'Yoga ball'}}, changes=['Dropped (ambiguous product type).'])
task(3, eval={'type': 'answer', 'answer': {'must_include': ['Quest Lumaflex', 'Sprite Stasis Ball 65 cm |OR| Cruise Dual Analog Watch |OR| Sprite Stasis Ball 55 cm']},
              'answer_sql': best(4, '=', "'2022'", 4)},
     changes=['2nd place in 2022 is a three-way tie at 4 units (Sprite Stasis Ball 65 cm, Cruise Dual Analog Watch, Sprite Stasis Ball 55 cm); the lite report breaks ties by price (shows Cruise Dual Analog Watch 2nd), Magento showed Sprite Stasis Ball 65 cm. Any of the tied products is accepted.'])
task(4, eval={'type': 'answer', 'answer': {'must_include': ['Impulse Duffle', 'Overnight Duffle', 'Hawkeye Yoga Short-32-Blue']},
              'answer_sql': best(7, '=', "'2023-01'", 3)},
     changes=['Merged store: Jan 2023 adds 34 shop orders, all 1-unit lines; top 3 unchanged (2 units each).'])
task(5, status='dropped', drop_reason='Ambiguous: "product type" has no attribute; by kind, shorts (9 units) outsell the reference "Duffle" (4) in Jan 2023.',
     eval={'type': 'answer', 'answer': {'exact': 'Duffle'}}, changes=['Dropped (ambiguous product type).'])
task(6, eval={'type': 'answer', 'answer': {'must_include': ['Sprite Yoga Strap 6 foot', '9 Elements Liquid Laundry Detergent', 'Ida Workout Parachute Pant-29-Purple', 'Overnight Duffle']},
              'answer_sql': best(4, '=', "'2023'", 4)},
     changes=['Re-derived on the merged store (answer_sql = Bestsellers report, yearly 2023): the shop product "9 Elements Liquid Laundry Detergent, Lemon Scent, 46 Oz" (3 units) enters the top 4; 5th place is a many-way tie at 2 units, so only the first four are required (was: Sprite Yoga Strap 6 foot, Overnight Duffle, Ida Workout Parachute Pant-29-Purple, Hawkeye Yoga Short-32-Blue, Sprite Stasis Ball 65 cm on the Luma store alone).'])

# ---- 288 reviews mentioning a term (Marketing > All Reviews, filter Review contains term)
for tid, term, old in [(11, 'disappointed', 6), (12, 'satisfied', 2), (13, 'decent', 2), (14, 'not useful', 0), (15, 'best', 2)]:
    task(tid, eval={'type': 'answer', 'answer': {'must_include': '$sql'},
                    'answer_sql': num_alts(f"SELECT count(*) AS n FROM reviews WHERE detail LIKE {lit('%' + term + '%')}")},
         changes=[f'Re-derived on the merged store (309,290 reviews): count of reviews whose text contains "{term}" (All Reviews grid, Review filter; case-insensitive substring, as the Luma reference {old} was). With thousands commas accepted.'])

# ---- 285 top search terms (Marketing > Search Terms / Reports > Search Terms / dashboard)
task(41, eval={'type': 'answer', 'answer': {'exact': 'hollister'},
               'answer_sql': 'SELECT query_text FROM search_terms ORDER BY popularity DESC, id LIMIT 1'},
     changes=['Merged search terms (popularity summed by query text): hollister (19 uses) is still #1.'])
task(42, eval={'type': 'answer', 'answer': {'must_include': ['hollister', 'laundry detergent']},
               'answer_sql': 'SELECT query_text FROM search_terms ORDER BY popularity DESC, id LIMIT 2'},
     changes=['Re-derived on the merged store: #2 is now the shop term "laundry detergent" (7 uses; Luma "Joust Bag" has 4).'])
task(43, eval={'type': 'answer', 'answer': {'must_include': ['hollister', 'laundry detergent', 'earphone |OR| iphone |OR| laptop |OR| sony bluetooth headphone']},
               'answer_sql': 'SELECT query_text FROM search_terms ORDER BY popularity DESC, id LIMIT 6'},
     changes=['Re-derived on the merged store: hollister (19), laundry detergent (7), then a four-way tie at 6 uses (earphone, iphone, laptop, sony bluetooth headphone): any one of them is accepted as #3.'])

# ---- 276 customers by completed orders (Sales > Orders filtered Status = Complete; customer view Orders tab)
COMPLETE_BY_CUST = ("SELECT trim(c.firstname || ' ' || c.lastname) AS name, count(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id "
                    "WHERE o.status = 'complete' GROUP BY o.customer_id")
task(62, eval={'type': 'answer', 'answer': {'must_include': '$sql'},
               'answer_sql': f'SELECT name FROM ({COMPLETE_BY_CUST}) WHERE n = (SELECT max(n) FROM ({COMPLETE_BY_CUST}))'},
     changes=['Re-derived on the merged store: Bob Jones has 44 complete orders (6 Luma + 38 shop); Jane Smith (9) led on the Luma store alone.'])
task(63, eval={'type': 'answer', 'answer': {'must_include': '$sql'},
               'answer_sql': f'SELECT name FROM ({COMPLETE_BY_CUST}) WHERE n = (SELECT max(n) FROM ({COMPLETE_BY_CUST}) WHERE n < (SELECT max(n) FROM ({COMPLETE_BY_CUST})))'},
     changes=['Re-derived on the merged store: Jane Doe (28 complete orders) is second (was Adam Garcia / Michael Nguyen / Sarah Miller with 8 on the Luma store).'])
task(64, intent='Which customers have completed exactly 2 orders in the entire history?',
     eval={'type': 'answer', 'answer': {'must_include': '$sql'},
           'answer_sql': f'SELECT name FROM ({COMPLETE_BY_CUST}) WHERE n = 2 ORDER BY name'},
     changes=['Intent "placed 2 orders" said "completed" in the template and the reference counted complete orders; reworded to "completed exactly 2 orders".',
              'Re-derived on the merged store: Alexander Thomas, Brian Smith, Lisa Green, Sophie Taylor (Lisa Kim and Julia Williams now have more complete shop orders).'])
task(65, eval={'type': 'answer', 'answer': {'must_include': ['Sarah Miller |OR| Jane Smith']},
               'answer_sql': (f'SELECT name, n FROM ({COMPLETE_BY_CUST}) WHERE n = (SELECT DISTINCT n FROM ({COMPLETE_BY_CUST}) ORDER BY n DESC LIMIT 1 OFFSET 4)')},
     changes=['Re-derived on the merged store: by customer account the 5th most complete orders is Sarah Miller (10: Bob Jones 44, Jane Doe 28, John Smith 27, Emma Lopez 25); counting by name, the two "Jane Smith" accounts together (9 + 5) are 5th, so Jane Smith is accepted too.'])

# ---- 277 review counts by status (All Reviews grid, Status filter)
for tid, status, label in [(77, 'pending', 'Pending'), (78, 'approved', 'Approved'), (79, 'not_approved', 'Not Approved')]:
    task(tid, eval={'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': review_status_count(status)},
         changes=[f'Re-derived on the merged store: {label} reviews among all 309,290 (the shop\'s 308,939 reviews are all approved). Thousands commas accepted.'])

# ---- 274 invoice grand total (Sales > Invoices) -- invoices are Luma only, ids unchanged
for tid, inc, amt in [(94, '000000001', '36.39'), (95, '000000002', '39.64')]:
    task(tid, eval={'type': 'answer', 'answer': {'must_include': [amt]},
                    'answer_sql': f"SELECT printf('%.2f', grand_total) FROM invoices WHERE increment_id = {lit(inc)}"},
         changes=['Unchanged: invoice numbers and totals kept from the Luma store.'])

# ---- 270 monthly count of complete orders (Reports > Sales > Orders, period Month, status Complete)
MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
MONTH_CASE = 'CASE CAST(substr(m, 6, 2) AS INTEGER) ' + ' '.join(f"WHEN {i + 1} THEN '{n}'" for i, n in enumerate(MONTHS)) + ' END'


def monthly(frm, to):
    return (f"SELECT {MONTH_CASE} || ': ' || n || ' orders' FROM (SELECT substr(admin_local(created_at), 1, 7) AS m, count(*) AS n FROM orders "
            f"WHERE status = 'complete' GROUP BY m) WHERE m BETWEEN '{frm}' AND '{to}' ORDER BY m")


for tid, frm, to in [(107, '2022-05', '2022-12'), (108, '2023-01', '2023-05'), (109, '2022-01', '2022-12'), (110, '2022-01', '2022-11'), (111, '2022-02', '2022-11')]:
    task(tid, eval={'type': 'answer', 'answer': {'fuzzy': '$sql'}, 'answer_sql': monthly(frm, to)},
         changes=['Re-derived on the merged store (answer_sql): complete orders per store-local month, Luma + shop (the Orders report with Order Status = Complete, period Month shows the same counts). Fuzzy (LLM judge) as before.'])

# ---- 245 / 244 / 250 / 249 per-product reviews (Luma products only have these reviews; unchanged)
task(112, eval={'type': 'answer', 'answer': {'exact': 'Hannah Lim'}}, changes=['Unchanged: the Circe Hooded Ice Fleece reviews are Luma data (review 353, 1 star).'])
task(113, eval={'type': 'answer', 'answer': {'must_include': ['Emma Lopez |OR| Emma', 'Seam Miller']}},
     changes=['Unchanged data (reviews 351 "Emma" = customer Emma Lopez, 349 "seam miller"); "Emma" (the review nickname) accepted for Emma Lopez.'])
task(114, eval={'type': 'answer', 'answer': {'must_include': ['Shaunte', 'Merrie']}}, changes=['Unchanged (reviews 337, 338).'])
task(115, eval={'type': 'answer', 'answer': {'must_include': ['Teofila']}},
     changes=['Reference corrected: WebArena said N/A ("no negative review for Chloe tank"), but review 335 by Teofila (2 stars, "Not for non-petite") is negative; task 246 of the same data names Teofila as the most unhappy Chloe Compete Tank customer.'])
task(116, intent='Show me the name of the customers who have expressed dissatisfaction with the tanks products of the Luma Apparel department (the men\'s and women\'s tank tops)?',
     eval={'type': 'answer', 'answer': {'must_include': ['Alexander', 'Carma', 'Dominic', 'Merrie', 'Monroe', 'Scotty', 'Shaunte', 'Teofila', 'Valorie']}},
     changes=['Scoped to the Luma Apparel department: the merged store also has 223 shop products named "tank" (fish tanks, tank tops, ...) with 1,378 reviews, which would change the meaning. Reference unchanged.'])
task(119, eval={'type': 'answer', 'answer': {'fuzzy': ['Its color and style is good']}}, changes=['Unchanged (Luma reviews).'])
task(120, eval={'type': 'answer', 'answer': {'fuzzy': ['It is comfortable']}}, changes=['Unchanged (Luma reviews).'])
task(121, eval={'type': 'answer', 'answer': {'fuzzy': ['Warm and comfortable. True to size.']}}, changes=['Unchanged (Luma reviews; Circe Hooded Ice Fleece review 352).'])
task(122, eval={'type': 'answer', 'answer': {'fuzzy': ['Lightweight, comfortable and stylish. Good design and details.']}}, changes=['Unchanged (Luma reviews).'])
task(123, eval={'type': 'answer', 'answer': {'fuzzy': ['Warm and comfortable. True to size.']}}, changes=['Unchanged: Circe Hooded Ice Fleece is the only "Circe" product.'])
task(127, status='dropped', drop_reason='Merged store: the top search terms are now generic shop queries (laundry detergent, earphone, iphone, laptop, ...); "brands appearing most frequently" no longer has a well-defined answer (the Luma reference Hollister, Joust, Antonia came from a 7-term list).',
     eval={'type': 'answer', 'answer': {'must_include': ['Hollister', 'Joust', 'Antonia']}}, changes=['Dropped (store-wide answer undefined after the merge).'])

# ---- 1002 items in the most recent N orders (dashboard "Last Orders" Items; order views)
for tid, k, old in [(128, 2, 9), (129, 4, 16), (130, 5, 18), (131, 7, 25)]:
    task(tid, eval={'type': 'answer', 'answer': {'must_include': '$sql'},
                    'answer_sql': (f"SELECT CAST(sum(q) AS INTEGER) FROM (SELECT (SELECT sum(qty_ordered) FROM order_items i WHERE i.order_id = o.id AND i.parent_item_id IS NULL) AS q "
                                   f"FROM orders o WHERE o.created_at < '2023-06-12' {ORDERS_RECENT} LIMIT {k})")},
         changes=[f'Re-derived on the merged store: the most recent {k} orders by purchase date now include shop orders (Luma reference {old}); items = ordered quantity of every order, any status (as the reference counted pending orders; the dashboard Last Orders "Items" column).'])

task(157, eval={'type': 'url', 'url': f'{H}/admin/customer/index/'}, changes=['URL under /admin (WebArena __SHOPPING_ADMIN__ included /admin).'])

# ---- 368 products with N units left (scoped to Luma simple products)
LUMA_SIMPLE = "type = 'simple' AND source = 'admin'"
task(183, intent='Give me the SKU of the Luma Apparel simple products (single size/color items) that have 10 units left',
     eval={'type': 'answer', 'answer': {'fuzzy': 'N/A'}, 'answer_sql': f'SELECT sku FROM products WHERE {LUMA_SIMPLE} AND qty = 10'},
     changes=['Scoped to the Luma Apparel department\'s simple products: shop products have quantities 0-100 (about 1,000 products at each quantity), so store-wide the answer would be ~1,000 SKUs. answer_sql confirms none has 10.'])
task(184, intent='Give me the name of the Luma Apparel simple products (single size/color items) that have 0 units left',
     eval={'type': 'answer', 'answer': {'must_include': ['Cronus Yoga Pant -33-Blue |OR| Cronus Yoga Pant-33-Blue |OR| Cronus Yoga Pant 33 Blue']},
           'answer_sql': f'SELECT name FROM products WHERE {LUMA_SIMPLE} AND qty = 0'},
     changes=['Scoped to Luma simple products (store-wide ~1,000 shop products have 0).',
              'Reference corrected to the data: the only Luma simple product with qty 0 is Cronus Yoga Pant -33-Blue (MP12-33-Blue, also restocked by task 768); WebArena said Sinbad Fitness Tank, a configurable (all configurables show 0) with no child at 0.'])
task(185, intent='Give me the brand of the Luma Apparel simple products (single size/color items) that have 3 units left',
     eval={'type': 'answer', 'answer': {'must_include': ['Eos', 'Minerva']}, 'answer_sql': f'SELECT name FROM products WHERE {LUMA_SIMPLE} AND qty = 3'},
     changes=['Scoped to Luma simple products (store-wide ~1,000 shop products have 3). Reference unchanged ("brand" = the product line: Eos V-Neck Hoodie, Minerva LumaTech V-Tee).'])
task(186, intent='Give me the product names and the sizes of the Luma Apparel simple products (single size/color items) that have 2-3 units left',
     eval={'type': 'answer', 'answer': {'fuzzy': ['Eos V-Neck Hoodie: S', 'Minerva LumaTech™ V-Tee: XS']},
           'answer_sql': f'SELECT name, size FROM products WHERE {LUMA_SIMPLE} AND qty BETWEEN 2 AND 3'},
     changes=['Scoped to Luma simple products. Reference unchanged (typo "Minera" fixed).'])
task(187, intent='Give me the SKU of the Luma Apparel simple products (single size/color items) that have 1-3 units left',
     eval={'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': f'SELECT sku FROM products WHERE {LUMA_SIMPLE} AND qty BETWEEN 1 AND 3 ORDER BY sku'},
     changes=['Scoped to Luma simple products. Reference unchanged: WH11-S-Blue, WS08-XS-Blue.'])

# ---- 367 payment totals of the last N orders by status (Sales > Orders, sort Purchase Date, status filter)


def last_total(status_where, k):
    return f"(SELECT sum(grand_total) FROM (SELECT o.grand_total FROM orders o WHERE {status_where} {ORDERS_RECENT} LIMIT {k}))"


def money_alts(expr):
    """answer_sql: '57.03', or '182.40 |OR| 182.4', (+ ' |OR| 1,234.50') for a money expression."""
    return (f"SELECT printf('%.2f', v) || CASE WHEN v * 10 = round(v * 10) THEN ' |OR| ' || printf('%.1f', v) ELSE '' END "
            f"|| CASE WHEN abs(v) >= 1000 THEN ' |OR| ' || printf('%,.2f', v) ELSE '' END AS answer FROM (SELECT round({expr}, 2) AS v)")


for tid, where, k, old, what in [(193, "o.status = 'complete'", 2, '182.4', 'last 2 complete'), (194, "o.status = 'complete'", 5, '555.2', 'last 5 complete'),
                                 (195, "o.status = 'pending'", 5, '885.4', 'last 5 pending'), (197, "o.status <> 'canceled'", 5, '778.2', 'last 5 non-canceled')]:
    task(tid, eval={'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': money_alts(last_total(where, k))},
         changes=[f'Re-derived on the merged store: the {what} orders by purchase date now include shop orders (Luma reference {old}); sum of Grand Total (Purchased).'])
task(196, eval={'type': 'answer', 'answer': {'must_include': '$sql'},
                'answer_sql': money_alts(f"abs({last_total(chr(111) + '.status = ' + lit('canceled'), 4)} - {last_total(chr(111) + '.status = ' + lit('complete'), 4)})")},
     changes=['Re-derived on the merged store: |sum of the last 4 canceled - sum of the last 4 complete orders| (Grand Total), shop orders included (Luma reference 194.25).'])

# ---- 366 attribute of the newest/oldest order with a status
task(198, eval={'type': 'answer', 'answer': {'exact': '$sql'}, 'answer_sql': f"SELECT {CUST_NAME} FROM orders o WHERE o.status = 'canceled' {ORDERS_RECENT} LIMIT 1"},
     changes=['Re-derived on the merged store: the most recent canceled order is shop order 000001122 (John Smith, May 30, 2023); was Lily Potter (000000136) on the Luma store.'])
task(199, eval={'type': 'answer', 'answer': {'must_include': ['000000299 |OR| 299']}, 'answer_sql': f"SELECT o.increment_id FROM orders o WHERE o.status = 'pending' {ORDERS_RECENT} LIMIT 1"},
     changes=['Merged store: the newest pending order is still 000000299 (May 31, 2023). Reference "299" -> "000000299 |OR| 299" (the kit grader matches numbers as whole numbers).'])
task(200, eval={'type': 'answer', 'answer': {'exact': 'John Lee'},
                'answer_sql': "SELECT trim(a.firstname || ' ' || a.lastname) FROM orders o JOIN order_addresses a ON a.order_id = o.id AND a.address_type = 'billing' WHERE o.status = 'complete' ORDER BY o.created_at, o.id LIMIT 1"},
     changes=['Merged store: the oldest complete order is still a Luma order (Jan 2022, bill-to John Lee); shop orders start in Mar 2022.'])
task(201, eval={'type': 'answer', 'answer': {'fuzzy': 'N/A'}, 'answer_sql': "SELECT count(*) FROM orders WHERE status = 'fraud'"},
     changes=['Unchanged: no order has status Suspected Fraud in either store.'])
task(202, eval={'type': 'answer', 'answer': {'fuzzy': ['May 30, 2023']},
                'answer_sql': f"SELECT admin_local(o.created_at) FROM orders o WHERE o.status = 'canceled' {ORDERS_RECENT} LIMIT 1"},
     changes=['Re-derived on the merged store: most recent canceled order 000001122 was purchased May 30, 2023 11:10 AM store time (was May 23, 2023 on the Luma store).'])
task(203, eval={'type': 'answer', 'answer': {'fuzzy': ['order id: 000000299', 'purchase date: May 31, 2023']},
                'answer_sql': f"SELECT o.increment_id, admin_local(o.created_at) FROM orders o WHERE o.status = 'pending' {ORDERS_RECENT} LIMIT 1"},
     changes=['Unchanged on the merged store: 000000299, May 31, 2023 2:55 AM.'])
task(204, eval={'type': 'answer', 'answer': {'fuzzy': '$sql'},
                'answer_sql': ("SELECT name || ': $' || printf('%.2f', price) FROM (SELECT i.name, i.price - coalesce(i.discount_amount, 0) / i.qty_ordered AS price FROM order_items i "
                               f"WHERE i.parent_item_id IS NULL AND i.order_id = (SELECT o.id FROM orders o WHERE o.status = 'complete' {ORDERS_RECENT} LIMIT 1)) ORDER BY price")},
     changes=['Re-derived on the merged store: the most recent complete order is shop order 000001057 (Jane Doe, May 28, 2023); its items with the price after discount, low to high (was 000000230 on the Luma store).'])

# ---- 364 customer by phone (customer grid keyword / Phone filter) -- customers merged with admin ids kept
for tid, name, email in [(208, 'John Smith', 'john.smith.xyz@gmail.com'), (209, 'Jennifer White', 'jennifer.white@yahoo.com'), (210, 'Adam Garcia', 'gamingpro456@gmail.com'),
                         (211, 'Sean Miller', 'sean.miller@gmail.com'), (212, 'Veronica Costello', 'roni_cost@example.com')]:
    task(tid, eval={'type': 'answer', 'answer': {'must_include': [name, email]}}, changes=['Unchanged: customers merged by e-mail keep the Luma account, phone and e-mail.'])

task(213, eval={'type': 'answer', 'answer': {'fuzzy': ['Not suitable for high-impact workouts']}}, changes=['Unchanged (Luma reviews).'])
task(214, eval={'type': 'answer', 'answer': {'fuzzy': 'N/A'}},
     changes=['Reference corrected: the three Zing Jump Rope reviews (148-150, 4-5 stars) contain no complaint; the WebArena reference ("hard to find the right size, won\'t last long") quotes the Ana Running Short reviews.'])
task(215, eval={'type': 'answer', 'answer': {'fuzzy': ['Material quality, fit, insufficient warmth, color']}}, changes=['Unchanged (Luma review 353).'])
task(216, eval={'type': 'answer', 'answer': {'fuzzy': ['Not true to size']}}, changes=['Unchanged (Luma reviews).'])
task(217, eval={'type': 'answer', 'answer': {'fuzzy': ['Insufficient resistance for their workouts.']}}, changes=['Unchanged (Luma reviews).'])
task(243, eval={'type': 'answer', 'answer': {'exact': 'hannah.lim@gmail.com'}}, changes=['Unchanged: review 353 by "Hannah Lim" (guest review); her customer account has this e-mail.'])
task(244, eval={'type': 'answer', 'answer': {'exact': 'emma.lopez@gmail.com'}}, changes=['Unchanged: review 351 by customer Emma Lopez (id 70).'])
task(245, eval={'type': 'answer', 'answer': {'exact': 'Shaunte'}}, changes=['Unchanged (review 337, 2 stars).'])
task(246, eval={'type': 'answer', 'answer': {'exact': 'Teofila'}}, changes=['Unchanged (review 335, 2 stars).'])
task(247, eval={'type': 'answer', 'answer': {'fuzzy': 'N/A'}}, changes=['Unchanged: the most unhappy Zoe Tank reviewer (Valorie, 2 stars) is a guest without an e-mail.'])

# ---- 234 customer with the most cancellations
CANCEL_TOP = ("(SELECT o.customer_id FROM orders o WHERE o.status = 'canceled' AND o.customer_id IS NOT NULL GROUP BY o.customer_id ORDER BY count(*) DESC LIMIT 1)")
LAST_CANCELED = f"(SELECT o.id FROM orders o WHERE o.status = 'canceled' AND o.customer_id = {CANCEL_TOP} {ORDERS_RECENT} LIMIT 1)"
task(288, eval={'type': 'answer', 'answer': {'exact': '$sql'}, 'answer_sql': f"SELECT trim(firstname || ' ' || lastname) FROM customers WHERE id = {CANCEL_TOP}"},
     changes=['Re-derived on the merged store: John Smith has 14 canceled orders (6 Luma + 8 shop); Samantha Jones (9) led on the Luma store alone.'])
task(289, eval={'type': 'answer', 'answer': {'fuzzy': '$sql'},
                'answer_sql': f"SELECT 'email: ' || c.email || ', name: ' || trim(c.firstname || ' ' || c.lastname) || ', phone number: ' || (SELECT telephone FROM customer_addresses a WHERE a.id = c.default_billing_id) FROM customers c WHERE c.id = {CANCEL_TOP}"},
     changes=['Re-derived on the merged store: John Smith, john.smith.xyz@gmail.com, 2058812302.'])
task(290, eval={'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': f'SELECT sku FROM order_items WHERE parent_item_id IS NULL AND order_id = {LAST_CANCELED}'},
     changes=['Re-derived on the merged store: John Smith\'s most recent canceled order is shop order 000001122 (1 item, SKU B0875MT5V6).'])
task(291, eval={'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': f"SELECT printf('%.2f', subtotal) FROM orders WHERE id = {LAST_CANCELED}"},
     changes=['Re-derived on the merged store: subtotal of order 000001122 = $40.49 (the Luma reference $148 was the subtotal of Samantha Jones\'s order 000000088).'])
task(292, eval={'type': 'answer', 'answer': {'must_include': '$sql'},
                'answer_sql': f"SELECT count(*) FROM orders WHERE status = 'canceled' AND customer_id = {CANCEL_TOP}"},
     changes=['Re-derived on the merged store: 14 (was 9).'])

# ---- 248 reviews received in a period (All Reviews grid, Created filter)
for tid, cond, what in [(344, '1', 'by far'), (345, "substr(admin_local(created_at), 1, 7) = '2023-04'", 'in Apr 2023'), (346, "substr(admin_local(created_at), 1, 4) = '2022'", 'during 2022'),
                        (347, '1', 'from the beginning'), (348, "substr(admin_local(created_at), 1, 7) = '2023-05'", 'in May 2023')]:
    task(tid, eval={'type': 'answer', 'answer': {'must_include': '$sql'},
                    'answer_sql': num_alts(f'SELECT count(*) AS n FROM reviews WHERE {cond}')},
         changes=[f'Re-derived on the merged store: reviews {what} (both stores\' reviews carry their April 2023 import date: 309,290 in Apr 2023, none in 2022 or May 2023). Thousands commas accepted.'])

task(374, eval={'type': 'url', 'url': f'{H}/admin/admin/system_design_theme/edit/id/1'}, changes=['URL under /admin; theme ids kept (1 Magento Blank).'])
task(375, eval={'type': 'url', 'url': f'{H}/admin/admin/system_design_theme/edit/id/3'}, changes=['URL under /admin (the trailing Magento /key/ segment dropped; both forms load the page); theme 3 Magento Luma.'])

# ---- 237 sale flag
task(423, eval={'type': 'state', 'state_sql': [attr_state(126, 'sale')], 'state_expect': [1]},
     changes=['program_html (product[sale] of product 126) -> product_attributes(126, sale) = 1. Hollister Backyard Sweatshirt is the only Hollister shirt.'])

# ---- 242 disable product
for tid, pid in [(453, 78), (454, 478), (455, 676), (456, 1840), (457, 1819)]:
    task(tid, eval={'type': 'state', 'state_sql': f'SELECT status FROM products WHERE id = {pid}', 'state_expect': 2},
         changes=[f'program_html (product[status] of {pid}) -> products.status = 2 (disabled).'])

# ---- 247 price of this product
for tid, pid, price in [(458, 1481, 27.00), (459, 237, 62.10), (460, 418, 38.25), (461, 721, 29.50), (462, 710, 19.80), (463, 996, 36.80)]:
    task(tid, start=f'/admin/catalog/product/edit/id/{pid}/',
         eval={'type': 'state', 'state_sql': f'SELECT round(price, 2) FROM products WHERE id = {pid}', 'state_expect': price},
         changes=[f'program_html (product[price]) -> products.price = {price:.2f}.'])

# ---- 251 product description quoting positive reviews (storefront product page shows the description)


def desc_has(pid, quotes):
    conds = ' AND '.join(f"instr(lower(description), lower({lit(q)})) > 0" for q in quotes)
    return f'SELECT ({conds}) AS ok FROM products WHERE id = {pid}'


task(464, eval={'type': 'state', 'state_sql': desc_has(1796, ['This is in regular rotation at the gym', 'Its colorful and looks kinda cute under my exercise tanks', "it's very stylish for yoga or something else low impact"]), 'state_expect': 1},
     changes=['program_html (storefront page text) -> products.description of Antonia Racer Tank (1796) contains every quote (case-insensitive).'])
task(543, eval={'type': 'state', 'state_sql': desc_has(1684, ["Good choice for working out and stylin' enough to wear when I'm hanging with friends on hot days", 'Also washes really well', 'Always a sweet n sporty look for the gym', "Keeps me cool and the seams don't rub up against me like some of my other tanks"]), 'state_expect': 1},
     changes=['program_html -> products.description of Bella Tank (1684) contains every quote.'])
task(544, eval={'type': 'state', 'state_sql': desc_has(1108, ['I was super cold and it did the job.', 'The sleeves are definitely thicker than you realize, which is a good thing', 'really quite substantial', 'planning on buying another one of these in another color', 'the best hoodie ive ever owned']), 'state_expect': 1},
     changes=['program_html -> products.description of Selene Yoga Hoodie (1108) contains every quote.'])
task(545, eval={'type': 'state', 'state_sql': desc_has(1556, ['What I rally love here is that it does the job of keeping me cool and dry', "I'm a big guy and sweat A LOT", "Even after a day of gulf, I'm still dry and comfortable", 'What a versatile shirt', 'Not only does it feel very soft compared to my old worn out polos, but it also does the job promised', 'I like going out after my game', "drinks so I look good then too and don't need to change into something fresh"]), 'state_expect': 1},
     changes=['program_html -> products.description of Radiant Tee (1556) contains every quote. The last WebArena quote was split around "game for": review 282 reads "after my gamefor drinks", so a verbatim quote failed the original check.'])
task(546, eval={'type': 'state', 'state_sql': desc_has(1668, ['Comfy though', 'I did like it in the end']), 'state_expect': 1},
     changes=['WebArena checked the Affirm Water Bottle page for a water-bottle review (copy-paste error). Lucia Cross-Fit Bra (1668) has three reviews (1-3 stars); the only positive remarks are "Comfy though" (review 331) and "I did like it in the end" (332): the description must quote both.'])

# ---- 257 cancel order
for tid, oid in [(470, 302), (471, 307), (472, 299), (473, 301), (474, 305)]:
    task(tid, eval={'type': 'state', 'state_sql': f'SELECT status FROM orders WHERE id = {oid}', 'state_expect': 'canceled'},
         changes=[f'program_html (#order_status of order {oid}) -> orders.status = canceled (order ids unchanged).'])

# ---- 275 CMS page title
for tid, pid, title in [(486, 1, 'Bruh bro you clicked the wrong page'), (487, 3, 'Cookie monster coming to your place'), (488, 2, 'This is the home page!! Leave here!!'),
                        (489, 4, 'No privacy policy is needed is this dystopian world'), (490, 5, 'Secret')]:
    twin = {1: 11, 3: 13}.get(pid)  # merged store: the shop's copies have the same title (and the storefront serves them)
    if twin:
        task(tid, eval={'type': 'state', 'state_sql': f'SELECT max(title = {lit(title)}) FROM cms_pages WHERE id IN ({pid}, {twin})', 'state_expect': 1},
             changes=[f'program_html (title input of CMS page {pid}) -> cms_pages.title. Merged store: page {twin} (the shop copy, identifier *-shop, which the storefront serves) has the same title, so either page may be the one renamed.'])
    else:
        task(tid, eval={'type': 'state', 'state_sql': f'SELECT title FROM cms_pages WHERE id = {pid}', 'state_expect': title},
             changes=[f'program_html (title input of CMS page {pid}) -> cms_pages.title (page ids unchanged; the title is unique).'])

# ---- 280 notify a customer in their most recent pending order (order comment, customer notified)


def comment_state(oid, msg):
    return (f"SELECT comment FROM order_status_history WHERE order_id = {oid} AND entity_name = 'order' AND comment IS NOT NULL AND created_at >= '2023-06-12' "
            "ORDER BY created_at DESC, id DESC LIMIT 1"), msg


for tid, oid, msg, note in [
    (491, 299, 'the order is ready to be shipped soon!', 'WebArena expected N/A because its Magento refused to add history to order 299 ("We cannot add order history"); the lite admin adds comments to pending orders, so this is now a state task: Sarah Miller\'s most recent pending order is 000000299.'),
    (492, 1092, 'sorry we are out of stock, please reorder', 'Re-derived on the merged store: Jane Doe\'s most recent pending order is shop order 000001092 (May 4, 2023), not 000000302 (Apr 19).'),
    (493, 65, 'sorry we are bankrupt, please contact our customer service for refund', 'Reference corrected: Grace Nguyen\'s most recent pending order is 000000065 (May 28, 2023); WebArena used 000000307 (Apr 19, 2023), which is not even her latest of that day (000000308).'),
    (494, 304, 'Yo, your order will be shipped soon!', 'Unchanged: Alexander Thomas\'s only pending order is 000000304.'),
    (495, 303, 'Thanks, your order is ready to be shipped!', 'Unchanged: Lily Potter\'s most recent pending order is 000000303.')]:
    s, e = comment_state(oid, msg)
    task(tid, eval={'type': 'state', 'state_sql': [s, f'SELECT is_customer_notified FROM order_status_history WHERE order_id = {oid} AND entity_name = \'order\' AND created_at >= \'2023-06-12\' AND comment = {lit(msg)} ORDER BY id DESC LIMIT 1'],
                    'state_expect': [e, 1]},
         changes=[note, 'program_html (newest comment of the order) -> the newest new order_status_history comment equals the message, with "Notify Customer by Email" checked (the task says notify).'])

# ---- 284 tracking number


def track_state(oid, carrier, number):
    return f"SELECT carrier_code, track_number FROM shipment_tracks WHERE order_id = {oid} AND track_number = {lit(number)}", [[carrier, number]]


for tid, oid, carrier, label, number in [(496, 299, 'fedex', 'Federal Express', '8974568499'), (497, 307, 'dhl', 'DHL', '24353446464'), (498, 306, 'ups', 'United Parcel Service', '55591023930'),
                                         (499, 304, 'usps', 'United States Postal Service', '13849373987'), (500, 301, 'dhl', 'DHL', '239028439840')]:
    s, e = track_state(oid, carrier, number)
    task(tid, eval={'type': 'state', 'state_sql': s, 'state_expect': e},
         changes=[f'program_html ("Tracking number {number} for {label} assigned" in the comments history) -> a shipment_tracks row of order {oid} with carrier {carrier} and that number (the history line is generated from it).'])

# ---- 287 out of stock (configurable parent, as WebArena checked)
for tid, pid in [(501, 350), (502, 446), (503, 682), (504, 1108), (505, 1861)]:
    task(tid, eval={'type': 'state', 'state_sql': f'SELECT is_in_stock FROM products WHERE id = {pid}', 'state_expect': 0},
         changes=[f'program_html (stock status of product {pid}) -> products.is_in_stock = 0 for the configurable product (as WebArena checked; children optional).'])

# ---- 240 order address


def addr_state(oid, parts, region):
    conds = ' AND '.join(f"instr(lower(street || ' ' || city || ' ' || postcode), lower({lit(p)})) > 0" for p in parts)
    return f"SELECT count(*) FROM order_addresses WHERE order_id = {oid} AND {conds} AND region_id = (SELECT id FROM regions WHERE country_id = 'US' AND code = {lit(region)})"


for tid, oid, parts, region in [(538, 299, ['456 Oak Avenue', 'Apartment 5B', 'New York', '10001'], 'NY'), (539, 65, ['789 Pine Lane', 'San Francisco', '94102'], 'CA'),
                                (540, 301, ['321 Birch Boulevard', 'Suite 200', 'Dallas', '75201'], 'TX'), (541, 125, ['654 Elm Drive', 'Apartment 12', 'Miami', '33101'], 'FL'),
                                (542, 300, ['987 Cedar Court', 'Los Angeles', '90012'], 'CA')]:
    task(tid, eval={'type': 'state', 'state_sql': addr_state(oid, parts, region), 'state_expect': {'min': 1}},
         changes=[f'program_html (order {oid} page contains the new address) -> an address of the order (billing or shipping, like the page check) has the street/city/postcode and state {region}.'])

# ---- 252 add configurable variants


def variants_state(pid, combos):
    """the configurable has a child for every (size, color) combo (by the child's size/color labels, so the name
    the agent types does not matter; WebArena checked the default child names)."""
    conds = ' OR '.join(f'(c.size = {lit(sz)} AND c.color = {lit(co)})' for sz, co in combos)
    return (f"SELECT DISTINCT c.size, c.color FROM product_variants v JOIN products c ON c.id = v.child_id WHERE v.parent_id = {pid} AND ({conds})",
            {'count': len(combos)})


for tid, pid, combos, names, note in [
    (547, 1130, [('S', 'Brown')], 'Phoebe Zipper Sweatshirt-S-Brown', ''),
    (548, 110, [('S', 'Blue'), ('M', 'Blue')], 'Frankie  Sweatshirt-S-Blue / -M-Blue', ' (the product name has two spaces, "Frankie  Sweatshirt", which the old name check depended on)'),
    (549, 1492, [('XXXL', 'Green')], 'Minerva LumaTech&trade; V-Tee-XXXL-Green', '; size XXXL is not a size option yet (Stores > Attributes > Product > size: add the option first)'),
    (550, 1732, [('XXS', 'Blue'), ('XXS', 'Purple')], 'Nona Fitness Tank-XXS-Blue / -XXS-Purple', '; size XXS has to be added to the size attribute first'),
    (551, 1854, [(sz, co) for sz in ('30', '31') for co in ('Blue', 'Black', 'Orange')], 'Diana Tights-30/31-Blue/Black/Orange', '')]:
    s, e = variants_state(pid, combos)
    task(tid, eval={'type': 'state', 'state_sql': s, 'state_expect': e},
         changes=[f'program_html (Configurations table of {pid} contains {names}) -> product_variants of {pid} has a child with each size/color: '
                  + ', '.join(f'{a}/{b}' for a, b in combos) + note + '.'])

# ---- 253 lookup orders by status (orders grid status filter)
for tid, code, label in [(676, 'fraud', 'Suspected Fraud'), (677, 'processing', 'Processing'), (678, 'canceled', 'Canceled'), (679, 'complete', 'Complete'), (680, 'holded', 'On Hold')]:
    task(tid, eval={'type': 'url', 'url': f'{H}/admin/sales/order/?status={code}'},
         changes=[f'url_match + program_html ("{label}" in the active-filters bar of the last page) -> the orders grid URL with the Status filter status={code} (the filter bar is rendered from that parameter).'])

# ---- 256 new simple product
SETS = {'Top': 9, 'Bottom': 10, 'Gear': 11}


def new_product_state(name, price, qty, set_name, size_id, color_id, cats):
    p = f"(SELECT max(id) FROM products WHERE id > {MAX_PRODUCT} AND name = {lit(name)})"
    sqls = [f"SELECT type, round(price, 2), CAST(qty AS INTEGER), is_in_stock, attribute_set_id FROM products WHERE id = {p}"]
    exps = [[['simple', price, qty, 1, SETS[set_name]]]]
    if size_id:
        sqls.append(f"SELECT size_option_id FROM products WHERE id = {p}"); exps.append(size_id)
    sqls.append(f"SELECT color_option_id FROM products WHERE id = {p}"); exps.append(color_id)
    sqls.append(f"SELECT count(*) FROM product_categories pc JOIN categories c ON c.id = pc.category_id WHERE pc.product_id = {p} AND c.id IN ({', '.join(str(c) for c in cats)})")
    exps.append({'min': 1})
    return sqls, exps


for tid, name, price, qty, set_name, size_id, color_id, cats, catname in [
    (694, 'Energy-Bulk Women Shirt', 60.00, 50, 'Top', 167, 50, [21, 12], 'Tops (Women or Men)'),
    (695, 'Energy-Bulk Man Yoga Pant', 69.99, 50, 'Bottom', 179, 60, [13, 22], 'Bottoms (Men or Women)'),
    (696, 'FancyBoy Man Causal Jeans', 169.99, 42, 'Bottom', 177, 50, [13, 22], 'Bottoms (Men or Women)'),
    (697, 'Swaatch Smart Watch', 769.99, 42, 'Gear', None, 50, [6], 'Gear > Watches'),
    (698, 'Lelelumon Yoga Mat', 769.99, 42, 'Gear', None, 49, [5], 'Gear > Fitness Equipment')]:
    s, e = new_product_state(name, price, qty, set_name, size_id, color_id, cats)
    task(tid, eval={'type': 'state', 'state_sql': s, 'state_expect': e},
         changes=[f'url_match (/catalog/product) + program_html (fields of the saved product) -> state of the new product named "{name}": simple, price {price:.2f}, qty {qty}, in stock, attribute set {set_name}'
                  + (f', size option {size_id}' if size_id else '') + f', color option {color_id}, category {catname}. The URL check was dropped (the state check covers it).'])

# ---- 258 cart price rule
ALL_GROUPS = "(','||replace(customer_group_ids,' ','')||',') LIKE '%,0,%' AND (','||replace(customer_group_ids,' ','')||',') LIKE '%,1,%' AND (','||replace(customer_group_ids,' ','')||',') LIKE '%,2,%' AND (','||replace(customer_group_ids,' ','')||',') LIKE '%,3,%'"
for tid, name, action, amount in [(699, 'spring sale', 'by_percent', 20), (700, 'fall discount', 'cart_fixed', 10), (701, "Mother's day sale", 'cart_fixed', 15),
                                  (702, 'Pride Month', 'by_percent', 45), (703, 'Thanks giving sale', 'cart_fixed', 40)]:
    acts = "simple_action IN ('cart_fixed', 'by_fixed')" if action == 'cart_fixed' else f"simple_action = {lit(action)}"
    task(tid, eval={'type': 'state',
                    'state_sql': f"SELECT ({acts}) AS action_ok, round(discount_amount, 2) AS amount, ({ALL_GROUPS}) AS all_groups FROM sales_rules WHERE id > {MAX_RULE_SQL} AND instr(lower(name), lower({lit(name)})) > 0 ORDER BY id DESC LIMIT 1",
                    'state_expect': [[1, amount, 1]]},
         changes=['url_match + program_html (fields of the saved rule) -> the newest new cart price rule whose name contains "' + name + '": action ' + ('"Fixed amount discount for whole cart" (or per item)' if action == 'cart_fixed' else '"Percent of product price discount"')
                  + f', discount {amount}, all four customer groups ("for all customers"; WebArena\'s selectedIndex check was inconsistent with that). One website only, so the website check is implicit.'])

# ---- 268 / 271 reports with date ranges (the report run of the last report page shown)


def report_state(rtype, frm, to):
    return (f"SELECT type, json_extract(params, '$.from') AS f, json_extract(params, '$.to') AS t FROM temp.admin_report_runs ORDER BY coalesce(last_shown, 0) DESC, id DESC LIMIT 1",
            [[rtype, frm, to]])


for tid, rtype, frm, to, note in [
    (704, 'sales', '2023-02-01', '2023-02-28', 'last month of 3/15/2023'), (705, 'sales', '2023-01-29', '2023-03-15', '45 days back from 3/15/2023 (WebArena: 1/29/23-3/15/23)'),
    (706, 'refunded', '2023-01-01', '2023-03-31', 'Q1 2023'), (707, 'sales', '2022-01-01', '2022-12-31', 'last year'), (708, 'tax', '2023-01-01', '2023-12-31', 'this year'),
    (709, 'sales', '2021-05-01', '2022-03-31', ''), (710, 'shipping', '2022-08-05', '2023-03-01', ''), (711, 'viewed', '2021-07-05', '2023-05-31', ''),
    (712, 'coupons', '2021-05-01', '2023-05-15', ''), (713, 'bestsellers', '2022-05-01', '2023-05-31', '')]:
    s, e = report_state(rtype, frm, to)
    task(tid, eval={'type': 'state', 'state_sql': s, 'state_expect': e},
         changes=[f'url_match (report path) + program_html (From/To inputs of the last page) -> the last report shown (temp.admin_report_runs, newest last_shown) is the {rtype} report for {frm}..{to}' + (f' ({note})' if note else '') + '. Dates compared as parsed days, so 2/1/23, 02/01/2023 and 2023-02-01 all pass.'])

# ---- 241 stock arrivals
task(768, eval={'type': 'state', 'state_sql': 'SELECT CAST(qty AS INTEGER), is_in_stock FROM products WHERE id = 872', 'state_expect': [[5, 1]]},
     changes=['program_html (qty and stock status of 872) -> Cronus Yoga Pant -33-Blue qty 5, in stock.'])
task(769, eval={'type': 'state', 'state_sql': 'SELECT id, CAST(qty AS INTEGER) FROM products WHERE id IN (544, 547, 550, 553, 556) ORDER BY id', 'state_expect': [[544, 478], [547, 478], [550, 478], [553, 478], [556, 478]]},
     changes=['program_html -> the five brown Aero Daily Fitness Tee children (XS-XL) have qty 100 + 378 = 478.'])
task(770, eval={'type': 'state', 'state_sql': 'SELECT id, CAST(qty AS INTEGER) FROM products WHERE id IN (1836, 1838) ORDER BY id', 'state_expect': [[1836, 112], [1838, 156]]},
     changes=['program_html -> Cora Parachute Pant-28-White qty 112, -29-Blue qty 156.'])

# ---- 243 approve positive pending reviews
task(771, eval={'type': 'state', 'state_sql': ["SELECT id, status FROM reviews WHERE id IN (347, 352) ORDER BY id", "SELECT id, status FROM reviews WHERE id IN (349, 351, 353) ORDER BY id"],
                'state_expect': [[[347, 'approved'], [352, 'approved']], [[349, 'pending'], [351, 'pending'], [353, 'pending']]]},
     changes=['program_html (status of reviews 352, 349, 347) -> the positive pending reviews 347 (5 stars, "extremely satisfied") and 352 (4 stars, "quite happy") approved.',
              'Reference corrected: 349 (3 stars, "I\'m not impressed ... zipper is really hard to use") is not positive, so it must stay pending, with the negative 351 and 353 (1 star); otherwise "approve everything" passes.'])

# ---- 246 delete reviews


def gone(ids):
    return f"SELECT count(*) FROM reviews WHERE id IN ({', '.join(str(i) for i in ids)})", 0


def kept(ids):
    return f"SELECT count(*) FROM reviews WHERE id IN ({', '.join(str(i) for i in ids)})", len(ids)


for tid, dele, keep, note in [
    (772, [353], [352], 'WebArena checked review 999 (does not exist, so the check always passed); the pending negative Circe fleece review is 353 (1 star); 352 (4 stars) must stay.'),
    (773, [351, 353], [347, 352], 'reviews 351 and 353 (1 star); the positive pending reviews 347 and 352 must stay (349, 3 stars "not impressed", may go either way).'),
    (774, [349, 351, 353], [347, 352], 'pending reviews with 1-3 stars: 349, 351, 353; 347 (5) and 352 (4) must stay.'),
]:
    s1, e1 = gone(dele)
    sqls, exps = [s1], [e1]
    if keep:
        s2, e2 = kept(keep); sqls.append(s2); exps.append(e2)
    task(tid, eval={'type': 'state', 'state_sql': sqls, 'state_expect': exps},
         changes=['program_html ("Rating isn\'t Available" on the deleted review\'s edit page) -> the review rows are gone; ' + note])
for tid, nick, n_exact, n_like, old in [(775, 'Arden', 3, 148, 'review 51'), (776, 'Carlo', 34, 301, 'reviews 93 and 109')]:
    task(tid, eval={'type': 'state',
                    'state_sql': [f"SELECT count(*) FROM reviews WHERE lower(trim(nickname)) = lower({lit(nick)})",
                                  f"SELECT count(*) FROM reviews WHERE nickname LIKE {lit('%' + nick + '%')} AND lower(trim(nickname)) <> lower({lit(nick)})"],
                    'state_expect': [0, n_like]},
         changes=[f'Re-derived on the merged store: the reviewer "{nick}" wrote {old} on the Luma store and {n_exact - len(old.split(",")) if False else n_exact} reviews in all (shop reviews included); every review with nickname exactly "{nick}" must be gone, and the {n_like} reviews of look-alike nicknames (e.g. "{nick}s ...", substring matches of the grid\'s Nickname filter) must stay.',
                  'program_html ("Rating isn\'t Available" on the deleted review\'s edit page) -> review rows.'])

task(790, eval={'type': 'answer', 'answer': {'fuzzy': 'N/A'}},
     changes=['Unchanged: the three Sybil Running Short reviews (301-303) are 4-5 stars, nothing to delete; answer N/A (fuzzy).'])

# ---- 742 price changes of variants
for tid, pids, price, note in [
    (777, [111, 114, 117, 120, 123], 47.00, ''), (778, [1841, 1842, 1843], 64.88, ''), (779, [1559, 1562, 1565], 20.40, ''),
    (780, [1264, 1267], 101.00, 'Reference corrected: Ingrid Running Jacket L/XL White cost $84.00, +$17 = $101.00 (WebArena said 64.00).'),
    (781, [1573], 32.88, ''),
    (782, [496, 499], 35.67, 'Reference corrected: +23% of $29.00 = $35.67 (Crew-Neck XS/S) and of $28.00 = $34.44 (V-neck XS/S); WebArena\'s 22.33 / 21.56 are a 23% DEcrease.')]:
    if tid == 782:
        sql = 'SELECT id, round(price, 2) FROM products WHERE id IN (479, 482, 496, 499) ORDER BY id'
        exp = [[479, 34.44], [482, 34.44], [496, 35.67], [499, 35.67]]
    else:
        sql = f"SELECT id, round(price, 2) FROM products WHERE id IN ({', '.join(map(str, pids))}) ORDER BY id"
        exp = [[p, price] for p in sorted(pids)]
    task(tid, eval={'type': 'state', 'state_sql': sql, 'state_expect': exp},
         changes=['program_html (product[price] of each variant) -> products.price of the variant rows.'] + ([note] if note else []))
    if tid == 782:
        T[tid]['intent'] = 'Increase the price of all blue running tshirts of the Luma Apparel department in extra small and small sizes by 23%'
        T[tid]['changes'].append('Scoped to the Luma Apparel department: the merged store has many shop running t-shirts (sizes/colors as custom options, not variants).')
T[780]['start'] = '/admin/catalog/product/edit/id/1481/'


def lite_start(url):
    if not url.startswith(H):
        raise ValueError(url)
    rest = url[len(H):]
    return f'{H}/admin' + (rest if rest.startswith('/') else '/' + rest if rest else '')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC)
    ap.add_argument('--out', default=os.path.join(HERE, 'webarena-admin.jsonl'))
    ap.add_argument('--verify', default=os.path.join(HERE, 'verify-admin.jsonl'), help='status = verified for tasks with an ok manual run (and an ok negative check where logged)')
    a = ap.parse_args()
    src = [t for t in json.load(open(a.src)) if t['sites'] == ['shopping_admin']]
    ok = {}
    if os.path.exists(a.verify):
        for line in open(a.verify):
            if line.strip():
                v = json.loads(line)
                if not v.get('negative'):
                    ok[v['task_id']] = v.get('ok')
    out = []
    missing = [t['task_id'] for t in src if t['task_id'] not in T]
    if missing:
        raise SystemExit(f'no conversion for {missing}')
    for t in src:
        c = T[t['task_id']]
        status = c.get('status') or ('verified' if ok.get(t['task_id']) else 'unverified')
        rec = {
            'task_id': t['task_id'], 'site': 'shopping_admin', 'intent': c.get('intent', t['intent']), 'intent_template': t['intent_template'],
            'intent_template_id': t['intent_template_id'], 'instantiation_dict': t.get('instantiation_dict', {}),
            'start_url': lite_start(H + c['start']) if 'start' in c else lite_start(t['start_url']),
            'require_login': True, 'login_user': 'admin', 'eval': c['eval'],
            'changes': (['Intent changed: ' + json.dumps(t['intent']) + ' -> ' + json.dumps(c['intent'])] if 'intent' in c else []) + c.get('changes', []),
            'status': status, 'drop_reason': c.get('drop_reason'),
        }
        out.append(rec)
    with open(a.out, 'w') as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    n = {}
    for r in out:
        n[r['status']] = n.get(r['status'], 0) + 1
    print(f'{len(out)} tasks -> {a.out}: {n}')


if __name__ == '__main__':
    main()
