#!/usr/bin/env python3
"""Convert the 187 WebArena shopping-only tasks to the websandbox store storefront.

    python3 -I tasks/store/convert_shopping.py [--src .../test.raw.json] [--db .../base.db]
                                                [--out tasks/store/webarena-shopping.jsonl]

One task per line (docs/CONVENTIONS.md "WebArena tasks"), site "shopping", host placeholder
__SHOPPING__. Evaluators:
  string_match  -> answer (exact / must_include / fuzzy), + answer_sql where the reference is
                   data-derived (order totals, prices, counts) so it is recomputed on the tenant;
  url_match     -> url (lite URLs = Magento URLs; shop order ids +1000; sorted listings carry an
                   explicit product_list_dir, see sites/store/ROUTES.md);
  program_html  -> state_sql + state_expect on the tenant DB (cart, wishlist, orders, reviews,
                   newsletter, address book, contact-form draft in the session).
The base DB (read-only) is used only to look up ids at conversion time; references were checked
on base.db and by manual UI runs (tasks/store/verify-shopping.jsonl). Notes: docs/NOTES-store.md.
"""
import argparse
import json
import os
import re
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = '$WEBARENA_TASKS'
DB = '$WSB_DATA_ROOT/store/base.db'
EMMA = 'emma.lopez@gmail.com'
ME = 70  # customers.id of emma.lopez@gmail.com (shop customer 27, merged)
TODAY = '2023-06-12'  # store clock; every imported order is older, every rollout order newer
ORDER_OFFSET = 1000   # shop order ids and increment ids (+1000)

# Final price as the storefront shows it (special price within its window, store clock).
FP = ("(CASE WHEN p.special_price IS NOT NULL AND (p.price IS NULL OR p.special_price < p.price) "
      "AND (p.special_from IS NULL OR substr(p.special_from, 1, 10) <= today()) "
      "AND (p.special_to IS NULL OR substr(p.special_to, 1, 10) >= today()) THEN p.special_price ELSE p.price END)")
# Local (America/New_York) date of an order. -5 h gives the same local date as the real zone
# for every imported order (none falls in the 04:00-05:00 UTC hour during DST).
LOCAL_DATE = "date(o.created_at, '-5 hours')"
MY_BASE_ORDERS = f"o.customer_id = {ME} AND o.created_at < '{TODAY}'"


def lit(s):
    return "'" + str(s).replace("'", "''") + "'"


def money_alts(x):
    """SQL: '745.00' plus the forms people write: '17,774.32' for >= 1000, '35' for whole dollars
    (one must_include entry with |OR| alternatives)."""
    return (f"(printf('%.2f', {x}) "
            f"|| CASE WHEN {x} >= 1000 THEN ' |OR| ' || printf('%d', CAST({x} / 1000 AS INTEGER)) || ',' || printf('%06.2f', {x} - CAST({x} / 1000 AS INTEGER) * 1000) ELSE '' END "
            f"|| CASE WHEN {x} = CAST({x} AS INTEGER) THEN ' |OR| ' || printf('%d', CAST({x} AS INTEGER)) ELSE '' END)")


def widen(ref):
    """Numeric must_include references: the kit grader matches whole numbers only ("406" is not in
    "$406.00"), so add the other common written forms: 406 -> 406.00, 27.6 -> 27.60."""
    out = []
    for alt in str(ref).split(' |OR| '):
        out.append(alt)
        if re.fullmatch(r'\d+', alt):
            out.append(alt + '.00')
        elif re.fullmatch(r'\d+\.\d', alt):
            out.append(alt + '0')
    return ' |OR| '.join(dict.fromkeys(out))


def has_all(expr, needles):
    """SQL: expr contains every needle (case-insensitive); a needle may be a list of alternatives."""
    parts = []
    for n in needles:
        alts = n if isinstance(n, (list, tuple)) else [n]
        parts.append('(' + ' OR '.join(f'instr(lower({expr}), lower({lit(a)})) > 0' for a in alts) + ')')
    return ' AND '.join(parts) or '1'


def product_id_sql(sku):
    return f'(SELECT id FROM products WHERE sku = {lit(sku)})'


# ------------------------------------------------------------------ state checks
def latest_new_order_has(skus):
    """The customer's newest order placed during the rollout contains one of the products."""
    ids = ', '.join(product_id_sql(s) for s in skus)
    return (f"SELECT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.product_id IN ({ids})) AS ok, "
            f"o.increment_id, (SELECT group_concat(i.sku) FROM order_items i WHERE i.order_id = o.id) AS skus "
            f"FROM orders o WHERE o.customer_id = {ME} AND o.created_at >= '{TODAY}' ORDER BY o.id DESC LIMIT 1")


def cart_has(pid, not_pids=()):
    cart = f"cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.customer_id = {ME} AND c.is_active = 1"
    neg = ' AND '.join(f'NOT EXISTS (SELECT 1 FROM {cart} AND ci.product_id = {x})' for x in not_pids) or '1'
    return f"SELECT (EXISTS (SELECT 1 FROM {cart} AND ci.product_id = {pid}) AND {neg}) AS ok"


WISH = f"wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id JOIN products p ON p.id = wi.product_id WHERE w.customer_id = {ME}"


def wishlist_has(pid):
    return f"SELECT EXISTS (SELECT 1 FROM {WISH} AND wi.product_id = {pid}) AS ok"


def wishlist_new_item_named(needles):
    """A product added to the wishlist during the rollout whose name has every needle."""
    return (f"SELECT EXISTS (SELECT 1 FROM {WISH} AND wi.added_at >= '{TODAY}' AND {has_all('p.name', needles)}) AS ok")


def address_ok(street_parts, city, region, postcode):
    def one(col):
        a = f"(SELECT a.* FROM customer_addresses a WHERE a.id = (SELECT {col} FROM customers WHERE id = {ME}))"
        return (f"(SELECT {has_all('x.street', street_parts)} AND x.city = {lit(city)} AND x.postcode = {lit(postcode)} "
                f"AND coalesce((SELECT name FROM regions WHERE id = x.region_id), x.region) = {lit(region)} FROM {a} x)")
    return f"SELECT coalesce({one('default_billing_id')}, 0) AND coalesce({one('default_shipping_id')}, 0) AS ok"


def review_sql(sku):
    return (f"SELECT r.nickname, v.percent FROM reviews r JOIN review_votes v ON v.review_id = r.id "
            f"WHERE r.product_id = {product_id_sql(sku)} AND r.customer_id = {ME} AND r.created_at >= '{TODAY}' "
            f"ORDER BY r.id DESC, v.rating_id DESC LIMIT 1")


DRAFT = "json_extract(data, '$.contact_draft.comment')"


def draft_has(needles):
    """The newest unsent contact-form draft of the customer's session contains every needle
    (storefront autosave, ROUTES.md /contact/draft)."""
    return (f"SELECT {has_all('d', needles)} AS ok, d FROM (SELECT {DRAFT} AS d FROM kit_sessions "
            f"WHERE user_id = {ME} AND {DRAFT} IS NOT NULL AND {DRAFT} <> '' ORDER BY json_extract(data, '$.contact_draft.at') DESC LIMIT 1)")


NOT_SUBMITTED = "SELECT count(*) FROM contact_messages"  # "Don't submit yet": no message sent


# ------------------------------------------------------------------ answers
def complete_orders_since(start):
    return (f"SELECT count(*) || ' orders, $' || printf('%.2f', total(o.grand_total)) || ' total spend' FROM orders o "
            f"WHERE {MY_BASE_ORDERS} AND o.status = 'complete' AND {LOCAL_DATE} >= {lit(start)}")


def latest_order_total(where):
    return f"SELECT printf('%.2f', o.grand_total) FROM orders o WHERE {MY_BASE_ORDERS} AND {where} ORDER BY o.created_at DESC LIMIT 1"


def latest_order_number(status):
    return f"SELECT CAST(CAST(o.increment_id AS INTEGER) AS TEXT) || ' |OR| ' || o.increment_id FROM orders o WHERE {MY_BASE_ORDERS} AND o.status = {lit(status)} ORDER BY o.created_at DESC LIMIT 1"


def spent_between(a, b):
    """Total of the customer's non-canceled orders with local date in [a, b)."""
    return f"SELECT printf('%.2f', total(o.grand_total)) FROM orders o WHERE {MY_BASE_ORDERS} AND o.status <> 'canceled' AND {LOCAL_DATE} >= {lit(a)} AND {LOCAL_DATE} < {lit(b)}"


def search_match(q):
    """FTS MATCH string the storefront search builds for q (kit.search.prepare, prefix 'none')."""
    words = [w.lower() for w in re.findall(r'\w+', q)]
    return ' AND '.join('"' + w + '"' for w in words)


def search_price_range(q):
    """Lowest and highest price among the storefront's search results for q (all words required,
    stemmed; what the result page shows when sorted by price)."""
    rows = (f"SELECT {FP} AS fp FROM product_search s JOIN products p ON p.id = s.rowid "
            f"WHERE product_search MATCH {lit(search_match(q))} AND p.status = 1 AND p.visibility IN (3, 4)")
    return (f"WITH r AS ({rows}) SELECT {money_alts('x')} FROM (SELECT min(fp) AS x FROM r WHERE fp IS NOT NULL "
            f"UNION ALL SELECT max(fp) FROM r WHERE fp IS NOT NULL)")


def brand_price_range(brand):
    """Price range of the products of a brand: the Brand attribute or the product name starts
    with the brand (case-insensitive; e.g. 'Amazon Basics ...', 'UGREEN ...')."""
    b = brand.lower()
    rows = (f"SELECT {FP} AS fp FROM products p WHERE p.status = 1 AND p.visibility IN (3, 4) "
            f"AND (lower(coalesce(p.brand, '')) LIKE {lit(b + '%')} OR lower(p.name) LIKE {lit(b + '%')})")
    return f"WITH r AS ({rows}) SELECT {money_alts('x')} FROM (SELECT min(fp) AS x FROM r UNION ALL SELECT max(fp) FROM r)"


# ------------------------------------------------------------------ helpers on base.db
class Base:
    def __init__(self, path):
        self.db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        self.db.create_function('today', 0, lambda: TODAY)

    def one(self, sql, *a):
        r = self.db.execute(sql, a).fetchone()
        return r[0] if r else None

    def pid_by_key(self, key):
        return self.one('SELECT id FROM products WHERE url_key = ?', key)

    def pid_by_name(self, name):
        return self.one('SELECT id FROM products WHERE name = ? AND status = 1', name)

    def product_urls(self, pid):
        key = self.one('SELECT url_key FROM products WHERE id = ?', pid)
        return [f'__SHOPPING__/{key}.html', f'__SHOPPING__/catalog/product/view/id/{pid}']


def key_of(url):
    m = re.match(r'^__SHOPPING__/(.+)\.html$', url.strip())
    return m.group(1) if m else None


NA = {'fuzzy': 'N/A'}


def convert(t, B):
    """-> (intent, start_url, eval, changes, status, drop_reason)"""
    tid = t['task_id']
    tpl = t['intent_template_id']
    ev0 = t['eval']
    ra = ev0.get('reference_answers') or {}
    intent = t['intent']
    start = t['start_url']
    ch = []
    ev = None

    def ans_static():
        if 'must_include' in ra:
            return {'must_include': ra['must_include']}
        if 'exact_match' in ra:
            return {'exact': ra['exact_match']}
        if 'fuzzy_match' in ra:
            f = ra['fuzzy_match']
            return {'fuzzy': f if isinstance(f, str) else '; '.join(f)}
        raise ValueError(f'task {tid}: no reference answer')

    def keep_answer(note=None):
        nonlocal ev
        ev = {'type': 'answer', 'answer': ans_static()}
        if 'fuzzy' in ev['answer']:
            ch.append(f'Kept fuzzy {json.dumps(ev["answer"]["fuzzy"])} (LLM judge); checked on the lite data' + (f': {note}' if note else '.'))
        else:
            ch.append('Kept the reference answer; checked on the lite data' + (f': {note}' if note else '.'))

    def url_eval(urls, note=None):
        nonlocal ev
        ev = {'type': 'url', 'url': urls if len(urls) > 1 else urls[0]}
        if note:
            ch.append(note)

    ref_url = (ev0.get('reference_url') or '').strip()

    # -------------------------------------------------------------- per template
    if tpl == 222:  # reviewers who mention X (product page)
        keep_answer('the product has the same reviews (nicknames) as in WebArena')
    elif tpl == 197:  # fulfilled orders over a period + total
        start_d = {'over the past month': '2023-05-12', 'over the past three days': '2023-06-09', 'over the past four month': '2023-02-12',
                   'over the past year': '2022-06-12', 'over the past six month': '2022-12-12'}[t['instantiation_dict']['period']]
        ev = {'type': 'answer', 'answer': {'fuzzy': '$sql'}, 'answer_sql': complete_orders_since(start_d)}
        ch.append(f'Reference derived by answer_sql (LLM judge): Complete orders with local order date >= {start_d} (today 6/12/2023) and their Order Total sum.')
        if tid == 50:
            ch.append('Reference corrected: past year = 21 complete orders (WebArena said 24; its total $6560.69 is right).')
        if tid == 51:
            ch.append('Reference corrected: past six months (since 12/12/2022) = 9 complete orders, $1774.62 (WebArena: 12 orders, $1603.69, matches no reading of the data).')
    elif tpl in (193, 161, 135, 182, 134, 666, 1356):
        keep_answer()
    elif tpl == 151:  # jaw bruxism -> show a product page
        pids = [r[0] for r in B.db.execute(
            "SELECT p.id FROM product_search s JOIN products p ON p.id = s.rowid WHERE product_search MATCH '\"bruxism\"' "
            "AND p.status = 1 AND p.visibility IN (3, 4) AND instr(lower(p.name), 'guard') > 0 ORDER BY p.id")]
        intent = 'I have jaw bruxism problem, show me the product page of something that could alleviate the problem.'
        urls = [u for pid in pids for u in B.product_urls(pid)]
        url_eval(urls, f'Intent tightened to "show me the product page": WebArena checked that the last page contains "jaw bruxism" and "mouth guard", '
                       f'which a URL/SQL grader cannot see. Accepted: the product page of any of the {len(pids)} guards (name has "guard") whose name/description mentions bruxism.')
    elif tpl == 159:  # price range of <product> (search)
        q = t['instantiation_dict']['product']
        intent = f'What is the price range of {q} in the One Stop Market? Search the store for "{q}" and give the lowest and the highest price among the results.'
        ev = {'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': search_price_range(q)}
        ch.append('Intent tightened to the search results (the WebArena reference came from Magento/Elasticsearch ranking): '
                  'answer_sql = min and max final price of the storefront search results (all words, stemmed, name/brand/category/SKU/description).')
        ch.append(f'WebArena reference {ra.get("must_include")} replaced by the lite search results.')
    elif tpl == 162:  # spent on category during period
        refs = list(ra['must_include'])
        if tid == 142:
            refs = ['95.5']
            ch.append('Reference corrected 95.23 -> 95.50: Jan 2023 hair care/style items (order 1163: Alaffia conditioner 50.52, headbands 11.99, '
                      'Revlon hair color 17.99) + $5 flat-rate shipping each, the same reading as 141/143/145 (which include shipping).')
        ev = {'type': 'answer', 'answer': {'must_include': refs}}
        if tid != 142:
            ch.append('Kept the reference (item totals incl. $5/item flat-rate shipping); checked on the lite data.')
    elif tpl == 155:  # option configuration of an item
        refs = list(ra['must_include'])
        if refs == ['16x24']:
            refs = ['16x24 |OR| 16*24']
            ch.append('Reference widened: the order shows the option as "Color: Mist 16*24", so 16*24 is accepted too.')
        else:
            ch.append('Kept the reference; checked on the order item options.')
        ev = {'type': 'answer', 'answer': {'must_include': refs}}
    elif tpl in (171, 210, 207):  # product URL
        pid = B.pid_by_key(key_of(ref_url))
        urls = B.product_urls(pid)
        if tid == 286:
            urls += B.product_urls(B.one("SELECT id FROM products WHERE sku = 'B07SNHB4RC'"))
        url_eval(urls, 'Kept the product (same data); URL also accepted as /catalog/product/view/id/<id>.')
        if tid == 286:
            ch.append('Also accepted: SK hynix Gold S31 1TB internal SSD ($97.99), the cheapest product whose NAME says SSD with >= 1TB; '
                      'the reference ($32.17 "External Hard Drive 2TB") is called an external SSD only in its description.')
    elif tpl == 136:  # criticisms
        refs = ra.get('must_include')
        if refs is None:
            keep_answer('the reviews have no criticism')
        else:
            refs = list(refs)
            if tid == 163:
                refs = [r for r in refs if not r.startswith('No original packaging')] + ['No original packaging', "It's used and the previous owners data has not been erased"]
                ch.append('Reference split: "No original packaging It\'s used and ..." joined sentences of two reviews; now two verbatim pieces.')
            if tid == 165:
                refs = [r for r in refs if not r.startswith('The 39 was too small')] + ['The 39 was too small', 'I am afraid the 40 will be too big']
                ch.append('Reference split: the review reads "The 39 was too small.They are so cute! I am afraid the 40 will be too big."; now two verbatim pieces.')
            ev = {'type': 'answer', 'answer': {'must_include': refs}}
            if tid not in (163, 165):
                ch.append('Kept the reference sentences; each is verbatim in the product\'s reviews.')
    elif tpl == 214:  # total of latest <status> order
        st = t['instantiation_dict']['status']
        where = {'cancelled': "o.status = 'canceled'", 'pending': "o.status = 'pending'", 'complete': "o.status = 'complete'", 'non-cancelled': "o.status <> 'canceled'"}.get(st)
        if where is None:
            keep_answer('no order has status processing')
        else:
            ev = {'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': latest_order_total(where)}
            ch.append(f'Reference {ra["must_include"]} re-derived by answer_sql (same value).')
    elif tpl == 370:  # brand price range
        brand = t['instantiation_dict']['brand']
        intent = f'What is the price range for products from {brand}? Count every product whose brand or product name starts with "{brand}".'
        ch.append('Intent tightened: the Brand attribute (lifted from the Amazon details table) is missing or spelled differently on many products '
                  '(e.g. "Amazon Basics ..." mattresses have no brand, UGREEN has 3 spellings), so "products from X" = brand or name starts with X.')
        ev = {'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': brand_price_range(brand)}
        ch.append('answer_sql: min/max final price of products whose Brand or name starts with the brand '
                  '(the WebArena reference was read off Magento search results).')
        if tid in (226, 229, 230):
            ch.append({226: 'Amazon Basics: $5.49 - $375.19 (same as WebArena).', 229: 'UGREEN: $6.99 - $38.99 (same as WebArena).', 230: 'Perricone MD: $35 - $149 (same).'}[tid])
    elif tpl == 213:  # order number of most recent <status>
        st = t['instantiation_dict']['status']
        if st in ('cancelled', 'pending', 'complete'):
            s = {'cancelled': 'canceled'}.get(st, st)
            ref = str(int(ra['must_include'][0]) + ORDER_OFFSET)
            ev = {'type': 'answer', 'answer': {'must_include': [f'{ref} |OR| {int(ref):09d}']}, 'answer_sql': latest_order_number(s)}
            ch.append(f'Order number renumbered (+1000): {ra["must_include"][0]} -> {ref} (order {int(ref):09d}); answer_sql re-derives it.')
        else:
            keep_answer(f'no {st} order')
    elif tpl == 138:  # most expensive product in category
        if tid == 241:
            pid = B.one("SELECT id FROM products WHERE url_key LIKE 'atdoriat-hydrogen-oxygen-facial-skin-beauty-machine%'")
            url_eval(B.product_urls(pid), 'Reference corrected: the most expensive product of the "Skin Care Tools" category (Beauty & Personal Care > Tools & Accessories > Skin Care Tools) '
                                          'is the Atdoriat hydrogen-oxygen facial machine ($529.00); WebArena\'s Medi-Spa system ($1,799.95) is in Skin Care > Maternity, not a skin care tools category.')
        else:
            pid = B.pid_by_key(key_of(ref_url))
            url_eval(B.product_urls(pid), 'Kept the product: it is the most expensive (final price) in the category subtree; also /catalog/product/view/id/<id>.')
    elif tpl == 211:  # browse category
        url_eval([ref_url], 'Kept the category URL (category url_path unchanged).')
    elif tpl == 139:  # under $X in category
        url_eval([ref_url], 'Kept the URL (price=0-X: 0 <= price < X). The lite storefront has a "From $ .. to $ .. Go" form under the Price facet that produces it (Magento needed URL editing).')
    elif tpl == 212:  # search for
        if tid == 277:
            url_eval(['__SHOPPING__/catalogsearch/result/?q=batteries+for+iphone+13'], 'Reference corrected: the WebArena URL searched "iphone 13" for the intent "batteries for iphone 13".')
        else:
            url_eval([ref_url], 'Kept the search URL.')
    elif tpl == 204:  # names + price range
        refs = list(ra['must_include'])
        if tid == 280:
            nm = B.one("SELECT name FROM products WHERE name LIKE 'Anker USB C Charger 30W, 711 Charger%'")
            refs[0] = nm
            ch.append('First reference name corrected to the product\'s exact name ("13 Mini/ 13 Pro/ 13 Pro Max/ 12" has spaces).')
        ev = {'type': 'answer', 'answer': {'must_include': refs}}
        ch.append('Kept the reference names and price range (all products exist with these names and prices; the storefront search for the brand + product type lists them).')
    elif tpl == 180:  # most recent <status> order (URL)
        if ref_url:
            n = int(re.search(r'order_id/(\d+)', ref_url).group(1)) + ORDER_OFFSET
            url_eval([f'__SHOPPING__/sales/order/view/order_id/{n}/'], f'Order id renumbered (+1000): {n - ORDER_OFFSET} -> {n}.')
        else:
            keep_answer('no such order')
    elif tpl == 160:  # refund of cancelled order
        keep_answer('canceled orders and totals unchanged')
    elif tpl == 208:  # search listing sorted
        fixed = {
            324: '__SHOPPING__/catalogsearch/result/index/?q=chairs&product_list_order=price&product_list_dir=asc',
            325: '__SHOPPING__/catalogsearch/result/index/?q=mouth+night+guard&product_list_order=price&product_list_dir=desc',
            326: '__SHOPPING__/catalogsearch/result/?q=Canon+photo+printer',
            327: '__SHOPPING__/catalogsearch/result/index/?q=iphone+12+phone+case&product_list_order=name&product_list_dir=asc',
            328: '__SHOPPING__/catalogsearch/result/index/?q=iphone+12+phone+case&product_list_order=price&product_list_dir=asc',
        }
        u = fixed[tid]
        both = [u, u.replace('/catalogsearch/result/index/?', '/catalogsearch/result/?')] if '/index/' in u else [u, u.replace('/catalogsearch/result/?', '/catalogsearch/result/index/?')]
        url_eval(both, '/catalogsearch/result/ and /catalogsearch/result/index/ are the same page (both accepted). Sorted listings carry an explicit product_list_dir on the lite storefront (a sort without a direction redirects to its default), '
                               'so the reference states the direction.' + (' WebArena\'s reference lacked product_list_dir=desc for "descending".' if tid == 325 else ''))
        if tid == 326:
            ch[-1] = 'Kept the URL (relevance is the default search order; subset match ignores the sort params); /catalogsearch/result/index/ accepted too.'
    elif tpl == 147:  # spend in period
        if tid == 329:
            ev = {'type': 'answer', 'answer': {'must_include': ['0']}, 'answer_sql': spent_between('2023-04-19', '2023-04-20')}
            ch.append('Kept "0"; answer_sql (non-canceled orders that day) = 0.00.')
        elif tid == 330:
            ev = {'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': spent_between('2023-03-01', '2023-04-01')}
            ch.append('Reference corrected 81.31 -> 83.31 (orders 1166 $17.99 + 1180 $65.32; WebArena\'s own task 332 says Mar: 83.31).')
        elif tid == 331:
            ev = {'type': 'answer', 'answer': {'must_include': '$sql'}, 'answer_sql': spent_between('2022-07-01', '2022-08-01')}
            ch.append('Reference 40.16 re-derived by answer_sql (non-canceled orders).')
        elif tid == 332:
            sql = ("SELECT 'Jan: $' || (SELECT printf('%.2f', total(o.grand_total)) FROM orders o WHERE " + MY_BASE_ORDERS + " AND o.status <> 'canceled' AND " + LOCAL_DATE + " >= '2023-01-01' AND " + LOCAL_DATE + " < '2023-02-01')"
                   " || ', Feb: $' || (SELECT printf('%.2f', total(o.grand_total)) FROM orders o WHERE " + MY_BASE_ORDERS + " AND o.status <> 'canceled' AND " + LOCAL_DATE + " >= '2023-02-01' AND " + LOCAL_DATE + " < '2023-03-01')"
                   " || ', Mar: $' || (SELECT printf('%.2f', total(o.grand_total)) FROM orders o WHERE " + MY_BASE_ORDERS + " AND o.status <> 'canceled' AND " + LOCAL_DATE + " >= '2023-03-01' AND " + LOCAL_DATE + " < '2023-04-01')")
            ev = {'type': 'answer', 'answer': {'fuzzy': '$sql'}, 'answer_sql': sql}
            ch.append('Reference corrected by answer_sql (LLM judge): Jan $572.88 (WebArena 572.8), Feb $947.50 = orders 1157 $185.32 + 1161 $762.18 '
                      '(WebArena counted only 1161), Mar $83.31; canceled orders excluded as in 330/331.')
        else:
            keep_answer('Nov 2022 orders 1183 $51.94, 1171 $133.07, 1164 $218.17 x 0.8')
    elif tpl == 169:
        keep_answer('dates shown in America/New_York (order 1163 is 1/16/23 local)')
    elif tpl == 137:  # category sorted by price
        base = ref_url.split('?')[0]
        desc = 'descending' in intent
        u = f'{base}?product_list_order=price&product_list_dir={"desc" if desc else "asc"}'
        url_eval([u], 'Reference states the sort and the direction explicitly (the lite storefront always puts product_list_dir in sorted listing URLs).'
                      + (' WebArena\'s reference had only product_list_dir=desc (no price sort).' if tid == 355 else ''))
    elif tpl == 206:  # order info by order number
        num = str(t['instantiation_dict']['order_number'])
        if tid == 361:
            intent = 'Show me the order statuses for order number 1170 and 1189.'
            ev = {'type': 'answer', 'answer': {'fuzzy': '1170: canceled; 1189: pending'}}
            ch.append('Order numbers renumbered (+1000): 170 -> 1170, 189 -> 1189; reference updated (LLM judge).')
        else:
            new = {'187': '1187', '148': '1148', '00178': '001178'}[num]
            intent = intent.replace(f'order number {num}', f'order number {new}')
            ev = {'type': 'answer', 'answer': ans_static()}
            ch.append(f'Order number renumbered (+1000): {num} -> {new}; reference unchanged ({"LLM judge" if "fuzzy" in ev["answer"] else "same data"}).')
    elif tpl == 188:  # find discounted items
        return intent, start, {'type': 'answer', 'answer': NA}, ['Dropped (see drop_reason).'], 'dropped', (
            'The N/A reference ("no function to show only discount items") does not hold on the merged store: the Luma apparel department has '
            'Sale / Women Sale / Men Sale categories and a "sale" filter, and the home page has a Deals block. "Find discounted items" has no well-defined answer to grade.')
    elif tpl == 1355:
        keep_answer('rating 65% (3.25 stars) from 12 reviews')
    elif tpl == 145:  # lowest per-unit price of the open tabs -> cart
        keys = [key_of(u) for u in start.split(' |AND| ')]
        pids = [B.pid_by_key(k) for k in keys]
        target_name = ra.get('must_include') or [p['required_contents']['must_include'][0] for p in ev0['program_html']][0]
        tname = target_name.split(' |OR| ')[0] if isinstance(target_name, str) else target_name[0]
        win = [pid for pid in pids if B.one('SELECT name FROM products WHERE id = ?', pid).startswith(tname[:30])]
        assert len(win) == 1, (tid, win)
        others = [p for p in pids if p != win[0]]
        ev = {'type': 'state', 'state_sql': cart_has(win[0], others), 'state_expect': 1}
        ch.append(f'program_html (cart page text) -> state_sql: the active cart has product {win[0]} and none of the other open-tab products {others}.')
    elif tpl == 156:  # reorder cancelled item
        sku = ev0['program_html'][0]['required_contents']['must_include'][0]
        if tid == 437:
            sku = 'B087QSCXGT'
            ch.append('Reference corrected B072XS3F6W -> B087QSCXGT: the table lamp canceled in May 2023 is the Uttermost Volterra lamp (order 1170, 5/17/2023); '
                      'B072XS3F6W was canceled in Feb 2023 (order 1158).')
        if tid == 438:
            sku = 'B017SK5E3M'
            ch.append('Reference corrected B08PVHRRB7 -> B017SK5E3M: B08PVHRRB7 is the wall light in canceled order 1177 (Oct 2022); the TV stand in that order is the Manhattan Comforts Nacka TV Stand B017SK5E3M.')
        ev = {'type': 'state', 'state_sql': latest_new_order_has([sku]), 'state_expect': 1}
        ch.append('program_html (latest order page contains the SKU) -> state_sql: the newest order placed in the rollout contains the product.')
    elif tpl in (186, 196):  # add named / this product to wishlist
        if tpl == 186:
            pid = B.pid_by_name(t['instantiation_dict']['product'])
        else:
            pid = B.pid_by_key(key_of(start))
        assert pid, tid
        ev = {'type': 'state', 'state_sql': wishlist_has(pid), 'state_expect': 1}
        ch.append(f'program_html (wishlist page text) -> state_sql: product {pid} is in the customer\'s wish list (empty at start).')
    elif tpl == 172:
        if 'program_html' in ev0['eval_types']:
            sku = ev0['program_html'][0]['required_contents']['must_include'][0]
            skus = [sku]
            if tid == 508:
                skus = ['B07116LGP6', 'B0989N4SWC']
                ch.append('Also accepted B0989N4SWC (HIGOPLAY carry case, $19.99): it ties with the Zelda Multi Pouch at a 100% rating in Nintendo Switch under $60.')
            ev = {'type': 'state', 'state_sql': latest_new_order_has(skus), 'state_expect': 1}
            ch.append('program_html -> state_sql: the newest order placed in the rollout contains the product. Reference re-checked: highest average rating in the category within the budget.')
        else:
            keep_answer('the storefront has no rating sort; the category is too large to compare by hand (thousands of products, many at 100%)')
    elif tpl == 216:
        cat = t['instantiation_dict']['category']
        sku = {509: 'B07LGHBV54', 510: 'B07MSBHCGM'}[tid]
        intent = (f'Buy the best rating product from "{cat}" category with at least 5 reviews; if several products share the best rating, buy the least expensive of them.')
        ev = {'type': 'state', 'state_sql': latest_new_order_has([sku]), 'state_expect': 1}
        ch.append('Intent tightened (WebArena: "...with at least 5 reviews and the product is least expensive", read as a trade-off; its references '
                  f'B01J4MM3KO / B002R5ABIW are neither the best rated nor consistent): best average rating among products with >= 5 reviews, ties -> lowest price. '
                  f'{"Men > Shoes" if tid == 509 else "Home Audio > Speakers"}: {sku}.')
        ch.append('program_html -> state_sql: the newest order placed in the rollout contains the product.')
    elif tpl == 189:  # add a <kind> to wishlist
        needles = ev0['program_html'][0]['required_contents']['must_include']
        ev = {'type': 'state', 'state_sql': wishlist_new_item_named(needles), 'state_expect': 1}
        ch.append(f'program_html (wishlist text contains {needles}) -> state_sql: an item added to the wish list in the rollout whose name contains each word.')
    elif tpl == 199:
        ev = {'type': 'state', 'state_sql': f'SELECT count(*) FROM newsletter_subscribers WHERE customer_id = {ME} AND status = 1', 'state_expect': {'min': 1}}
        ch.append('program_html (newsletter checkbox checked) -> state_sql: a subscribed newsletter_subscribers row for the customer (none at start).')
    elif tpl in (154, 153, 163):  # contact form drafts
        needles = list(ev0['program_html'][0]['required_contents']['must_include'])
        if tid == 529:
            needles = ['refund', 'it broke after three days of use', '000001161', '56.35']
            ch.append('Reference corrected: the bluetooth speaker bought in Feb 2023 is the wangliwer Mini Wireless Bluetooth Speaker, order 000001161, $56.35 '
                      '(WebArena: order 148 $169.95 = Russound wired speakers bought 1/29/2023).')
        out = []
        for n in needles:
            if re.fullmatch(r'0000001\d\d', n):
                n2 = f'{int(n) + ORDER_OFFSET:09d}'
                ch.append(f'Order number renumbered: {n} -> {n2}.')
                n = n2
            elif tpl == 153 and re.fullmatch(r'1\d\d', n):
                n2 = str(int(n) + ORDER_OFFSET)
                ch.append(f'Order number renumbered: {n} -> {n2}.')
                n = n2
            if 'broke after three days of use' in n:
                n = [n, n.replace('broke after three', 'broke after just three')]
            out.append(n)
        if tpl == 153:
            m = re.search(r'#(\d+)', intent)
            new = f'{int(m.group(1)) + ORDER_OFFSET:0{len(m.group(1))}d}'
            intent = intent.replace('#' + m.group(1), '#' + new)
        ev = {'type': ['state'], 'state_sql': [draft_has(out), NOT_SUBMITTED], 'state_expect': [1, 0]}
        if tpl in (153, 163):
            ev['type'] = ['url', 'state']
            ev['url'] = '__SHOPPING__/contact'
        ch.append('program_html (textarea value on the last page) -> state_sql on the contact-form draft the storefront autosaves to the session '
                  '(kit_sessions.data $.contact_draft), plus "not submitted": contact_messages stays empty. "broke after just three days" accepted too.')
    elif tpl == 165:  # address change
        req = [p['required_contents']['must_include'] for p in ev0['program_html']][0]
        street = [x for x in req if not re.search(r', \w+, \d{5}$', x)]
        city, region, postcode = re.search(r'^(.*), (.*), (\d{5})$', [x for x in req if re.search(r', \w+, \d{5}$', x)][0]).groups()
        ev = {'type': 'state', 'state_sql': address_ok(street, city, region, postcode), 'state_expect': 1}
        ch.append(f'program_html (address book boxes) -> state_sql: the default billing and default shipping addresses have street {street}, city {city}, region {region}, ZIP {postcode}.')
    elif tpl == 194:  # rate purchase
        pc = ev0['program_html']
        sku = re.search(r"'(\w+)'", pc[0]['locator']).group(1)
        pct = int(pc[0]['required_contents']['must_include'][0])
        nick = pc[1]['required_contents']['must_include'][0]
        ev = {'type': 'state', 'state_sql': review_sql(sku), 'state_expect': [{'nickname': nick, 'percent': pct}]}
        ch.append(f'program_html (latest review of {sku}: rating {pct}%, author {nick}) -> state_sql on reviews/review_votes (new reviews are pending moderation).')
    elif tpl == 191:
        keep_answer('the storefront has no way to change an order\'s address')
    else:
        raise ValueError(f'unhandled template {tpl} (task {tid})')
    a = ev.get('answer') if isinstance(ev, dict) else None
    if a and isinstance(a.get('must_include'), list) and tpl not in (213, 206):
        w = [widen(r) for r in a['must_include']]
        if w != a['must_include']:
            a['must_include'] = w
            ch.append('Numeric references widened to the usual written forms (e.g. 406 |OR| 406.00): the grader matches whole numbers only.')
    return intent, start, ev, ch, 'verified', None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=SRC)
    ap.add_argument('--db', default=DB)
    ap.add_argument('--out', default=os.path.join(HERE, 'webarena-shopping.jsonl'))
    ap.add_argument('--verify', default=os.path.join(HERE, 'verify-shopping.jsonl'), help='verification log: tasks without an ok manual run stay "unverified"')
    a = ap.parse_args()
    B = Base(a.db)
    tasks = [t for t in json.load(open(a.src)) if t['sites'] == ['shopping']]
    ok = set()
    if os.path.exists(a.verify):
        runs = {}
        for line in open(a.verify):
            if line.strip():
                r = json.loads(line)
                runs.setdefault(r['task_id'], []).append(r)
        ok = {tid for tid, rs in runs.items() if any(r.get('ok') and not r.get('negative') for r in rs)}
    n = {'verified': 0, 'unverified': 0, 'dropped': 0}
    with open(a.out, 'w') as f:
        for t in tasks:
            intent, start, ev, ch, status, drop = convert(t, B)
            if status == 'verified' and t['task_id'] not in ok:
                status = 'unverified'
            n[status] += 1
            tpl_text = t['intent_template']
            out = {
                'task_id': t['task_id'], 'site': 'shopping', 'intent': intent, 'intent_template': tpl_text,
                'intent_template_id': t['intent_template_id'], 'instantiation_dict': t.get('instantiation_dict', {}),
                'start_url': start, 'require_login': True, 'login_user': EMMA, 'eval': ev,
                'changes': ch, 'status': status, 'drop_reason': drop,
            }
            f.write(json.dumps(out, ensure_ascii=False) + '\n')
    print(json.dumps({'tasks': len(tasks), **n, 'out': a.out}))


if __name__ == '__main__':
    main()
