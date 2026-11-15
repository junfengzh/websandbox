"""Task-relevant facts (WebArena task id in the name) checked against base.db by verify.py.

Each check: (name, SQL, expected flat list of values | predicate on the flat list).
Facts that are store-wide aggregates in WebArena are checked on the rows of the
store they came from (source = 'admin' | 'shop'): after the merge the store-wide
answer changes, and task conversion re-derives it (see docs/NOTES-store.md).
Shop orders are renumbered +1000 (id_map), e.g. WebArena shop order 170 -> 1170.
"""

EMMA = "(select id from customers where email='emma.lopez@gmail.com')"

CHECKS = [
    ('0 bestseller 2022 (admin report)',
     "select product_name from report_bestsellers where source='admin' and period_type='yearly' "
     "and period like '2022%' order by rating_pos limit 1", ['Quest Lumaflex&trade; Band']),
    ('11 admin reviews mentioning disappointed',
     "select count(*) from reviews where source='admin' and detail like '%disappointed%'", [6]),
    ('41 top search term (admin)',
     "select query_text from search_terms where source='admin' order by popularity desc limit 1", ['hollister']),
    ('77 pending reviews (admin)', "select count(*) from reviews where source='admin' and status='pending'", [5]),
    ('94 invoice 000000001 grand total', "select grand_total from invoices where increment_id='000000001'", [36.39]),
    ('112 Circe fleece unhappy reviewer',
     "select r.nickname from reviews r join products p on p.id=r.product_id join review_votes v on v.review_id=r.id "
     "where p.name like 'Circe Hooded Ice Fleece' and v.value<=2", lambda f: 'Hannah Lim' in f),
    ('198 most recent cancelled admin order customer',
     "select customer_firstname||' '||customer_lastname from orders where source='admin' and status='canceled' "
     "order by created_at desc limit 1", ['Lily Potter']),
    ('208 customer by phone 2058812302',
     "select c.firstname||' '||c.lastname, c.email from customers c join customer_addresses a on a.customer_id=c.id "
     "where a.telephone like '%2058812302%'", ['John Smith', 'john.smith.xyz@gmail.com']),
    ('344 admin review count', "select count(*) from reviews where source='admin'", [351]),
    ('62 customer with most complete orders (admin)',
     "select customer_firstname||' '||customer_lastname from orders where source='admin' and status='complete' "
     "group by customer_id order by count(*) desc limit 1", ['Jane Smith']),
    ('288 customer with most cancellations (admin)',
     "select customer_firstname||' '||customer_lastname from orders where source='admin' and status='canceled' "
     "group by customer_id order by count(*) desc limit 1", ['Samantha Jones']),
    ('470 order 302 is cancellable (not canceled yet)',
     "select increment_id, status in ('pending','processing') from orders where id=302", ['000000302', 1]),
    ('496 order 299 belongs to Sarah Miller',
     "select customer_firstname||' '||customer_lastname from orders where id=299", ['Sarah Miller']),
    ('486 CMS page 1 is 404 Not Found', "select title, identifier from cms_pages where id=1", ['404 Not Found', 'no-route']),
    ('453 product 78 Teton Pullover Hoodie enabled', "select name, status from products where id=78",
     ['Teton Pullover Hoodie', 1]),
    ('458 product 1481 price 32 (task expects 27.00 after -$5)', "select price from products where id=1481", [32.0]),
    ('547 Phoebe Zipper Sweatshirt (1130) variants',
     "select count(*)>0 from product_variants v join products c on c.id=v.child_id "
     "where v.parent_id=1130 and c.name like 'Phoebe Zipper Sweatshirt-%'", [1]),
    ('464 antonia-racer-tank url', "select name from products where url_key='antonia-racer-tank'", ['Antonia Racer Tank']),
    ('358 shop order 187 (now 000001187) shipping method',
     "select shipping_description from orders where increment_id='000001187'", ['Flat Rate - Fixed']),
    ('188 emma latest cancelled order total',
     "select grand_total from orders where customer_id=%s and status='canceled' order by created_at desc limit 1" % EMMA,
     [365.42]),
    ('231 emma most recent cancelled order number (WebArena 170)',
     "select increment_id from orders where customer_id=%s and status='canceled' order by created_at desc limit 1" % EMMA,
     ['000001170']),
    ('117 emma first purchase 3/2/22',
     "select substr(created_at,1,10) from orders where customer_id=%s order by created_at limit 1" % EMMA, ['2022-03-02']),
    ('146 picture frame bought Sep 2022 is 16x24',
     "select count(*)>0 from order_items i join orders o on o.id=i.order_id where o.customer_id=%s "
     "and o.created_at like '2022-09%%' and i.name like '%%16\"x24\"%%'" % EMMA, [1]),
    ('124 wireless earphone price range ends 0.14 and 745.00 exist',
     "select count(*) from products where source='shop' and ((price=0.14 and name like '%Wireless Earphone%') "
     "or (price=745 and name like 'David Clark PRO-X2%'))", [2]),
    ('585 floor lamp SKU B00J8RZL7I exists', "select count(*) from products where sku='B00J8RZL7I'", [1]),
    ('21 ear-cup reviewers on the 6S wireless headphones page',
     "select count(distinct r.nickname) from reviews r join products p on p.id=r.product_id where p.url_key like "
     "'6s-wireless-headphones-over-ear-noise-canceling%' and r.nickname in "
     "('Joseph Brzezinski','Catso','Dibbins','Anglebert Dinkherhump','Michelle Davis')", [5]),
    ('465 Tide PODS Spring Meadow 81 count is a product',
     "select count(*)>0 from products where name like 'Tide PODS Spring Meadow Scent HE Turbo Laundry Detergent Pacs, 81 Count%'",
     [1]),
    ('260 video-games category url', "select name from categories where url_path='video-games'", ['Video Games']),
    ('351 ps4 accessories category url', "select count(*) from categories where url_path='video-games/playstation-4/accessories'",
     [1]),
    ('emma login exists with password hash',
     "select count(*) from customers where email='emma.lopez@gmail.com' and password_hash is not null", [1]),
]
