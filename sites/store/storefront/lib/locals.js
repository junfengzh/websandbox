'use strict';
// Template locals for every storefront render (header: menu, mini cart, customer box).
const S = require('../../shared');

module.exports = function locals(req) {
  const base = { S, money: S.money, date: S.date, htmlName: S.htmlName, plainName: S.plainName };
  if (/^\/admin(\/|$|\?)/.test(req.url || '')) return base;
  if (!req.tenant || !req.session) return base;
  const catalog = require('./catalog');
  const cart = require('./cart');
  const db = req.tenant.db;
  let menu = [];
  let cartQty = 0; let compareCount = 0; let wishCount = 0;
  try {
    const t = catalog.tree(db);
    menu = catalog.activeChildren(t.root, true);
    cartQty = cart.count(req);
    compareCount = db.prepare('SELECT count(*) FROM compare_items WHERE ' + (req.user ? 'customer_id = ?' : 'visitor_id = ? AND customer_id IS NULL')).pluck().get(req.user ? req.user.id : String(req.session.get('vid') || '-'));
    if (req.user) wishCount = db.prepare('SELECT count(*) FROM wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id WHERE w.customer_id = ?').pluck().get(req.user.id);
  } catch { /* outside a tenant context (error page) */ }
  const fmtAddr = (a) => require('../routes/customer').helpers.formatAddress(db, a);
  return { ...base, fmtAddr, catMenu: menu, catUrl: catalog.catUrl, cartQty, compareCount, wishCount, customer: req.user && req.user.kind === 'customer' ? req.user : null };
};
