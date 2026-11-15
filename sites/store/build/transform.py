#!/usr/bin/env python3
"""Transform raw Magento exports (export_raw.py) into the lite store schema.

Usage:
  python -I transform.py --admin raw_admin.db [--shop raw_shop.db] --out base.db \
      [--iso3166 iso3166.tab]

Sources are processed admin first (its IDs are kept), then shop (renumbered
where it collides; see ID POLICY below and ../SCHEMA.md). Every renumbering is
written to id_map(source, entity, old_id, new_id).
"""
import argparse
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)   # our own modules (htmlclean); -I drops the script dir

# ------------------------------------------------------------------ ID POLICY
# admin ('admin' = WebArena shopping_admin, Luma): IDs kept as-is (tasks reference
#   admin product/order/review/CMS IDs in URLs).
# shop ('shop' = WebArena shopping, One Stop Market): IDs shifted by a fixed offset
#   per entity, chosen above the admin maximum, unless the shop entity is merged
#   with an admin one by natural key (email, url path, code ...).
# The concrete offsets are computed in plan_offsets() and recorded in build_info.
SHOP_ORDER_POLICY = os.environ.get('WSB_SHOP_ORDER_POLICY', 'keep_shop')  # see plan_offsets()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def money(v):
    if v is None or v == '':
        return None
    return round(float(v), 4)


def num(v):
    if v is None or v == '':
        return None
    f = float(v)
    return int(f) if f.is_integer() else f


class Src:
    def __init__(self, name, path):
        self.name = name
        self.db = sqlite3.connect('file:%s?mode=ro' % path, uri=True)
        self.db.row_factory = sqlite3.Row
        self.tables = {r[0] for r in self.db.execute("select name from sqlite_master where type='table'")}
        self.map = defaultdict(dict)  # entity -> {old: new}

    def has(self, t):
        return t in self.tables

    def q(self, sql, args=()):
        return self.db.execute(sql, args).fetchall()

    def rows(self, table, where=''):
        if not self.has(table):
            return []
        return self.db.execute('select * from "%s" %s' % (table, where))

    def maxid(self, table, col):
        if not self.has(table):
            return 0
        return self.db.execute('select coalesce(max("%s"),0) from "%s"' % (col, table)).fetchone()[0] or 0

    def count(self, table, where=''):
        if not self.has(table):
            return 0
        return self.db.execute('select count(*) from "%s" %s' % (table, where)).fetchone()[0]


class Out:
    def __init__(self, path):
        if os.path.exists(path):
            os.remove(path)
        self.db = sqlite3.connect(path)
        self.db.execute('pragma journal_mode=off')
        self.db.execute('pragma synchronous=off')
        self.db.execute('pragma cache_size=-2000000')
        self.db.executescript(open(os.path.join(HERE, 'schema.sql')).read())
        self.cols = {}

    def columns(self, table):
        if table not in self.cols:
            self.cols[table] = [r[1] for r in self.db.execute('pragma table_info("%s")' % table)]
        return self.cols[table]

    def insert(self, table, rows, mode='insert'):
        cols = self.columns(table)
        sql = '%s into "%s" (%s) values (%s)' % (mode, table, ','.join('"%s"' % c for c in cols),
                                                  ','.join('?' * len(cols)))
        batch = []
        n = 0
        for r in rows:
            unknown = set(r) - set(cols)
            if unknown:
                raise KeyError('%s: unknown columns %s' % (table, unknown))
            batch.append(tuple(r.get(c) for c in cols))
            if len(batch) >= 10000:
                self.db.executemany(sql, batch)
                n += len(batch)
                batch = []
        if batch:
            self.db.executemany(sql, batch)
            n += len(batch)
        return n


def idmap(out, src, entity, old, new):
    src.map[entity][old] = new
    if str(old) != str(new):
        out.append((src.name, entity, str(old), str(new)))


# ------------------------------------------------------------------ EAV helpers
def eav_attributes(src, entity_type_code):
    et = src.q('select entity_type_id from eav_entity_type where entity_type_code=?', (entity_type_code,))
    if not et:
        return {}
    etid = et[0][0]
    extra = {}
    if entity_type_code in ('catalog_product', 'catalog_category') and src.has('catalog_eav_attribute'):
        for r in src.rows('catalog_eav_attribute'):
            extra[r['attribute_id']] = dict(r)
    attrs = {}
    for r in src.q('select * from eav_attribute where entity_type_id=?', (etid,)):
        d = dict(r)
        d.update({k: v for k, v in extra.get(r['attribute_id'], {}).items() if k != 'attribute_id'})
        attrs[r['attribute_id']] = d
    return attrs


def option_labels(src):
    """option_id -> label (store 1 label overrides admin store 0)."""
    lab = {}
    if not src.has('eav_attribute_option_value'):
        return lab
    for r in src.q('select option_id, store_id, value from eav_attribute_option_value order by store_id'):
        if r['store_id'] in (0, 1):
            if r['store_id'] == 0 or r['value']:
                lab[r['option_id']] = r['value']
    return lab


def eav_values(src, prefix, attrs, link='entity_id'):
    """entity_id -> {attribute_id: value}; store 1 (default view) overrides store 0."""
    vals = defaultdict(dict)
    for bt in ('varchar', 'int', 'decimal', 'text', 'datetime'):
        t = '%s_%s' % (prefix, bt)
        if not src.has(t):
            continue
        for r in src.db.execute('select %s, attribute_id, store_id, value from "%s" where store_id in (0,1) '
                                'order by store_id' % (link, t)):
            if r[1] in attrs:
                if r[2] == 0 or r[1] not in vals[r[0]] or r[3] is not None:
                    vals[r[0]][r[1]] = r[3]
    return vals


# ------------------------------------------------------------------ main build
class Builder:
    def __init__(self, out, sources, iso3166):
        self.o = out
        self.S = sources  # list of Src, admin first
        self.idmap_rows = []
        self.iso3166 = iso3166
        self.info = {}

    def mapid(self, src, entity, old):
        if old is None:
            return None
        return src.map[entity].get(old)

    # -------------------------------------------------------------- offsets
    def plan_offsets(self):
        """Compute per-entity offsets for every source after the first."""
        def roundup(n, base):
            return ((n // base) + 1) * base
        self.off = {}
        prev = {}
        for i, s in enumerate(self.S):
            spec = {
                'product': ('catalog_product_entity', 'entity_id'),
                'category': ('catalog_category_entity', 'entity_id'),
                'customer': ('customer_entity', 'entity_id'),
                'customer_address': ('customer_address_entity', 'entity_id'),
                'review': ('review', 'review_id'),
                'order': ('sales_order', 'entity_id'),
                'order_item': ('sales_order_item', 'item_id'),
                'order_address': ('sales_order_address', 'entity_id'),
                'order_payment': ('sales_order_payment', 'entity_id'),
                'order_status_history': ('sales_order_status_history', 'entity_id'),
                'invoice': ('sales_invoice', 'entity_id'),
                'invoice_item': ('sales_invoice_item', 'entity_id'),
                'shipment': ('sales_shipment', 'entity_id'),
                'shipment_item': ('sales_shipment_item', 'entity_id'),
                'shipment_track': ('sales_shipment_track', 'entity_id'),
                'creditmemo': ('sales_creditmemo', 'entity_id'),
                'creditmemo_item': ('sales_creditmemo_item', 'entity_id'),
                'attribute_option': ('eav_attribute_option', 'option_id'),
                'media': ('catalog_product_entity_media_gallery', 'value_id'),
                'sales_rule': ('salesrule', 'rule_id'),
                'coupon': ('salesrule_coupon', 'coupon_id'),
                'catalog_rule': ('catalogrule', 'rule_id'),
                'cms_page': ('cms_page', 'page_id'),
                'cms_block': ('cms_block', 'block_id'),
                'search_query': ('search_query', 'query_id'),
                'wishlist': ('wishlist', 'wishlist_id'),
                'wishlist_item': ('wishlist_item', 'wishlist_item_id'),
                'quote': ('quote', 'entity_id'),
                'quote_item': ('quote_item', 'item_id'),
                'newsletter': ('newsletter_subscriber', 'subscriber_id'),
                'url_rewrite': ('url_rewrite', 'url_rewrite_id'),
                'bundle_option': ('catalog_product_bundle_option', 'option_id'),
                'bundle_selection': ('catalog_product_bundle_selection', 'selection_id'),
                'product_option': ('catalog_product_option', 'option_id'),
                'product_option_value': ('catalog_product_option_type_value', 'option_type_id'),
                'tier_price': ('catalog_product_entity_tier_price', 'value_id'),
                'reservation': ('inventory_reservation', 'reservation_id'),
                'sales_comment': (None, None),
            }
            off = {}
            for ent, (t, c) in spec.items():
                if i == 0 or t is None:
                    off[ent] = 0
                else:
                    off[ent] = roundup(prev.get(ent, 0), 10 ** max(1, len(str(prev.get(ent, 0)))))
                m = s.maxid(t, c) if t else 0
                prev[ent] = max(prev.get(ent, 0), m + off[ent])
            self.off[s.name] = off
        # Orders are the one entity both stores' tasks reference by number. Policy
        # (see SCHEMA.md): admin orders keep entity_id/increment_id, shop orders are
        # shifted by the order offset.
        for s in self.S:
            for k, v in self.off[s.name].items():
                if v:
                    self.info['offset.%s.%s' % (s.name, k)] = v

    # -------------------------------------------------------------- directory/config
    def directory(self):
        s = self.S[0]
        names = {}
        if self.iso3166 and os.path.exists(self.iso3166):
            for line in open(self.iso3166, encoding='utf-8'):
                if line.startswith('#') or '\t' not in line:
                    continue
                code, name = line.rstrip('\n').split('\t', 1)
                names[code] = name
        # Magento shows "United States" (CLDR) while iso3166.tab says "United States"; keep tab names.
        self.o.insert('countries', ({'id': r['country_id'], 'iso3': r['iso3_code'], 'name': names.get(r['country_id'])}
                                    for r in s.rows('directory_country')))
        rn = {}
        for r in s.rows('directory_country_region_name'):
            if r['locale'] == 'en_US':
                rn[r['region_id']] = r['name']
        self.o.insert('regions', ({'id': r['region_id'], 'country_id': r['country_id'], 'code': r['code'],
                                   'name': rn.get(r['region_id'], r['default_name'])}
                                  for r in s.rows('directory_country_region')))
        # config: later sources do not override earlier (admin first) except where listed
        cfg = {}
        for src in reversed(self.S):
            for r in src.rows('core_config_data'):
                if r['scope'] == 'default':
                    cfg[r['path']] = r['value']
        for src in self.S:
            for r in src.rows('core_config_data'):
                cfg['source.%s.%s' % (src.name, r['path'])] = r['value']
        self.o.insert('store_config', ({'path': k, 'value': v} for k, v in sorted(cfg.items())))

    def simple_lookups(self):
        o = self.o
        seen = set()
        for s in self.S:
            o.insert('customer_groups', ({'id': r['customer_group_id'], 'code': r['customer_group_code'],
                                          'tax_class_id': r['tax_class_id']} for r in s.rows('customer_group')),
                     'insert or ignore')
            o.insert('tax_classes', ({'id': r['class_id'], 'name': r['class_name'], 'type': r['class_type']}
                                     for r in s.rows('tax_class')), 'insert or ignore')
            o.insert('order_statuses', ({'status': r['status'], 'label': r['label']} for r in s.rows('sales_order_status')),
                     'insert or ignore')
            o.insert('order_status_states', ({'status': r['status'], 'state': r['state'], 'is_default': r['is_default'],
                                              'visible_on_front': r['visible_on_front']}
                                             for r in s.rows('sales_order_status_state')), 'insert or ignore')
            o.insert('ratings', ({'id': r['rating_id'], 'code': r['rating_code'], 'position': r['position'],
                                  'is_active': r['is_active']} for r in s.rows('rating')), 'insert or ignore')
            o.insert('themes', ({'id': r['theme_id'], 'parent_id': r['parent_id'], 'code': r['code'],
                                 'title': r['theme_title'], 'area': r['area'], 'preview_image': r['preview_image']}
                                for r in s.rows('theme')), 'insert or ignore')
            o.insert('tax_rates', ({'id': r['tax_calculation_rate_id'], 'country_id': r['tax_country_id'],
                                    'region_id': r['tax_region_id'], 'postcode': r['tax_postcode'], 'code': r['code'],
                                    'rate': num(r['rate'])} for r in s.rows('tax_calculation_rate')), 'insert or ignore')
            for r in s.rows('shipping_tablerate'):
                key = (r['dest_country_id'], r['dest_region_id'], r['dest_zip'], r['condition_name'], r['condition_value'])
                if key in seen:
                    continue
                seen.add(key)
                o.insert('shipping_table_rates', [{'dest_country_id': r['dest_country_id'],
                                                   'dest_region_id': r['dest_region_id'], 'dest_zip': r['dest_zip'],
                                                   'condition_name': r['condition_name'],
                                                   'condition_value': num(r['condition_value']),
                                                   'price': money(r['price']), 'cost': money(r['cost'])}])

    # -------------------------------------------------------------- attributes
    TYPED = {
        'name': 'name', 'url_key': 'url_key', 'status': 'status', 'visibility': 'visibility', 'price': 'price',
        'special_price': 'special_price', 'special_from_date': 'special_from', 'special_to_date': 'special_to',
        'cost': 'cost', 'msrp': 'msrp', 'weight': 'weight', 'tax_class_id': 'tax_class_id',
        'description': 'description', 'short_description': 'short_description', 'meta_title': 'meta_title',
        'meta_keyword': 'meta_keywords', 'meta_description': 'meta_description', 'color': 'color', 'size': 'size',
        'news_from_date': 'news_from', 'news_to_date': 'news_to', 'country_of_manufacture': 'country_of_manufacture',
        'gift_message_available': 'gift_message_available', 'manufacturer': 'brand', 'brand': 'brand',
    }
    # system attributes not kept anywhere (derivable or presentation-only)
    DROP = {'options_container', 'msrp_display_actual_price_type', 'quantity_and_stock_status', 'image', 'small_image',
            'thumbnail', 'swatch_image', 'media_gallery', 'url_path', 'page_layout', 'custom_layout_update',
            'custom_layout_update_file', 'custom_design', 'custom_design_from', 'custom_design_to', 'custom_layout',
            'image_label', 'small_image_label', 'thumbnail_label', 'links_purchased_separately', 'links_title',
            'links_exist', 'samples_title', 'category_ids', 'tier_price', 'gallery', 'has_options',
            'required_options', 'old_id', 'minimal_price'}

    def attributes(self):
        self.attr_meta = {}   # src -> {attribute_id: meta}
        self.opt_label = {}
        seen = {}
        for s in self.S:
            attrs = eav_attributes(s, 'catalog_product')
            self.attr_meta[s.name] = attrs
            self.opt_label[s.name] = option_labels(s)
            for aid, a in attrs.items():
                code = a['attribute_code']
                if code in self.DROP or code in seen:
                    continue
                seen[code] = 1
                self.o.insert('attributes', [{
                    'code': code, 'label': a['frontend_label'], 'input': a['frontend_input'],
                    'backend_type': a['backend_type'], 'is_filterable': a.get('is_filterable'),
                    'is_searchable': a.get('is_searchable'), 'is_comparable': a.get('is_comparable'),
                    'is_visible_on_front': a.get('is_visible_on_front'),
                    'used_in_listing': a.get('used_in_product_listing'), 'is_variant_axis': 0,
                    'position': a.get('position'), 'is_user_defined': a['is_user_defined'],
                    'typed_column': self.TYPED.get(code)}])
        # options: merge by (attribute_code, label); admin ids kept, shop new ids offset
        self.optmap = {}  # (src, option_id) -> new option id
        bykey = {}
        for s in self.S:
            attrs = self.attr_meta[s.name]
            off = self.off[s.name]['attribute_option']
            sw = {}
            for r in s.rows('eav_attribute_option_swatch'):
                if r['store_id'] == 0:
                    sw[r['option_id']] = r['value']
            for r in s.rows('eav_attribute_option'):
                a = attrs.get(r['attribute_id'])
                if not a:
                    continue
                code = a['attribute_code']
                label = self.opt_label[s.name].get(r['option_id'])
                key = (code, label)
                if key in bykey:
                    new = bykey[key]
                else:
                    new = r['option_id'] + off
                    bykey[key] = new
                    self.o.insert('attribute_options', [{'id': new, 'attribute_code': code, 'label': label,
                                                         'position': r['sort_order'], 'swatch': sw.get(r['option_id'])}])
                self.optmap[(s.name, r['option_id'])] = new
                idmap(self.idmap_rows, s, 'attribute_option', r['option_id'], new)

    # -------------------------------------------------------------- categories
    def categories(self):
        """Merge category trees. Root (1) and 'Default Category' (2) are shared; the
        admin (Luma) top-level categories go under a new department category; shop
        categories are offset. url_path values are kept exactly (stable URLs)."""
        o = self.o
        used_paths = set()
        for s in self.S:
            attrs = eav_attributes(s, 'catalog_category')
            vals = eav_values(s, 'catalog_category_entity', attrs)
            off = self.off[s.name]['category']
            code = {aid: a['attribute_code'] for aid, a in attrs.items()}
            rows = list(s.rows('catalog_category_entity', 'order by level, position'))
            for r in rows:
                cid = r['entity_id']
                v = {code[k]: x for k, x in vals.get(cid, {}).items()}
                if cid in (1, 2):
                    new = cid
                    if s is not self.S[0]:
                        idmap(self.idmap_rows, s, 'category', cid, new)
                        continue
                else:
                    new = cid + off
                idmap(self.idmap_rows, s, 'category', cid, new)
                parent = r['parent_id']
                new_parent = s.map['category'].get(parent, parent + off if parent not in (0, 1, 2) else parent)
                up = v.get('url_path')
                if up and up in used_paths:
                    up = up + '-' + s.name
                if up:
                    used_paths.add(up)
                o.insert('categories', [{
                    'id': new, 'parent_id': new_parent, 'path': None, 'level': r['level'], 'position': r['position'],
                    'name': v.get('name') or '', 'url_key': v.get('url_key'), 'url_path': up,
                    'is_active': v.get('is_active'), 'include_in_menu': v.get('include_in_menu'),
                    'is_anchor': v.get('is_anchor'), 'display_mode': v.get('display_mode'),
                    'description': v.get('description'), 'meta_title': v.get('meta_title'),
                    'meta_keywords': v.get('meta_keywords'), 'meta_description': v.get('meta_description'),
                    'image': v.get('image'), 'children_count': r['children_count'], 'created_at': r['created_at'],
                    'updated_at': r['updated_at'], 'source': s.name if cid > 2 else None}])
        if len(self.S) > 1:
            # The Luma (admin) top-level categories become children of one department
            # category; their url_path values stay unchanged (stable URLs).
            new = o.db.execute('select max(id)+1 from categories').fetchone()[0]
            pos = o.db.execute('select coalesce(max(position),0)+1 from categories where parent_id=2').fetchone()[0]
            o.insert('categories', [{'id': new, 'parent_id': 2, 'level': 2, 'position': pos, 'name': 'Luma Apparel',
                                     'url_key': 'luma-apparel', 'url_path': 'luma-apparel', 'is_active': 1,
                                     'include_in_menu': 1, 'is_anchor': 1, 'display_mode': 'PRODUCTS',
                                     'source': 'admin'}])
            o.db.execute("update categories set parent_id=? where parent_id=2 and source='admin' and id<>?", (new, new))
            self.info['luma_department_category_id'] = new
        o.db.commit()
        self.fix_category_paths()

    def fix_category_paths(self):
        db = self.o.db
        par = dict(db.execute('select id, parent_id from categories'))
        upd = []
        for cid in par:
            chain = [cid]
            while chain[-1] in par and par[chain[-1]] not in (0, None):
                chain.append(par[chain[-1]])
            chain.reverse()
            upd.append(('/'.join(map(str, chain)), len(chain) - 1, cid))
        db.executemany('update categories set path=?, level=? where id=?', upd)
        db.execute('update categories set children_count=(select count(*) from categories c2 '
                   "where c2.path like categories.path || '/%')")

    # -------------------------------------------------------------- products
    def products(self):
        o = self.o
        skus = {}
        url_keys = set()
        self.prod_src = {}
        for s in self.S:
            attrs = self.attr_meta[s.name]
            labels = self.opt_label[s.name]
            code = {aid: a['attribute_code'] for aid, a in attrs.items()}
            vals = eav_values(s, 'catalog_product_entity', attrs,
                              link='row_id' if s.has('sequence_product') and False else 'entity_id')
            stock = {r['product_id']: r for r in s.rows('cataloginventory_stock_item')}
            off = self.off[s.name]['product']
            sets = {}
            for r in s.rows('eav_attribute_set'):
                sets[r['attribute_set_id']] = r['attribute_set_name']
            setoff = 0 if s is self.S[0] else 1000
            for sid, nm in sets.items():
                o.insert('attribute_sets', [{'id': sid + setoff, 'name': nm, 'source': s.name}], 'insert or ignore')
            prow, arow = [], []
            for r in s.rows('catalog_product_entity'):
                pid = r['entity_id']
                new = pid + off
                idmap(self.idmap_rows, s, 'product', pid, new)
                v = vals.get(pid, {})
                p = {'id': new, 'sku': r['sku'], 'type': r['type_id'], 'attribute_set_id': r['attribute_set_id'] + setoff,
                     'has_options': r['has_options'], 'required_options': r['required_options'],
                     'created_at': r['created_at'], 'updated_at': r['updated_at'], 'source': s.name, 'source_id': pid}
                if p['sku'] in skus:
                    log('WARN duplicate sku %r (%s %s vs %s)' % (p['sku'], s.name, pid, skus[p['sku']]))
                    p['sku'] = p['sku'] + '-' + s.name
                skus[p['sku']] = (s.name, pid)
                for aid, val in v.items():
                    c = code[aid]
                    a = attrs[aid]
                    if c in self.DROP:
                        continue
                    if val is None:
                        continue
                    col = self.TYPED.get(c)
                    inp = a['frontend_input']
                    if inp == 'select' and a['backend_type'] == 'int' and (a['source_model'] in (None, '',
                            'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table') or c in ('color', 'size', 'manufacturer')):
                        oid = int(val)
                        label = labels.get(oid)
                        if col in ('color', 'size'):
                            p[col] = label
                            p[col + '_option_id'] = self.optmap.get((s.name, oid))
                        elif col:
                            p[col] = label
                        else:
                            arow.append({'product_id': new, 'attribute_code': c, 'value': label,
                                         'option_id': self.optmap.get((s.name, oid))})
                        continue
                    if inp == 'multiselect':
                        for x in str(val).split(','):
                            if x.strip().isdigit():
                                oid = int(x)
                                arow.append({'product_id': new, 'attribute_code': c, 'value': labels.get(oid),
                                             'option_id': self.optmap.get((s.name, oid))})
                            elif x.strip():
                                arow.append({'product_id': new, 'attribute_code': c, 'value': x.strip(), 'option_id': None})
                        continue
                    if col:
                        if col in ('price', 'special_price', 'cost', 'msrp'):
                            val = money(val)
                        elif col in ('weight',):
                            val = num(val)
                        elif col in ('status', 'visibility', 'tax_class_id', 'gift_message_available'):
                            val = int(val) if str(val).strip().lstrip('-').isdigit() else None
                        p[col] = val
                    else:
                        if a['backend_type'] == 'decimal':
                            val = str(num(val))
                        arow.append({'product_id': new, 'attribute_code': c, 'value': val, 'option_id': None})
                st = stock.get(pid)
                if st:
                    p.update({'qty': num(st['qty']), 'is_in_stock': st['is_in_stock'], 'manage_stock': st['manage_stock'],
                              'min_qty': num(st['min_qty']), 'notify_stock_qty': num(st['notify_stock_qty']),
                              'min_sale_qty': num(st['min_sale_qty']), 'max_sale_qty': num(st['max_sale_qty']),
                              'backorders': st['backorders'], 'low_stock_date': st['low_stock_date']})
                if p.get('url_key'):
                    if p['url_key'] in url_keys:
                        log('WARN duplicate url_key %r (%s %s)' % (p['url_key'], s.name, pid))
                        idmap(self.idmap_rows, s, 'product_url_key', p['url_key'], p['url_key'] + '-' + s.name)
                        p['url_key'] = p['url_key'] + '-' + s.name
                    url_keys.add(p['url_key'])
                p.setdefault('name', '')
                p.setdefault('status', 1)
                p.setdefault('visibility', 4)
                prow.append(p)
            if s.name == 'shop':
                self.clean_descriptions(prow, arow)
            n = o.insert('products', prow)
            o.insert('product_attributes', arow)
            log('products %s: %d, attribute rows %d' % (s.name, n, len(arow)))
            del vals
            o.db.commit()

    SPEC_MIN = 200   # a product-detail key becomes a spec_* attribute if this many products have it

    def clean_descriptions(self, prow, arow):
        """Shop descriptions are scraped Amazon HTML (~14 KB each, mostly attribute noise):
        shrink them with htmlclean, and lift the product-details table into
        products.brand and spec_* attributes."""
        import htmlclean
        from concurrent.futures import ProcessPoolExecutor
        before = sum(len(p.get('description') or '') for p in prow)
        jobs = [(i, p['description']) for i, p in enumerate(prow) if p.get('description')]
        dets = {}
        with ProcessPoolExecutor(int(os.environ.get('JOBS', '6'))) as ex:
            for i, c, br, d in ex.map(htmlclean.clean_one, jobs, chunksize=200):
                prow[i]['description'] = c
                if br and not prow[i].get('brand'):
                    prow[i]['brand'] = br
                dets[i] = d
        after = sum(len(p.get('description') or '') for p in prow)
        freq = defaultdict(int)
        for d in dets.values():
            for k in d:
                freq[k] += 1
        keys = {}
        for k, n in freq.items():
            if n >= self.SPEC_MIN:
                code = 'spec_' + re.sub(r'[^a-z0-9]+', '_', k.lower()).strip('_')
                if code not in keys.values():
                    keys[k] = code
        for k, code in keys.items():
            self.o.insert('attributes', [{'code': code, 'label': k, 'input': 'text', 'backend_type': 'varchar',
                                          'is_filterable': 0, 'is_searchable': 0, 'is_comparable': 1,
                                          'is_visible_on_front': 1, 'used_in_listing': 0, 'is_variant_axis': 0,
                                          'position': 100, 'is_user_defined': 1, 'typed_column': None}],
                          'insert or ignore')
        for i, d in dets.items():
            for k, v in d.items():
                if k in keys:
                    arow.append({'product_id': prow[i]['id'], 'attribute_code': keys[k], 'value': v, 'option_id': None})
        self.info['shop.description_bytes_raw'] = before
        self.info['shop.description_bytes_clean'] = after
        log('descriptions: %.1f MB -> %.1f MB, %d spec attributes, %d with brand' % (
            before / 1e6, after / 1e6, len(keys), sum(1 for p in prow if p.get('brand'))))

    def product_relations(self):
        o = self.o
        for s in self.S:
            P = s.map['product']
            C = s.map['category']
            attrs = self.attr_meta[s.name]
            o.insert('product_categories', ({'product_id': P[r['product_id']], 'category_id': C[r['category_id']],
                                             'position': r['position']} for r in s.rows('catalog_category_product')
                                            if r['product_id'] in P and r['category_id'] in C), 'insert or ignore')
            labels = {r['product_super_attribute_id']: r['value'] for r in s.rows('catalog_product_super_attribute_label')
                      if r['store_id'] == 0}
            axes = []
            for r in s.rows('catalog_product_super_attribute'):
                if r['product_id'] in P and r['attribute_id'] in attrs:
                    axes.append({'product_id': P[r['product_id']], 'attribute_code': attrs[r['attribute_id']]['attribute_code'],
                                 'position': r['position'], 'label': labels.get(r['product_super_attribute_id'])})
            o.insert('product_variant_axes', axes, 'insert or ignore')
            for code in {a['attribute_code'] for a in axes}:
                o.db.execute('update attributes set is_variant_axis=1 where code=?', (code,))
            o.insert('product_variants', ({'parent_id': P[r['parent_id']], 'child_id': P[r['product_id']]}
                                          for r in s.rows('catalog_product_super_link')
                                          if r['parent_id'] in P and r['product_id'] in P), 'insert or ignore')
            types = {r['link_type_id']: r['code'] for r in s.rows('catalog_product_link_type')}
            names = {1: 'related', 3: 'grouped', 4: 'upsell', 5: 'crosssell'}
            pos = {}
            qty = {}
            la = {r['product_link_attribute_id']: r['product_link_attribute_code'] for r in s.rows('catalog_product_link_attribute')}
            for t in ('catalog_product_link_attribute_int', 'catalog_product_link_attribute_decimal'):
                for r in s.rows(t):
                    c = la.get(r['product_link_attribute_id'])
                    if c == 'position':
                        pos[r['link_id']] = num(r['value'])
                    elif c == 'qty':
                        qty[r['link_id']] = num(r['value'])
            o.insert('product_links', ({'product_id': P[r['product_id']], 'linked_product_id': P[r['linked_product_id']],
                                        'link_type': names.get(r['link_type_id'], types.get(r['link_type_id'])),
                                        'position': pos.get(r['link_id']), 'qty': qty.get(r['link_id'])}
                                       for r in s.rows('catalog_product_link')
                                       if r['product_id'] in P and r['linked_product_id'] in P), 'insert or ignore')
            # bundles
            boff = self.off[s.name]['bundle_option']
            titles = {r['option_id']: r['title'] for r in s.rows('catalog_product_bundle_option_value') if r['store_id'] == 0}
            o.insert('bundle_options', ({'id': r['option_id'] + boff, 'product_id': P.get(r['parent_id']),
                                         'title': titles.get(r['option_id']), 'type': r['type'], 'required': r['required'],
                                         'position': r['position']} for r in s.rows('catalog_product_bundle_option')))
            soff = self.off[s.name]['bundle_selection']
            o.insert('bundle_selections', ({'id': r['selection_id'] + soff, 'option_id': r['option_id'] + boff,
                                            'product_id': P.get(r['parent_product_id']),
                                            'selection_product_id': P.get(r['product_id']),
                                            'qty': num(r['selection_qty']), 'can_change_qty': r['selection_can_change_qty'],
                                            'is_default': r['is_default'], 'price_type': r['selection_price_type'],
                                            'price_value': money(r['selection_price_value']), 'position': r['position']}
                                           for r in s.rows('catalog_product_bundle_selection')))
            # custom options
            ooff = self.off[s.name]['product_option']
            ot = {r['option_id']: r['title'] for r in s.rows('catalog_product_option_title') if r['store_id'] == 0}
            opr = {r['option_id']: r for r in s.rows('catalog_product_option_price') if r['store_id'] == 0}
            o.insert('product_options', ({'id': r['option_id'] + ooff, 'product_id': P.get(r['product_id']),
                                          'title': ot.get(r['option_id']), 'type': r['type'], 'is_require': r['is_require'],
                                          'sku': r['sku'], 'max_characters': r['max_characters'], 'position': r['sort_order'],
                                          'price': money(opr[r['option_id']]['price']) if r['option_id'] in opr else None,
                                          'price_type': opr[r['option_id']]['price_type'] if r['option_id'] in opr else None}
                                         for r in s.rows('catalog_product_option')))
            voff = self.off[s.name]['product_option_value']
            vt = {r['option_type_id']: r['title'] for r in s.rows('catalog_product_option_type_title') if r['store_id'] == 0}
            vp = {r['option_type_id']: r for r in s.rows('catalog_product_option_type_price') if r['store_id'] == 0}
            o.insert('product_option_values', ({'id': r['option_type_id'] + voff, 'option_id': r['option_id'] + ooff,
                                                'title': vt.get(r['option_type_id']), 'sku': r['sku'],
                                                'position': r['sort_order'],
                                                'price': money(vp[r['option_type_id']]['price']) if r['option_type_id'] in vp else None,
                                                'price_type': vp[r['option_type_id']]['price_type'] if r['option_type_id'] in vp else None}
                                               for r in s.rows('catalog_product_option_type_value')))
            toff = self.off[s.name]['tier_price']
            o.insert('tier_prices', ({'id': r['value_id'] + toff, 'product_id': P.get(r['entity_id']),
                                      'customer_group_id': r['customer_group_id'], 'all_groups': r['all_groups'],
                                      'qty': num(r['qty']), 'value': money(r['value']),
                                      'percentage_value': num(r['percentage_value'])}
                                     for r in s.rows('catalog_product_entity_tier_price')))
            roff = self.off[s.name]['reservation']
            o.insert('stock_reservations', ({'id': r['reservation_id'] + roff, 'sku': r['sku'], 'quantity': num(r['quantity']),
                                             'metadata': r['metadata'], 'source': s.name}
                                            for r in s.rows('inventory_reservation')))
            o.db.commit()

    def images(self):
        o = self.o
        for s in self.S:
            P = s.map['product']
            attrs = self.attr_meta[s.name]
            role_ids = {a['attribute_code']: aid for aid, a in attrs.items()
                        if a['attribute_code'] in ('image', 'small_image', 'thumbnail', 'swatch_image')}
            roles = defaultdict(dict)  # pid -> role -> file
            for r in s.db.execute('select entity_id, attribute_id, store_id, value from catalog_product_entity_varchar '
                                  'where attribute_id in (%s) and store_id in (0,1) order by store_id'
                                  % ','.join(map(str, role_ids.values()) or ['-1'])):
                code = [c for c, a in role_ids.items() if a == r[1]][0]
                if r[3] and r[3] != 'no_selection':
                    roles[r[0]][code] = r[3]
            gal = {r['value_id']: r for r in s.rows('catalog_product_entity_media_gallery')}
            vals = {}
            for r in s.rows('catalog_product_entity_media_gallery_value', 'order by store_id'):
                if r['store_id'] in (0, 1):
                    vals[(r['value_id'], r['entity_id'])] = r
            links = list(s.rows('catalog_product_entity_media_gallery_value_to_entity'))
            off = self.off[s.name]['media']
            rows = []
            seen = set()
            for l in links:
                g = gal.get(l['value_id'])
                if not g or l['entity_id'] not in P:
                    continue
                v = vals.get((l['value_id'], l['entity_id']))
                f = g['value']
                ro = roles.get(l['entity_id'], {})
                seen.add((l['entity_id'], f))
                rows.append({'id': l['value_id'] + off if (l['value_id'] + off) not in seen else None,
                             'product_id': P[l['entity_id']], 'file': None, 'orig_path': f,
                             'position': v['position'] if v else None, 'label': v['label'] if v else None,
                             'disabled': (v['disabled'] if v else 0) or g['disabled'],
                             'is_base': int(ro.get('image') == f), 'is_small': int(ro.get('small_image') == f),
                             'is_thumbnail': int(ro.get('thumbnail') == f), 'is_swatch': int(ro.get('swatch_image') == f)})
            # role images that are not in the gallery
            for pid, ro in roles.items():
                for role, f in ro.items():
                    if (pid, f) not in seen and pid in P:
                        seen.add((pid, f))
                        rows.append({'id': None, 'product_id': P[pid], 'file': None, 'orig_path': f, 'position': 99,
                                     'label': None, 'disabled': 0, 'is_base': int(ro.get('image') == f),
                                     'is_small': int(ro.get('small_image') == f),
                                     'is_thumbnail': int(ro.get('thumbnail') == f),
                                     'is_swatch': int(ro.get('swatch_image') == f)})
            # ids: keep gallery value ids where unique per link, else autoincrement
            used = set()
            for r in rows:
                if r['id'] in used:
                    r['id'] = None
                if r['id'] is not None:
                    used.add(r['id'])
            o.insert('product_images', rows)
            log('images %s: %d' % (s.name, len(rows)))
        o.db.commit()

    def url_rewrites(self):
        o = self.o
        seen = set(r[0] for r in o.db.execute('select request_path from url_rewrites'))
        for s in self.S:
            P, C = s.map['product'], s.map['category']
            off = self.off[s.name]['url_rewrite']
            CP = s.map['cms_page']
            rows = []
            for r in s.rows('url_rewrite', 'where store_id=1'):
                et = r['entity_type']
                eid = r['entity_id']
                if et == 'product':
                    eid = P.get(eid)
                elif et == 'category':
                    eid = C.get(eid)
                elif et == 'cms-page':
                    eid = CP.get(eid)
                if eid is None and et in ('product', 'category', 'cms-page'):
                    continue
                if r['request_path'] in seen:
                    continue
                seen.add(r['request_path'])
                md = r['metadata']
                cat = None
                if md:
                    try:
                        cat = C.get(json.loads(md).get('category_id') and int(json.loads(md)['category_id']))
                    except Exception:
                        cat = None
                tp = r['target_path']
                tp = re.sub(r'(catalog/product/view/id/)(\d+)', lambda m: m.group(1) + str(P.get(int(m.group(2)), m.group(2))), tp)
                tp = re.sub(r'(catalog/category/view/id/)(\d+)', lambda m: m.group(1) + str(C.get(int(m.group(2)), m.group(2))), tp)
                tp = re.sub(r'(/category/)(\d+)', lambda m: m.group(1) + str(C.get(int(m.group(2)), m.group(2))), tp)
                rows.append({'id': r['url_rewrite_id'] + off, 'entity_type': et, 'entity_id': eid,
                             'request_path': r['request_path'], 'target_path': tp, 'redirect_type': r['redirect_type'],
                             'category_id': cat, 'is_autogenerated': r['is_autogenerated'], 'source': s.name})
            o.insert('url_rewrites', rows)
            log('url_rewrites %s: %d' % (s.name, len(rows)))
        o.db.commit()

    # -------------------------------------------------------------- reviews
    def reviews(self):
        o = self.o
        status = {1: 'approved', 2: 'pending', 3: 'not_approved'}
        for s in self.S:
            P = s.map['product']
            off = self.off[s.name]['review']
            pe = [r[0] for r in s.q("select entity_id from review_entity where entity_code='product'")]
            det = {r['review_id']: r for r in s.rows('review_detail')}
            rows = []
            for r in s.rows('review'):
                if r['entity_id'] not in pe or r['entity_pk_value'] not in P:
                    continue
                d = det.get(r['review_id'])
                new = r['review_id'] + off
                idmap(self.idmap_rows, s, 'review', r['review_id'], new)
                rows.append({'id': new, 'product_id': P[r['entity_pk_value']],
                             'customer_id': None if not d else self.mapid(s, 'customer', d['customer_id']),
                             'status': status.get(r['status_id'], str(r['status_id'])),
                             'title': d['title'] if d else None, 'detail': d['detail'] if d else None,
                             'nickname': d['nickname'] if d else None, 'created_at': r['created_at'], 'source': s.name})
            o.insert('reviews', rows)
            R = s.map['review']
            # ratings are merged by code; map source rating ids to ours
            rid = {r['rating_id']: o.db.execute('select id from ratings where code=?', (r['rating_code'],)).fetchone()[0]
                   for r in s.rows('rating')}
            vo = 0 if s is self.S[0] else 10 ** len(str(self.S[0].maxid('rating_option_vote', 'vote_id')))
            o.insert('review_votes', ({'id': r['vote_id'] + vo, 'review_id': R[r['review_id']], 'rating_id': rid.get(r['rating_id']),
                                       'value': r['value'], 'percent': r['percent']}
                                      for r in s.rows('rating_option_vote') if r['review_id'] in R))
            log('reviews %s: %d' % (s.name, len(rows)))
        o.db.commit()

    # -------------------------------------------------------------- customers
    def customers(self):
        o = self.o
        by_email = {}
        for s in self.S:
            off = self.off[s.name]['customer']
            rows = []
            for r in s.rows('customer_entity', 'order by entity_id'):
                em = r['email'].lower()
                if em in by_email:
                    # Same person in both stores (identical name/e-mail/address): one account.
                    # The storefront persona logs in with the shop password, so the shop
                    # password hash wins; everything else keeps the first (admin) record.
                    idmap(self.idmap_rows, s, 'customer', r['entity_id'], by_email[em])
                    s.map['customer_merged'][r['entity_id']] = by_email[em]
                    if s.name == 'shop' and r['password_hash']:
                        o.db.execute('update customers set password_hash=? where id=?', (r['password_hash'], by_email[em]))
                    continue
                new = r['entity_id'] + off
                by_email[em] = new
                idmap(self.idmap_rows, s, 'customer', r['entity_id'], new)
                rows.append({'id': new, 'email': r['email'], 'prefix': r['prefix'], 'firstname': r['firstname'],
                             'middlename': r['middlename'], 'lastname': r['lastname'], 'suffix': r['suffix'],
                             'dob': r['dob'], 'gender': r['gender'], 'taxvat': r['taxvat'], 'group_id': r['group_id'],
                             'is_active': r['is_active'], 'password_hash': r['password_hash'],
                             'default_billing_id': r['default_billing'], 'default_shipping_id': r['default_shipping'],
                             'created_at': r['created_at'], 'updated_at': r['updated_at'], 'created_in': r['created_in'],
                             'confirmation': r['confirmation'], 'failures_num': r['failures_num'],
                             'lock_expires': r['lock_expires'], 'source': s.name})
            o.insert('customers', rows)
            log('customers %s: %d new, %d merged by email' % (s.name, len(rows), len(s.map['customer_merged'])))
            # addresses (customer_address_entity is flat in Magento 2.4)
            aoff = self.off[s.name]['customer_address']
            arows = []
            merged = s.map['customer_merged']
            for r in s.rows('customer_address_entity'):
                cid = s.map['customer'].get(r['parent_id'])
                if cid is None:
                    continue
                if r['parent_id'] in merged:
                    key = tuple((r[k] or '') for k in ADDR_KEY)
                    dup = [x for x in o.db.execute('select id, %s from customer_addresses where customer_id=?'
                                                   % ','.join(ADDR_KEY), (cid,))
                           if tuple((v or '') for v in x[1:]) == key]
                    if dup:
                        idmap(self.idmap_rows, s, 'customer_address', r['entity_id'], dup[0][0])
                        continue
                new = r['entity_id'] + aoff
                idmap(self.idmap_rows, s, 'customer_address', r['entity_id'], new)
                arows.append({'id': new, 'customer_id': cid, 'prefix': r['prefix'], 'firstname': r['firstname'],
                              'middlename': r['middlename'], 'lastname': r['lastname'], 'suffix': r['suffix'],
                              'company': r['company'], 'street': r['street'], 'city': r['city'], 'region': r['region'],
                              'region_id': r['region_id'], 'postcode': r['postcode'], 'country_id': r['country_id'],
                              'telephone': r['telephone'], 'fax': r['fax'], 'vat_id': r['vat_id'],
                              'is_active': r['is_active'], 'created_at': r['created_at'], 'updated_at': r['updated_at']})
            o.insert('customer_addresses', arows)
            o.db.commit()
            A = s.map['customer_address']
            for old, new in s.map['customer'].items():
                if old in merged:
                    continue
                c = o.db.execute('select default_billing_id, default_shipping_id from customers where id=?', (new,)).fetchone()
                o.db.execute('update customers set default_billing_id=?, default_shipping_id=? where id=?',
                             (A.get(c[0]), A.get(c[1]), new))
            # newsletter
            noff = self.off[s.name]['newsletter']
            o.insert('newsletter_subscribers', ({'id': r['subscriber_id'] + noff,
                                                 'customer_id': s.map['customer'].get(r['customer_id']) if r['customer_id'] else None,
                                                 'email': r['subscriber_email'], 'status': r['subscriber_status'],
                                                 'change_status_at': r['change_status_at'], 'confirm_code': None}
                                                for r in s.rows('newsletter_subscriber')))
            if s.has('customer_log'):
                o.insert('customer_log', ({'customer_id': s.map['customer'][r['customer_id']], 'last_login_at': r['last_login_at'],
                                           'last_logout_at': r['last_logout_at']} for r in s.rows('customer_log')
                                          if r['customer_id'] in s.map['customer']), 'insert or replace')
        o.db.commit()

    def wishlists_carts(self):
        o = self.o
        for s in self.S:
            P, Cu = s.map['product'], s.map['customer']
            woff = self.off[s.name]['wishlist']
            W = {}
            for r in s.rows('wishlist'):
                cid = Cu.get(r['customer_id'])
                if cid is None:
                    continue
                ex = o.db.execute('select id from wishlists where customer_id=?', (cid,)).fetchone()
                if ex:
                    W[r['wishlist_id']] = ex[0]
                    continue
                W[r['wishlist_id']] = r['wishlist_id'] + woff
                o.insert('wishlists', [{'id': r['wishlist_id'] + woff, 'customer_id': cid, 'shared': r['shared'],
                                        'sharing_code': r['sharing_code'], 'updated_at': r['updated_at']}])
            wioff = self.off[s.name]['wishlist_item']
            opts = defaultdict(dict)
            for r in s.rows('wishlist_item_option'):
                opts[r['wishlist_item_id']][r['code']] = r['value']
            o.insert('wishlist_items', ({'id': r['wishlist_item_id'] + wioff, 'wishlist_id': W[r['wishlist_id']],
                                         'product_id': P[r['product_id']], 'qty': num(r['qty']),
                                         'description': r['description'], 'added_at': r['added_at'],
                                         'options_json': scrub_options(json.dumps(opts[r['wishlist_item_id']])) if opts.get(r['wishlist_item_id']) else None}
                                        for r in s.rows('wishlist_item') if r['wishlist_id'] in W and r['product_id'] in P))
            # carts: customer quotes that are active and have items
            qoff = self.off[s.name]['quote']
            qioff = self.off[s.name]['quote_item']
            Q = {}
            for r in s.rows('quote', 'where customer_id is not null and is_active=1 and items_count>0'):
                cid = Cu.get(r['customer_id'])
                if cid is None:
                    continue
                Q[r['entity_id']] = r['entity_id'] + qoff
                o.insert('carts', [{'id': r['entity_id'] + qoff, 'customer_id': cid, 'is_active': r['is_active'],
                                    'items_count': r['items_count'], 'items_qty': num(r['items_qty']),
                                    'subtotal': money(r['subtotal']), 'grand_total': money(r['grand_total']),
                                    'coupon_code': r['coupon_code'], 'created_at': r['created_at'],
                                    'updated_at': r['updated_at'], 'source': s.name}])
            qopts = defaultdict(dict)
            if Q:
                for r in s.rows('quote_item_option'):
                    qopts[r['item_id']][r['code']] = r['value']
            o.insert('cart_items', ({'id': r['item_id'] + qioff, 'cart_id': Q[r['quote_id']],
                                     'parent_item_id': r['parent_item_id'] + qioff if r['parent_item_id'] else None,
                                     'product_id': P.get(r['product_id']), 'product_type': r['product_type'], 'sku': r['sku'],
                                     'name': r['name'], 'qty': num(r['qty']), 'price': money(r['price']),
                                     'row_total': money(r['row_total']),
                                     'options_json': scrub_options(json.dumps(qopts[r['item_id']])) if qopts.get(r['item_id']) else None,
                                     'created_at': r['created_at'], 'updated_at': r['updated_at']}
                                    for r in s.rows('quote_item') if r['quote_id'] in Q))
            log('wishlists/carts %s: %d wishlists, %d carts' % (s.name, len(W), len(Q)))
        o.db.commit()

    # -------------------------------------------------------------- sales
    def sales(self):
        o = self.o
        for s in self.S:
            P, Cu, CA = s.map['product'], s.map['customer'], s.map['customer_address']
            off = self.off[s.name]
            O = {}
            pay = {r['parent_id']: r for r in s.rows('sales_order_payment')}
            rows = []
            for r in s.rows('sales_order', 'order by entity_id'):
                new = r['entity_id'] + off['order']
                inc = r['increment_id']
                if off['order']:
                    inc = renumber_increment(inc, off['order'])
                    idmap(self.idmap_rows, s, 'order_increment_id', r['increment_id'], inc)
                O[r['entity_id']] = new
                idmap(self.idmap_rows, s, 'order', r['entity_id'], new)
                pm = pay.get(r['entity_id'])
                rows.append({
                    'id': new, 'increment_id': inc, 'state': r['state'], 'status': r['status'],
                    'customer_id': Cu.get(r['customer_id']), 'customer_email': r['customer_email'],
                    'customer_firstname': r['customer_firstname'], 'customer_lastname': r['customer_lastname'],
                    'customer_group_id': r['customer_group_id'], 'customer_is_guest': r['customer_is_guest'],
                    'customer_note': r['customer_note'], 'created_at': r['created_at'], 'updated_at': r['updated_at'],
                    'subtotal': money(r['subtotal']), 'subtotal_incl_tax': money(r['subtotal_incl_tax']),
                    'discount_amount': money(r['discount_amount']), 'discount_description': r['discount_description'],
                    'shipping_amount': money(r['shipping_amount']), 'shipping_incl_tax': money(r['shipping_incl_tax']),
                    'tax_amount': money(r['tax_amount']), 'grand_total': money(r['grand_total']),
                    'total_paid': money(r['total_paid']), 'total_due': money(r['total_due']),
                    'total_invoiced': money(r['total_invoiced']), 'total_refunded': money(r['total_refunded']),
                    'total_canceled': money(r['total_canceled']),
                    'total_offline_refunded': money(r['total_offline_refunded']),
                    'total_online_refunded': money(r['total_online_refunded']),
                    'subtotal_invoiced': money(r['subtotal_invoiced']), 'subtotal_refunded': money(r['subtotal_refunded']),
                    'subtotal_canceled': money(r['subtotal_canceled']), 'shipping_invoiced': money(r['shipping_invoiced']),
                    'shipping_refunded': money(r['shipping_refunded']), 'shipping_canceled': money(r['shipping_canceled']),
                    'total_qty_ordered': num(r['total_qty_ordered']), 'total_item_count': r['total_item_count'],
                    'weight': num(r['weight']), 'shipping_method': r['shipping_method'],
                    'shipping_description': r['shipping_description'], 'payment_method': pm['method'] if pm else None,
                    'coupon_code': r['coupon_code'], 'applied_rule_ids': r['applied_rule_ids'], 'remote_ip': r['remote_ip'],
                    'currency': r['order_currency_code'], 'store_name': r['store_name'],
                    'billing_address_id': r['billing_address_id'] + off['order_address'] if r['billing_address_id'] else None,
                    'shipping_address_id': r['shipping_address_id'] + off['order_address'] if r['shipping_address_id'] else None,
                    'source': s.name, 'source_id': r['entity_id']})
            o.insert('orders', rows)
            oi = off['order_item']
            o.insert('order_items', ({
                'id': r['item_id'] + oi, 'order_id': O[r['order_id']],
                'parent_item_id': r['parent_item_id'] + oi if r['parent_item_id'] else None,
                'product_id': P.get(r['product_id']), 'product_type': r['product_type'], 'sku': r['sku'], 'name': r['name'],
                'options_json': scrub_options(r['product_options']), 'qty_ordered': num(r['qty_ordered']),
                'qty_invoiced': num(r['qty_invoiced']), 'qty_shipped': num(r['qty_shipped']),
                'qty_refunded': num(r['qty_refunded']), 'qty_canceled': num(r['qty_canceled']),
                'price': money(r['price']), 'base_price': money(r['base_price']), 'original_price': money(r['original_price']),
                'price_incl_tax': money(r['price_incl_tax']), 'discount_percent': num(r['discount_percent']),
                'discount_amount': money(r['discount_amount']), 'tax_percent': num(r['tax_percent']),
                'tax_amount': money(r['tax_amount']), 'row_total': money(r['row_total']),
                'row_total_incl_tax': money(r['row_total_incl_tax']), 'amount_refunded': money(r['amount_refunded']),
                'row_invoiced': money(r['row_invoiced']), 'weight': num(r['weight']), 'row_weight': num(r['row_weight']),
                'applied_rule_ids': r['applied_rule_ids'], 'created_at': r['created_at'], 'updated_at': r['updated_at']}
                for r in s.rows('sales_order_item') if r['order_id'] in O))
            oa = off['order_address']
            o.insert('order_addresses', ({
                'id': r['entity_id'] + oa, 'order_id': O[r['parent_id']], 'address_type': r['address_type'],
                'customer_address_id': CA.get(r['customer_address_id']), 'customer_id': Cu.get(r['customer_id']),
                'prefix': r['prefix'], 'firstname': r['firstname'], 'middlename': r['middlename'], 'lastname': r['lastname'],
                'suffix': r['suffix'], 'company': r['company'], 'street': r['street'], 'city': r['city'],
                'region': r['region'], 'region_id': r['region_id'], 'postcode': r['postcode'], 'country_id': r['country_id'],
                'telephone': r['telephone'], 'fax': r['fax'], 'email': r['email']}
                for r in s.rows('sales_order_address') if r['parent_id'] in O))
            op = off['order_payment']
            o.insert('order_payments', ({
                'id': r['entity_id'] + op, 'order_id': O[r['parent_id']], 'method': r['method'],
                'amount_ordered': money(r['amount_ordered']), 'amount_paid': money(r['amount_paid']),
                'amount_refunded': money(r['amount_refunded']), 'amount_canceled': money(r['amount_canceled']),
                'shipping_amount': money(r['shipping_amount']), 'cc_type': r['cc_type'], 'cc_last_4': r['cc_last_4'],
                'po_number': r['po_number'], 'additional_information': r['additional_information']}
                for r in s.rows('sales_order_payment') if r['parent_id'] in O))
            oh = off['order_status_history']
            o.insert('order_status_history', ({
                'id': r['entity_id'] + oh, 'order_id': O[r['parent_id']], 'status': r['status'], 'comment': r['comment'],
                'is_customer_notified': r['is_customer_notified'], 'is_visible_on_front': r['is_visible_on_front'],
                'entity_name': r['entity_name'], 'created_at': r['created_at']}
                for r in s.rows('sales_order_status_history') if r['parent_id'] in O))
            self.sales_docs(s, O)
            log('orders %s: %d' % (s.name, len(rows)))
        o.db.commit()

    def sales_docs(self, s, O):
        o = self.o
        off = self.off[s.name]
        P = s.map['product']
        oi, oa = off['order_item'], off['order_address']
        I = {}
        for r in s.rows('sales_invoice'):
            if r['order_id'] not in O:
                continue
            new = r['entity_id'] + off['invoice']
            I[r['entity_id']] = new
            inc = r['increment_id'] if not off['order'] else renumber_increment(r['increment_id'], off['invoice'])
            idmap(self.idmap_rows, s, 'invoice', r['entity_id'], new)
            if inc != r['increment_id']:
                idmap(self.idmap_rows, s, 'invoice_increment_id', r['increment_id'], inc)
            o.insert('invoices', [{'id': new, 'increment_id': inc, 'order_id': O[r['order_id']], 'state': r['state'],
                                   'subtotal': money(r['subtotal']), 'discount_amount': money(r['discount_amount']),
                                   'shipping_amount': money(r['shipping_amount']), 'tax_amount': money(r['tax_amount']),
                                   'grand_total': money(r['grand_total']), 'total_qty': num(r['total_qty']),
                                   'billing_address_id': r['billing_address_id'] + oa if r['billing_address_id'] else None,
                                   'shipping_address_id': r['shipping_address_id'] + oa if r['shipping_address_id'] else None,
                                   'email_sent': r['email_sent'], 'created_at': r['created_at'], 'updated_at': r['updated_at']}])
        o.insert('invoice_items', ({'id': r['entity_id'] + off['invoice_item'], 'invoice_id': I[r['parent_id']],
                                    'order_item_id': r['order_item_id'] + oi if r['order_item_id'] else None,
                                    'product_id': P.get(r['product_id']), 'sku': r['sku'], 'name': r['name'],
                                    'qty': num(r['qty']), 'price': money(r['price']), 'row_total': money(r['row_total']),
                                    'discount_amount': money(r['discount_amount']), 'tax_amount': money(r['tax_amount'])}
                                   for r in s.rows('sales_invoice_item') if r['parent_id'] in I))
        S = {}
        for r in s.rows('sales_shipment'):
            if r['order_id'] not in O:
                continue
            new = r['entity_id'] + off['shipment']
            S[r['entity_id']] = new
            inc = r['increment_id'] if not off['order'] else renumber_increment(r['increment_id'], off['shipment'])
            idmap(self.idmap_rows, s, 'shipment', r['entity_id'], new)
            if inc != r['increment_id']:
                idmap(self.idmap_rows, s, 'shipment_increment_id', r['increment_id'], inc)
            o.insert('shipments', [{'id': new, 'increment_id': inc, 'order_id': O[r['order_id']],
                                    'total_qty': num(r['total_qty']), 'total_weight': num(r['total_weight']),
                                    'shipping_address_id': r['shipping_address_id'] + oa if r['shipping_address_id'] else None,
                                    'billing_address_id': r['billing_address_id'] + oa if r['billing_address_id'] else None,
                                    'email_sent': r['email_sent'], 'created_at': r['created_at'], 'updated_at': r['updated_at']}])
        o.insert('shipment_items', ({'id': r['entity_id'] + off['shipment_item'], 'shipment_id': S[r['parent_id']],
                                     'order_item_id': r['order_item_id'] + oi if r['order_item_id'] else None,
                                     'product_id': P.get(r['product_id']), 'sku': r['sku'], 'name': r['name'],
                                     'qty': num(r['qty']), 'price': money(r['price']), 'weight': num(r['weight'])}
                                    for r in s.rows('sales_shipment_item') if r['parent_id'] in S))
        o.insert('shipment_tracks', ({'id': r['entity_id'] + off['shipment_track'], 'shipment_id': S.get(r['parent_id']),
                                      'order_id': O.get(r['order_id']), 'carrier_code': r['carrier_code'], 'title': r['title'],
                                      'track_number': r['track_number'], 'created_at': r['created_at'],
                                      'updated_at': r['updated_at']}
                                     for r in s.rows('sales_shipment_track') if r['order_id'] in O))
        CM = {}
        for r in s.rows('sales_creditmemo'):
            if r['order_id'] not in O:
                continue
            new = r['entity_id'] + off['creditmemo']
            CM[r['entity_id']] = new
            inc = r['increment_id'] if not off['order'] else renumber_increment(r['increment_id'], off['creditmemo'])
            idmap(self.idmap_rows, s, 'creditmemo', r['entity_id'], new)
            if inc != r['increment_id']:
                idmap(self.idmap_rows, s, 'creditmemo_increment_id', r['increment_id'], inc)
            o.insert('credit_memos', [{'id': new, 'increment_id': inc, 'order_id': O[r['order_id']],
                                       'invoice_id': I.get(r['invoice_id']), 'state': r['state'],
                                       'subtotal': money(r['subtotal']), 'discount_amount': money(r['discount_amount']),
                                       'shipping_amount': money(r['shipping_amount']), 'tax_amount': money(r['tax_amount']),
                                       'adjustment_positive': money(r['adjustment_positive']),
                                       'adjustment_negative': money(r['adjustment_negative']),
                                       'adjustment': money(r['adjustment']), 'grand_total': money(r['grand_total']),
                                       'created_at': r['created_at'], 'updated_at': r['updated_at']}])
        o.insert('credit_memo_items', ({'id': r['entity_id'] + off['creditmemo_item'], 'credit_memo_id': CM[r['parent_id']],
                                        'order_item_id': r['order_item_id'] + oi if r['order_item_id'] else None,
                                        'product_id': P.get(r['product_id']), 'sku': r['sku'], 'name': r['name'],
                                        'qty': num(r['qty']), 'price': money(r['price']), 'row_total': money(r['row_total']),
                                        'discount_amount': money(r['discount_amount']), 'tax_amount': money(r['tax_amount'])}
                                       for r in s.rows('sales_creditmemo_item') if r['parent_id'] in CM))
        for et, t, M in (('invoice', 'sales_invoice_comment', I), ('shipment', 'sales_shipment_comment', S),
                         ('creditmemo', 'sales_creditmemo_comment', CM)):
            o.insert('sales_comments', ({'entity_type': et, 'parent_id': M[r['parent_id']], 'comment': r['comment'],
                                         'is_customer_notified': r['is_customer_notified'],
                                         'is_visible_on_front': r['is_visible_on_front'], 'created_at': r['created_at']}
                                        for r in s.rows(t) if r['parent_id'] in M))

    # -------------------------------------------------------------- marketing / content / admin
    def marketing(self):
        o = self.o
        for s in self.S:
            off = self.off[s.name]
            groups = defaultdict(list)
            for r in s.rows('salesrule_customer_group'):
                groups[r['rule_id']].append(str(r['customer_group_id']))
            labels = {r['rule_id']: r['label'] for r in s.rows('salesrule_label')}
            R = {}
            for r in s.rows('salesrule'):
                new = r['rule_id'] + off['sales_rule']
                R[r['rule_id']] = new
                idmap(self.idmap_rows, s, 'sales_rule', r['rule_id'], new)
                o.insert('sales_rules', [{
                    'id': new, 'name': r['name'], 'description': r['description'], 'is_active': r['is_active'],
                    'from_date': r['from_date'], 'to_date': r['to_date'], 'customer_group_ids': ','.join(groups[r['rule_id']]),
                    'uses_per_customer': r['uses_per_customer'], 'uses_per_coupon': r['uses_per_coupon'],
                    'coupon_type': r['coupon_type'], 'use_auto_generation': r['use_auto_generation'],
                    'conditions_json': r['conditions_serialized'], 'actions_json': r['actions_serialized'],
                    'stop_rules_processing': r['stop_rules_processing'], 'sort_order': r['sort_order'],
                    'simple_action': r['simple_action'], 'discount_amount': money(r['discount_amount']),
                    'discount_qty': num(r['discount_qty']), 'discount_step': r['discount_step'],
                    'apply_to_shipping': r['apply_to_shipping'], 'simple_free_shipping': r['simple_free_shipping'],
                    'times_used': r['times_used'], 'is_rss': r['is_rss'], 'store_label': labels.get(r['rule_id']),
                    'source': s.name}])
            o.insert('coupons', ({'id': r['coupon_id'] + off['coupon'], 'rule_id': R.get(r['rule_id']), 'code': r['code'],
                                  'usage_limit': r['usage_limit'], 'usage_per_customer': r['usage_per_customer'],
                                  'times_used': r['times_used'], 'expiration_date': r['expiration_date'],
                                  'is_primary': r['is_primary'], 'created_at': r['created_at'], 'type': r['type']}
                                 for r in s.rows('salesrule_coupon')), 'insert or ignore')
            o.insert('sales_rule_usage', ({'rule_id': R[r['rule_id']], 'customer_id': s.map['customer'].get(r['customer_id']),
                                           'times_used': r['times_used']} for r in s.rows('salesrule_customer')
                                          if r['rule_id'] in R), 'insert or ignore')
            cg = defaultdict(list)
            for r in s.rows('catalogrule_customer_group'):
                cg[r['rule_id']].append(str(r['customer_group_id']))
            for r in s.rows('catalogrule'):
                new = r['rule_id'] + off['catalog_rule']
                idmap(self.idmap_rows, s, 'catalog_rule', r['rule_id'], new)
                o.insert('catalog_rules', [{
                    'id': new, 'name': r['name'], 'description': r['description'], 'is_active': r['is_active'],
                    'from_date': r['from_date'], 'to_date': r['to_date'], 'customer_group_ids': ','.join(cg[r['rule_id']]),
                    'conditions_json': r['conditions_serialized'], 'actions_json': r['actions_serialized'],
                    'stop_rules_processing': r['stop_rules_processing'], 'sort_order': r['sort_order'],
                    'simple_action': r['simple_action'], 'discount_amount': money(r['discount_amount']), 'source': s.name}])
            # search terms merged by query text (popularity summed, admin values otherwise kept)
            for r in s.rows('search_query', 'where store_id=1'):
                ex = o.db.execute('select id, popularity from search_terms where query_text=?', (r['query_text'],)).fetchone()
                if ex:
                    o.db.execute('update search_terms set popularity=popularity+? where id=?', (r['popularity'], ex[0]))
                    idmap(self.idmap_rows, s, 'search_query', r['query_id'], ex[0])
                    continue
                new = r['query_id'] + off['search_query']
                idmap(self.idmap_rows, s, 'search_query', r['query_id'], new)
                o.insert('search_terms', [{'id': new, 'query_text': r['query_text'], 'num_results': r['num_results'],
                                           'popularity': r['popularity'], 'redirect': r['redirect'],
                                           'display_in_terms': r['display_in_terms'], 'is_active': r['is_active'],
                                           'updated_at': r['updated_at'], 'source': s.name}])
            if s.has('search_synonyms'):
                o.insert('search_synonyms', ({'synonyms': r['synonyms']} for r in s.rows('search_synonyms')))
        o.db.commit()

    def content(self):
        o = self.o
        for s in self.S:
            off = self.off[s.name]
            for r in s.rows('cms_page'):
                ex = o.db.execute('select id from cms_pages where identifier=?', (r['identifier'],)).fetchone()
                if ex:   # same identifier in both stores: first (admin) wins; shop copy kept under a suffixed identifier
                    ident = r['identifier'] + '-' + s.name
                else:
                    ident = r['identifier']
                new = r['page_id'] + off['cms_page']
                idmap(self.idmap_rows, s, 'cms_page', r['page_id'], new)
                if ident != r['identifier']:
                    idmap(self.idmap_rows, s, 'cms_page_identifier', r['identifier'], ident)
                o.insert('cms_pages', [{'id': new, 'identifier': ident, 'title': r['title'], 'page_layout': r['page_layout'],
                                        'meta_title': r['meta_title'], 'meta_keywords': r['meta_keywords'],
                                        'meta_description': r['meta_description'], 'content_heading': r['content_heading'],
                                        'content': r['content'], 'is_active': r['is_active'], 'sort_order': r['sort_order'],
                                        'created_at': r['creation_time'], 'updated_at': r['update_time'], 'source': s.name}])
            for r in s.rows('cms_block'):
                ex = o.db.execute('select id from cms_blocks where identifier=?', (r['identifier'],)).fetchone()
                ident = r['identifier'] + '-' + s.name if ex else r['identifier']
                new = r['block_id'] + off['cms_block']
                idmap(self.idmap_rows, s, 'cms_block', r['block_id'], new)
                o.insert('cms_blocks', [{'id': new, 'identifier': ident, 'title': r['title'], 'content': r['content'],
                                         'is_active': r['is_active'], 'created_at': r['creation_time'],
                                         'updated_at': r['update_time'], 'source': s.name}])
        o.db.commit()

    def admin(self):
        o = self.o
        for s in self.S:
            roles = {}
            for r in s.rows('authorization_role'):
                if r['role_type'] == 'G':
                    ex = o.db.execute("select id from admin_roles where name=? and role_type='G'", (r['role_name'],)).fetchone()
                    if ex:
                        roles[r['role_id']] = ex[0]
                        continue
                    new = o.db.execute('select coalesce(max(id),0)+1 from admin_roles').fetchone()[0]
                    roles[r['role_id']] = new
                    o.insert('admin_roles', [{'id': new, 'name': r['role_name'], 'parent_id': 0, 'role_type': 'G'}])
                    o.insert('admin_role_rules', ({'role_id': new, 'resource_id': x['resource_id'], 'permission': x['permission']}
                                                  for x in s.rows('authorization_rule') if x['role_id'] == r['role_id']))
            user_role = {}
            for r in s.rows('authorization_role'):
                if r['role_type'] == 'U' and r['user_type'] == 2:
                    user_role[r['user_id']] = roles.get(r['parent_id'])
            for r in s.rows('admin_user'):
                ex = o.db.execute('select id from admin_users where username=?', (r['username'],)).fetchone()
                if ex:
                    idmap(self.idmap_rows, s, 'admin_user', r['user_id'], ex[0])
                    continue
                new = o.db.execute('select coalesce(max(id),0)+1 from admin_users').fetchone()[0]
                idmap(self.idmap_rows, s, 'admin_user', r['user_id'], new)
                o.insert('admin_users', [{'id': new, 'username': r['username'], 'firstname': r['firstname'],
                                          'lastname': r['lastname'], 'email': r['email'], 'password_hash': r['password'],
                                          'is_active': r['is_active'], 'role_id': user_role.get(r['user_id']),
                                          'created_at': r['created'], 'updated_at': r['modified'], 'logdate': r['logdate'],
                                          'lognum': r['lognum'], 'interface_locale': r['interface_locale']}])
        o.db.commit()

    def reports(self):
        o = self.o
        for s in self.S:
            P = s.map['product']
            for pt, t in (('daily', 'sales_bestsellers_aggregated_daily'), ('monthly', 'sales_bestsellers_aggregated_monthly'),
                          ('yearly', 'sales_bestsellers_aggregated_yearly')):
                o.insert('report_bestsellers', ({'period_type': pt, 'period': r['period'], 'product_id': P.get(r['product_id']),
                                                 'product_name': r['product_name'], 'product_price': money(r['product_price']),
                                                 'qty_ordered': num(r['qty_ordered']), 'rating_pos': r['rating_pos'],
                                                 'source': s.name} for r in s.rows(t, 'where store_id=1')))
            cols = o.columns('report_sales')
            o.insert('report_sales', ({**{c: (r[c] if c in ('period', 'order_status', 'orders_count') else num(r[c]))
                                          for c in cols if c != 'source' and c in r.keys()}, 'source': s.name}
                                      for r in s.rows('sales_order_aggregated_created', 'where store_id=1')))
            o.insert('report_refunded', ({'period': r['period'], 'order_status': r['order_status'],
                                          'orders_count': r['orders_count'], 'refunded': num(r['refunded']),
                                          'online_refunded': num(r['online_refunded']),
                                          'offline_refunded': num(r['offline_refunded']), 'source': s.name}
                                         for r in s.rows('sales_refunded_aggregated', 'where store_id=1')))
            o.insert('report_invoiced', ({'period': r['period'], 'order_status': r['order_status'],
                                          'orders_count': r['orders_count'], 'orders_invoiced': r['orders_invoiced'],
                                          'invoiced': num(r['invoiced']), 'invoiced_captured': num(r['invoiced_captured']),
                                          'invoiced_not_captured': num(r['invoiced_not_captured']), 'source': s.name}
                                         for r in s.rows('sales_invoiced_aggregated', 'where store_id=1')))
            o.insert('report_shipping', ({'period': r['period'], 'order_status': r['order_status'],
                                          'shipping_description': r['shipping_description'], 'orders_count': r['orders_count'],
                                          'total_shipping': num(r['total_shipping']),
                                          'total_shipping_actual': num(r['total_shipping_actual']), 'source': s.name}
                                         for r in s.rows('sales_shipping_aggregated', 'where store_id=1')))
            o.insert('report_tax', ({'period': r['period'], 'code': r['code'], 'order_status': r['order_status'],
                                     'percent': num(r['percent']), 'orders_count': r['orders_count'],
                                     'tax_base_amount_sum': num(r['tax_base_amount_sum']), 'source': s.name}
                                    for r in s.rows('tax_order_aggregated_created', 'where store_id=1')))
            o.insert('report_coupons', ({'period': r['period'], 'order_status': r['order_status'],
                                         'coupon_code': r['coupon_code'], 'coupon_uses': r['coupon_uses'],
                                         'subtotal_amount': num(r['subtotal_amount']),
                                         'discount_amount': num(r['discount_amount']), 'total_amount': num(r['total_amount']),
                                         'rule_name': r['rule_name'], 'source': s.name}
                                        for r in s.rows('salesrule_coupon_aggregated', 'where store_id=1')))
        o.db.commit()

    # -------------------------------------------------------------- search
    def search_index(self):
        db = self.o.db
        db.executescript(open(os.path.join(HERE, 'search.sql')).read())
        db.create_function('strip_html', 1, strip_html, deterministic=True)
        db.execute('insert into product_search(rowid, name, brand, categories, sku, description) '
                   'select p.id, p.name, p.brand, n.names, p.sku, strip_html(p.description) '
                   'from products p left join product_category_names n on n.product_id = p.id')
        db.execute('insert into product_search_tri(rowid, name, sku) select id, name, sku from products')
        db.execute("insert into product_search(product_search) values('optimize')")
        db.execute("insert into product_search_tri(product_search_tri) values('optimize')")
        db.commit()

    def finish(self):
        o = self.o
        rows = self.idmap_rows
        o.db.executemany('insert or replace into id_map values (?,?,?,?)', rows)
        for k, v in self.info.items():
            o.db.execute('insert or replace into build_info values (?,?)', (k, str(v)))
        o.db.commit()

    def run(self):
        self.plan_offsets()
        self.directory()
        self.simple_lookups()
        self.attributes()
        self.categories()
        # CMS first: url_rewrites reference cms page ids
        self.content()
        self.products()
        self.product_relations()
        self.images()
        self.url_rewrites()
        self.customers()
        self.reviews()
        self.wishlists_carts()
        self.sales()
        self.marketing()
        self.admin()
        self.reports()
        self.search_index()
        self.finish()


ADDR_KEY = ('firstname', 'lastname', 'company', 'street', 'city', 'region_id', 'postcode', 'country_id', 'telephone')
_TAG = re.compile(r'<[^>]*>')
_WS = re.compile(r'\s+')


def strip_html(s):
    if not s:
        return s
    import html
    return _WS.sub(' ', html.unescape(_TAG.sub(' ', s))).strip()


SCRUB_KEYS = ('login', 'form_key')


def scrub_options(js):
    """Drop form noise (login form with credentials, form_key) from a Magento buyRequest JSON."""
    if not js or not any(k in js for k in SCRUB_KEYS):
        return js
    try:
        d = json.loads(js)
    except ValueError:
        return js

    def walk(x):
        if isinstance(x, dict):
            for k in SCRUB_KEYS:
                x.pop(k, None)
            for k, v in list(x.items()):
                if isinstance(v, str) and v.startswith('{') and any(s in v for s in SCRUB_KEYS):
                    try:
                        x[k] = json.dumps(walk(json.loads(v)))
                    except ValueError:
                        pass
                else:
                    walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        return x
    return json.dumps(walk(d))


def renumber_increment(inc, offset):
    """'000000170' + 1000 -> '000001170' (same width, digits only)."""
    m = re.match(r'^(\D*)(\d+)$', inc or '')
    if not m:
        return inc
    width = len(m.group(2))
    return m.group(1) + str(int(m.group(2)) + offset).zfill(width)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--admin', required=True)
    ap.add_argument('--shop')
    ap.add_argument('--out', required=True)
    ap.add_argument('--iso3166')
    a = ap.parse_args()
    srcs = [Src('admin', a.admin)]
    if a.shop:
        srcs.append(Src('shop', a.shop))
    out = Out(a.out)
    b = Builder(out, srcs, a.iso3166)
    b.run()
    out.db.execute('analyze')
    out.db.commit()
    out.db.close()
    log('done')


if __name__ == '__main__':
    main()
