'use strict';
// Cart price rules (sales_rules + coupons): a small evaluator for the Magento condition
// trees in conditions_json / actions_json. Supports Combine (all/any, true/false),
// Address (base_subtotal, total_qty, weight, shipping_method, postcode, region_id, country_id),
// Product\Found / Product\Subselect, and Product conditions (category_ids, sku, attribute_set_id,
// quote_item_qty, quote_item_price, quote_item_row_total, any product attribute).
// Actions: by_percent, by_fixed, cart_fixed, buy_x_get_y; free shipping; stop_rules_processing.

const num = (v) => (v == null || v === '' ? null : Number(v));
const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '');

function compare(op, actual, expected) {
  const isArr = Array.isArray(actual);
  const exp = list(expected);
  const eq = (a, b) => (num(a) != null && num(b) != null && !isNaN(num(a)) && !isNaN(num(b)) ? num(a) === num(b) : String(a).toLowerCase() === String(b).toLowerCase());
  switch (op) {
    case '==': return isArr ? actual.some((a) => eq(a, expected)) : eq(actual, expected);
    case '!=': return isArr ? !actual.some((a) => eq(a, expected)) : !eq(actual, expected);
    case '>=': return num(actual) >= num(expected);
    case '>': return num(actual) > num(expected);
    case '<=': return num(actual) <= num(expected);
    case '<': return num(actual) < num(expected);
    case '()': return (isArr ? actual : [actual]).some((a) => exp.some((e) => eq(a, e)));
    case '!()': return !(isArr ? actual : [actual]).some((a) => exp.some((e) => eq(a, e)));
    case '{}': return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    case '!{}': return !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
    default: return false;
  }
}

function productValue(ctx, item, attr) {
  switch (attr) {
    case 'category_ids': return ctx.categoryIds(item.product_id);
    case 'sku': return item.sku;
    case 'quote_item_qty': return item.qty;
    case 'quote_item_price': return item.price;
    case 'quote_item_row_total': return item.row_total;
    default: return ctx.attribute(item.product_id, attr);
  }
}

function evalCond(c, ctx, item) {
  if (!c) return true;
  const t = String(c.type || '');
  const kids = c.conditions || [];
  if (/Combine$/.test(t)) {
    const want = c.value === undefined || c.value === null || c.value === true || String(c.value) === '1';
    if (!kids.length) return true;
    const res = kids.map((k) => evalCond(k, ctx, item));
    const agg = c.aggregator === 'any' ? res.some((r) => r === want) : res.every((r) => r === want);
    return agg;
  }
  if (/Product\\Found$/.test(t)) {
    const want = String(c.value ?? '1') === '1';
    const found = ctx.items.some((it) => (c.aggregator === 'any' ? !kids.length || kids.some((k) => evalCond(k, ctx, it)) : kids.every((k) => evalCond(k, ctx, it))));
    return want ? found : !found;
  }
  if (/Product\\Subselect$/.test(t)) {
    const match = ctx.items.filter((it) => (c.aggregator === 'any' ? !kids.length || kids.some((k) => evalCond(k, ctx, it)) : kids.every((k) => evalCond(k, ctx, it))));
    const v = c.attribute === 'base_row_total' ? match.reduce((s, it) => s + it.row_total, 0) : match.reduce((s, it) => s + it.qty, 0);
    return compare(c.operator, v, c.value);
  }
  if (/Address$/.test(t)) {
    const a = ctx.address;
    const v = { base_subtotal: ctx.subtotal, base_subtotal_with_discount: ctx.subtotal, total_qty: ctx.qty, weight: ctx.weight, shipping_method: ctx.shippingMethod, postcode: a && a.postcode, region_id: a && a.region_id, region: a && a.region, country_id: a && a.country_id, payment_method: ctx.paymentMethod }[c.attribute];
    return compare(c.operator, v, c.value);
  }
  if (/Product$/.test(t)) {
    if (!item) return ctx.items.some((it) => compare(c.operator, productValue(ctx, it, c.attribute), c.value));
    return compare(c.operator, productValue(ctx, item, c.attribute), c.value);
  }
  return true;
}

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// rules: sales_rules rows (active, in date, group matches) ordered by sort_order.
// cart: { items: [{id, product_id, sku, qty, price, row_total}], subtotal, qty, weight, address,
//   shippingMethod, coupon } ; ctx helpers: categoryIds(pid) -> [ids], attribute(pid, code)
// -> { discount, perItem: Map(itemId -> amount), freeShipping, applied: [{id, name, label, amount}], couponValid }
function apply(rules, cart, helpers) {
  const ctx = { ...cart, ...helpers };
  const perItem = new Map();
  const applied = [];
  let freeShipping = false;
  let couponValid = false;
  let total = 0;
  for (const r of rules) {
    if (r.coupon_type === 2 || r.coupon_type === 3) {
      if (!cart.coupon || !r.coupon_codes.includes(String(cart.coupon).toLowerCase())) continue;
    }
    if (!evalCond(parse(r.conditions_json), ctx, null)) continue;
    const act = parse(r.actions_json);
    const items = cart.items.filter((it) => evalCond(act, ctx, it));
    let amount = 0;
    const pct = Math.min(Number(r.discount_amount) || 0, 100) / 100;
    if (r.simple_action === 'by_percent') {
      for (const it of items) {
        const q = r.discount_qty ? Math.min(it.qty, r.discount_qty) : it.qty;
        const left = it.row_total - (perItem.get(it.id) || 0);
        const d = Math.min(round(it.price * q * pct), left);
        if (d > 0) { perItem.set(it.id, (perItem.get(it.id) || 0) + d); amount += d; }
      }
    } else if (r.simple_action === 'by_fixed') {
      for (const it of items) {
        const q = r.discount_qty ? Math.min(it.qty, r.discount_qty) : it.qty;
        const left = it.row_total - (perItem.get(it.id) || 0);
        const d = Math.min(round((Number(r.discount_amount) || 0) * q), left);
        if (d > 0) { perItem.set(it.id, (perItem.get(it.id) || 0) + d); amount += d; }
      }
    } else if (r.simple_action === 'cart_fixed') {
      const base = items.reduce((s, it) => s + it.row_total - (perItem.get(it.id) || 0), 0);
      let left = Math.min(Number(r.discount_amount) || 0, base);
      for (const it of items) {
        const share = base ? round(left * ((it.row_total - (perItem.get(it.id) || 0)) / base)) : 0;
        if (share > 0) { perItem.set(it.id, (perItem.get(it.id) || 0) + share); amount += share; }
      }
      void left;
    } else if (r.simple_action === 'buy_x_get_y') {
      const x = Number(r.discount_step) || 0; const y = Number(r.discount_amount) || 0;
      if (x > 0 && y > 0) {
        for (const it of items) {
          const free = Math.floor(it.qty / (x + y)) * y + Math.max(0, (it.qty % (x + y)) - x);
          const d = Math.min(round(free * it.price), it.row_total - (perItem.get(it.id) || 0));
          if (d > 0) { perItem.set(it.id, (perItem.get(it.id) || 0) + d); amount += d; }
        }
      }
    }
    const fs = Number(r.simple_free_shipping) === 2 || (Number(r.simple_free_shipping) === 1 && items.length > 0);
    if (fs) freeShipping = true;
    if (amount > 0 || fs || r.coupon_type === 2 || r.coupon_type === 3) {
      if (r.coupon_type === 2 || r.coupon_type === 3) couponValid = true;
      applied.push({ id: r.id, name: r.name, label: r.store_label || r.name, amount: round(amount) });
    }
    total += amount;
    if (r.stop_rules_processing) break;
  }
  return { discount: round(total), perItem, freeShipping, applied, couponValid };
}
const round = (x) => Math.round(x * 100) / 100;

module.exports = { apply, evalCond, compare, round };
