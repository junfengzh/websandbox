'use strict';
// Rule conditions (Magento's conditions_json): render as text, edit as a flat list under the
// top "If ALL/ANY of these conditions are TRUE/FALSE" combine; existing nested conditions are
// kept as-is unless removed. Form fields (prefix = conditions | actions):
//   <prefix>[aggregator] all|any, <prefix>[value] 1|0, <prefix>[remove][]=<index>,
//   <prefix>[new][<n>][attribute|operator|value]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const OPS = [['==', 'is'], ['!=', 'is not'], ['>=', 'equals or greater than'], ['<=', 'equals or less than'], ['>', 'greater than'], ['<', 'less than'], ['{}', 'contains'], ['!{}', 'does not contain'], ['()', 'is one of'], ['!()', 'is not one of']];
const OPL = Object.fromEntries(OPS);
const NS = {
  cart: { combine: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Combine', address: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Address', found: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Product\\Found', product: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Product', pcombine: 'Magento\\SalesRule\\Model\\Rule\\Condition\\Product\\Combine' },
  catalog: { combine: 'Magento\\CatalogRule\\Model\\Rule\\Condition\\Combine', product: 'Magento\\CatalogRule\\Model\\Rule\\Condition\\Product' },
};
const ADDRESS_ATTRS = [['base_subtotal', 'Subtotal (Excl. Tax)'], ['base_subtotal_with_discount', 'Subtotal (Excl. Tax) with discount'], ['total_qty', 'Total Items Quantity'], ['weight', 'Total Weight'], ['payment_method', 'Payment Method'], ['shipping_method', 'Shipping Method'], ['postcode', 'Shipping Postcode'], ['region', 'Shipping Region'], ['region_id', 'Shipping State/Province'], ['country_id', 'Shipping Country']];
const PRODUCT_ATTRS = [['category_ids', 'Category'], ['sku', 'SKU'], ['attribute_set_id', 'Attribute Set'], ['price', 'Price'], ['color', 'Color'], ['size', 'Size'], ['material', 'Material'], ['activity', 'Activity'], ['gender', 'Gender'], ['sale', 'Sale'], ['new', 'New'], ['quote_item_qty', 'Quantity in cart'], ['quote_item_price', 'Price in cart'], ['quote_item_row_total', 'Row total in cart']];
const LABEL = Object.fromEntries([...ADDRESS_ATTRS, ...PRODUCT_ATTRS]);

function parse(json, kind, top = 'combine') {
  let c;
  try { c = JSON.parse(json || 'null'); } catch { c = null; }
  if (!c || typeof c !== 'object') c = { type: kind === 'cart' && top === 'pcombine' ? NS.cart.pcombine : NS[kind].combine, attribute: null, operator: null, value: '1', is_value_processed: null, aggregator: 'all' };
  if (!Array.isArray(c.conditions)) c.conditions = [];
  return c;
}

function describe(c) {
  if (!c) return '';
  if (Array.isArray(c.conditions) && (/Combine$|Found$|Subselect$/.test(c.type || ''))) {
    const agg = String(c.aggregator || 'all').toUpperCase();
    const tf = c.value === false || c.value === '0' || c.value === 0 ? 'FALSE' : 'TRUE';
    const head = /Found$/.test(c.type) ? `If an item is ${tf === 'TRUE' ? 'FOUND' : 'NOT FOUND'} in the cart with ${agg} of these conditions true:` : `If ${agg} of these conditions are ${tf}:`;
    return `${head} ${c.conditions.map(describe).map((s) => `[${s}]`).join(' ') || '(none)'}`;
  }
  return `${LABEL[c.attribute] || c.attribute} ${OPL[c.operator] || c.operator} ${Array.isArray(c.value) ? c.value.join(', ') : c.value}`;
}

// editor html for one top-level combine
function editor(prefix, c, kind, { productOnly = false } = {}) {
  const attrs = kind === 'catalog' || productOnly ? PRODUCT_ATTRS.filter((a) => !(kind === 'catalog' && a[0].startsWith('quote_'))).map(([k, l]) => [`product:${k}`, `Product: ${l}`])
    : [...ADDRESS_ATTRS.map(([k, l]) => [`address:${k}`, `Cart: ${l}`]), ...PRODUCT_ATTRS.map(([k, l]) => [`product:${k}`, `Product in cart: ${l}`])];
  const sel = (name, opts, cur, label) => `<label class="sr-only" for="${esc(name)}">${esc(label)}</label><select id="${esc(name)}" name="${esc(name)}">${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const tf = c.value === false || c.value === '0' || c.value === 0 ? '0' : '1';
  const rows = c.conditions.map((x, i) => `<li class="condition-row"><span>${esc(describe(x))}</span> <label class="choice"><input type="checkbox" name="${prefix}[remove][]" value="${i}"> Remove</label></li>`).join('');
  const blank = [0, 1].map((n) => `<div class="condition-row" role="group" aria-label="New condition ${n + 1}">
      ${sel(`${prefix}[new][${n}][attribute]`, [['', '-- add condition --'], ...attrs], '', 'Condition attribute')}
      ${sel(`${prefix}[new][${n}][operator]`, OPS, '==', 'Operator')}
      <label class="sr-only" for="${prefix}_new_${n}_value">Value</label><input id="${prefix}_new_${n}_value" type="text" name="${prefix}[new][${n}][value]" placeholder="value (comma list for 'is one of')">
    </div>`).join('');
  return `<div class="rule-tree" id="${prefix}__1__children">
    <p>If ${sel(`${prefix}[aggregator]`, [['all', 'ALL'], ['any', 'ANY']], c.aggregator || 'all', 'Aggregator')} of these conditions are ${sel(`${prefix}[value]`, [['1', 'TRUE'], ['0', 'FALSE']], tf, 'True or false')}:</p>
    <ul class="note-list">${rows || '<li class="muted">No conditions: the rule applies to everything.</li>'}</ul>${blank}</div>`;
}

// apply the form to a combine; returns the new JSON string
function apply(b, prefix, c, kind) {
  const str = (v) => (Array.isArray(v) ? v[v.length - 1] : v ?? '').toString().trim();
  if (b[`${prefix}[aggregator]`] != null) c.aggregator = str(b[`${prefix}[aggregator]`]) === 'any' ? 'any' : 'all';
  if (b[`${prefix}[value]`] != null) c.value = str(b[`${prefix}[value]`]) === '0' ? '0' : '1';
  const rm = new Set([].concat(b[`${prefix}[remove][]`] ?? b[`${prefix}[remove]`] ?? []).map((x) => +x));
  c.conditions = c.conditions.filter((_, i) => !rm.has(i));
  for (let n = 0; n < 5; n++) {
    const at = str(b[`${prefix}[new][${n}][attribute]`]);
    const val = str(b[`${prefix}[new][${n}][value]`]);
    if (!at || val === '') continue;
    const [scope, attribute] = at.split(':');
    const op = OPL[str(b[`${prefix}[new][${n}][operator]`])] ? str(b[`${prefix}[new][${n}][operator]`]) : '==';
    const value = op === '()' || op === '!()' ? val.split(',').map((s) => s.trim()).filter(Boolean).join(',') : val;
    if (kind === 'catalog') c.conditions.push({ type: NS.catalog.product, attribute, operator: op, value, is_value_processed: false });
    else if (scope === 'address') c.conditions.push({ type: NS.cart.address, attribute, operator: op, value, is_value_processed: false });
    else if (c.type === NS.cart.pcombine) c.conditions.push({ type: NS.cart.product, attribute, operator: op, value, is_value_processed: false, attribute_scope: '' });
    else c.conditions.push({ type: NS.cart.found, attribute: null, operator: null, value: '1', is_value_processed: null, aggregator: 'all', conditions: [{ type: NS.cart.product, attribute, operator: op, value, is_value_processed: false, attribute_scope: '' }] });
  }
  return JSON.stringify(c);
}

module.exports = { parse, describe, editor, apply, OPS };
