'use strict';
// Storefront account templates (write): address book, account information + newsletter,
// product review of an ordered item.
const { shoppers } = require('./account');

const addressDefault = {
  id: 'gen-shopping-address-new-default', site: 'shopping', kind: 'write', skills: ['navigate', 'form-edit', 'create'], difficulty: 2, cap: 80,
  phrasings: [
    'Add a new address to my address book: {{address}}, phone {{phone}}. Make it my default {{which}} address, but keep my current default {{other}} address.',
    'I have a new {{which}} address: {{address}} (phone {{phone}}). Save it in my account as the default {{which}} address; the {{other}} address stays as it is.',
  ],
  sample(L, r) {
    const out = [];
    for (const c of L.customers()) {
      if (!c.default_billing_id || !c.default_shipping_id) continue;
      for (let k = 0; k < 2; k++) {
        const a = L.fakeAddress(r);
        const which = r.pick(['shipping', 'billing']);
        const other = which === 'shipping' ? 'billing' : 'shipping';
        const col = `default_${which}_id`;
        const keepCol = `default_${other}_id`;
        out.push({ slots: { address: a.text, phone: a.telephone, which, other }, login_user: c.email,
          eval: { type: 'state', state_sql: [
            `SELECT count(*) FROM customer_addresses x WHERE x.id = (SELECT ${col} FROM customers WHERE id = ${c.id}) AND ${L.addrMatch('x', a)} AND replace(replace(x.telephone, '-', ''), ' ', '') = ${L.lit(a.telephone.replace(/-/g, ''))}`,
            `SELECT ${keepCol} FROM customers WHERE id = ${c.id}`,
          ], state_expect: [1, c[keepCol]] } });
      }
    }
    return out;
  },
};

const LAST = ['Carter', 'Nguyen', 'Patel', 'Rivera', 'Brooks', 'Sullivan', 'Hayes', 'Morales', 'Bennett', 'Foster', 'Kim', 'Reyes', 'Coleman', 'Ward', 'Price', 'Hughes'];
const accountUpdate = {
  id: 'gen-shopping-account-name-newsletter', site: 'shopping', kind: 'write', skills: ['navigate', 'form-edit'], difficulty: 2, cap: 70,
  phrasings: [
    'I changed my name: update my account so my {{part}} name is {{name}}. Also {{news}} the store newsletter.',
    'Edit my account information to set the {{part}} name to "{{name}}", and {{news}} the general newsletter subscription.',
  ],
  sample(L, r) {
    const out = [];
    for (const c of L.customers()) {
      const st = L.one('SELECT status FROM newsletter_subscribers WHERE customer_id = ? ORDER BY id DESC LIMIT 1', c.id);
      const subscribed = st === 1;
      const news = subscribed ? 'unsubscribe from' : 'subscribe to';
      const part = r.pick(['last', 'first']);
      const name = part === 'last' ? r.pick(LAST.filter((x) => x !== c.lastname)) : r.pick(['Alexandra', 'Benjamin', 'Chloe', 'Daniel', 'Elena', 'Felix', 'Grace', 'Henry'].filter((x) => x !== c.firstname));
      out.push({ slots: { part, name, news }, login_user: c.email,
        eval: { type: 'state', state_sql: [
          `SELECT ${part}name FROM customers WHERE id = ${c.id}`,
          `SELECT coalesce((SELECT status FROM newsletter_subscribers WHERE customer_id = ${c.id} ORDER BY id DESC LIMIT 1), 0) = 1`,
        ], state_expect: [name, subscribed ? 0 : 1] } });
    }
    return out;
  },
};

const TITLES = [['Works as described', 'Does what it says and arrived quickly.'], ['Not worth it', 'Stopped working after a week.'], ['Great value', 'Good quality for the price, would buy again.'],
  ['Just okay', 'It is fine, nothing special.'], ['Love it', 'Exactly what I needed, highly recommend.'], ['Disappointed', 'Smaller than I expected and feels cheap.']];
const NICKS = ['HappyBuyer', 'ShopperJoe', 'MaryK', 'DealHunter', 'Sam_R', 'TechFan', 'CozyHome', 'Runner42'];
const reviewOrdered = {
  id: 'gen-shopping-review-ordered-item', site: 'shopping', kind: 'write', skills: ['navigate', 'read-detail', 'form-edit', 'create', 'multi-step'], difficulty: 3, cap: 84,
  phrasings: [
    'Write a {{stars}}-star review for the most expensive item in my order #{{order}}. Nickname: {{nick}}, summary: "{{title}}", review: "{{detail}}".',
    'Review the priciest product I bought in order {{order}}: give it {{stars}} stars, use the nickname {{nick}}, the title "{{title}}" and the text "{{detail}}".',
  ],
  sample(L, r) {
    const out = [];
    for (const c of shoppers(L, 2)) {
      for (const o of r.sample(L.all('SELECT id, increment_id FROM orders WHERE customer_id = ?', c.id), 4)) {
        const items = L.all(`SELECT i.product_id, i.price FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ? AND i.parent_item_id IS NULL AND p.status = 1 AND p.visibility IN (2, 3, 4) ORDER BY i.price DESC`, o.id);
        const n = L.one('SELECT count(*) FROM order_items WHERE order_id = ? AND parent_item_id IS NULL', o.id);
        if (items.length < 2 || items.length !== n || Math.abs(items[0].price - items[1].price) < 0.005) continue;
        const [title, detail] = r.pick(TITLES);
        const stars = 1 + r.int(5);
        const nick = r.pick(NICKS);
        const R = `(SELECT id FROM reviews WHERE customer_id = ${c.id} AND product_id = ${items[0].product_id} AND created_at >= '${L.TODAY}' ORDER BY id DESC LIMIT 1)`;
        out.push({ slots: { stars, order: o.increment_id, nick, title, detail }, login_user: c.email,
          eval: { type: 'state', state_sql: [
            `SELECT nickname, title, instr(detail, ${L.lit(detail)}) > 0 FROM reviews WHERE id = ${R}`,
            `SELECT value FROM review_votes WHERE review_id = ${R} AND rating_id = (SELECT id FROM ratings WHERE code = 'Rating')`,
          ], state_expect: [[[nick, title, 1]], stars] } });
      }
    }
    return out;
  },
};

module.exports = [addressDefault, accountUpdate, reviewOrdered];
