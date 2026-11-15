#!/usr/bin/env python3
"""Export a running Magento 2 MariaDB into a raw SQLite file (1:1 tables).

Usage: python -I export_raw.py --port 7301 --db magentodb --out raw_admin.db

Values are kept exact: DECIMAL -> TEXT (as printed by MariaDB), DATETIME /
TIMESTAMP -> 'YYYY-MM-DD HH:MM:SS' TEXT, integers -> INTEGER, blobs -> BLOB.
Index / cache / log tables that the lite schema never needs are skipped.
"""
import argparse
import datetime
import decimal
import re
import sqlite3
import sys

import pymysql
import pymysql.cursors

SKIP = [
    r'^catalog_product_index_', r'_replica$', r'_tmp$', r'_idx$', r'^catalog_category_product_index',
    r'^catalogrule_product_price', r'^catalogrule_product$', r'^catalogrule_group_website$',
    r'^cron_schedule$', r'^queue', r'^magento_', r'^session$', r'^cache', r'^admin_user_session$',
    r'^oauth_', r'^integration$', r'^admin_passwords$', r'^customer_visitor$',
    r'^report_event$', r'^report_viewed_product', r'^report_compared_product', r'^ui_bookmark$',
    r'^patch_list$', r'^setup_module$', r'^mview_', r'^indexer_', r'^cl_', r'_cl$', r'^search_synonyms$',
    r'^layout_', r'^widget_', r'^adminnotification', r'^admin_analytics', r'^login_as_customer',
    r'^password_reset', r'^captcha', r'^persistent_session$', r'^sequence_', r'^inventory_reservation$',
    r'^catalogsearch_', r'^email_', r'^amazon_', r'^vault_', r'^jwt_', r'^media_gallery_',
    r'^salesrule_coupon_aggregated', r'^sales_order_aggregated_updated$', r'^tax_order_aggregated_updated$',
    r'^import_history$', r'^importexport_', r'^flag$',
]
# inventory_reservation is small and gives salable qty; keep it after all.
KEEP_ANYWAY = {'inventory_reservation', 'flag'}
# Columns never exported (secrets that nothing needs). Admin password hashes ARE kept.
DROP_COLS = {('customer_entity', 'rp_token'), ('admin_user', 'rp_token')}
# core_config_data rows whose path looks secret are not exported.
SECRET_PATH = re.compile(r'password|passwd|secret|token|key|encrypt|api', re.I)


def sqlite_type(mysql_type):
    t = mysql_type.lower()
    if re.match(r'(tiny|small|medium|big)?int', t):
        return 'INTEGER'
    if t.startswith(('float', 'double')):
        return 'REAL'
    if 'blob' in t or t.startswith(('binary', 'varbinary')):
        return 'BLOB'
    return 'TEXT'


def conv(v):
    if isinstance(v, decimal.Decimal):
        return str(v)
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime('%Y-%m-%d %H:%M:%S') if isinstance(v, datetime.datetime) else v.isoformat()
    if isinstance(v, datetime.timedelta):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        try:
            return v.decode('utf-8')
        except UnicodeDecodeError:
            return bytes(v)
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, required=True)
    ap.add_argument('--db', default='magentodb')
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', nargs='*')
    a = ap.parse_args()

    my = pymysql.connect(host=a.host, port=a.port, user='root', database=a.db, charset='utf8mb4')
    cur = my.cursor()
    cur.execute("select table_name from information_schema.tables where table_schema=%s and table_type='BASE TABLE' "
                "order by table_name", (a.db,))
    tables = [r[0] for r in cur.fetchall()]
    out = sqlite3.connect(a.out)
    out.execute('pragma journal_mode=off')
    out.execute('pragma synchronous=off')
    out.execute('create table if not exists _export_meta (table_name text primary key, rows integer, source_rows integer)')
    for t in tables:
        if a.only and t not in a.only:
            continue
        if t not in KEEP_ANYWAY and any(re.search(p, t) for p in SKIP):
            continue
        cur.execute('select count(*) from `%s`' % t)
        n = cur.fetchone()[0]
        if n == 0:
            continue
        cur.execute('select column_name, column_type from information_schema.columns where table_schema=%s and '
                    'table_name=%s order by ordinal_position', (a.db, t))
        cols = [(c, ty) for c, ty in cur.fetchall() if (t, c) not in DROP_COLS]
        out.execute('drop table if exists "%s"' % t)
        out.execute('create table "%s" (%s)' % (t, ', '.join('"%s" %s' % (c, sqlite_type(ty)) for c, ty in cols)))
        ss = my.cursor(pymysql.cursors.SSCursor)
        ss.execute('select %s from `%s`' % (', '.join('`%s`' % c for c, _ in cols), t))
        ins = 'insert into "%s" values (%s)' % (t, ','.join('?' * len(cols)))
        got = 0
        while True:
            rows = ss.fetchmany(5000)
            if not rows:
                break
            if t == 'core_config_data':
                pi = [c for c, _ in cols].index('path')
                rows = [r for r in rows if not SECRET_PATH.search(r[pi] or '')]
            out.executemany(ins, [tuple(conv(v) for v in r) for r in rows])
            got += len(rows)
        ss.close()
        out.execute('insert or replace into _export_meta values (?,?,?)', (t, got, n))
        out.commit()
        print(f'{t}: {got}', file=sys.stderr, flush=True)
    out.commit()
    out.close()


if __name__ == '__main__':
    main()
