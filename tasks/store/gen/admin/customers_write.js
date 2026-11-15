'use strict';
// Back-office customer templates (write): customer group, date of birth + gender, a new address
// as default shipping; review moderation.

const ADMIN = 'admin';
function people(L) {
  const d = new Set(L.col("SELECT firstname || ' ' || lastname FROM customers GROUP BY 1 HAVING count(*) > 1"));
  return L.all('SELECT * FROM customers ORDER BY id').map((c) => ({ ...c, label: d.has(`${c.firstname} ${c.lastname}`) ? `${c.firstname} ${c.lastname} (${c.email})` : `${c.firstname} ${c.lastname}` }));
}
const GROUPS = { 1: 'General', 2: 'Wholesale', 3: 'Retailer' };

const group = {
  id: 'gen-admin-customer-group', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 1, cap: 40,
  phrasings: [
    'Move the customer {{customer}} to the "{{group}}" customer group.',
    '{{customer}} now buys in bulk for a shop. Assign them to the {{group}} group.',
    'Change the customer group of {{customer}} to {{group}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const c of people(L)) {
      for (const g of Object.keys(GROUPS).map(Number).filter((x) => x !== c.group_id)) {
        out.push({ slots: { customer: c.label, group: GROUPS[g] }, login_user: ADMIN, phrasing: g === 2 ? null : r.pick([0, 2]),
          eval: { type: 'state', state_sql: `SELECT group_id FROM customers WHERE id = ${c.id}`, state_expect: g } });
      }
    }
    return out;
  },
};

const GENDER = { 1: 'male', 2: 'female' };
const dobGender = {
  id: 'gen-admin-customer-dob-gender', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'Update the account of {{customer}}: date of birth {{dob}}, gender {{gender}}.',
    'In the admin, set {{customer}}\'s date of birth to {{dob}} and their gender to {{gender}}.',
  ],
  sample(L, r) {
    const out = [];
    for (const c of people(L)) {
      for (let k = 0; k < 2; k++) {
        const y = 1960 + r.int(40); const m = 1 + r.int(12); const dd = 1 + r.int(28);
        const dob = `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        if (c.dob && c.dob.slice(0, 10) === dob) continue;
        const g = 1 + r.int(2);
        out.push({ slots: { customer: c.label, dob: L.longDate(dob), gender: GENDER[g] }, login_user: ADMIN,
          eval: { type: 'state', state_sql: `SELECT substr(dob, 1, 10), gender FROM customers WHERE id = ${c.id}`, state_expect: [[dob, g]] } });
      }
    }
    return out;
  },
};

const addAddress = {
  id: 'gen-admin-customer-address-default', site: 'shopping_admin', kind: 'write', skills: ['search', 'form-edit', 'create'], difficulty: 2, cap: 40,
  phrasings: [
    'Add a new address for the customer {{customer}}: {{address}}, phone {{phone}}, and make it their default {{which}} address.',
    '{{customer}} moved. Add the address {{address}} (phone {{phone}}) to their account as the default {{which}} address.',
  ],
  sample(L, r) {
    const out = [];
    for (const c of people(L)) {
      if (!c.default_billing_id || !c.default_shipping_id) continue;
      const a = L.fakeAddress(r);
      const which = r.pick(['shipping', 'billing']);
      out.push({ slots: { customer: c.label, address: a.text, phone: a.telephone, which }, login_user: ADMIN,
        eval: { type: 'state', state_sql: [`SELECT count(*) FROM customer_addresses x WHERE x.id = (SELECT default_${which}_id FROM customers WHERE id = ${c.id}) AND x.customer_id = ${c.id} AND ${L.addrMatch('x', a)}`],
          state_expect: [1] } });
    }
    return out;
  },
};

const STATUS = { approved: 'Approved', pending: 'Pending', not_approved: 'Not Approved' };
const reviewStatus = {
  id: 'gen-admin-review-status', site: 'shopping_admin', kind: 'write', skills: ['search', 'filter-sort', 'form-edit'], difficulty: 2, cap: 40,
  phrasings: [
    'Set the review "{{title}}" by {{nick}} on "{{product}}" to {{status}}.',
    'The review titled "{{title}}" (nickname {{nick}}) for the product "{{product}}" should be {{status}}. Update its status.',
  ],
  sample(L, r) {
    const out = [];
    const rows = L.all(`SELECT r.id, r.title, r.nickname, r.status, p.name FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.id % 997 = 11 AND length(r.title) BETWEEN 6 AND 60
      AND length(r.nickname) BETWEEN 3 AND 30 AND length(p.name) < 90 AND r.title NOT GLOB '*[^ -~]*' AND r.nickname NOT GLOB '*[^ -~]*' ORDER BY r.id`);
    for (const x of r.sample(rows, 200)) {
      if (L.one('SELECT count(*) FROM reviews WHERE title = ? AND nickname = ?', x.title, x.nickname) !== 1) continue;
      const st = r.pick(Object.keys(STATUS).filter((s) => s !== x.status));
      out.push({ slots: { title: x.title, nick: x.nickname, product: L.plain(x.name), status: STATUS[st] }, login_user: ADMIN,
        eval: { type: 'state', state_sql: `SELECT status FROM reviews WHERE id = ${x.id}`, state_expect: st } });
    }
    return out;
  },
};

module.exports = [group, dobGender, addAddress, reviewStatus];
