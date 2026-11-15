#!/usr/bin/env python3
"""Verify base.db: row counts vs the raw source exports, referential integrity,
FTS consistency, image coverage, and task-relevant spot checks.

Usage: python -I verify.py --db base.db --admin raw_admin.db --shop raw_shop.db [--media media/]
Exit status 1 if any check fails.
"""
import argparse
import os
import sqlite3
import sys

FAIL = []


def check(name, ok, detail=''):
    print('%-4s %s %s' % ('ok' if ok else 'FAIL', name, detail))
    if not ok:
        FAIL.append(name)


# (lite table, where for lite rows of a source, raw table, raw where) - counted per source
COUNTS = [
    ('products', "source='{s}'", 'catalog_product_entity', ''),
    ('orders', "source='{s}'", 'sales_order', ''),
    ('reviews', "source='{s}'", 'review', 'where entity_id=1'),
    ('cms_pages', "source='{s}'", 'cms_page', ''),
    ('cms_blocks', "source='{s}'", 'cms_block', ''),
    ('sales_rules', "source='{s}'", 'salesrule', ''),
    ('catalog_rules', "source='{s}'", 'catalogrule', ''),
    ('url_rewrites', "source='{s}'", 'url_rewrite', 'where store_id=1'),
]
# child tables counted through their parent's source
CHILD = [
    ('order_items', 'order_id', 'orders', 'sales_order_item'),
    ('order_addresses', 'order_id', 'orders', 'sales_order_address'),
    ('order_payments', 'order_id', 'orders', 'sales_order_payment'),
    ('order_status_history', 'order_id', 'orders', 'sales_order_status_history'),
    ('invoices', 'order_id', 'orders', 'sales_invoice'),
    ('shipments', 'order_id', 'orders', 'sales_shipment'),
    ('shipment_tracks', 'order_id', 'orders', 'sales_shipment_track'),
    ('credit_memos', 'order_id', 'orders', 'sales_creditmemo'),
    ('review_votes', 'review_id', 'reviews', 'rating_option_vote'),
    ('product_variants', 'parent_id', 'products', 'catalog_product_super_link'),
    ('product_categories', 'product_id', 'products', 'catalog_category_product'),
]
FKS = [
    ('product_categories', 'product_id', 'products'), ('product_categories', 'category_id', 'categories'),
    ('product_variants', 'parent_id', 'products'), ('product_variants', 'child_id', 'products'),
    ('product_variant_axes', 'product_id', 'products'), ('product_links', 'product_id', 'products'),
    ('product_links', 'linked_product_id', 'products'), ('product_attributes', 'product_id', 'products'),
    ('product_images', 'product_id', 'products'), ('categories', 'parent_id', 'categories'),
    ('reviews', 'product_id', 'products'), ('reviews', 'customer_id', 'customers'),
    ('review_votes', 'review_id', 'reviews'), ('review_votes', 'rating_id', 'ratings'),
    ('customer_addresses', 'customer_id', 'customers'), ('customers', 'default_billing_id', 'customer_addresses'),
    ('customers', 'default_shipping_id', 'customer_addresses'), ('customers', 'group_id', 'customer_groups'),
    ('orders', 'customer_id', 'customers'), ('orders', 'billing_address_id', 'order_addresses'),
    ('orders', 'shipping_address_id', 'order_addresses'), ('order_items', 'order_id', 'orders'),
    ('order_items', 'parent_item_id', 'order_items'), ('order_addresses', 'order_id', 'orders'),
    ('order_payments', 'order_id', 'orders'), ('order_status_history', 'order_id', 'orders'),
    ('invoices', 'order_id', 'orders'), ('invoice_items', 'invoice_id', 'invoices'),
    ('shipments', 'order_id', 'orders'), ('shipment_items', 'shipment_id', 'shipments'),
    ('shipment_tracks', 'shipment_id', 'shipments'), ('credit_memos', 'order_id', 'orders'),
    ('credit_memo_items', 'credit_memo_id', 'credit_memos'), ('wishlist_items', 'wishlist_id', 'wishlists'),
    ('wishlist_items', 'product_id', 'products'), ('wishlists', 'customer_id', 'customers'),
    ('cart_items', 'cart_id', 'carts'), ('carts', 'customer_id', 'customers'),
    ('coupons', 'rule_id', 'sales_rules'), ('newsletter_subscribers', 'customer_id', 'customers'),
    ('attribute_options', 'attribute_code', 'attributes', 'code'),
    ('product_attributes', 'attribute_code', 'attributes', 'code'),
    ('admin_users', 'role_id', 'admin_roles'), ('bundle_selections', 'option_id', 'bundle_options'),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--admin', required=True)
    ap.add_argument('--shop')
    ap.add_argument('--media')
    a = ap.parse_args()
    db = sqlite3.connect('file:%s?mode=ro' % a.db, uri=True)
    raws = {'admin': a.admin}
    if a.shop:
        raws['shop'] = a.shop
    print('# row counts (lite vs source)')
    for s, path in raws.items():
        raw = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
        rt = {r[0] for r in raw.execute("select name from sqlite_master where type='table'")}

        def rc(t, w=''):
            return raw.execute('select count(*) from "%s" %s' % (t, w)).fetchone()[0] if t in rt else 0
        for lt, lw, t, w in COUNTS:
            n = db.execute('select count(*) from %s where %s' % (lt, lw.format(s=s))).fetchone()[0]
            m = rc(t, w)
            # url_rewrites may drop duplicates of a path already taken by the other store
            check('%s.%s' % (s, lt), n == m or (lt == 'url_rewrites' and m - n <= m * 0.01), '%d vs %d' % (n, m))
        for lt, fk, parent, t in CHILD:
            n = db.execute('select count(*) from %s c join %s p on p.id=c.%s where p.source=?' % (lt, parent, fk), (s,)).fetchone()[0]
            m = rc(t)
            check('%s.%s' % (s, lt), n == m, '%d vs %d' % (n, m))
        emails = [r[0].lower() for r in raw.execute('select email from customer_entity')]
        have = {r[0].lower() for r in db.execute('select email from customers')}
        nn = db.execute('select count(*) from customers where source=?', (s,)).fetchone()[0]
        check('%s.customers' % s, all(e in have for e in emails),
              '%d source customers, %d new rows, %d merged by e-mail' % (len(emails), nn, len(emails) - nn))
    print('# referential integrity')
    for fk in FKS:
        t, c, p = fk[:3]
        pc = fk[3] if len(fk) > 3 else 'id'
        n = db.execute("select count(*) from %s where %s is not null and %s not in (0, '') and %s not in (select %s from %s)"
                       % (t, c, c, c, pc, p)).fetchone()[0]
        check('fk %s.%s -> %s' % (t, c, p), n == 0, '%d dangling' % n)
    print('# uniqueness / search')
    for t, c in (('products', 'url_key'), ('categories', 'url_path'), ('orders', 'increment_id'), ('customers', 'email')):
        n = db.execute('select count(*) from (select %s from %s where %s is not null group by 1 having count(*)>1)'
                       % (c, t, c)).fetchone()[0]
        check('unique %s.%s' % (t, c), n == 0, '%d duplicates' % n)
    rw = sqlite3.connect(a.db)
    for t in ('product_search', 'product_search_tri'):
        try:
            rw.execute("insert into %s(%s, rank) values('integrity-check', 1)" % (t, t))
            check('fts integrity %s' % t, True)
        except sqlite3.DatabaseError as e:
            check('fts integrity %s' % t, False, str(e))
    rw.close()
    n = db.execute("select count(*) from product_search where product_search match 'name:antonia'").fetchone()[0]
    check('fts query works', n > 0, '%d hits for name:antonia' % n)
    n = db.execute("select count(*) from customers where password_hash not like 'scrypt$%' and password_hash not like '$argon2id$%'").fetchone()[0]
    check('customer password hashes kit-verifiable', n == 0, '%d other' % n)
    print(db.execute("select group_concat(key||'='||value, ', ') from build_info where key like 'passwords.%'").fetchone()[0])
    if a.media:
        rows = db.execute('select file from product_images where file is not null').fetchall()
        missing = sum(1 for (f,) in rows if not os.path.exists(os.path.join(a.media, f)))
        tot = db.execute('select count(*) from product_images').fetchone()[0]
        check('image files exist', missing == 0, '%d of %d rows have a file, %d missing on disk' % (len(rows), tot, missing))
    print('# task spot checks')
    import spotchecks
    for name, sql, expect in spotchecks.CHECKS:
        try:
            got = db.execute(sql).fetchall()
        except Exception as e:
            check('task ' + name, False, 'error %s' % e)
            continue
        flat = [x for row in got for x in row]
        ok = expect(flat) if callable(expect) else (flat == expect)
        check('task ' + name, ok, repr(flat)[:160])
    print('\n%d failures' % len(FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
