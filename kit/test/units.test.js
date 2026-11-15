'use strict';
// Pure helpers: search, web (pagination/sort/filter/validate), auth, grader.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const kit = require('..');
const { search, grader } = kit;

const fakeReq = (url) => {
  const u = new URL(url, 'http://x');
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
  return { url: u.pathname + u.search, query };
};

test('search.match sanitises user input into a safe FTS5 expression', () => {
  assert.equal(search.match('quick brown'), '"quick" AND "brown"*');
  assert.equal(search.match('quick brown', { prefix: 'none' }), '"quick" AND "brown"');
  assert.equal(search.match('"brown fox" jumps'), '"brown fox" AND "jumps"*');
  assert.equal(search.match('a" OR b* NEAR(c) -d ^e:f'), '"a" AND "or" AND "b" AND "near" AND "c" AND "d" AND "e" AND "f"*');
  assert.equal(search.match('garden bike', { synonyms: { bike: ['bicycle'] } }), '"garden" AND ("bike"* OR "bicycle")');
  assert.equal(search.match('!!! ***'), null);
  assert.equal(search.match('bike', { synonyms: { bike: ['bicycle'] } }), '("bike"* OR "bicycle")');
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(title, body); INSERT INTO t VALUES ('Quick brown fox', 'jumps over the lazy dog'), ('Lazy afternoon', 'a quick nap'), ('bicycle repair', 'fix a flat');");
  db.exec("CREATE TABLE syn(term, synonym); INSERT INTO syn VALUES ('bike', 'bicycle')");
  // every sanitised string must be valid FTS5 syntax
  for (const s of ['a" OR', 'NOT', 'AND OR NOT', '(((', 'x*y', 'col:term', '"unbalanced', "it's", 'ünïcödé straße', '日本語']) {
    const m = search.match(s);
    if (m) db.prepare('SELECT count(*) FROM t WHERE t MATCH ?').get(m);
  }
  const s = search.prepare(db, 't', 'quick', { weights: { title: 10, body: 1 } });
  assert.equal(s.rank, 'bm25(t, 10.00, 1.00)');
  const rows = db.prepare(`SELECT title, ${s.highlight('title')} AS h, ${s.snippet('body', 5)} AS sn FROM t WHERE t MATCH ? ORDER BY ${s.rank}`).all(s.match);
  assert.equal(rows[0].title, 'Quick brown fox'); // title weight wins
  assert.equal(search.markup(rows[0].h), '<mark>Quick</mark> brown fox');
  assert.equal(search.markup('<b>\u0002x\u0003'), '&lt;b&gt;<mark>x</mark>');
  const syn = search.prepare(db, 't', 'bike', { synonyms: 'syn' });
  assert.equal(db.prepare('SELECT title FROM t WHERE t MATCH ?').pluck().get(syn.match), 'bicycle repair');
  assert.equal(db.prepare('SELECT title FROM t WHERE t MATCH ?').pluck().get(search.match('flat bike', { db, synonyms: 'syn' })), 'bicycle repair');
  assert.equal(search.didYouMean(db, 't', 'quikc borwn'), 'quick brown');
  assert.equal(search.didYouMean(db, 't', 'lazy'), null);
  assert.equal(search.didYouMean(db, 't', 'bicycel'), 'bicycle');
  assert.equal(search.editDistance('kitten', 'sitting'), 3);
  assert.equal(search.editDistance('ab', 'ba'), 1);
});

test('paginate / sorter / filters / urlWith use stable params', () => {
  const req = fakeReq('/list?q=x&page=3&sort=price_desc&brand=Acme&price_min=10&bad=');
  const p = kit.paginate(req, 95, { perPage: 10 });
  assert.equal(p.page, 3); assert.equal(p.pages, 10); assert.equal(p.offset, 20);
  assert.equal(p.prev, '/list?q=x&page=2&sort=price_desc&brand=Acme&price_min=10');
  assert.equal(p.links[0].href, '/list?q=x&sort=price_desc&brand=Acme&price_min=10');
  assert.deepEqual(p.links.map((l) => l.gap ? '…' : l.n), [1, 2, 3, 4, 5, '…', 10]);
  assert.equal(kit.paginate(fakeReq('/l?page=99'), 5).page, 1);
  const s = kit.sorter(req, { options: { price: 'p.price', name: 'p.name' }, default: 'name_asc', tiebreak: 'p.id' });
  assert.equal(s.orderBy, 'p.price DESC, p.id DESC');
  assert.equal(s.link('price'), '/list?q=x&sort=price_asc&brand=Acme&price_min=10');
  assert.equal(kit.sorter(fakeReq('/l?sort=evil;drop_asc'), { options: { name: 'n' }, default: 'name_desc' }).orderBy, 'n DESC');
  const f = kit.filters(req, { brand: { col: 'p.brand' }, price_min: { col: 'p.price', op: '>=', type: 'number' }, bad: { col: 'x' }, tags: { col: 't', op: 'in' } });
  assert.equal(f.where, 'p.brand = ? AND p.price >= ?');
  assert.deepEqual(f.params, ['Acme', 10]);
  assert.equal(f.active[0].removeHref, '/list?q=x&sort=price_desc&price_min=10');
  const g = kit.filters(fakeReq('/l?tags=a,b&name=50%_off'), { tags: { col: 't', op: 'in' }, name: { col: 'n', op: 'like' } });
  assert.equal(g.where, "t IN (?,?) AND n LIKE ? ESCAPE '\\'");
  assert.deepEqual(g.params, ['a', 'b', '%50\\%\\_off%']);
});

test('validate', () => {
  const v = kit.validate({ title: '  hi ', price: 'abc', qty: '3', email: 'no', agree: 'on', color: 'red' }, {
    title: { required: true, minLength: 3 }, price: { type: 'number' }, qty: { type: 'int', max: 2 }, email: { type: 'email' },
    agree: { type: 'bool' }, color: { oneOf: ['blue'] }, missing: { required: true, label: 'Name' }, opt: { default: 'x' },
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, {
    title: 'Title must be at least 3 characters.', price: 'Price must be a number.', qty: 'Qty must be at most 2.',
    email: 'Email must be a valid email address.', color: 'Color has an invalid value.', missing: 'Name is required.',
  });
  assert.equal(v.values.agree, true); assert.equal(v.values.opt, 'x'); assert.equal(v.values.qty, 3);
  assert.equal(kit.validate({ a: '5' }, { a: { type: 'int', min: 1 } }).ok, true);
});

test('auth: scrypt, bcrypt, argon2, plain', async () => {
  const h = kit.auth.hashPassword('s3cret');
  assert.ok(await kit.auth.verifyPassword('s3cret', h));
  assert.ok(!(await kit.auth.verifyPassword('nope', h)));
  const { bcrypt, argon2id } = require('hash-wasm');
  const salt = new Uint8Array(16).fill(7);
  const b = await bcrypt({ password: 'pw', salt, costFactor: 4, outputType: 'encoded' });
  assert.ok(await kit.auth.verifyPassword('pw', b.replace('$2b$', '$2y$')));
  const a = await argon2id({ password: 'pw', salt, parallelism: 1, iterations: 2, memorySize: 512, hashLength: 32, outputType: 'encoded' });
  assert.ok(await kit.auth.verifyPassword('pw', a));
  assert.ok(await kit.auth.verifyPassword('pw', 'plain$pw'));
  assert.ok(!(await kit.auth.verifyPassword('pw', 'md5$whatever')));
});

test('grader: answers, URLs, state', async () => {
  assert.ok(grader.exactMatch(' "Yes" ', 'yes'));
  assert.ok(grader.mustInclude('The total is $55.00 for 2 items', ['55.00', '2 |OR| two']));
  assert.ok(!grader.mustInclude('total 55', ['55.00']));
  assert.ok(grader.urlMatch('http://127.10.3.2/search?sort=price_desc&q=usb+hub&page=1', '__SHOPPING__/search?q=usb%20hub&sort=price_desc'));
  assert.ok(!grader.urlMatch('http://x/search?q=usb', '__SHOPPING__/search?q=usb&sort=price_desc'));
  assert.ok(!grader.urlMatch('http://x/search?q=usb&sort=price_desc&page=2', '__SHOPPING__/search?q=usb&sort=price_desc', { mode: 'exact' }));
  assert.ok(grader.urlMatch('http://x/f/books/', '__REDDIT__/f/books'));
  assert.ok(grader.stateMatch([{ n: '55.00' }], 55));
  assert.ok(grader.stateMatch([{ a: 1, b: 'x' }, { a: 2, b: 'y' }], [[2, 'y'], [1, 'x']]));
  assert.ok(!grader.stateMatch([{ a: 1 }, { a: 2 }], { rows: [[2], [1]], ordered: true }));
  assert.ok(grader.stateMatch([{ a: 1, b: 2 }], [{ b: 2 }]));
  assert.ok(grader.stateMatch([], { count: 0 }));
  assert.ok(grader.stateMatch([{ x: 1 }], { nonempty: true }));
  assert.ok(grader.stateMatch([{ x: 3 }], { min: 2, max: 3 }));
  assert.ok(grader.stateMatch([{ x: 1 }, { x: 2 }], { includes: [2] }));
  const db = new Database(':memory:');
  db.exec("CREATE TABLE p(name, price); INSERT INTO p VALUES ('Circe fleece', 55), ('Antonia tank', 34)");
  const query = async (sql) => db.prepare(sql).all();
  let r = await grader.grade({ eval: { type: 'answer', answer: { exact: '$sql' }, answer_sql: "SELECT price FROM p WHERE name = 'Circe fleece'" } }, { answer: '55', query });
  assert.equal(r.pass, true);
  r = await grader.grade({ eval: { type: ['answer', 'url'], answer: { must_include: ['Circe', 'Antonia'] }, answer_sql: 'SELECT name FROM p', url: '__SHOPPING__/p?sort=price_asc' } },
    { answer: 'circe fleece and antonia tank', url: 'http://h/p?sort=price_asc&page=1', query });
  assert.equal(r.pass, true);
  assert.equal(r.checks[0].drift, true); // static refs differ from the SQL values
  r = await grader.grade({ eval: { type: 'state', state_sql: ['SELECT price FROM p WHERE name = \'Circe fleece\'', 'SELECT count(*) FROM p'], state_expect: [55, 3] } }, { query });
  assert.equal(r.pass, false); assert.equal(r.checks[0].pass, true); assert.equal(r.checks[1].pass, false);
  r = await grader.grade({ intent: 'q', eval: { type: 'answer', answer: { fuzzy: ['about 55 dollars'] } } }, { answer: '55' });
  assert.equal(r.pass, null); assert.equal(r.checks[0].pending, 'fuzzy');
  r = await grader.grade({ intent: 'q', eval: { type: 'answer', answer: { fuzzy: ['55'] } } }, { answer: '55', fuzzy: async ({ answer, reference }) => answer === reference[0] });
  assert.equal(r.pass, true);
  r = await grader.grade({ eval: { type: 'state', state_sql: 'DELETE FROM p', state_expect: 1 } }, { query: async () => { throw new Error('read-only'); } });
  assert.equal(r.pass, false); assert.match(r.checks[0].error, /read-only/);
});
