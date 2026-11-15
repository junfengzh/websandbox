'use strict';
// Wish list, product reviews (write + My Product Reviews), Contact Us.
const S = require('../../shared');
const C = require('../lib/catalog');
const cart = require('../lib/cart');
const { safeBack } = require('./catalog');
const { parseOptions } = require('./checkout');

module.exports = async function miscRoutes(app, kit) {
  const db = () => kit.db();
  const LOGIN = { login: true };

  // ---------------------------------------------------------------- wish list
  const wishlistOf = (uid, create) => {
    let w = db().prepare('SELECT * FROM wishlists WHERE customer_id = ?').get(uid);
    if (!w && create) {
      const id = db().prepare('INSERT INTO wishlists (customer_id, shared, sharing_code, updated_at) VALUES (?, 0, ?, ?)').run(uid, `w${uid}`, kit.nowSql()).lastInsertRowid;
      w = db().prepare('SELECT * FROM wishlists WHERE id = ?').get(id);
    }
    return w;
  };
  const wishPage = async (req, reply) => {
    const w = wishlistOf(req.user.id, false);
    const rows = w ? db().prepare('SELECT * FROM wishlist_items WHERE wishlist_id = ? ORDER BY added_at, id').all(w.id) : [];
    const cards = new Map(C.cards(db(), rows.map((r) => r.product_id)).map((c) => [c.id, c]));
    const items = rows.map((r) => ({ ...r, p: cards.get(r.product_id) })).filter((x) => x.p);
    return reply.render('wishlist', { title: 'My Wish List', items, nav: 'wishlist' });
  };
  app.get('/wishlist', { config: LOGIN }, wishPage);
  app.get('/wishlist/index/index', { config: LOGIN }, wishPage);
  app.get('/wishlist/index/index/wishlist_id/:id', { config: LOGIN }, wishPage);
  app.post('/wishlist/index/add', async (req, reply) => {
    const pid = +((req.body && req.body.product) || 0);
    const p = db().prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(pid);
    if (!req.user) {
      req.flash('error', 'You must login or register to add items to your wishlist.');
      return reply.redirect(`/customer/account/login/?next=${encodeURIComponent(p ? C.productUrl(p) : '/wishlist/')}`);
    }
    if (!p) { req.flash('error', 'We can\'t specify a product.'); return reply.redirect('/wishlist/'); }
    const w = wishlistOf(req.user.id, true);
    const { opts } = parseOptions(db(), p, req.body || {});
    const buy = { product: String(p.id), qty: 1, ...(opts.super_attribute ? { super_attribute: opts.super_attribute } : {}) };
    const ex = db().prepare('SELECT id FROM wishlist_items WHERE wishlist_id = ? AND product_id = ?').get(w.id, p.id);
    if (ex) db().prepare('UPDATE wishlist_items SET qty = qty + 1 WHERE id = ?').run(ex.id);
    else db().prepare('INSERT INTO wishlist_items (wishlist_id, product_id, qty, description, added_at, options_json) VALUES (?, ?, 1, NULL, ?, ?)').run(w.id, p.id, kit.nowSql(), JSON.stringify({ info_buyRequest: buy }));
    db().prepare('UPDATE wishlists SET updated_at = ? WHERE id = ?').run(kit.nowSql(), w.id);
    req.flash('success', `${S.plainName(p.name)} has been added to your Wish List. Click here to continue shopping.`);
    return reply.redirect('/wishlist/');
  });
  const ownItem = (req, id) => db().prepare('SELECT wi.* FROM wishlist_items wi JOIN wishlists w ON w.id = wi.wishlist_id WHERE wi.id = ? AND w.customer_id = ?').get(+id, req.user.id);
  app.post('/wishlist/index/remove', { config: LOGIN }, async (req, reply) => {
    const it = ownItem(req, req.body.item);
    if (it) db().prepare('DELETE FROM wishlist_items WHERE id = ?').run(it.id);
    if (it) req.flash('success', 'You removed the item from your Wish List.');
    return reply.redirect('/wishlist/');
  });
  app.post('/wishlist/index/update', { config: LOGIN }, async (req, reply) => {
    const b = req.body || {};
    for (const [k, v] of Object.entries(b)) {
      let m = /^qty\[(\d+)\]$/.exec(k);
      if (m) { const it = ownItem(req, m[1]); const q = parseFloat(v); if (it && q > 0) db().prepare('UPDATE wishlist_items SET qty = ? WHERE id = ?').run(q, it.id); else if (it && q === 0) db().prepare('DELETE FROM wishlist_items WHERE id = ?').run(it.id); }
      m = /^description\[(\d+)\]$/.exec(k);
      if (m) { const it = ownItem(req, m[1]); if (it) db().prepare('UPDATE wishlist_items SET description = ? WHERE id = ?').run(String(v).slice(0, 2000) || null, it.id); }
    }
    req.flash('success', 'Your Wish List has been updated.');
    return reply.redirect('/wishlist/');
  });
  app.post('/wishlist/index/cart', { config: LOGIN }, async (req, reply) => {
    const it = ownItem(req, req.body.item);
    if (!it) return reply.redirect('/wishlist/');
    const p = db().prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(it.product_id);
    if (!p) return reply.redirect('/wishlist/');
    let buy = {};
    try { buy = (JSON.parse(it.options_json || '{}') || {}).info_buyRequest || {}; } catch {}
    const body = {};
    for (const [k, v] of Object.entries(buy.super_attribute || {})) body[`super_attribute[${k}]`] = v;
    const { opts, errors } = parseOptions(db(), p, body);
    if (errors.length || p.required_options || (p.type === 'configurable' && !opts.child_id)) {
      req.flash('notice', 'You need to choose options for your item.');
      return reply.redirect(C.productUrl(p));
    }
    cart.addItem(req, p, Math.max(1, +(req.body.qty || it.qty || 1)), opts);
    db().prepare('DELETE FROM wishlist_items WHERE id = ?').run(it.id);
    req.flash('success', `You added ${S.plainName(p.name)} to your shopping cart.`);
    return reply.redirect('/wishlist/');
  });
  app.post('/wishlist/index/allcart', { config: LOGIN }, async (req, reply) => {
    const w = wishlistOf(req.user.id, false);
    let n = 0;
    for (const it of w ? db().prepare('SELECT * FROM wishlist_items WHERE wishlist_id = ?').all(w.id) : []) {
      const p = db().prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(it.product_id);
      if (!p || p.type !== 'simple' || p.required_options) continue;
      cart.addItem(req, p, it.qty || 1, {}); db().prepare('DELETE FROM wishlist_items WHERE id = ?').run(it.id); n++;
    }
    req.flash(n ? 'success' : 'error', n ? `${n} product(s) have been added to shopping cart.` : 'No items could be added; choose their options on the product page.');
    return reply.redirect(n ? '/checkout/cart/' : '/wishlist/');
  });

  // ---------------------------------------------------------------- reviews
  app.post('/review/product/post/id/:id', async (req, reply) => {
    const p = db().prepare('SELECT * FROM products WHERE id = ? AND status = 1').get(+req.params.id);
    if (!p) throw kit.httpError(404, 'Product not found');
    const b = req.body || {};
    const nickname = String(b.nickname || '').trim(); const title = String(b.title || '').trim(); const detail = String(b.detail || '').trim();
    const ratings = db().prepare('SELECT id, code FROM ratings WHERE coalesce(is_active, 1) = 1').all();
    const votes = [];
    for (const r of ratings) {
      const v = +(b[`ratings[${r.id}]`] ?? (b.ratings && b.ratings[r.id]) ?? 0);
      if (v >= 1 && v <= 5) votes.push([r.id, v]);
    }
    const url = C.productUrl(p);
    if (!nickname || !title || !detail || (ratings.length && !votes.length)) {
      req.flash('error', !votes.length && ratings.length ? 'Please select one of each of the ratings above.' : 'Please enter a nickname, a summary and a review.');
      return reply.redirect(url + '#review-form');
    }
    const r = db().prepare("INSERT INTO reviews (product_id, customer_id, status, title, detail, nickname, created_at, source) VALUES (?, ?, 'pending', ?, ?, ?, ?, 'live')")
      .run(p.id, req.user ? req.user.id : null, title.slice(0, 255), detail.slice(0, 20000), nickname.slice(0, 128), kit.nowSql());
    for (const [rid, v] of votes) db().prepare('INSERT INTO review_votes (review_id, rating_id, value, percent) VALUES (?, ?, ?, ?)').run(r.lastInsertRowid, rid, v, v * 20);
    req.flash('success', 'You submitted your review for moderation.');
    return reply.redirect(url + '#reviews');
  });
  app.get('/review/customer', { config: LOGIN }, async (req, reply) => {
    const per = 10;
    const total = db().prepare('SELECT count(*) FROM reviews WHERE customer_id = ?').pluck().get(req.user.id);
    const pages = Math.max(1, Math.ceil(total / per));
    const page = Math.min(Math.max(parseInt(req.query.p, 10) || 1, 1), pages);
    const rows = db().prepare(`SELECT r.*, p.name AS product_name, p.url_key, (SELECT avg(percent) FROM review_votes v WHERE v.review_id = r.id) AS pct
      FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.customer_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(req.user.id, per, (page - 1) * per);
    return reply.render('reviews_customer', { title: 'My Product Reviews', rows, page, pages, href: (n) => kit.urlWith(req, { p: n > 1 ? n : null }), nav: 'reviews' });
  });
  app.get('/review/customer/index', { config: LOGIN }, async (req, reply) => reply.redirect('/review/customer/'));
  app.get('/review/customer/view/id/:id', { config: LOGIN }, async (req, reply) => {
    const r = db().prepare(`SELECT r.*, p.name AS product_name, p.url_key, p.id AS pid FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.id = ? AND r.customer_id = ?`).get(+req.params.id, req.user.id);
    if (!r) throw kit.httpError(404, 'Review not found');
    r.votes = db().prepare('SELECT rt.code, v.value, v.percent FROM review_votes v JOIN ratings rt ON rt.id = v.rating_id WHERE v.review_id = ?').all(r.id);
    const card = C.cards(db(), [r.pid])[0];
    return reply.render('review_view', { title: 'Review Details', r, card, nav: 'reviews' });
  });

  // ---------------------------------------------------------------- contact
  const contactPage = async (req, reply) => {
    const u = req.user;
    return reply.render('contact', { title: 'Contact Us', values: { name: u ? `${u.firstname} ${u.lastname}` : '', email: u ? u.email : '', telephone: '', comment: '' }, errors: {}, bodyClass: 'contact-index-index' });
  };
  app.get('/contact', contactPage);
  app.get('/contact/index', contactPage);
  app.post('/contact/index/post', async (req, reply) => {
    const v = kit.validate(req.body || {}, {
      name: { required: true, maxLength: 255, label: 'Name', message: 'This is a required field.' },
      email: { required: true, type: 'email', label: 'Email', message: 'This is a required field.' },
      telephone: { maxLength: 64, label: 'Phone Number' },
      comment: { required: true, maxLength: 20000, label: "What's on your mind?", message: 'This is a required field.' },
    });
    if (!v.ok) return reply.render('contact', { title: 'Contact Us', values: v.values, errors: v.errors }, 422);
    db().prepare('INSERT INTO contact_messages (name, email, telephone, comment, created_at) VALUES (?, ?, ?, ?, ?)').run(v.values.name, v.values.email, v.values.telephone || null, v.values.comment, kit.nowSql());
    req.flash('success', "Thanks for contacting us with your comments and questions. We'll respond to you very soon.");
    return reply.redirect('/contact/');
  });

  void safeBack;
};
